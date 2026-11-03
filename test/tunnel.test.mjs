// End-to-end: phone browser role -> relay -> desktop connector -> herdr bridge.
// Proves the tunnel works and that the relay only ever forwards sealed records.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2ESession, createPairingCode, routingIdForCode } from '../web/lib/e2e.js';
import { createRelay } from '../src/relay/server.mjs';
import { createBridge } from '../src/desktop/herdr-bridge.mjs';
import { createConnector } from '../src/desktop/connector.mjs';
import { connectWebSocket } from '../src/protocol/ws.mjs';

const PANE_SECRET = 'TOP-SECRET-PANE-CONTENT';

test('phone reaches herdr through the relay with end-to-end encryption', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-relay-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const herdr = await startFakeHerdr(socketPath);
  const bridge = createBridge({ socketPath });
  const bridgeAddress = await bridge.listen(0, '127.0.0.1');
  const relay = createRelay({ log: () => {} });
  const relayAddress = await relay.listen(0, '127.0.0.1');

  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const connector = createConnector({
    relayUrl: `http://127.0.0.1:${relayAddress.port}`,
    code,
    localOrigin: `http://127.0.0.1:${bridgeAddress.port}`,
    log: () => {},
  });
  await connector.start();

  t.after(async () => {
    connector.stop();
    await relay.close();
    await bridge.close();
    await herdr.close();
    await rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => relay.agents.size === 1, 5000, 'desktop registered with the relay');
  const agentWs = relay.agents.values().next().value.ws;
  const toDesktop = captureSends(agentWs);

  const phone = await openPhone(relayAddress.port, routingId);
  const toPhone = captureSends(phone.relaySocket);

  const session = new E2ESession({
    role: 'initiator',
    code,
    send: (payload) => phone.relaySocket.send(payload),
    onFrame: (frame) => phone.dispatch(frame),
    onError: (reason) => phone.fail(reason),
  });
  phone.attach(session);
  await session.start();
  await waitFor(() => session.isReady(), 5000, 'E2E handshake over the relay');

  // 1. HTTP through the tunnel.
  const snapshot = await phone.fetch(session, 'GET', '/api/snapshot');
  assert.equal(snapshot.status, 200);
  const payload = JSON.parse(new TextDecoder().decode(snapshot.body));
  assert.equal(payload.snapshot.panes[0].terminal_title, PANE_SECRET);

  // 2. JSON-RPC through the tunnel.
  const rpc = await phone.fetch(session, 'POST', '/api/rpc', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'pane.read', params: { pane_id: 'w1:p1', source: 'visible' } }),
  });
  assert.equal(rpc.status, 200);
  assert.match(new TextDecoder().decode(rpc.body), /pane-output-ok/);

  // 3. WebSocket through the tunnel (same E2E session, `/ws` bridge path).
  const socketId = 'w1';
  const lines = [];
  phone.on('frame', (frame) => {
    if (String(frame.id ?? '') !== socketId) return;
    if (frame.t === 'wmsg' && typeof frame.s === 'string') lines.push(frame.s.trim());
    if (frame.t === 'wclose') lines.push('closed');
    if (frame.t === 'werr') lines.push(`werr ${frame.message}`);
  });
  await session.sendFrame({ t: 'wopen', id: socketId, path: '/ws' });
  await session.sendFrame({ t: 'wmsg', id: socketId, s: `${JSON.stringify({ id: 'p1', method: 'ping', params: {} })}\n` });
  await waitFor(() => lines.some((line) => line.includes('pong')), 5000, 'bridge websocket replies through the tunnel');
  await session.sendFrame({ t: 'wclose', id: socketId });

  // 4. The relay never sees plaintext: everything it forwarded to the desktop
  //    and everything it forwarded back to the phone is an opaque E2E record.
  const desktopFrames = Buffer.concat(toDesktop.map((entry) => Buffer.from(entry)));
  const phoneFrames = Buffer.concat(toPhone.map((entry) => Buffer.from(entry)));
  assert.ok(!desktopFrames.includes(Buffer.from(PANE_SECRET)), 'relay->desktop frames carry no pane text');
  assert.ok(!phoneFrames.includes(Buffer.from(PANE_SECRET)), 'relay->phone frames carry no pane text');
  assert.ok(!desktopFrames.includes(Buffer.from('session.snapshot')), 'relay->desktop frames carry no method names');
  assert.ok(!phoneFrames.includes(Buffer.from('session.snapshot')), 'relay->phone frames carry no method names');

  // 5. The desktop refuses plaintext tunnels: a phone asking for a non-E2E path
  //    is rejected with the E2E-only error.
  const rawPhone = await connectWebSocket(`ws://127.0.0.1:${relayAddress.port}/c/${routingId}/api/snapshot`);
  const rejection = await nextText(rawPhone);
  assert.equal(JSON.parse(rejection).t, 'error');
  assert.match(JSON.parse(rejection).message, /end-to-end/i);
  rawPhone.terminate();
});

