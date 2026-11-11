// The desktop's frame dispatch must match Alma 0.4.400's `MobileRelay`:
//
//   wopen  E2E path          -> open the E2E responder (or `werr` when E2E is off)
//   wopen  other path, E2E   -> `werr` "This desktop only accepts end-to-end
//                               encrypted connections"
//   wopen  other path, plain -> dial the local socket
//   wmsg   unknown tunnel    -> `wclose` 4404 "Unknown tunnel; reconnect"
//   hreq   while E2E is on   -> 403 + plaintext explanation
//
// A fake relay drives the connector directly so each branch is observable.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnector } from '../src/desktop/connector.mjs';
import { acceptUpgrade } from '../src/protocol/ws.mjs';
import { decodeRecord } from '../src/protocol/relay-frames.mjs';
import { createPairingCode } from '../web/lib/e2e.js';

async function fakeRelay() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    acceptUpgrade(req, socket, head, {
      onConnection: (ws) => {
        sockets.add(ws);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          let frame;
          try {
            frame = JSON.parse(String(data));
          } catch {
            return;
          }
          if (frame.t === 'register') ws.send(JSON.stringify({ t: 'registered', proto: 2 }));
        });
        ws.on('close', () => sockets.delete(ws));
      },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    frames: () => {
      const agent = [...sockets][0];
      assert.ok(agent, 'the connector dialed the relay');
      return agent;
    },
    close: () => {
      for (const ws of sockets) ws.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Collect every JSON frame the connector sends after `send`. */
function collect(ws, send, count = 1, timeoutMs = 3000) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${JSON.stringify(frames)}`)), timeoutMs);
    const onMessage = (data, isBinary) => {
      let frame;
      if (isBinary) {
        // Protocol-2 body bytes: [kind][idLen][id][payload]
        const record = decodeRecord(Buffer.from(data));
        if (!record) return;
        frame = { t: 'bin', kind: record.kind, id: record.id, data: record.data };
      } else {
        try {
          frame = JSON.parse(String(data));
        } catch {
          return;
        }
      }
      if (frame.t === 'registered') return;
      frames.push(frame);
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(frames);
      }
    };
    ws.on('message', onMessage);
    send(ws);
  });
}

async function started(options) {
  const relay = await fakeRelay();
  const code = createPairingCode();
  const connector = createConnector({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    code,
    localOrigin: 'http://127.0.0.1:1',
    lan: false,
    log: () => {},
    ...options,
  });
  await connector.start();
  const deadline = Date.now() + 5000;
  while (connector.getStatus().status !== 'connected' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(connector.getStatus().status, 'connected', 'connector registered with the fake relay');
  return {
    connector,
    relay,
    stop: async () => {
      connector.stop();
      await relay.close();
    },
  };
}

test('E2E on: the encrypted path opens and every other socket is refused', async (t) => {
  const { relay, stop } = await started({ e2e: true });
  t.after(stop);
  const ws = relay.frames();

  const [opened] = await collect(ws, () => ws.send(JSON.stringify({ t: 'wopen', id: 'w1', path: '/__alma_e2e__' })));
  assert.deepEqual(opened, { t: 'wopened', id: 'w1' });

  const [refused] = await collect(ws, () => ws.send(JSON.stringify({ t: 'wopen', id: 'w2', path: '/ws/herdr' })));
  assert.equal(refused.t, 'werr');
  assert.equal(refused.id, 'w2');
  assert.match(refused.message, /only accepts end-to-end encrypted connections/i);

  // A request that never went through `wopen` cannot be answered.
  const [closed] = await collect(ws, () => ws.send(JSON.stringify({ t: 'wmsg', id: 'nope', s: 'hello' })));
  assert.deepEqual(closed, { t: 'wclose', id: 'nope', code: 4404, reason: 'Unknown tunnel; reconnect' });

  // Plaintext HTTP is answered 403 with the explanation, never proxied.
  const http_ = await collect(ws, () => ws.send(JSON.stringify({ t: 'hreq', id: 'h1', method: 'GET', path: '/api/snapshot', headers: {} })), 3);
  assert.equal(http_[0].t, 'hres');
  assert.equal(http_[0].status, 403);
  assert.equal(http_[1].t, 'bin');
  assert.equal(http_[1].kind, 1, 'the body is an HCHUNK binary frame');
  assert.match(http_[1].data.toString(), /end-to-end/i);
  assert.deepEqual(http_[2], { t: 'hend', id: 'h1' });
});

test('E2E off: the encrypted path is refused instead of proxied', async (t) => {
  const { relay, stop } = await started({ e2e: false });
  t.after(stop);
  const ws = relay.frames();

  const [refused] = await collect(ws, () => ws.send(JSON.stringify({ t: 'wopen', id: 'w1', path: '/__alma_e2e__' })));
  assert.equal(refused.t, 'werr');
  assert.equal(refused.message, 'E2E not enabled on this desktop');
});

test('E2E off: an ordinary socket is dialed locally and its failure reported', async (t) => {
  const { relay, stop } = await started({ e2e: false });
  t.after(stop);
  const ws = relay.frames();

  // Nothing listens on 127.0.0.1:1, so the desktop answers `werr`.
  const [failed] = await collect(ws, () => ws.send(JSON.stringify({ t: 'wopen', id: 'w1', path: '/ws/herdr' })), 1, 8000);
  assert.equal(failed.t, 'werr');
  assert.equal(failed.id, 'w1');
});
