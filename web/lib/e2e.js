// Pairing + end-to-end encryption for herdr-relay.
//
// Wire-compatible with the Alma desktop "remote" subsystem
// (`alma-relay-e2e/v1`, recovered from app.asar out/main/index.js):
//
//   routingId  = b64url(HKDF-SHA256(ikm = code, salt = "alma-relay-e2e/v1/routing", 128 bit))
//   tokenHash  = sha256hex(routingId)                     (relay registration key)
//   transcript = SHA-256("alma-relay-e2e/v1" || iPk || rPk || iNonce || rNonce)
//   shared     = ECDH P-256 (iPk, rPk) -> 256 bit
//   c2s        = HKDF(shared, salt = code, info = "c2s|" || transcript, 256 bit)
//   s2c        = HKDF(shared, salt = code, info = "s2c|" || transcript, 256 bit)
//   confirm-r  = HKDF(shared, salt = code, info = "confirm-r|" || transcript)
//   confirm-i  = HKDF(shared, salt = code, info = "confirm-i|" || transcript)
//
// Handshake: initiator -> {t:"hi",epk,n,bin,sb}; responder -> {t:"hi",epk,n,cr,bin,sb};
// initiator -> {t:"ok",ci}. Sealed frames: AES-GCM, IV = 0x00000000 || u64 counter.
//
// This module is dependency-free and uses only WebCrypto, so the exact same code
// runs in Node and in the phone's browser.

export const E2E_LABEL = 'alma-relay-e2e/v1';
export const PAIRING_CODE_BYTES = 32;

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function raw(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A fresh pairing code: 32 random bytes, base64url (43 chars). */
export function createPairingCode() {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(PAIRING_CODE_BYTES)));
}

export function isValidPairingCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code);
}

/** Relay routing id for a pairing code (this is the only public identifier). */
export async function routingIdForCode(code) {
  const key = await subtle.importKey('raw', encoder.encode(code), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`${E2E_LABEL}/routing`), info: new Uint8Array(0) },
    key,
    128,
  );
  return base64url(new Uint8Array(bits));
}

/** Registration token the desktop presents to the relay (sha256 hex of routing id). */
export async function tokenHashForCode(code) {
  const routingId = await routingIdForCode(code);
  const digest = await subtle.digest('SHA-256', encoder.encode(routingId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** HMAC proof used to signal "this pairing code was replaced by the desktop". */
export async function pairingReplacedProof(code, nonce) {
  const key = await subtle.importKey('raw', encoder.encode(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await subtle.sign('HMAC', key, concat(encoder.encode('alma-pairing-replaced'), nonce));
  return base64url(new Uint8Array(signature));
}

export async function generateEphemeralKeyPair() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKeyRaw: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

function randomNonce() {
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

async function derive(sharedBits, code, label, transcript) {
  const ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(code), info: concat(encoder.encode(label), transcript) },
      ikm,
      256,
    ),
  );
}

async function deriveSessionKeys({ privateKey, peerPublicKeyRaw, code, initiatorPublicKeyRaw, responderPublicKeyRaw, initiatorNonce, responderNonce }) {
  const peerKey = await subtle.importKey(
    'raw',
    raw(peerPublicKeyRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256));
  const transcript = new Uint8Array(
    await subtle.digest(
      'SHA-256',
      concat(encoder.encode(E2E_LABEL), initiatorPublicKeyRaw, responderPublicKeyRaw, initiatorNonce, responderNonce),
    ),
  );
  const [c2s, s2c, confirmResponder, confirmInitiator] = await Promise.all([
    derive(shared, code, 'c2s|', transcript),
    derive(shared, code, 's2c|', transcript),
    derive(shared, code, 'confirm-r|', transcript),
    derive(shared, code, 'confirm-i|', transcript),
  ]);
  return {
    c2s: await subtle.importKey('raw', raw(c2s), 'AES-GCM', false, ['encrypt', 'decrypt']),
    s2c: await subtle.importKey('raw', raw(s2c), 'AES-GCM', false, ['encrypt', 'decrypt']),
    confirmResponder,
    confirmInitiator,
  };
}

/** Directional AES-GCM stream: 12 byte IV = 4 zero bytes || u64 counter. */
export class SealedStream {
  constructor(key) {
    this.key = key;
    this.counter = 0n;
  }

  static iv(counter) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, counter);
    return iv;
  }

  async seal(bytes) {
    const iv = SealedStream.iv(this.counter);
    this.counter += 1n;
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: raw(iv) }, this.key, raw(bytes)));
    return concat(iv, ciphertext);
  }

  async open(frame) {
    if (frame.length < 12) throw new Error('E2E frame too short');
    const iv = frame.subarray(0, 12);
    const ciphertext = frame.subarray(12);
    const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: raw(iv) }, this.key, raw(ciphertext));
    return new Uint8Array(plaintext);
  }
}

