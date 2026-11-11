// The relay speaks the official alma-relay protocol (see
// github.com/yetone/alma-relay/docs/PROTOCOL.md). These tests pin the parts
// this project's desktop/phone depend on: HTTP proxying (protocol 1 and 2),
// streamed request bodies, binary frames, WebSocket bridging, registration
// auth and the push fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRelay } from '../src/relay/server.mjs';
import { encodeRecord } from '../src/protocol/relay-frames.mjs';
import { connectWebSocket } from '../src/protocol/ws.mjs';
import { createPairingCode, routingIdForCode } from '../web/lib/e2e.js';

const BIN = { HCHUNK: 1, HBODY: 2, WBIN: 3, WTEXT: 4 };

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function startRelay(env = {}) {
  const relay = createRelay({ env, log: () => {} });
  const address = await relay.listen(0, '127.0.0.1');
  return { relay, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

async function connectAgent(port, tokenHash, proto = 2, key = null) {
  const socket = await connectWebSocket(`ws://127.0.0.1:${port}/agent?th=${tokenHash}`);
  const messages = [];
  socket.on('message', (data, isBinary) => {
    messages.push(isBinary ? { binary: Buffer.from(data) } : { json: JSON.parse(String(data)) });
  });
  socket.send(JSON.stringify({ t: 'register', tokenHash, name: 'test', ...(key ? { key } : {}), proto }));
  return { socket, messages };
}

async function waitFor(fn, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function decodeBinary(buffer) {
  if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return null;
  return {
    kind: buffer[0],
    id: buffer.toString('utf8', 2, 2 + buffer[1]),
    data: buffer.subarray(2 + buffer[1]),
  };
}

test('healthz matches the reference relay identity', async (t) => {
  const { relay, base } = await startRelay();
  t.after(() => relay.close());
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.edition, 'node');
  assert.equal(body.version, '1.2.0');
  assert.equal(body.protocol, 2);
  assert.equal(body.agents, 0);
});

test('protocol 2: HTTP requests are proxied and responses stream in binary frames', async (t) => {
  const { relay, port, base } = await startRelay();
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const { socket } = await connectAgent(port, hash(routingId), 2);
  t.after(async () => {
    socket.terminate();
    await relay.close();
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    const frame = JSON.parse(String(data));
    if (frame.t !== 'hreq') return;
    assert.equal(frame.method, 'GET');
    assert.equal(frame.path, '/api/hello?x=1');
    socket.send(JSON.stringify({ t: 'hres', id: frame.id, status: 201, headers: { 'content-type': 'text/plain', 'x-reply': 'yes' } }));
    socket.send(encodeRecord(BIN.HCHUNK, frame.id, Buffer.from('hello ')));
    socket.send(encodeRecord(BIN.HCHUNK, frame.id, Buffer.from('world')));
    socket.send(JSON.stringify({ t: 'hend', id: frame.id }));
  });

  const response = await fetch(`${base}/c/${routingId}/api/hello?x=1`);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-reply'), 'yes');
  assert.equal(await response.text(), 'hello world');
});

test('protocol 2: request bodies stream through HBODY frames and are acknowledged', async (t) => {
  const { relay, port, base } = await startRelay();
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const { socket } = await connectAgent(port, hash(routingId), 2);
  t.after(async () => {
    socket.terminate();
    await relay.close();
  });

  const payload = 'Z'.repeat(300 * 1024);
  let received = Buffer.alloc(0);
  let sawStream = false;
  let acks = 0;
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = decodeBinary(Buffer.from(data));
      if (frame?.kind === BIN.HBODY) {
        received = Buffer.concat([received, frame.data]);
        socket.send(JSON.stringify({ t: 'hack', id: frame.id, n: frame.data.length }));
        acks += 1;
      }
      return;
    }
    const frame = JSON.parse(String(data));
    if (frame.t === 'hreq') {
      sawStream = frame.stream === true;
      assert.equal(frame.path, '/api/echo');
    } else if (frame.t === 'hreqend') {
      assert.equal(received.toString(), payload);
      socket.send(JSON.stringify({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'text/plain' } }));
      socket.send(encodeRecord(BIN.HCHUNK, frame.id, Buffer.from(`got ${received.length}`)));
      socket.send(JSON.stringify({ t: 'hend', id: frame.id }));
    }
  });

  const response = await fetch(`${base}/c/${routingId}/api/echo`, { method: 'POST', body: payload });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `got ${payload.length}`);
  assert.equal(sawStream, true);
  assert.ok(acks > 0, 'the desktop acknowledged body bytes with hack');
});

