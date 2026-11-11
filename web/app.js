// Phone client: pairing code -> relay -> end-to-end encrypted tunnel -> Herdr.
//
// Two backends are supported over the same encrypted tunnel:
//   * herdr-relay bridge  (GET /api/snapshot, POST /api/rpc)
//   * installed Alma app  (WS /ws/herdr hub + POST /api/herdr/rpc)
// The backend is detected at connect time; the UI stays the same.

import { E2ESession, isValidPairingCode, routingIdForCode } from './lib/e2e.js';
import {
  ALMA,
  BRIDGE,
  applyHubMessage,
  detectBackend,
  errorMessage,
  panesFromSnapshot,
  parseHubMessage,
  parseJson,
  readText,
  rpcPath,
} from './lib/backend.js';

const HUB_PATH = '/ws/herdr';
const HUB_SOCKET_ID = 'hub';

const els = {
  pair: document.getElementById('pair'),
  pairForm: document.getElementById('pair-form'),
  code: document.getElementById('code'),
  plainMode: document.getElementById('plain-mode'),
  pairError: document.getElementById('pair-error'),
  session: document.getElementById('session'),
  route: document.getElementById('route'),
  disconnect: document.getElementById('disconnect'),
  refresh: document.getElementById('refresh'),
  panes: document.getElementById('panes'),
  paneTitle: document.getElementById('pane-title'),
  output: document.getElementById('output'),
  inputForm: document.getElementById('input-form'),
  input: document.getElementById('input'),
};

const state = {
  epoch: 0,
  ws: null,
  session: null,
  pending: new Map(),
  seq: 0,
  backend: BRIDGE,
  hub: { open: false, failed: false, state: { panes: [], online: true, reason: null, dirty: false } },
  panes: [],
  currentPane: null,
  pollTimer: null,
  code: null,
  lanDirect: false,
  plain: false,
};

function setRoute(text) {
  els.route.textContent = text;
}

function showError(message) {
  els.pairError.textContent = message ?? '';
}