test('a second desktop takes over the pairing and the first is told so', async (t) => {
  const relay = createRelay({ log: () => {} });
  const relayAddress = await relay.listen(0, '127.0.0.1');
  const code = createPairingCode();
  const first = createConnector({ relayUrl: `http://127.0.0.1:${relayAddress.port}`, code, localOrigin: 'http://127.0.0.1:1', log: () => {} });
  const second = createConnector({ relayUrl: `http://127.0.0.1:${relayAddress.port}`, code, localOrigin: 'http://127.0.0.1:1', log: () => {} });
  t.after(async () => {
    first.stop();
    second.stop();
    await relay.close();
  });
  await first.start();
  await waitFor(() => first.getStatus().status === 'connected', 5000, 'first desktop connected');
  await second.start();
  await waitFor(() => first.getStatus().status === 'replaced', 5000, 'first desktop is told it was replaced');
  assert.equal(second.getStatus().status, 'connected');
});

// --- helpers ---------------------------------------------------------------

function captureSends(ws) {
  const captured = [];
  const original = ws.send.bind(ws);
  ws.send = (data) => {
    captured.push(data);
    return original(data);
  };
  return captured;
}

async function openPhone(relayPort, routingId) {
  const relaySocket = await connectWebSocket(`ws://127.0.0.1:${relayPort}/c/${routingId}/__alma_e2e__`);
  const handlers = new Set();
  const pending = new Map();
  let session = null;
  let failure = null;
  const control = [];
  const controlWaiters = [];

  relaySocket.on('message', (data, isBinary) => {
    if (session) {
      session.onMessage(isBinary ? new Uint8Array(data) : String(data));
      return;
    }
    const text = isBinary ? Buffer.from(data).toString('utf8') : String(data);
    control.push(text);
    for (const waiter of controlWaiters.splice(0)) waiter();
  });

  const nextControl = () =>
    new Promise((resolve) => {
      const check = () => {
        if (control.length) resolve(control.shift());
        else controlWaiters.push(check);
      };
      check();
    });

  const readyMessage = await Promise.race([nextControl(), new Promise((resolve) => setTimeout(() => resolve('{"t":"timeout"}'), 5000))]);
  assert.equal(JSON.parse(readyMessage).t, 'ready', 'relay opened the tunnel');

  return {
    relaySocket,
    attach: (e2e) => {
      session = e2e;
    },
    on: (_event, handler) => handlers.add(handler),
    dispatch: (frame) => {
      for (const handler of pending.values()) {
        if (handler(frame)) return;
      }
      for (const handler of handlers) handler(frame);
    },
    fail: (reason) => {
      failure = reason;
    },
    get failure() {
      return failure;
    },
    fetch: (e2e, method, path, options) => tunnelFetch(e2e, method, path, pending, options),
  };
}

function tunnelFetch(session, method, path, pending, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const id = `h${pending.size + 1}-${Date.now()}`;
    const chunks = [];
    let head = null;
    pending.set(id, (frame) => {
      if (String(frame.id ?? '') !== id) return false;
      if (frame.t === 'hres') head = frame;
      else if (frame.t === 'hchunk') chunks.push(Buffer.from(frame.b));
      else if (frame.t === 'hend') {
        pending.delete(id);
        resolve({ status: head?.status ?? 200, headers: head?.headers ?? {}, body: Buffer.concat(chunks) });
      } else if (frame.t === 'herr') {
        pending.delete(id);
        reject(new Error(String(frame.message)));
      } else {
        return false;
      }
      return true;
    });
    const payload = { t: 'hreq', id, method, path, headers };
    if (body) payload.b = new TextEncoder().encode(body);
    session.sendFrame(payload);
  });
}

function nextText(ws) {
  return new Promise((resolve) => {
    ws.on('message', (data, isBinary) => resolve(isBinary ? Buffer.from(data).toString('utf8') : String(data)));
  });
}

async function startFakeHerdr(socketPath) {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        const reply = (result) => socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        switch (request.method) {
          case 'ping':
            reply({ type: 'pong', version: '0.9.5', protocol: 22 });
            break;
          case 'session.snapshot':
            reply({
              snapshot: {
                version: 'herdr-core',
                panes: [{ id: 'w1:p1', terminal_title: PANE_SECRET, workspace_id: 'w1' }],
              },
            });
            break;
          case 'pane.read':
            reply({ text: 'pane-output-ok' });
            break;
          default:
            socket.write(`${JSON.stringify({ id: request.id, error: { code: 'method_not_found', message: request.method } })}\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
