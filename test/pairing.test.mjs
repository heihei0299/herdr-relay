import test from 'node:test';
import assert from 'node:assert/strict';
import {
  E2ESession,
  SealedStream,
  createPairingCode,
  isValidPairingCode,
  pairingReplacedProof,
  routingIdForCode,
  tokenHashForCode,
} from '../web/lib/e2e.js';

test('pairing code is 32 random bytes in base64url', () => {
  const code = createPairingCode();
  assert.equal(code.length, 43);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(isValidPairingCode(code));
  assert.ok(!isValidPairingCode(code.slice(0, 42)));
  assert.notEqual(createPairingCode(), code);
});

test('routing id is a 128 bit base64url value and token hash is its sha256', async () => {
  const code = createPairingCode();
  const routingId = await routingIdForCode(code);
  assert.match(routingId, /^[A-Za-z0-9_-]{22}$/);

  const tokenHash = await tokenHashForCode(code);
  assert.match(tokenHash, /^[a-f0-9]{64}$/);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(routingId));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(tokenHash, expected);
});

test('routing id is stable for a code and different across codes', async () => {
  const code = createPairingCode();
  assert.equal(await routingIdForCode(code), await routingIdForCode(code));
  assert.notEqual(await routingIdForCode(code), await routingIdForCode(createPairingCode()));
});

test('sealed frames do not contain the plaintext', async () => {
  const code = createPairingCode();
  const keys = await deriveTestKeys(code);
  const stream = new SealedStream(keys);
  const secret = 'TOP-SECRET-PANE-CONTENT';
  const sealed = await stream.seal(new TextEncoder().encode(secret));
  assert.ok(!Buffer.from(sealed).includes(Buffer.from(secret)));
  const opened = await stream.open(sealed);
  assert.equal(new TextDecoder().decode(opened), secret);
  // The nonce is the frame prefix (4 zero bytes + u64 counter).
  assert.deepEqual([...sealed.subarray(0, 12)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('handshake completes and carries encrypted frames', async () => {
  const code = createPairingCode();
  const { initiator, responder, pump, history } = await handshakePair(code);
  await pump();
  assert.ok(initiator.isReady());
  assert.ok(responder.isReady());
  assert.equal(initiator.usesBinaryFrames(), true);

  const received = [];
  responder.onFrame = (frame) => received.push(frame);
  await initiator.sendFrame({ t: 'wmsg', id: 'w1', s: 'hello pane' });
  await pump();
  assert.deepEqual(received, [{ t: 'wmsg', id: 'w1', s: 'hello pane' }]);

  assert.ok(history.responder.length > 0);
  const sealedOutbound = history.initiator.filter((entry) => typeof entry !== 'string');
  assert.ok(sealedOutbound.length > 0);
  assert.ok(!Buffer.concat(sealedOutbound.map((entry) => Buffer.from(entry))).includes(Buffer.from('hello pane')));
});

test('a wrong pairing code fails the handshake instead of connecting', async () => {
  const code = createPairingCode();
  const other = createPairingCode();
  const { initiator, responder, pump } = await handshakePair(other, code);
  await pump();
  assert.equal(initiator.isReady(), false);
  assert.equal(responder.isReady(), false);
  assert.match(String(initiator.lastError ?? ''), /authentication failed/i);
});

test('the retired-code proof only validates for the matching nonce', async () => {
  const code = createPairingCode();
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const proof = await pairingReplacedProof(code, nonce);
  assert.notEqual(proof, await pairingReplacedProof(code, crypto.getRandomValues(new Uint8Array(16))));
});

async function deriveTestKeys(code) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peerRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const peerKey = await crypto.subtle.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, peer.privateKey, 256));
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(code), info: new Uint8Array(0) },
    ikm,
    256,
  );
  return await crypto.subtle.importKey('raw', new Uint8Array(bits), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function handshakePair(initiatorCode, responderCode = initiatorCode) {
  const sent = { initiator: [], responder: [] };
  const history = { initiator: [], responder: [] };
  let initiator;
  let responder;
  initiator = new E2ESession({
    role: 'initiator',
    code: initiatorCode,
    send: (payload) => {
      sent.initiator.push(payload);
      history.initiator.push(payload);
    },
    onFrame: () => {},
    onError: (reason) => {
      initiator.lastError = reason;
    },
  });
  responder = new E2ESession({
    role: 'responder',
    code: responderCode,
    send: (payload) => {
      sent.responder.push(payload);
      history.responder.push(payload);
    },
    onFrame: () => {},
    onError: (reason) => {
      responder.lastError = reason;
    },
  });
  await initiator.start();
  const pump = async () => {
    for (let round = 0; round < 12; round += 1) {
      const work = [];
      while (sent.initiator.length) work.push(responder.onMessage(sent.initiator.shift()));
      while (sent.responder.length) work.push(initiator.onMessage(sent.responder.shift()));
      if (!work.length) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Promise.all(work);
      if (initiator.isReady() && responder.isReady() && !sent.initiator.length && !sent.responder.length) break;
    }
  };
  return { initiator, responder, pump, sent, history };
}