function wsBase() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}`;
}

async function connect(code, plainOverride) {
  const epoch = ++state.epoch;
  showError('');
  if (!isValidPairingCode(code)) {
    showError('配对码格式不对：应为 43 个字符的 base64url 字符串。');
    return;
  }
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const plain = plainOverride ?? hashParams.get('e2e') === '0';
  state.code = code;
  state.plain = plain;
  state.lanDirect = false;
  if (els.plainMode) els.plainMode.checked = plain;
  if (plain) {
    // E2E off: the relay is an ordinary HTTP/WebSocket reverse proxy and the
    // pairing code itself is the token in the URL, exactly like Alma's old
    // `connectUrl`.
    setRoute('正在连接中继（明文模式）…');
    state.ws = null;
    state.session = createPlainTransport(code);
    enterSession();
    return;
  }
  const routingId = await routingIdForCode(code);
  setRoute('正在连接中继…');

  const socket = new WebSocket(`${wsBase()}/c/${routingId}/__alma_e2e__`);
  socket.binaryType = 'arraybuffer';
  state.ws = socket;

  socket.addEventListener('open', () => {
    if (epoch !== state.epoch) return;
    // The relay opens the `/__alma_e2e__` tunnel by itself when the phone
    // connects; the E2E handshake is the first thing that crosses it.
    startSession();
  });
  socket.addEventListener('message', (event) => {
    if (epoch !== state.epoch) return;
    state.session?.onMessage(event.data);
  });
  socket.addEventListener('close', () => {
    if (epoch !== state.epoch || state.ws !== socket) return;
    stopPolling();
    state.session = null;
    state.pending.clear();
    if (!els.session.hidden) setRoute(state.lanDirect ? '局域网连接已断开' : '连接已断开');
  });
  socket.addEventListener('error', () => {
    if (epoch === state.epoch) showError('无法连接中继服务器');
  });
}

function resetSessionUi() {
  els.session.hidden = true;
  els.pair.hidden = false;
  els.disconnect.hidden = true;
  stopPolling();
}

function enterSession() {
  showError('');
  els.pair.hidden = true;
  els.session.hidden = false;
  els.disconnect.hidden = false;
  localStorage.setItem('herdr.pairing', state.code);
  localStorage.setItem('herdr.plain', state.plain ? '1' : '0');
  (async () => {
    // Alma probes the desktop's LAN candidates once the E2E session is up and
    // switches to a direct socket when one answers (E2E only).
    if (!state.plain) await maybeUseLan();
    boot().catch((error) => showError(error.message));
  })();
}

function startSession() {
  setRoute('正在握手…');
  state.session = new E2ESession({
    role: 'initiator',
    code: state.code,
    send: (payload) => {
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(payload);
    },
    onFrame: (frame) => onTunnelFrame(frame),
    onError: (reason) => {
      showError(String(reason));
      setRoute('握手失败');
      localStorage.removeItem('herdr.pairing');
      resetSessionUi();
    },
    onReady: enterSession,
  });
  state.session.start();
}

async function boot() {
  if (!state.lanDirect) setRoute('已加密连接 · 检测后端…');
  let probe = { status: 0, body: null };
  try {
    probe = await request('GET', '/api/snapshot');
  } catch {
    probe = { status: 0, body: null };
  }
  state.backend = detectBackend(probe.status, probe.body) ?? ALMA;
  if (state.backend === BRIDGE) {
    setRoute('已加密连接 · herdr');
    await refresh();
  } else {
    setRoute('已加密连接 · Alma');
    openHub();
    await refreshAlma();
  }
  startPolling();
}

// --- tunnel transport ------------------------------------------------------

function onTunnelFrame(frame) {
  const id = String(frame.id ?? '');
  if (id === HUB_SOCKET_ID) {
    onHubFrame(frame);
    return;
  }
  const pending = state.pending.get(id);
  if (!pending) return;
  switch (frame.t) {
    case 'hres':
      pending.head = { status: Number(frame.status) || 200, headers: frame.headers || {} };
      return;
    case 'hchunk':
      if (frame.b instanceof Uint8Array) pending.chunks.push(frame.b);
      return;
    case 'hend': {
      state.pending.delete(id);
      const body = concatBytes(pending.chunks);
      pending.resolve({ status: pending.head?.status ?? 200, headers: pending.head?.headers ?? {}, body });
      return;
    }
    case 'herr':
      state.pending.delete(id);
      pending.reject(new Error(String(frame.message || 'tunnel error')));
      return;
    default:
      return;
  }
}

function onHubFrame(frame) {
  if (frame.t === 'wopened') {
    state.hub.open = true;
    return;
  }
  if (frame.t === 'werr') {
    state.hub.failed = true;
    showError(`hub 不可用：${frame.message ?? ''}`);
    return;
  }
  if (frame.t === 'wclose') {
    state.hub.open = false;
    return;
  }
  if (frame.t !== 'wmsg') return;
  const text = typeof frame.s === 'string' ? frame.s : null;
  if (!text) return;
  const message = parseHubMessage(text);
  if (!message) return;
  applyHubMessage(state.hub.state, message);
  const panes = state.hub.state.panes;
  if (panes.length) {
    state.panes = panes;
    renderPanes();
    if (!state.currentPane || !panes.some((pane) => pane.id === state.currentPane)) {
      selectPane(panes[0].id).catch(() => {});
    }
  } else if (message.type === 'herdr' && !state.hub.state.online) {
    state.panes = [];
    renderPanes();
    els.output.textContent = `Herdr 离线：${state.hub.state.reason ?? 'unknown'}`;
  }
}

/**
 * Try the desktop's LAN-direct endpoint advertised over the encrypted tunnel.
 * The phone repeats the E2E handshake against the desktop directly and keeps
 * the relay socket as a fallback until the direct session is ready.
 */
async function maybeUseLan() {
  if (!state.session?.isReady()) return false;
  let lan = null;
  try {
    const response = await request('GET', '/__alma_lan__', { timeoutMs: 3000 });
    if (response.status !== 200) return false;
    lan = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return false;
  }
  if (!lan || !Number.isInteger(lan.port) || !Array.isArray(lan.hosts)) return false;
  for (const host of lan.hosts) {
    if (typeof host !== 'string' || !host) continue;
    const direct = await tryDirect(`ws://${host}:${lan.port}/__alma_e2e__`, state.code);
    if (!direct) continue;
    const previous = state.ws;
    state.ws = direct.socket;
    state.session = direct.session;
    state.lanDirect = true;
    direct.socket.addEventListener('message', (event) => {
      if (state.ws !== direct.socket) return;
      direct.session.onMessage(event.data);
    });
    direct.socket.addEventListener('close', () => {
      if (state.ws !== direct.socket) return;
      stopPolling();
      state.session = null;
      state.pending.clear();
      setRoute('局域网连接已断开');
      showError('局域网直连已断开，请重新连接（会回到中继）。');
    });
    try {
      previous?.close();
    } catch {
      /* ignore */
    }
    setRoute('局域网直连 · 已加密');
    return true;
  }
  return false;
}

