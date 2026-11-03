// Minimal RFC 6455 WebSocket (server + client), no extensions, no dependencies.
// Supports text/binary messages, ping/pong, close, and fragmented data frames.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import httpMod from 'node:http';
import httpsMod from 'node:https';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_MESSAGE = 64 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { mask = false, head = null } = {}) {
    super();
    this.socket = socket;
    this.masked = mask;
    this.readyState = 'open';
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOp = 0;
    this._closed = false;
    this._pending = [];
    this.alive = true;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._finish(null, err));
    socket.on('close', () => this._finish());
    if (head && head.length) this._onData(head);
  }

  // Data can arrive in the upgrade `head` or in the first `data` event before
  // the caller attaches its listener; hold those messages until it does.
  on(event, listener) {
    const result = super.on(event, listener);
    if (event === 'message' && this._pending.length) {
      setImmediate(() => {
        while (this._pending.length) {
          const [data, isBinary] = this._pending.shift();
          this.emit('message', data, isBinary);
        }
      });
    }
    return result;
  }

  _deliver(data, isBinary) {
    if (this.listenerCount('message') === 0) {
      this._pending.push([data, isBinary]);
      return;
    }
    this.emit('message', data, isBinary);
  }

  send(data) {
    if (this.readyState !== 'open') return false;
    const isText = typeof data === 'string';
    const payload = isText ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return this._writeFrame(isText ? OP_TEXT : OP_BIN, payload);
  }

  ping() {
    return this._writeFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return;
    this.readyState = 'closing';
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this._writeFrame(OP_CLOSE, body);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }

  terminate() {
    this.socket.destroy();
  }

  _writeFrame(opcode, payload) {
    if (this.socket.destroyed) return false;
    const len = payload.length;
    let headerLen = 2;
    if (len > 65535) headerLen += 8;
    else if (len > 125) headerLen += 2;
    if (this.masked) headerLen += 4;
    const frame = Buffer.allocUnsafe(headerLen + len);
    frame[0] = 0x80 | opcode;
    let offset = 2;
    if (len > 65535) {
      frame[1] = 127;
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(len, 6);
      offset = 10;
    } else if (len > 125) {
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      frame[1] = len;
    }
    if (this.masked) {
      frame[1] |= 0x80;
      const mask = randomBytes(4);
      mask.copy(frame, offset);
      offset += 4;
      for (let i = 0; i < len; i += 1) frame[offset + i] = payload[i] ^ mask[i & 3];
    } else {
      payload.copy(frame, offset);
    }
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  _finish(code = null, err = null) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 'closed';
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._pending = [];
    this.emit('close', code, err);
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        if (hi !== 0) return this._protocolError('frame too large');
        len = lo;
        offset = 10;
      }
      if (len > MAX_MESSAGE) return this._protocolError('frame too large');
      let mask = null;
      if (masked) {
        if (this._buf.length < offset + 4) return;
        mask = this._buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this._buf.length < offset + len) return;
      let payload = this._buf.subarray(offset, offset + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      } else {
        payload = Buffer.from(payload);
      }
      this._buf = this._buf.subarray(offset + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      let code = 1005;
      if (payload.length >= 2) code = payload.readUInt16BE(0);
      if (this.readyState === 'open') {
        this.readyState = 'closing';
        const body = Buffer.alloc(2);
        body.writeUInt16BE(1000, 0);
        this._writeFrame(OP_CLOSE, body);
      }
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 500).unref?.();
      this._finish(code);
      return;
    }
    if (opcode === OP_PING) {
      this._writeFrame(OP_PONG, payload);
      this.emit('ping');
      return;
    }
    if (opcode === OP_PONG) {
      this.alive = true;
      this.emit('pong');
      return;
    }
    if (opcode === OP_CONT) {
      this._fragments.push(payload);
    } else if (opcode === OP_TEXT || opcode === OP_BIN) {
      this._fragments = [payload];
      this._fragOp = opcode;
    } else {
      return this._protocolError(`unknown opcode ${opcode}`);
    }
    if (!fin) return;
    const data = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
    const isText = this._fragOp === OP_TEXT;
    this._fragments = [];
    this._deliver(isText ? data.toString('utf8') : data, !isText);
  }

  _protocolError(reason) {
    try {
      this.close(1002, reason);
    } catch {
      /* ignore */
    }
    this._finish(1002);
  }
}

// --- server side -----------------------------------------------------------

export function acceptUpgrade(req, socket, head, { onConnection }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  const protocols = req.headers['sec-websocket-protocol'];
  if (protocols) lines.push(`Sec-WebSocket-Protocol: ${String(protocols).split(',')[0].trim()}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const ws = new WebSocketConnection(socket, { mask: false, head });
  onConnection?.(ws, req);
  return ws;
}

// --- client side -----------------------------------------------------------

export function connectWebSocket(url, { headers = {}, timeoutMs = 15000, maxPayload = MAX_MESSAGE } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      reject(new Error(`unsupported websocket protocol ${target.protocol}`));
      return;
    }
    const secure = target.protocol === 'wss:';
    const host = target.hostname;
    const port = target.port ? Number(target.port) : secure ? 443 : 80;
    const mod = secure ? httpsMod : httpMod;
    const key = randomBytes(16).toString('base64');
    const path = `${target.pathname || '/'}${target.search || ''}`;
    const req = mod.request({
      host,
      port,
      path,
      method: 'GET',
      servername: secure ? host : undefined,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Host: target.host,
        ...headers,
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('websocket connect timeout'));
    }, timeoutMs);
    timer.unref?.();
    req.on('upgrade', (res, socket, head) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay?.(true);
      const ws = new WebSocketConnection(socket, { mask: true, head });
      ws.maxPayload = maxPayload;
      resolve(ws);
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.resume();
      reject(new Error(`websocket upgrade rejected: ${res.statusCode}`));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

