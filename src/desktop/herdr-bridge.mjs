// Local bridge: exposes the Herdr socket API (newline-delimited JSON-RPC over a
// Unix socket) as HTTP + WebSocket on loopback, so the encrypted tunnel can
// carry it. It never listens on a public interface.

import http from 'node:http';
import net from 'node:net';
import { acceptUpgrade } from '../protocol/ws.mjs';

const MAX_LINE = 64 * 1024 * 1024;

export function defaultSocketPath(env = process.env) {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SOCKET) return env.HERDR_SOCKET;
  const configHome = env.XDG_CONFIG_HOME || `${env.HOME}/.config`;
  const session = env.HERDR_SESSION;
  if (session && session !== 'default') return `${configHome}/herdr/sessions/${session}/herdr.sock`;
  return `${configHome}/herdr/herdr.sock`;
}

/** One JSON-RPC round trip over a fresh socket connection (Herdr closes after the answer). */
export function herdrCall(socketPath, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => done(new Error(`${method} timed out`)), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: `bridge:${++callSeq}`, method, params: params ?? {} })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) return done(new Error('herdr answer too large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.error) done(new Error(message.error.message || message.error.code || 'herdr error'));
        else done(null, message.result);
      } catch (error) {
        done(error);
      }
    });
    socket.on('error', (error) => done(new Error(`herdr unavailable: ${error.message}`)));
    socket.on('close', () => {
      if (!settled) done(new Error('herdr closed the connection'));
    });
  });
}

let callSeq = 0;

// Methods a paired phone may call. Reads are already open-ended (`*.list`,
// `*.get`, `*.read`); mutating calls are opt-in, mirroring the desktop app's
// "not available from the phone" allowlist.
const DEFAULT_ALLOWED = new Set([
  'ping',
  'pane.send_text',
  'pane.send_keys',
  'pane.send_input',
  'pane.focus',
  'workspace.focus',
  'tab.focus',
  'agent.send_keys',
]);

export function isAllowedFromPhone(method, allowAll = false) {
  if (allowAll) return true;
  if (DEFAULT_ALLOWED.has(method)) return true;
  return /\.(list|get|read|wait|snapshot)$/.test(method);
}

export function createBridge({ socketPath = defaultSocketPath(), log = () => {}, allowAll = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://bridge.local');
    res.setHeader('access-control-allow-origin', 'null');
    try {
      if (url.pathname === '/healthz') {
        const result = await herdrCall(socketPath, 'ping', {}, 5000);
        return json(res, 200, { ok: true, herdr: result });
      }
      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        const result = await herdrCall(socketPath, 'session.snapshot', {}, 5000);
        return json(res, 200, result);
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body?.method) return json(res, 400, { error: 'method is required' });
        if (!isAllowedFromPhone(String(body.method), allowAll)) {
          return json(res, 403, { error: `${body.method} is not available from the phone` });
        }
        const result = await herdrCall(socketPath, String(body.method), body.params ?? {}, body.timeoutMs ?? 15000);
        return json(res, 200, { result });
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      log('bridge error', error?.message ?? String(error));
      json(res, 502, { error: error?.message ?? String(error) });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://bridge.local');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    acceptUpgrade(req, socket, head, { onConnection: (ws) => pipeHerdr(ws) });
  });

  // WebSocket <-> herdr socket: one herdr connection per tunnel, JSON lines both ways.
  function pipeHerdr(ws) {
    const upstream = net.createConnection(socketPath);
    let buffer = '';
    upstream.setEncoding('utf8');
    upstream.on('connect', () => log('bridge ws upstream connected'));
    upstream.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        ws.close(1011, 'event line too large');
        upstream.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) ws.send(line);
      }
    });
    upstream.on('error', (error) => ws.close(1011, `herdr: ${error.message}`));
    upstream.on('close', () => ws.close(1000, 'herdr closed'));
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? Buffer.from(data).toString('utf8') : String(data);
      if (upstream.destroyed) return;
      upstream.write(text.endsWith('\n') ? text : `${text}\n`);
    });
    ws.on('close', () => upstream.destroy());
  }

  return {
    server,
    socketPath,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolvePromise) => server.listen(port, host, () => resolvePromise(server.address())));
    },
    close() {
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolvePromise(null);
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
