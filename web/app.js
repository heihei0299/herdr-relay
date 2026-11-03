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

async function connect(code) {
  const epoch = ++state.epoch;
  showError('');
  if (!isValidPairingCode(code)) {
    showError('配对码格式不对：应为 43 个字符的 base64url 字符串。');
    return;
  }
  state.code = code;
  const routingId = await routingIdForCode(code);
  setRoute('正在连接中继…');

  const socket = new WebSocket(`${wsBase()}/c/${routingId}/__alma_e2e__`);
  socket.binaryType = 'arraybuffer';
  state.ws = socket;

  socket.addEventListener('open', () => {
    if (epoch !== state.epoch) return;
    // Alma's handshake: ask the relay for the encrypted tunnel by name.
    socket.send(JSON.stringify({ t: 'wopen', id: 'w1', path: '/__alma_e2e__' }));
  });
  socket.addEventListener('message', (event) => {
    if (epoch !== state.epoch) return;
    if (state.session) {
      state.session.onMessage(event.data);
      return;
    }
    const message = parseJson(typeof event.data === 'string' ? event.data : '');
    if (!message) return;
    if (message.t === 'wopened' || message.t === 'ready') {
      startSession();
    } else if (message.t === 'error' || message.t === 'werr') {
      showError(message.message || '中继拒绝了连接');
      localStorage.removeItem('herdr.pairing');
      resetSessionUi();
      socket.close();
    }
  });
  socket.addEventListener('close', () => {
    if (epoch !== state.epoch) return;
    stopPolling();
    state.session = null;
    state.pending.clear();
    if (!els.session.hidden) setRoute('连接已断开');
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
    onReady: () => {
      showError('');
      els.pair.hidden = true;
      els.session.hidden = false;
      els.disconnect.hidden = false;
      localStorage.setItem('herdr.pairing', state.code);
      boot().catch((error) => showError(error.message));
    },
  });
  state.session.start();
}

async function boot() {
  setRoute('已加密连接 · 检测后端…');
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

function disconnect() {
  stopPolling();
  state.epoch += 1;
  state.session = null;
  state.pending.clear();
  state.hub = { open: false, failed: false, state: { panes: [], online: true, reason: null, dirty: false } };
  state.ws?.close();
  state.ws = null;
  localStorage.removeItem('herdr.pairing');
  resetSessionUi();
  setRoute('未连接');
}

els.pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  connect(els.code.value.trim()).catch((error) => showError(error.message));
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

const saved = new URLSearchParams(location.hash.slice(1)).get('code') || localStorage.getItem('herdr.pairing');
if (saved) {
  els.code.value = saved;
  connect(saved).catch((error) => showError(error.message));
}
