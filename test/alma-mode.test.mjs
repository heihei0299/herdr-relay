// Alma mode: the phone adapter talking to an Alma-shaped desktop over the
// encrypted tunnel — backend detection, the /ws/herdr hub and /api/herdr/rpc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { E2ESession, createPairingCode, routingIdForCode } from '../web/lib/e2e.js';
import { createRelay } from '../src/relay/server.mjs';
import { createConnector } from '../src/desktop/connector.mjs';
import { connectWebSocket } from '../src/protocol/ws.mjs';
import { createFakeAlma } from './fixtures/fake-alma-desktop.mjs';
import { ALMA, detectBackend, parseHubMessage } from '../web/lib/backend.js';

test('phone detects Alma, reads panes through /api/herdr/rpc and opens the /ws/herdr hub', async (t) => {
  const alma = createFakeAlma();
  const almaAddress = await alma.listen(0, '127.0.0.1');
  const relay = createRelay({ log: () => {} });
  const relayAddress = await relay.listen(0, '127.0.0.1');
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const connector = createConnector({
    relayUrl: `http://127.0.0.1:${relayAddress.port}`,
    code,
    localOrigin: `http://127.0.0.1:${almaAddress.port}`,
    log: () => {},
  });
  await connector.start();
  t.after(async () => {
    connector.stop();
    await relay.close();
    await alma.close();
  });
  await waitFor(() => relay.agents.size === 1, 5000, 'desktop registered');

  const socket = await connectWebSocket(`ws://127.0.0.1:${relayAddress.port}/c/${routingId}`);
  const frames = [];
  const waiters = new Set();
  let session = null;
  socket.on('message', (data, isBinary) => {
    if (session) {
      session.onMessage(isBinary ? new Uint8Array(data) : String(data));
      return;
    }
    frames.push(isBinary ? Buffer.from(data) : String(data));
    for (const waiter of [...waiters]) waiter();
  });
  const nextControl = async () => {
    await waitFor(() => frames.length > 0, 5000, 'relay control frame');
    return frames.shift();
  };

  socket.send(JSON.stringify({ t: 'wopen', id: 'w1', path: '/__alma_e2e__' }));
  assert.equal(JSON.parse(String(await nextControl())).t, 'wopened');

  const tunnelFrames = [];
  session = new E2ESession({
    role: 'initiator',
    code,
    send: (payload) => socket.send(payload),
    onFrame: (frame) => {
      tunnelFrames.push(frame);
      for (const waiter of [...waiters]) waiter();
    },
    onError: (reason) => {
      throw new Error(String(reason));
    },
  });
  await session.start();
  await waitFor(() => session.isReady(), 5000, 'E2E handshake');

  // 1. `/api/snapshot` belongs to herdr-relay's bridge, so Alma mode is chosen.
  const probe = await http(session, tunnelFrames, waiters, 'GET', '/api/snapshot');
  assert.equal(probe.status, 404);
  assert.equal(detectBackend(probe.status, null), ALMA);

  // 2. Pane list through Alma's rpc.
  const list = await rpc(session, tunnelFrames, waiters, 'pane.list', {});
  assert.deepEqual(
    list.panes.map((pane) => pane.pane_id),
    ['wA:p1', 'wA:p2'],
  );

  // 3. The hub opens over the same tunnel and pushes herdr + snapshot messages.
  await session.sendFrame({ t: 'wopen', id: 'hub', path: '/ws/herdr' });
  await waitFor(() => tunnelFrames.some((frame) => frame.t === 'wopened' && String(frame.id) === 'hub'), 5000, 'hub wopened');
  await waitFor(
    () => tunnelFrames.filter((frame) => frame.t === 'wmsg' && String(frame.id) === 'hub').length >= 2,
    5000,
    'hub messages',
  );
  const hubMessages = tunnelFrames
    .filter((frame) => frame.t === 'wmsg' && String(frame.id) === 'hub')
    .map((frame) => parseHubMessage(frame.s))
    .filter(Boolean);
  assert.deepEqual(hubMessages.map((message) => message.type), ['herdr', 'snapshot']);
  assert.equal(hubMessages[1].snapshot.panes[0].pane_id, 'wA:p1');
  await waitFor(() => alma.hubClients === 1, 5000, 'fake Alma sees the hub');

  // 4. Reading and typing reach the Alma-shaped API.
  const read = await rpc(session, tunnelFrames, waiters, 'pane.read', { pane_id: 'wA:p1', source: 'visible' });
  assert.match(read.read.text, /fake Alma terminal/);
  await rpc(session, tunnelFrames, waiters, 'pane.send_text', { pane_id: 'wA:p1', text: 'hi' });
  await rpc(session, tunnelFrames, waiters, 'pane.send_keys', { pane_id: 'wA:p1', keys: ['Enter'] });
  assert.deepEqual(
    alma.state.typed.map((entry) => entry.method),
    ['pane.send_text', 'pane.send_keys'],
  );

  // 5. Methods outside the phone allowlist are refused, not silently allowed.
  const forbidden = await rpcRaw(session, tunnelFrames, waiters, 'server.stop', {});
  assert.equal(forbidden.status, 403);
  socket.terminate();
});

async function rpc(session, frames, waiters, method, params) {
  const response = await rpcRaw(session, frames, waiters, method, params);
  assert.ok(response.status < 400, `${method} -> ${response.status}`);
  return response.body.result;
}

async function rpcRaw(session, frames, waiters, method, params) {
  const response = await http(session, frames, waiters, 'POST', '/api/herdr/rpc', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  let body = null;
  try {
    body = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function http(session, frames, waiters, method, path, { headers = {}, body = null } = {}) {
  const id = `h${Math.random().toString(36).slice(2, 8)}`;
  const payload = { t: 'hreq', id, method, path, headers };
  if (body) payload.b = new TextEncoder().encode(body);
  await session.sendFrame(payload);
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${method} ${path} timed out`)), 5000);
    const check = () => {
      const chunks = frames.filter((frame) => String(frame.id ?? '') === id && frame.t === 'hchunk');
      const head = frames.find((frame) => String(frame.id ?? '') === id && frame.t === 'hres');
      const end = frames.find((frame) => String(frame.id ?? '') === id && frame.t === 'hend');
      const error = frames.find((frame) => String(frame.id ?? '') === id && frame.t === 'herr');
      if (error) {
        clearTimeout(deadline);
        waiters.delete(check);
        reject(new Error(String(error.message)));
        return;
      }
      if (!head || !end) return;
      clearTimeout(deadline);
      waiters.delete(check);
      resolve({ status: head.status, headers: head.headers, body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.b))) });
    };
    waiters.add(check);
    check();
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
