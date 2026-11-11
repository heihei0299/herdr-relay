// Desktop agent: registers with an alma-relay-compatible relay under a pairing
// code and answers the relay's phone traffic.
//
// Two modes, both from the official protocol:
//   e2e=true   the desktop serves only the `/__alma_e2e__` WebSocket and the
//              phone does the alma-relay-e2e/v1 handshake inside it.
//   e2e=false  the relay proxies plain HTTP/WebSocket frames (protocol 1/2).
//
// The agent protocol itself is the reference one: `hreq`/`hres`/`hchunk`/
// `hend`/`herr`, `wopen`/`wopened`/`wmsg`/`wclose`, streamed request bodies
// (HBODY + `hack`), binary frames (protocol 2), heartbeat and registration
// timeout, replacement close code 4000, and LAN-direct candidates.

import { createHash } from 'node:crypto';
import { routingIdForCode, tokenHashForCode } from '../../web/lib/e2e.js';
import { connectWebSocket } from '../protocol/ws.mjs';
import {
  KIND_HBODY,
  KIND_HCHUNK,
  KIND_WBIN,
  KIND_WTEXT,
  encodeRecord,
} from '../protocol/relay-frames.mjs';
import { createE2ETunnel, createTunnel, E2E_ONLY } from './tunnel.mjs';
import { createLanDirect } from './lan.mjs';

const E2E_PATH = '/__alma_e2e__';
const E2E_DISABLED = 'E2E not enabled on this desktop';
const UNKNOWN_TUNNEL = 4404;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REGISTER_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 15000;
const WATCHDOG_MS = 15000;
const WATCHDOG_DIAL_MS = 65000;
const DRAIN_LIMIT = 262144;