function tryDirect(url, code) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      finish(null);
    }, 2500);
    socket.addEventListener('error', () => finish(null));
    socket.addEventListener('close', () => finish(null));
    socket.addEventListener('open', async () => {
      if (settled) return;
      const session = new E2ESession({
        role: 'initiator',
        code,
        send: (payload) => socket.send(payload),
        onFrame: (frame) => onTunnelFrame(frame),
        onError: () => {},
      });
      try {
        await session.start();
      } catch {
        finish(null);
        return;
      }
      const ready = await waitFor(() => session.isReady(), 3000);
      if (!ready) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        finish(null);
        return;
      }
      finish({ socket, session });
    });
  });
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function openHub() {
  if (!state.session?.isReady()) return;
  state.session.sendFrame({ t: 'wopen', id: HUB_SOCKET_ID, path: HUB_PATH });
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function request(method, path, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!state.session?.isReady()) {
      reject(new Error('tunnel is not ready'));
      return;
    }
    const id = `h${++state.seq}`;
    const timer = setTimeout(() => {
      if (!state.pending.delete(id)) return;
      reject(new Error(`${method} ${path} timed out`));
      state.session?.sendFrame({ t: 'hcancel', id });
    }, timeoutMs);
    state.pending.set(id, {
      chunks: [],
      head: null,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const payload = { t: 'hreq', id, method, path, headers };
    if (body) payload.b = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
    state.session.sendFrame(payload);
  });
}

