// Desktop agent: registers with the relay under a pairing code and answers only
// end-to-end encrypted tunnels. Plaintext HTTP/socket frames are refused, so
// the relay can never read pane contents or inject commands.

import { E2ESession } from '../../web/lib/e2e.js';
import { tokenHashForCode, routingIdForCode } from '../../web/lib/e2e.js';
import { connectWebSocket } from '../protocol/ws.mjs';
import { KIND_SOCKET_BINARY, KIND_SOCKET_TEXT, encodeRecord } from '../protocol/relay-frames.mjs';

const E2E_PATH = '/__alma_e2e__';
const E2E_ONLY = 'This desktop only accepts end-to-end encrypted connections';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function createConnector({
  relayUrl,
  code,
  localOrigin,
  name = 'Herdr Desktop',
  log = () => {},
  webSocketConnect = connectWebSocket,
  fetchImpl = globalThis.fetch,
} = {}) {
  const state = {
    status: 'stopped',
    lastError: null,
    connectedAt: null,
    tunnels: 0,
    replaced: false,
  };
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer = null;
  let stopped = true;
  let tokenHash = null;
  let routingId = null;
  const tunnels = new Map();
  const listeners = new Set();
  const debug = !!process.env.HERDR_RELAY_DEBUG;

  function notify() {
    for (const listener of listeners) {
      try {
        listener(getStatus());
      } catch {
        /* ignore */
      }
    }
  }

  function setStatus(patch) {
    Object.assign(state, patch);
    notify();
  }

  function getStatus() {
    return { ...state, tunnels: tunnels.size };
  }

  async function start() {
    stopped = false;
    tokenHash = await tokenHashForCode(code);
    routingId = await routingIdForCode(code);
    connect();
    return getStatus();
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    teardownTunnels();
    if (ws) {
      try {
        ws.close(1000, 'desktop stopping');
      } catch {
        /* ignore */
      }
      ws = null;
    }
    setStatus({ status: 'stopped', connectedAt: null });
  }

  function connect() {
    if (stopped) return;
    setStatus({ status: state.status === 'error' ? 'error' : 'connecting' });
    const base = relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const url = `${base}/agent?th=${tokenHash}`;
    let socket;
    connectWebSocket(url, { timeoutMs: 20000 }).then(
      (connection) => {
        if (stopped) {
          connection.close(1000, 'stopped');
          return;
        }
        socket = connection;
        ws = connection;
        connection.on('message', (data, isBinary) => {
          if (isBinary) {
            const record = decodeBinaryRecord(data);
            if (record) onAgentData(record);
            return;
          }
          let message;
          try {
            message = JSON.parse(String(data));
          } catch {
            return;
          }
          onRelayMessage(message);
        });
        connection.on('close', (closeCode, error) => {
          if (ws === connection) ws = null;
          teardownTunnels();
          if (closeCode === 4000) {
            state.replaced = true;
            setStatus({ status: 'replaced', lastError: "This computer's pairing was taken over by another desktop", connectedAt: null });
            return;
          }
          if (stopped) return;
          setStatus({ status: 'error', lastError: error?.message || `relay closed (${closeCode})`, connectedAt: null });
          scheduleReconnect();
        });
        connection.on('error', () => {});
        // Alma's desktop app registers with exactly these fields; the relay
        // recovers the routing id by hashing it, so the code never leaves here.
        connection.send(JSON.stringify({ t: 'register', tokenHash, name, proto: 2 }));
      },
      (error) => {
        if (stopped) return;
        setStatus({ status: 'error', lastError: error?.message ?? String(error) });
        scheduleReconnect();
      },
    );
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function onRelayMessage(message) {
    switch (message.t) {
      case 'registered': {
        reconnectDelay = RECONNECT_BASE_MS;
        setStatus({ status: 'connected', connectedAt: Date.now(), lastError: null });
        log('registered with relay');
        return;
      }
      case 'error': {
        if (message.message === 'replaced') {
          state.replaced = true;
          setStatus({ status: 'replaced', lastError: 'Another desktop took over this pairing' });
          return;
        }
        setStatus({ status: 'error', lastError: String(message.message || 'relay error') });
        return;
      }
      case 'wopen': {
        const id = String(message.id);
        const path = String(message.path || '/');
        if (path !== E2E_PATH) {
          ws?.send(JSON.stringify({ t: 'werr', id, message: E2E_ONLY }));
          return;
        }
        openTunnel(id);
        return;
      }
      case 'wmsg': {
        const tunnel = tunnels.get(String(message.id));
        if (!tunnel) {
          if (debug) console.error('[connector] wmsg for unknown tunnel', message.id);
          return;
        }
        if (debug) console.error('[connector] <- wmsg', message.id, String(message.s).slice(0, 60));
        if (typeof message.s === 'string') tunnel.session.onMessage(message.s);
        return;
      }
      case 'wclose': {
        const id = String(message.id);
        tunnels.get(id)?.destroy('closed by phone');
        tunnels.delete(id);
        return;
      }
      default:
        return;
    }
  }

  function onAgentData(record) {
    const tunnel = tunnels.get(record.id);
    if (!tunnel) return;
    if (record.kind === KIND_SOCKET_TEXT) tunnel.session.onMessage(record.data.toString('utf8'));
    else if (record.kind === KIND_SOCKET_BINARY) tunnel.session.onMessage(new Uint8Array(record.data));
  }

  function openTunnel(id) {
    const tunnel = createTunnel({ id });
    tunnels.set(id, tunnel);
    ws?.send(JSON.stringify({ t: 'wopened', id }));
    log('opened encrypted tunnel');
  }

  function sendSocketMessage(id, payload) {
    if (debug) console.error('[connector] ->', id, typeof payload === 'string' ? payload.slice(0, 60) : `bin(${payload.length})`);
    if (!ws || ws.readyState !== 'open') return;
    if (typeof payload === 'string') ws.send(JSON.stringify({ t: 'wmsg', id, s: payload }));
    else ws.send(encodeRecord(KIND_SOCKET_BINARY, id, Buffer.from(payload)));
  }

  function teardownTunnels() {
    for (const tunnel of tunnels.values()) tunnel.destroy('relay connection lost');
    tunnels.clear();
  }

  function createTunnel({ id }) {
    const httpAborts = new Map();
    const streamedBodies = new Map();
    const localSockets = new Map();
    // Frames that arrived while a local socket was still connecting.
    const pendingSocketMessages = new Map();
    let destroyed = false;

    const session = new E2ESession({
      role: 'responder',
      code,
      send: (payload) => sendSocketMessage(id, payload),
      onFrame: (frame) => onInnerFrame(frame),
      onError: (reason) => {
        log('e2e error', reason);
        destroy(reason);
      },
    });

    function send(frame) {
      if (destroyed) return;
      session.sendFrame(frame).catch((error) => log('tunnel send failed', error?.message));
    }

    function openStreamedBody(requestId) {
      const entry = { queue: [], ended: false, failed: null, wake: null };
      streamedBodies.set(requestId, entry);
      return new ReadableStream(
        {
          pull: async (controller) => {
            while (!entry.queue.length && !entry.ended && !entry.failed) {
              await new Promise((resolveWake) => {
                entry.wake = resolveWake;
              });
              entry.wake = null;
            }
            if (entry.failed) {
              controller.error(entry.failed);
              return;
            }
            const chunk = entry.queue.shift();
            if (chunk) {
              controller.enqueue(new Uint8Array(chunk));
              return;
            }
            controller.close();
          },
          cancel: () => {
            entry.failed = new Error('request body cancelled');
            entry.queue.length = 0;
          },
        },
        { highWaterMark: 0 },
      );
    }

    async function proxyHttp(request) {
      const requestId = String(request.id);
      const controller = new AbortController();
      httpAborts.set(requestId, controller);
      const method = String(request.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const streamedBody = request.stream && hasBody ? openStreamedBody(requestId) : null;
      try {
        const headers = {};
        for (const [key, value] of Object.entries(request.headers || {})) {
          const lower = key.toLowerCase();
          if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
          if (typeof value === 'string') headers[lower] = value;
        }
        headers['accept-encoding'] = 'identity';
        const body = hasBody ? streamedBody ?? (request.b ? Buffer.from(request.b) : undefined) : undefined;
        if (hasBody) headers['content-length'] = String(body?.length ?? 0);
        const response = await fetchImpl(`${localOrigin}${request.path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
          ...(streamedBody ? { duplex: 'half' } : {}),
        });
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (['connection', 'keep-alive', 'transfer-encoding'].includes(lower)) return;
          responseHeaders[lower] = value;
        });
        send({ t: 'hres', id: requestId, status: response.status, headers: responseHeaders });
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!httpAborts.has(requestId)) return;
            for (let offset = 0; offset < value.length; offset += 32768) {
              send({ t: 'hchunk', id: requestId, b: value.subarray(offset, offset + 32768) });
            }
          }
        }
        send({ t: 'hend', id: requestId });
      } catch (error) {
        if (!controller.signal.aborted) send({ t: 'herr', id: requestId, message: error?.message ?? String(error) });
      } finally {
        httpAborts.delete(requestId);
        streamedBodies.delete(requestId);
      }
    }

    function proxySocketOpen(requestId, path) {
      const target = `${localOrigin.replace(/^http/, 'ws')}${path}`;
      const queued = [];
      pendingSocketMessages.set(requestId, queued);
      webSocketConnect(target, { timeoutMs: 10000 }).then(
        (socket) => {
          if (destroyed) {
            socket.close(1000, 'tunnel closed');
            return;
          }
          localSockets.set(requestId, socket);
          pendingSocketMessages.delete(requestId);
          send({ t: 'wopened', id: requestId });
          for (const frame of queued.splice(0)) {
            if (typeof frame.s === 'string') socket.send(frame.s);
            else if (frame.b instanceof Uint8Array) socket.send(Buffer.from(frame.b));
          }
          socket.on('message', (data, isBinary) => {
            if (isBinary) send({ t: 'wmsg', id: requestId, b: Buffer.from(data) });
            else send({ t: 'wmsg', id: requestId, s: String(data) });
          });
          socket.on('close', (closeCode, error) => {
            if (!localSockets.has(requestId)) return;
            localSockets.delete(requestId);
            send({ t: 'wclose', id: requestId, code: closeCode || 1000, reason: error?.message || '' });
          });
          socket.on('error', () => {});
        },
        (error) => {
          pendingSocketMessages.delete(requestId);
          send({ t: 'werr', id: requestId, message: error?.message ?? String(error) });
        },
      );
    }

    function onInnerFrame(frame) {
      if (destroyed) return;
      const requestId = String(frame.id ?? '');
      switch (frame.t) {
        case 'hreq':
          proxyHttp(frame);
          return;
        case 'hbody': {
          const entry = streamedBodies.get(requestId);
          if (!entry || entry.ended || entry.failed || !(frame.b instanceof Uint8Array)) return;
          entry.queue.push(frame.b);
          entry.wake?.();
          return;
        }
        case 'hreqend': {
          const entry = streamedBodies.get(requestId);
          if (!entry) return;
          entry.ended = true;
          entry.wake?.();
          return;
        }
        case 'hcancel': {
          streamedBodies.delete(requestId);
          const controller = httpAborts.get(requestId);
          if (controller) {
            httpAborts.delete(requestId);
            controller.abort();
          }
          return;
        }
        case 'wopen':
          proxySocketOpen(requestId, String(frame.path || '/'));
          return;
        case 'wmsg': {
          const socket = localSockets.get(requestId);
          if (!socket || socket.readyState !== 'open') {
            pendingSocketMessages.get(requestId)?.push(frame);
            return;
          }
          if (typeof frame.s === 'string') socket.send(frame.s);
          else if (frame.b instanceof Uint8Array) socket.send(Buffer.from(frame.b));
          return;
        }
        case 'wclose': {
          pendingSocketMessages.delete(requestId);
          const socket = localSockets.get(requestId);
          if (!socket) return;
          localSockets.delete(requestId);
          try {
            socket.close(1000, 'phone closed');
          } catch {
            /* ignore */
          }
          return;
        }
        default:
          return;
      }
    }

    function destroy(reason) {
      if (destroyed) return;
      destroyed = true;
      for (const controller of httpAborts.values()) controller.abort();
      httpAborts.clear();
      streamedBodies.clear();
      pendingSocketMessages.clear();
      for (const socket of localSockets.values()) {
        try {
          socket.close(1000, reason ?? 'tunnel closed');
        } catch {
          /* ignore */
        }
      }
      localSockets.clear();
    }

    return { id, session, destroy };
  }

  return { start, stop, getStatus, onStatus: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
}

function decodeBinaryRecord(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 2) return null;
  const idLength = bytes[1];
  if (bytes.length < 2 + idLength) return null;
  return { kind: bytes[0], id: bytes.toString('utf8', 2, 2 + idLength), data: bytes.subarray(2 + idLength) };
}