/**
 * The handshake + sealed transport, mirroring Alma's E2E session.
 *
 * role: "initiator" (phone) | "responder" (desktop)
 * send(bytesOrString) delivers one E2E record to the peer (via the relay)
 * onReady() is called once keys are installed
 * onFrame(frame) receives each decrypted application frame (already JSON-parsed)
 */
export class E2ESession {
  constructor({ role, code, send, onFrame, onError, onReady, binaryFrames = true, streamedBodies = true, retired = false }) {
    this.role = role;
    this.code = code;
    this._send = send;
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {});
    this.onReadyCb = onReady ?? (() => {});
    this.offerBinary = binaryFrames;
    this.offerStreamed = streamedBodies;
    this.retired = retired;
    this.binary = false;
    this.streamed = false;
    this.state = 'init';
    this.eph = null;
    this.myNonce = randomNonce();
    this.keys = null;
    this.sendStream = null;
    this.recvStream = null;
    this.outbox = [];
    this.outgoing = Promise.resolve();
    this.incoming = Promise.resolve();
  }

  async start() {
    if (this.role !== 'initiator') return;
    this.eph = await generateEphemeralKeyPair();
    this.state = 'await-hi';
    const hello = { t: 'hi', epk: base64url(this.eph.publicKeyRaw), n: base64url(this.myNonce) };
    if (this.offerBinary) hello.bin = 1;
    if (this.offerStreamed) hello.sb = 1;
    this._send(JSON.stringify(hello));
  }

  isReady() {
    return this.state === 'ready';
  }

  usesBinaryFrames() {
    return this.binary;
  }

  usesStreamedBodies() {
    return this.streamed;
  }

  sendFrame(frame) {
    if (this.state === 'failed') return Promise.resolve();
    if (this.state !== 'ready' || !this.sendStream) {
      this.outbox.push(frame);
      return Promise.resolve();
    }
    this.outgoing = this.outgoing.then(async () => {
      if (this.state === 'failed') throw new Error('E2E session failed');
      const bytes = encodeSealedPayload(frame, this.binary);
      const sealed = await this.sendStream.seal(bytes);
      this._send(sealed);
    }).catch((error) => this._fail(error?.message ?? String(error)));
    return this.outgoing;
  }

  onMessage(data) {
    this.incoming = this.incoming.then(() => this._consume(data));
    return this.incoming;
  }

  async _consume(data) {
    if (this.state === 'failed') return;
    try {
      if (typeof data === 'string') {
        await this._onHandshake(JSON.parse(data));
        return;
      }
      if (!this.recvStream) return;
      const plaintext = await this.recvStream.open(toBytes(data));
      this.onFrame?.(decodeSealedPayload(plaintext));
    } catch (error) {
      this._fail(error?.message ?? String(error));
    }
  }

  async _onHandshake(message) {
    if (this.role === 'responder' && message.t === 'hi' && this.state === 'init') {
      if (this.retired) {
        const nonce = fromBase64url(String(message.n));
        const proof = await pairingReplacedProof(this.code, nonce);
        this._send(JSON.stringify({ t: 'err', message: 'pairing-replaced', proof }));
        this._fail('pairing-replaced');
        return;
      }
      const peerPublicKey = fromBase64url(String(message.epk));
      const peerNonce = fromBase64url(String(message.n));
      this.binary = this.offerBinary && message.bin === 1;
      this.streamed = this.offerStreamed && message.sb === 1;
      this.eph = await generateEphemeralKeyPair();
      this.keys = await deriveSessionKeys({
        privateKey: this.eph.privateKey,
        peerPublicKeyRaw: peerPublicKey,
        code: this.code,
        initiatorPublicKeyRaw: peerPublicKey,
        responderPublicKeyRaw: this.eph.publicKeyRaw,
        initiatorNonce: peerNonce,
        responderNonce: this.myNonce,
      });
      this.state = 'await-ok';
      const reply = { t: 'hi', epk: base64url(this.eph.publicKeyRaw), n: base64url(this.myNonce), cr: base64url(this.keys.confirmResponder) };
      if (this.binary) reply.bin = 1;
      if (this.streamed) reply.sb = 1;
      this._send(JSON.stringify(reply));
      return;
    }
    if (this.role === 'initiator' && message.t === 'hi' && this.state === 'await-hi') {
      const peerPublicKey = fromBase64url(String(message.epk));
      const peerNonce = fromBase64url(String(message.n));
      this.binary = this.offerBinary && message.bin === 1;
      this.streamed = this.offerStreamed && message.sb === 1;
      this.keys = await deriveSessionKeys({
        privateKey: this.eph.privateKey,
        peerPublicKeyRaw: peerPublicKey,
        code: this.code,
        initiatorPublicKeyRaw: this.eph.publicKeyRaw,
        responderPublicKeyRaw: peerPublicKey,
        initiatorNonce: this.myNonce,
        responderNonce: peerNonce,
      });
      if (!equalBytes(fromBase64url(String(message.cr)), this.keys.confirmResponder)) {
        this._send(JSON.stringify({ t: 'err', message: 'auth-failed' }));
        this._fail('Handshake authentication failed (wrong code or man-in-the-middle)');
        return;
      }
      this._send(JSON.stringify({ t: 'ok', ci: base64url(this.keys.confirmInitiator) }));
      this.sendStream = new SealedStream(this.keys.c2s);
      this.recvStream = new SealedStream(this.keys.s2c);
      await this._markReady();
      return;
    }
    if (this.role === 'responder' && message.t === 'ok' && this.state === 'await-ok') {
      if (!equalBytes(fromBase64url(String(message.ci)), this.keys.confirmInitiator)) {
        this._fail('Handshake authentication failed (wrong code or man-in-the-middle)');
        return;
      }
      this.sendStream = new SealedStream(this.keys.s2c);
      this.recvStream = new SealedStream(this.keys.c2s);
      await this._markReady();
      return;
    }
    if (message.t === 'err') {
      if (this.role === 'initiator' && message.message === 'pairing-replaced' && typeof message.proof === 'string') {
        const expected = await pairingReplacedProof(this.code, this.myNonce);
        if (equalBytes(fromBase64url(message.proof), fromBase64url(expected))) {
          this._fail("This computer's pairing code was changed. Pair again.");
          return;
        }
      }
      this._fail(`Peer rejected handshake: ${String(message.message || 'unknown')}`);
    }
  }

  async _markReady() {
    this.state = 'ready';
    this.onReadyCb();
    const queued = this.outbox;
    this.outbox = [];
    for (const frame of queued) await this.sendFrame(frame);
  }

  _fail(reason) {
    if (this.state === 'failed') return;
    this.state = 'failed';
    this.onError(reason);
  }
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export function encodeSealedPayload(frame, binary) {
  const body = frame.b === undefined ? null : toBytes(frame.b);
  const message = { ...frame };
  delete message.b;
  if (binary && body) {
    const json = encoder.encode(JSON.stringify({ ...message, $: 'b' }));
    const out = new Uint8Array(5 + json.length + body.length);
    out[0] = 0;
    new DataView(out.buffer).setUint32(1, json.length);
    out.set(json, 5);
    out.set(body, 5 + json.length);
    return out;
  }
  if (body) message.b = base64url(body);
  return encoder.encode(JSON.stringify(message));
}

export function decodeSealedPayload(bytes) {
  if (bytes.length > 0 && bytes[0] === 0) {
    if (bytes.length < 5) throw new Error('E2E frame header truncated');
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
    if (5 + jsonLength > bytes.length) throw new Error('E2E frame header truncated');
    const frame = JSON.parse(decoder.decode(bytes.subarray(5, 5 + jsonLength)));
    const kind = frame.$;
    delete frame.$;
    const body = bytes.subarray(5 + jsonLength);
    if (kind === 's') frame.s = decoder.decode(body);
    else frame.b = body;
    return frame;
  }
  const frame = JSON.parse(decoder.decode(bytes));
  if (typeof frame.b === 'string') frame.b = fromBase64url(frame.b);
  return frame;
}