async function rpc(method, params = {}) {
  const response = await request('POST', rpcPath(state.backend), {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const text = new TextDecoder().decode(response.body);
  const payload = parseJson(text);
  if (response.status >= 400 || (payload && payload.error)) {
    throw new Error(errorMessage(payload, response.status));
  }
  return payload?.result ?? payload;
}

// --- views -----------------------------------------------------------------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!state.currentPane) return;
    readPane().catch((error) => showError(error.message));
  }, 1500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refresh() {
  try {
    const snapshot = await request('GET', '/api/snapshot');
    const payload = parseJson(new TextDecoder().decode(snapshot.body));
    if (snapshot.status >= 400) throw new Error(errorMessage(payload, snapshot.status));
    applyPanes(panesFromSnapshot(payload?.snapshot));
  } catch (error) {
    els.output.textContent = `读取 herdr 失败：${error.message}`;
  }
}

async function refreshAlma() {
  try {
    const result = await rpc('pane.list', {});
    const list = (result?.panes ?? []).map((pane) => ({
      id: pane.pane_id ?? pane.id,
      title: pane.terminal_title ?? pane.title ?? pane.pane_id,
      focused: pane.focused === true,
    }));
    if (!state.hub.open || !state.hub.state.panes.length) applyPanes(list);
  } catch (error) {
    els.output.textContent = `读取 Alma 失败：${error.message}`;
  }
}

function applyPanes(list) {
  if (!Array.isArray(list) || !list.length) return;
  state.panes = list;
  renderPanes();
  if (!state.currentPane || !list.some((pane) => pane.id === state.currentPane)) {
    selectPane(list[0].id).catch(() => {});
  }
}

function renderPanes() {
  els.panes.textContent = '';
  for (const pane of state.panes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane';
    button.textContent = pane.title || pane.id;
    button.setAttribute('aria-pressed', String(state.currentPane === pane.id));
    button.addEventListener('click', () => selectPane(pane.id).catch((error) => showError(error.message)));
    els.panes.append(button);
  }
}

async function selectPane(id) {
  state.currentPane = id;
  renderPanes();
  const pane = state.panes.find((candidate) => candidate.id === id);
  els.paneTitle.textContent = pane?.title || id || '';
  await readPane();
}

async function readPane() {
  if (!state.currentPane) return;
  const result = await rpc('pane.read', {
    pane_id: state.currentPane,
    source: 'visible',
    lines: 200,
    strip_ansi: true,
  });
  const text = readText(result);
  const atBottom = els.output.scrollTop + els.output.clientHeight >= els.output.scrollHeight - 40;
  els.output.textContent = text || '(空)';
  if (atBottom) els.output.scrollTop = els.output.scrollHeight;
}

async function sendInput(text) {
  if (!state.currentPane || !text) return;
  await rpc('pane.send_text', { pane_id: state.currentPane, text });
  await rpc('pane.send_keys', { pane_id: state.currentPane, keys: ['Enter'] });
  await readPane();
}

/**
 * E2E-off transport: the relay proxies HTTP and WebSockets directly, so the
 * page speaks the same `hreq`/`wopen` shapes but over ordinary fetch/WebSocket.
 */
function createPlainTransport(code) {
  const sockets = new Map();
  const aborts = new Map();
  const httpBase = wsBase().replace(/^ws/, 'http');
  return {
    isReady: () => true,
    start: async () => {},
    onMessage: () => {},
    close: () => {
      for (const entry of sockets.values()) {
        try {
          entry.ws.close();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    },
    sendFrame(frame) {
      const id = String(frame.id ?? '');
      if (frame.t === 'hreq') {
        const controller = new AbortController();
        aborts.set(id, controller);
        const init = {
          method: frame.method || 'GET',
          headers: frame.headers || {},
          signal: controller.signal,
        };
        if (frame.b instanceof Uint8Array) init.body = frame.b;
        fetch(`${httpBase}/c/${code}${frame.path}`, init)
          .then(async (response) => {
            onTunnelFrame({ t: 'hres', id, status: response.status, headers: Object.fromEntries(response.headers) });
            if (response.body) {
              const reader = response.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                onTunnelFrame({ t: 'hchunk', id, b: value });
              }
            }
            onTunnelFrame({ t: 'hend', id });
          })
          .catch((error) => {
            if (!controller.signal.aborted) onTunnelFrame({ t: 'herr', id, message: error.message });
          })
          .finally(() => aborts.delete(id));
        return;
      }
      if (frame.t === 'hcancel') {
        aborts.get(id)?.abort();
        aborts.delete(id);
        return;
      }
      if (frame.t === 'wopen') {
        const ws = new WebSocket(`${wsBase()}/c/${code}${frame.path}`);
        ws.binaryType = 'arraybuffer';
        const entry = { ws, queue: [] };
        sockets.set(id, entry);
        ws.addEventListener('open', () => {
          onTunnelFrame({ t: 'wopened', id });
          for (const item of entry.queue.splice(0)) ws.send(item);
        });
        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') onTunnelFrame({ t: 'wmsg', id, s: event.data });
          else onTunnelFrame({ t: 'wmsg', id, b: new Uint8Array(event.data) });
        });
        ws.addEventListener('close', (event) => onTunnelFrame({ t: 'wclose', id, code: event.code }));
        ws.addEventListener('error', () => onTunnelFrame({ t: 'werr', id, message: 'websocket failed' }));
        return;
      }
      if (frame.t === 'wmsg') {
        const entry = sockets.get(id);
        if (!entry) return;
        const data = typeof frame.s === 'string' ? frame.s : frame.b;
        if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(data);
        else entry.queue.push(data);
        return;
      }
      if (frame.t === 'wclose') {
        const entry = sockets.get(id);
        if (!entry) return;
        sockets.delete(id);
        try {
          entry.ws.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function disconnect() {
  stopPolling();
  state.epoch += 1;
  state.session = null;
  state.pending.clear();
  state.hub = { open: false, failed: false, state: { panes: [], online: true, reason: null, dirty: false } };
  state.session?.close?.();
  state.ws?.close();
  state.ws = null;
  state.lanDirect = false;
  localStorage.removeItem('herdr.pairing');
  resetSessionUi();
  setRoute('未连接');
}

els.pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  connect(els.code.value.trim(), els.plainMode?.checked === true).catch((error) => showError(error.message));
});
els.refresh.addEventListener('click', () => {
  const work = state.backend === BRIDGE ? refresh() : refreshAlma();
  work.catch((error) => showError(error.message));
});
els.disconnect.addEventListener('click', disconnect);
els.inputForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = els.input.value;
  els.input.value = '';
  sendInput(value).catch((error) => showError(error.message));
});

const hashParams = new URLSearchParams(location.hash.slice(1));
const saved = hashParams.get('code') || localStorage.getItem('herdr.pairing');
if (saved) {
  const storedPlain = localStorage.getItem('herdr.plain') === '1';
  const plain = hashParams.get('e2e') === '0' || storedPlain;
  els.code.value = saved;
  if (els.plainMode) els.plainMode.checked = plain;
  connect(saved, plain).catch((error) => showError(error.message));
}
