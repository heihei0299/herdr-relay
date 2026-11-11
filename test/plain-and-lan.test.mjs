// Plaintext (E2E off) proxying and LAN-direct, the two transport modes the
// reference Alma desktop implements besides the encrypted tunnel.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay } from '../src/relay/server.mjs';
import { createConnector } from '../src/desktop/connector.mjs';
import { connectWebSocket } from '../src/protocol/ws.mjs';
import { E2ESession, createPairingCode, routingIdForCode } from '../web/lib/e2e.js';

async function waitFor(fn, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function localServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          method: req.method,
          path: req.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('plaintext mode proxies HTTP and streamed POST bodies', async (t) => {
  const local = await localServer();
  const relay = createRelay({ env: {}, log: () => {} });
  const address = await relay.listen(0, '127.0.0.1');
  const code = createPairingCode();
  const connector = createConnector({
    relayUrl: `http://127.0.0.1:${address.port}`,
    code,
    localOrigin: local.url,
    e2e: false,
    lan: false,
    log: () => {},
  });
  await connector.start();

  t.after(async () => {
    connector.stop();
    await relay.close();
    await local.close();
  });
  await waitFor(() => connector.getStatus().status === 'connected', 5000, 'plain connector registered');
  assert.equal(connector.getStatus().proto, 2);

  const get = await fetch(`http://127.0.0.1:${address.port}/c/${code}/api/anything?q=1`);
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.method, 'GET');
  assert.equal(getBody.path, '/api/anything?q=1');

  const payload = 'plain-body-'.repeat(20_000);
  const post = await fetch(`http://127.0.0.1:${address.port}/c/${code}/api/echo`, { method: 'POST', body: payload });
  assert.equal(post.status, 200);
  const postBody = await post.json();
  assert.equal(postBody.method, 'POST');
  assert.equal(postBody.body, payload);
});

test('LAN direct serves the same E2E tunnel and candidates endpoint', async (t) => {
  const local = await localServer();
  const relay = createRelay({ env: {}, log: () => {} });
  const address = await relay.listen(0, '127.0.0.1');
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const connector = createConnector({
    relayUrl: `http://127.0.0.1:${address.port}`,
    code,
    localOrigin: local.url,
    lan: true,
    log: () => {},
  });
  await connector.start();
  t.after(async () => {
    connector.stop();
    await relay.close();
    await local.close();
  });
  await waitFor(() => connector.getStatus().status === 'connected', 5000, 'connector registered');
  const lanPort = await waitFor(() => connector.getStatus().lanPort, 5000, 'LAN listener');
  assert.ok(lanPort > 0);

  // 1. Through the relay, `/__alma_lan__` advertises the direct endpoint.
  const relaySocket = await connectWebSocket(`ws://127.0.0.1:${address.port}/c/${routingId}/__alma_e2e__`);
  const relaySession = new E2ESession({
    role: 'initiator',
    code,
    send: (payload) => relaySocket.send(payload),
    onFrame: () => {},
    onError: () => {},
  });
  relaySocket.on('message', (data, isBinary) => relaySession.onMessage(isBinary ? new Uint8Array(data) : String(data)));
  await relaySession.start();
  await waitFor(() => relaySession.isReady(), 5000, 'relay handshake');
  const candidates = await e2eRequest(relaySession, 'GET', '/__alma_lan__');
  const parsed = JSON.parse(candidates.body);
  assert.equal(parsed.port, lanPort);
  assert.ok(Array.isArray(parsed.hosts));

  // 2. The direct socket answers the same tunnel.
  const directSocket = await connectWebSocket(`ws://127.0.0.1:${lanPort}/__alma_e2e__`);
  const directSession = new E2ESession({
    role: 'initiator',
    code,
    send: (payload) => directSocket.send(payload),
    onFrame: () => {},
    onError: () => {},
  });
  directSocket.on('message', (data, isBinary) => directSession.onMessage(isBinary ? new Uint8Array(data) : String(data)));
  await directSession.start();
  await waitFor(() => directSession.isReady(), 5000, 'LAN handshake');
  const direct = await e2eRequest(directSession, 'GET', '/api/anything');
  assert.equal(direct.status, 200);
  assert.equal(JSON.parse(direct.body).ok, true);

  relaySocket.terminate();
  directSocket.terminate();
});

function e2eRequest(session, method, path, body = null) {
  const id = `h${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let head = null;
    const timer = setTimeout(() => {
      session.onFrame = previous;
      reject(new Error(`timed out: ${method} ${path}`));
    }, 8000);
    const previous = session.onFrame;
    session.onFrame = (frame) => {
      if (String(frame.id) !== id) return;
      if (frame.t === 'hres') head = frame;
      else if (frame.t === 'hchunk') chunks.push(Buffer.from(frame.b));
      else if (frame.t === 'hend') {
        clearTimeout(timer);
        session.onFrame = previous;
        resolve({ status: head?.status, headers: head?.headers ?? {}, body: Buffer.concat(chunks).toString() });
      } else if (frame.t === 'herr') {
        clearTimeout(timer);
        session.onFrame = previous;
        reject(new Error(String(frame.message)));
      }
    };
    const payload = { t: 'hreq', id, method, path, headers: {} };
    if (body) payload.b = new TextEncoder().encode(body);
    session.sendFrame(payload);
  });
}