test('protocol 1 fallback keeps bodies and chunks in base64 JSON', async (t) => {
  const { relay, port, base } = await startRelay();
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const { socket, messages } = await connectAgent(port, hash(routingId), 1);
  t.after(async () => {
    socket.terminate();
    await relay.close();
  });
  await waitFor(() => messages.some((m) => m.json?.t === 'registered'), 3000, 'registered');
  assert.equal(messages.find((m) => m.json?.t === 'registered').json.proto, 1);

  socket.on('message', (data, isBinary) => {
    assert.equal(isBinary, false, 'protocol 1 never uses binary frames');
    const frame = JSON.parse(String(data));
    if (frame.t !== 'hreq') return;
    assert.equal('stream' in frame, false);
    assert.equal(Buffer.from(frame.b, 'base64').toString(), 'proto-one');
    socket.send(JSON.stringify({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'text/plain' } }));
    socket.send(JSON.stringify({ t: 'hchunk', id: frame.id, b: Buffer.from('base64 reply').toString('base64') }));
    socket.send(JSON.stringify({ t: 'hend', id: frame.id }));
  });

  const response = await fetch(`${base}/c/${routingId}/api/echo`, { method: 'POST', body: 'proto-one' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'base64 reply');
});

test('the registration key gate uses close code 4003', async (t) => {
  const { relay, port } = await startRelay({ RELAY_REGISTRATION_KEY: 'open-sesame' });
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const tokenHash = hash(routingId);

  const denied = await connectWebSocket(`ws://127.0.0.1:${port}/agent?th=${tokenHash}`);
  const deniedClose = new Promise((resolve) => denied.on('close', (closeCode) => resolve(closeCode)));
  denied.send(JSON.stringify({ t: 'register', tokenHash, name: 'test', proto: 2 }));
  assert.equal(await deniedClose, 4003);

  const allowed = await connectWebSocket(`ws://127.0.0.1:${port}/agent?th=${tokenHash}`);
  const registered = new Promise((resolve) => {
    allowed.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(String(data));
      if (frame.t === 'registered') resolve(frame);
    });
  });
  allowed.send(JSON.stringify({ t: 'register', tokenHash, key: 'open-sesame', proto: 2 }));
  assert.equal((await registered).proto, 2);
  allowed.terminate();

  t.after(() => relay.close());
});

test('push frames are answered with unsupported when the relay has no keys', async (t) => {
  const { relay, port } = await startRelay();
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const { socket, messages } = await connectAgent(port, hash(routingId), 2);
  t.after(async () => {
    socket.terminate();
    await relay.close();
  });
  await waitFor(() => messages.some((m) => m.json?.t === 'registered'), 3000, 'registered');
  socket.send(JSON.stringify({ t: 'push', id: 'p1', notifications: [] }));
  const pushed = await waitFor(() => messages.find((m) => m.json?.t === 'pushed'), 3000, 'pushed');
  assert.deepEqual(pushed.json, { t: 'pushed', id: 'p1', unsupported: true });
});

test('WebSockets bridge both directions with protocol-2 binary frame kinds', async (t) => {
  const { relay, port } = await startRelay();
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  const { socket } = await connectAgent(port, hash(routingId), 2);
  t.after(async () => {
    socket.terminate();
    await relay.close();
  });

  const fromPhone = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      fromPhone.push(decodeBinary(Buffer.from(data)));
      return;
    }
    const frame = JSON.parse(String(data));
    if (frame.t === 'wopen') {
      assert.equal(frame.path, '/ws/herdr');
      socket.send(JSON.stringify({ t: 'wopened', id: frame.id }));
    }
  });

  const client = await connectWebSocket(`ws://127.0.0.1:${port}/c/${routingId}/ws/herdr`);
  const inbox = [];
  client.on('message', (data, isBinary) => inbox.push(isBinary ? Buffer.from(data) : String(data)));
  client.send('hello-desktop');
  await waitFor(() => fromPhone.length > 0, 3000, 'text frame');
  assert.equal(fromPhone[0].kind, BIN.WTEXT);
  assert.equal(fromPhone[0].data.toString(), 'hello-desktop');

  socket.send(encodeRecord(BIN.WBIN, fromPhone[0].id, Buffer.from([1, 2, 3])));
  await waitFor(() => inbox.length > 0, 3000, 'binary reply');
  assert.deepEqual([...inbox[0]], [1, 2, 3]);
  client.terminate();
});
