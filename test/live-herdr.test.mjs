// Live check against the real Herdr server on this machine.
// Skipped when no Herdr socket is present.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { E2ESession, createPairingCode, routingIdForCode } from '../web/lib/e2e.js';
import { createRelay } from '../src/relay/server.mjs';
import { createBridge, defaultSocketPath, herdrCall } from '../src/desktop/herdr-bridge.mjs';
import { createConnector } from '../src/desktop/connector.mjs';
import { connectWebSocket } from '../src/protocol/ws.mjs';

const socketPath = defaultSocketPath();
const hasHerdr = existsSync(socketPath);

test('bridge speaks to the live herdr socket', { skip: !hasHerdr && 'no herdr socket on this host' }, async () => {
  const pong = await herdrCall(socketPath, 'ping', {}, 5000);
  assert.equal(pong.type, 'pong');
  const snapshot = await herdrCall(socketPath, 'session.snapshot', {}, 5000);
  assert.ok(snapshot.snapshot, 'snapshot payload present');
  assert.ok(Array.isArray(snapshot.snapshot.panes), 'panes array present');
});

test('phone reads the live herdr snapshot through relay + E2E', { skip: !hasHerdr && 'no herdr socket on this host' }, async (t) => {
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
  });

  await waitUntil(() => relay.agents.size === 1, 5000, 'desktop registered');
  const socket = await connectWebSocket(`ws://127.0.0.1:${relayAddress.port}/c/${routingId}/__alma_e2e__`);
  const inbox = [];
  let session = null;
  socket.on('message', (data, isBinary) => {
    if (session) {
      session.onMessage(isBinary ? new Uint8Array(data) : String(data));
      return;
    }
    inbox.push(isBinary ? Buffer.from(data) : String(data));
  });
  const frames = new Map();
  session = new E2ESession({
    role: 'initiator',
    code,
    send: (payload) => socket.send(payload),
    onFrame: (frame) => frames.get(String(frame.id))?.(frame),
    onError: (reason) => {
      throw new Error(String(reason));
    },
  });
  await session.start();
  await waitUntil(() => session.isReady(), 5000, 'handshake');

  const result = await new Promise((resolve, reject) => {
    const id = 'h1';
    const chunks = [];
    let head = null;
    frames.set(id, (frame) => {
      if (frame.t === 'hres') head = frame;
      else if (frame.t === 'hchunk') chunks.push(Buffer.from(frame.b));
      else if (frame.t === 'hend') resolve({ head, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      else if (frame.t === 'herr') reject(new Error(String(frame.message)));
    });
    session.sendFrame({ t: 'hreq', id, method: 'GET', path: '/api/snapshot', headers: {} });
  });

  assert.equal(result.head.status, 200);
  assert.ok(Array.isArray(result.body.snapshot.workspaces), 'live snapshot has workspaces');
  assert.ok(Array.isArray(result.body.snapshot.panes), 'live snapshot has panes');
  socket.terminate();
});

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForMessage(next, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = next();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a relay message');
}