export function createConnector({
  relayUrl,
  code,
  localOrigin,
  name = 'Herdr Desktop',
  relayToken = null,
  e2e = true,
  lan = true,
  log = () => {},
  webSocketConnect = connectWebSocket,
  fetchImpl = globalThis.fetch,
} = {}) {
  const state = {
    status: 'stopped',
    lastError: null,
    connectedAt: null,
    proto: 1,
    replaced: false,
    e2e: e2e !== false,
  };
  let ws = null;
  let tokenHash = null;
  let routingId = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer = null;
  let registerTimer = null;
  let registerTimedOut = false;
  let heartbeatTimer = null;
  let watchdogTimer = null;
  let dialStartedAt = null;
  let stopped = true;
  let plainTunnel = null;
  let lanDirect = null;
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
    return {
      ...state,
      tunnels: tunnels.size,
      lanPort: lanDirect?.port ?? null,
      lanFirewall: lanDirect?.firewall ?? null,
      routingId,
    };
  }

  async function start() {
    stopped = false;
    if (state.e2e) {
      routingId = await routingIdForCode(code);
      tokenHash = await tokenHashForCode(code);
    } else {
      routingId = code;
      tokenHash = sha256hex(code);
    }
    if (state.e2e && lan) {
      try {
        lanDirect = createLanDirect({ code, localOrigin, fetchImpl, log });
        await lanDirect.start();
        log(`LAN direct listening on tcp/${lanDirect.port}`);
      } catch (error) {
        lanDirect = null;
        log(`LAN direct unavailable: ${error?.message ?? String(error)}`);
      }
    }
    startWatchdog();
    connect();
    return getStatus();
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(registerTimer);
    registerTimer = null;
    stopHeartbeat();
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
    dialStartedAt = null;
    teardownTunnels();
    if (ws) {
      try {
        ws.close(1000, 'desktop stopping');
      } catch {
        /* ignore */
      }
      ws = null;
    }
    lanDirect?.stop();
    lanDirect = null;
    setStatus({ status: 'stopped', connectedAt: null });
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (stopped || state.status === 'connected' || state.status === 'replaced' || dialStartedAt === null) return;
      if (Date.now() - dialStartedAt < WATCHDOG_DIAL_MS) return;
      log(`still not registered after ${Math.round((Date.now() - dialStartedAt) / 1000)} s; dialing again`);
      reconnect();
    }, WATCHDOG_MS);
    watchdogTimer.unref?.();
  }

  function reconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelay = RECONNECT_BASE_MS;
    stopped = false;
    startWatchdog();
    stopHeartbeat();
    if (ws) {
      const previous = ws;
      ws = null;
      try {
        previous.close(1000, 'Reconnecting');
      } catch {
        /* ignore */
      }
    }
    teardownTunnels();
    state.connectedAt = null;
    dialStartedAt = null;
    connect();
  }

  function connect() {
    if (stopped) return;
    dialStartedAt = Date.now();
    if (state.status !== 'error') setStatus({ status: 'connecting' });
    const base = String(relayUrl).replace(/\/+$/, '').replace(/^http/, 'ws');
    const url = `${base}/agent?th=${tokenHash}`;
    let connection;
    webSocketConnect(url, { timeoutMs: 20000 }).then(
      (opened) => {
        if (stopped) {
          opened.close(1000, 'stopped');
          return;
        }
        connection = opened;
        ws = opened;
        if (!state.e2e) plainTunnel = createPlainTunnel();
        opened.on('message', (data, isBinary) => onMessage(data, isBinary));
        opened.on('close', (closeCode, error) => onClose(opened, closeCode, error));
        opened.on('error', (error) => {
          state.lastError = error?.message ?? String(error);
        });
        startHeartbeat(opened);
        registerTimedOut = false;
        clearTimeout(registerTimer);
        registerTimer = setTimeout(() => {
          if (ws === opened && state.status !== 'connected') {
            registerTimedOut = true;
            log('the relay did not answer register within 20 s');
            opened.terminate();
          }
        }, REGISTER_TIMEOUT_MS);
        registerTimer.unref?.();
        // The reference agent frame: token hash, name, optional registration
        // key/relay token, newest protocol. The code never leaves this side.
        opened.send(JSON.stringify({ t: 'register', tokenHash, name, ...(relayToken ? { key: relayToken } : {}), proto: 2 }));
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
    reconnectTimer.unref?.();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function startHeartbeat(connection) {
    stopHeartbeat();
    let armed = false;
    connection.on('pong', () => {
      armed = false;
    });
    heartbeatTimer = setInterval(() => {
      if (ws !== connection || connection.readyState !== 'open') return;
      if (armed) {
        log('the relay stopped answering pings; reconnecting');
        connection.terminate();
        return;
      }
      armed = true;
      try {
        connection.ping();
      } catch (error) {
        state.lastError = error?.message ?? String(error);
      }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearRegisterTimer() {
    clearTimeout(registerTimer);
    registerTimer = null;
  }

  function onClose(connection, closeCode, error) {
    if (ws === connection) ws = null;
    clearRegisterTimer();
    stopHeartbeat();
    teardownTunnels();
    if (stopped) {
      setStatus({ status: 'stopped', connectedAt: null });
      return;
    }
    if (closeCode === 4000) {
      state.replaced = true;
      setStatus({
        status: 'replaced',
        lastError: "This computer's pairing was taken over by another desktop",
        connectedAt: null,
      });
      return;
    }
    const message = registerTimedOut
      ? "The relay did not answer within 20 s; check this computer's network or proxy"
      : closeCode === 1000
        ? null
        : `Relay connection closed (${closeCode}${error?.message ? `: ${error.message}` : ''})`;
    setStatus({ status: message ? 'error' : 'connecting', lastError: message, connectedAt: null });
    scheduleReconnect();
  }

  function onMessage(data, isBinary) {
    if (isBinary) {
      onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    onFrame(frame);
  }

  function onFrame(frame) {
    if (debug) log(`[connector] <- ${frame.t} ${frame.id ?? ''}`);
    switch (frame.t) {
      case 'registered': {
        state.proto = Number(frame.proto) >= 2 ? 2 : 1;
        clearRegisterTimer();
        dialStartedAt = null;
        reconnectDelay = RECONNECT_BASE_MS;
        setStatus({ status: 'connected', connectedAt: Date.now(), lastError: null });
        log(`registered with relay (protocol ${state.proto})`);
        return;
      }
      case 'error': {
        clearRegisterTimer();
        state.lastError = String(frame.message || 'Relay error');
        setStatus({ status: 'error' });
        log(`relay rejected the desktop: ${state.lastError}`);
        return;
      }
      case 'pushed': {
        if (frame.unsupported) log('relay has no push key configured');
        else if (Array.isArray(frame.results)) log(`push results: ${frame.results.length}`);
        return;
      }
      case 'hreq': {
        if (state.e2e) rejectPlainHttp(frame);
        else plainTunnel?.onInnerFrame(frame);
        return;
      }
      case 'hreqend':
      case 'hcancel': {
        if (!state.e2e) plainTunnel?.onInnerFrame(frame);
        return;
      }
      case 'wopen': {
        onWopen(frame);
        return;
      }
      case 'wmsg': {
        if (state.e2e) {
          const id = String(frame.id);
          const tunnel = tunnels.get(id);
          if (!tunnel) {
            sendJson({ t: 'wclose', id, code: UNKNOWN_TUNNEL, reason: 'Unknown tunnel; reconnect' });
            return;
          }
          if (typeof frame.s === 'string') tunnel.session.onMessage(frame.s);
          else if (typeof frame.b === 'string') tunnel.session.onMessage(new Uint8Array(Buffer.from(frame.b, 'base64')));
        } else {
          if (!plainTunnel) {
            sendJson({ t: 'wclose', id: String(frame.id), code: UNKNOWN_TUNNEL, reason: 'Unknown tunnel; reconnect' });
            return;
          }
          plainTunnel.onInnerFrame(frame);
        }
        return;
      }
      case 'wclose': {
        if (state.e2e) {
          const id = String(frame.id);
          tunnels.get(id)?.destroy('closed by phone');
          tunnels.delete(id);
        } else {
          plainTunnel?.onInnerFrame(frame);
        }
        return;
      }
      default:
        return;
    }
  }

  function onBinary(buffer) {
    if (buffer.length < 2) return;
    const idLength = buffer[1];
    if (buffer.length < 2 + idLength) return;
    const kind = buffer[0];
    const id = buffer.toString('utf8', 2, 2 + idLength);
    const data = buffer.subarray(2 + idLength);
    if (state.e2e) {
      const tunnel = tunnels.get(id);
      if (!tunnel) {
        if (kind === KIND_WBIN || kind === KIND_WTEXT) {
          sendJson({ t: 'wclose', id, code: UNKNOWN_TUNNEL, reason: 'Unknown tunnel; reconnect' });
        }
        return;
      }
      if (kind === KIND_WBIN) tunnel.session.onMessage(new Uint8Array(data));
      else if (kind === KIND_WTEXT) tunnel.session.onMessage(data.toString('utf8'));
      return;
    }
    if (debug) log(`[connector] <- bin kind=${kind} id=${id} len=${data.length}`);
    if (kind === KIND_HBODY) plainTunnel?.onInnerFrame({ t: 'hbody', id, b: new Uint8Array(data) });
    else if (kind === KIND_WBIN) plainTunnel?.onInnerFrame({ t: 'wmsg', id, b: new Uint8Array(data) });
    else if (kind === KIND_WTEXT) plainTunnel?.onInnerFrame({ t: 'wmsg', id, s: data.toString('utf8') });
  }

  function onWopen(frame) {
    const id = String(frame.id);
    const path = String(frame.path || '/');
    // Alma's order: the E2E path is special-cased first, then a desktop with
    // E2E on refuses every other socket, then a plain desktop dials it.
    const isE2E = path === E2E_PATH || path.startsWith(`${E2E_PATH}?`);
    if (isE2E) {
      if (!state.e2e) {
        sendJson({ t: 'werr', id, message: E2E_DISABLED });
        return;
      }
    } else if (state.e2e) {
      sendJson({ t: 'werr', id, message: E2E_ONLY });
      return;
    } else {
      plainTunnel?.onInnerFrame({ t: 'wopen', id, path });
      return;
    }
    const tunnel = createE2ETunnel({
      id,
      code,
      localOrigin,
      lan: () => lanDirect?.candidates() ?? null,
      log,
      debug,
      fetchImpl,
      drain: () => waitForDrain(DRAIN_LIMIT),
      sendRaw: (payload) => sendTunnelRaw(id, payload),
      webSocketConnect,
    });
    tunnels.set(id, tunnel);
    sendJson({ t: 'wopened', id });
    log('opened encrypted tunnel');
  }

  function rejectPlainHttp(frame) {
    const id = String(frame.id);
    sendJson({
      t: 'hres',
      id,
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    sendChunk(id, Buffer.from(E2E_ONLY));
    sendJson({ t: 'hend', id });
  }

  function sendJson(frame) {
    if (!ws || ws.readyState !== 'open') return;
    ws.send(JSON.stringify(frame));
  }

  function sendBinary(kind, id, payload) {
    if (!ws || ws.readyState !== 'open') return;
    ws.send(encodeRecord(kind, id, Buffer.from(payload)), { binary: true });
  }

  function sendChunk(id, bytes) {
    if (state.proto >= 2) sendBinary(KIND_HCHUNK, id, bytes);
    else sendJson({ t: 'hchunk', id, b: Buffer.from(bytes).toString('base64') });
  }

  function sendSocketText(id, text) {
    if (state.proto >= 2) sendBinary(KIND_WTEXT, id, text);
    else sendJson({ t: 'wmsg', id, s: text });
  }

  function sendSocketBinary(id, bytes) {
    if (state.proto >= 2) sendBinary(KIND_WBIN, id, bytes);
    else sendJson({ t: 'wmsg', id, b: Buffer.from(bytes).toString('base64') });
  }

  function sendTunnelRaw(id, payload) {
    if (debug) log('tunnel ->', id, typeof payload === 'string' ? payload.slice(0, 60) : `bin(${payload.length})`);
    if (typeof payload === 'string') sendSocketText(id, payload);
    else sendSocketBinary(id, payload);
  }

  async function waitForDrain(limit = DRAIN_LIMIT) {
    while (ws && ws.readyState === 'open' && ws.bufferedAmount > limit) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  function createPlainTunnel() {
    if (debug) log('[connector] creating plain tunnel');
    return createTunnel({
      id: 'plain',
      mode: 'plain',
      localOrigin,
      lan: () => lanDirect?.candidates() ?? null,
      log,
      debug,
      fetchImpl,
      webSocketConnect,
      drain: () => waitForDrain(DRAIN_LIMIT),
      sendFrame: sendJson,
      sendHttpChunk: sendChunk,
      sendSocketMessage: (id, payload) =>
        typeof payload === 'string' ? sendSocketText(id, payload) : sendSocketBinary(id, payload),
      sendHack: (id, n) => sendJson({ t: 'hack', id, n }),
    });
  }

  function teardownTunnels() {
    for (const tunnel of tunnels.values()) tunnel.destroy('relay connection lost');
    tunnels.clear();
    plainTunnel?.destroy('relay connection lost');
    plainTunnel = null;
  }

  return {
    start,
    stop,
    getStatus,
    onStatus: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    lanCandidates: () => lanDirect?.candidates() ?? null,
  };
}

export { E2E_DISABLED, E2E_ONLY, E2E_PATH, UNKNOWN_TUNNEL };

function sha256hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
