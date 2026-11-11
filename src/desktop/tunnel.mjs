// One tunnel to a phone. The same proxy logic serves both transports:
//
//   e2e   the frames are sealed inside an alma-relay-e2e/v1 session
//   plain the frames are the relay's protocol-1/2 JSON/binary frames
//
// HTTP requests (`hreq`/`hbody`/`hreqend`/`hcancel`), WebSocket tunnels
// (`wopen`/`wmsg`/`wclose`) and the `/__alma_lan__` candidates endpoint are
// handled here, mirroring Alma's `hb` tunnel class.

import { E2ESession } from '../../web/lib/e2e.js';
import { connectWebSocket } from '../protocol/ws.mjs';

const CHUNK = 32768;
const HACK_WINDOW = 262144;
const E2E_ONLY = 'This desktop only accepts end-to-end encrypted connections';

export function createTunnel({
  id,
  code = null,
  mode = 'e2e',
  localOrigin,
  lan = null,
  log = () => {},
  debug = false,
  fetchImpl = globalThis.fetch,
  drain = async () => {},
  sendFrame,
  sendHttpChunk = null,
  sendSocketMessage = null,
  sendHack = null,
  retired = false,
  webSocketConnect = connectWebSocket,
}) {
  const httpAborts = new Map();
  const streamedBodies = new Map();
  const localSockets = new Map();
  // Frames that arrived while a local socket was still connecting.
  const pendingSocketMessages = new Map();
  let destroyed = false;

  function sendHackFrame(requestId, bytes) {
    if (sendHack) sendHack(requestId, bytes);
    else send({ t: 'hack', id: requestId, n: bytes });
  }

  function sendChunk(requestId, bytes) {
    if (sendHttpChunk) sendHttpChunk(requestId, bytes);
    else send({ t: 'hchunk', id: requestId, b: bytes });
  }

  function sendSocket(requestId, payload) {
    if (sendSocketMessage) sendSocketMessage(requestId, payload);
    else if (typeof payload === 'string') send({ t: 'wmsg', id: requestId, s: payload });
    else send({ t: 'wmsg', id: requestId, b: payload });
  }

  function send(frame) {
    if (destroyed) return;
    sendFrame(frame);
  }

  function openStreamedBody(requestId) {
    const entry = { queue: [], ended: false, failed: null, wake: null, unacked: 0 };
    streamedBodies.set(requestId, entry);
    const ack = () => {
      if (entry.unacked > 0 && streamedBodies.get(requestId) === entry) sendHackFrame(requestId, entry.unacked);
      entry.unacked = 0;
    };
    return new ReadableStream(
      {
        pull: async (controller) => {
          if (debug) log(`[tunnel] body pull q=${entry.queue.length} ended=${entry.ended} failed=${!!entry.failed}`);
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
          if (debug) log(`[tunnel] body after wait q=${entry.queue.length} ended=${entry.ended}`);
          const chunk = entry.queue.shift();
          if (chunk) {
            controller.enqueue(chunk);
            entry.unacked += chunk.byteLength;
            if (entry.unacked >= HACK_WINDOW || !entry.queue.length) ack();
            return;
          }
          if (debug) log('[tunnel] body close');
          controller.close();
        },
        cancel: () => {
          entry.failed = new Error('Request body cancelled');
          entry.queue.length = 0;
        },
      },
      { highWaterMark: 0 },
    );
  }

  async function proxyHttp(request) {
    const requestId = String(request.id);
    if (debug) log(`[tunnel] proxyHttp ${request.method} ${request.path} stream=${request.stream === true}`);
    const controller = new AbortController();
    httpAborts.set(requestId, controller);
    const method = String(request.method || 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const streamedBody = request.stream && hasBody ? openStreamedBody(requestId) : null;
    try {
      // Host services: the LAN candidates endpoint is answered here, like Alma.
      if (method === 'GET' && String(request.path || '').split('?')[0] === '/__alma_lan__') {
        const body = Buffer.from(JSON.stringify(lan?.() ?? null));
        send({
          t: 'hres',
          id: requestId,
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        });
        if (body.length) sendChunk(requestId, new Uint8Array(body));
        send({ t: 'hend', id: requestId });
        return;
      }

      const headers = {};
      for (const [key, value] of Object.entries(request.headers || {})) {
        const lower = key.toLowerCase();
        if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
        if (typeof value === 'string') headers[lower] = value;
      }
      headers['accept-encoding'] = 'identity';
      const body = hasBody ? streamedBody ?? (request.b instanceof Uint8Array ? Buffer.from(request.b) : undefined) : undefined;
      if (hasBody && !streamedBody) headers['content-length'] = String(body?.length ?? 0);
      if (debug) log(`[tunnel] fetch ${method} ${localOrigin}${request.path} body=${body ? 'stream' : 'none'}`);
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
      if (debug) log(`[tunnel] fetch response ${response.status}`);
      send({ t: 'hres', id: requestId, status: response.status, headers: responseHeaders });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!httpAborts.has(requestId) || destroyed) return;
          for (let offset = 0; offset < value.length; offset += CHUNK) {
            await drain();
            if (!httpAborts.has(requestId) || destroyed) return;
            sendChunk(requestId, value.subarray(offset, offset + CHUNK));
          }
        }
      }
      send({ t: 'hend', id: requestId });
    } catch (error) {
      if (debug) log(`[tunnel] proxyHttp error: ${error?.message ?? error}`);
      if (!controller.signal.aborted && !destroyed) {
        send({ t: 'herr', id: requestId, message: error?.message ?? String(error) });
      }
    } finally {
      httpAborts.delete(requestId);
      const entry = streamedBodies.get(requestId);
      if (entry) {
        streamedBodies.delete(requestId);
        failStreamedBody(entry, 'Request finished');
      }
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
          else if (frame.b) socket.send(Buffer.from(frame.b));
        }
        socket.on('message', (data, isBinary) => {
          sendSocket(requestId, isBinary ? Buffer.from(data) : String(data));
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

  function failStreamedBody(entry, reason) {
    if (entry.ended || entry.failed) return;
    entry.failed = new Error(reason);
    entry.wake?.();
  }

  function onInnerFrame(frame) {
    if (destroyed) return;
    const requestId = String(frame.id ?? '');
    if (debug) log(`[tunnel] <- ${frame.t} ${requestId}`);
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
        if (debug) log('[tunnel] hreqend');
        entry.ended = true;
        entry.wake?.();
        return;
      }
      case 'hcancel': {
        const entry = streamedBodies.get(requestId);
        if (entry) {
          streamedBodies.delete(requestId);
          failStreamedBody(entry, 'Request cancelled by the phone');
        }
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
    for (const entry of streamedBodies.values()) failStreamedBody(entry, 'Tunnel closed');
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

  return { id, mode, onInnerFrame, destroy };
}

/** An E2E responder tunnel: the phone speaks the sealed alma-relay-e2e/v1 session. */
export function createE2ETunnel({
  id,
  code,
  localOrigin,
  lan = null,
  log = () => {},
  debug = false,
  fetchImpl,
  drain,
  retired = false,
  sendRaw,
  webSocketConnect,
}) {
  let tunnel;
  const session = new E2ESession({
    role: 'responder',
    code,
    send: sendRaw,
    binaryFrames: true,
    streamedBodies: true,
    retired,
    onFrame: (frame) => tunnel?.onInnerFrame(frame),
    onError: (reason) => {
      log(`e2e tunnel error: ${reason}`);
      tunnel?.destroy(reason);
    },
  });
  tunnel = createTunnel({
    id,
    code,
    mode: 'e2e',
    localOrigin,
    lan,
    log,
    debug,
    fetchImpl,
    drain,
    retired,
    webSocketConnect,
    sendFrame: (frame) => session.sendFrame(frame),
    sendHttpChunk: (requestId, bytes) => session.sendFrame({ t: 'hchunk', id: requestId, b: bytes }),
    sendSocketMessage: (requestId, payload) =>
      session.sendFrame(
        typeof payload === 'string' ? { t: 'wmsg', id: requestId, s: payload } : { t: 'wmsg', id: requestId, b: payload },
      ),
    sendHack: (requestId, n) => session.sendFrame({ t: 'hack', id: requestId, n }),
  });
  return {
    id,
    session,
    onMessage: (data) => session.onMessage(data),
    destroy: (reason) => tunnel.destroy(reason),
  };
}

export { E2E_ONLY };
