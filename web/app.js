// Phone client: pairing code -> relay -> end-to-end encrypted tunnel -> Herdr.
// Everything below the E2E session is plain HTTP/JSON; the relay only ever
// forwards sealed records.

import { E2ESession, isValidPairingCode, routingIdForCode } from './lib/e2e.js';

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
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
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
      setRoute('已加密连接');
      localStorage.setItem('herdr.pairing', state.code);
      refresh();
      startPolling();
    },
  });
  state.session.start();
}

function onTunnelFrame(frame) {
  const id = String(frame.id ?? '');
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
  const response = await request('POST', '/api/rpc', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const text = new TextDecoder().decode(response.body);
  if (response.status >= 400) throw new Error(text || `HTTP ${response.status}`);
  const parsed = JSON.parse(text);
  return parsed.result ?? parsed;
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (state.currentPane) readPane().catch(() => {});
  }, 1500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refresh() {
  try {
    const snapshot = await rpc('session.snapshot', {});
    const panes = snapshot?.snapshot?.panes ?? snapshot?.panes ?? [];
    state.panes = panes;
    renderPanes();
    if (!state.currentPane && panes.length) selectPane(panes[0].id ?? panes[0].pane_id);
  } catch (error) {
    els.output.textContent = `读取 herdr 失败：${error.message}`;
  }
}

function renderPanes() {
  els.panes.textContent = '';
  for (const pane of state.panes) {
    const id = pane.id ?? pane.pane_id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane';
    button.textContent = pane.terminal_title || pane.name || id;
    button.setAttribute('aria-pressed', String(state.currentPane === id));
    button.addEventListener('click', () => selectPane(id));
    els.panes.append(button);
  }
}

async function selectPane(id) {
  state.currentPane = id;
  renderPanes();
  const pane = state.panes.find((candidate) => (candidate.id ?? candidate.pane_id) === id);
  els.paneTitle.textContent = pane?.terminal_title || id || '';
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
  const text = result?.read?.text ?? result?.text ?? result?.pane?.text ?? '';
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
  state.session = null;
  state.pending.clear();
  state.ws?.close();
  state.ws = null;
  localStorage.removeItem('herdr.pairing');
  els.session.hidden = true;
  els.pair.hidden = false;
  els.disconnect.hidden = true;
  setRoute('未连接');
}

els.pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  connect(els.code.value.trim()).catch((error) => showError(error.message));
});
els.refresh.addEventListener('click', () => refresh().catch((error) => showError(error.message)));
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
