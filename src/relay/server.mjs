// Relay server: routes phone browsers to their desktop agent.
//
//   desktop  ->  ws(s)://host/agent?th=<tokenHash>      (registers with {t:"register"})
//   phone    ->  ws(s)://host/c/<routingId>/<path>      (path forwarded, e.g. /__alma_e2e__)
//
// The relay never holds the pairing code and never parses phone payloads: it
// forwards them verbatim inside `wmsg` frames, so only the desktop and the
// phone can read them (end-to-end encryption lives in web/lib/e2e.js).

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { acceptUpgrade } from '../protocol/ws.mjs';
import { KIND_SOCKET_BINARY, KIND_SOCKET_TEXT, decodeRecord, encodeRecord, sendJson } from '../protocol/relay-frames.mjs';

const MAX_PHONE_SOCKET_IDLE_MS = 30 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function createRelay({ webRoot, log = () => {} } = {}) {
  /** tokenHash -> { ws, routingId, name, proto, connectedAt } */
  const agents = new Map();
  /** routingId -> { agentWs, phones: Map<channelId, {ws, opening}>, counter } */
  const routes = new Map();
  /** agentWs -> tunnel (so frames coming back from a desktop find their phone) */
  const tunnelByAgent = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      await handleHttp(req, res);
    } catch (error) {
      log('http error', error?.message ?? String(error));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://relay.local');
    if (url.pathname === '/agent') {
      acceptUpgrade(req, socket, head, { onConnection: (ws) => onAgent(ws, url) });
      return;
    }
    if (url.pathname.startsWith('/c/')) {
      acceptUpgrade(req, socket, head, { onConnection: (ws) => onPhone(ws, url) });
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  const heartbeat = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.ws.alive === false) {
        log('agent ping timeout');
        agent.ws.terminate();
        continue;
      }
      agent.ws.alive = false;
      agent.ws.ping();
    }
  }, 20000);
  heartbeat.unref?.();

  server.on('close', () => clearInterval(heartbeat));

  // --- desktop side --------------------------------------------------------

  function onAgent(ws, url) {
    const tokenHash = url.searchParams.get('th') || '';
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
      sendJson(ws, { t: 'error', message: 'invalid token' });
      ws.close(4401, 'invalid token');
      return;
    }
    const previous = agents.get(tokenHash);
    if (previous && previous.ws !== ws) {
      sendJson(previous.ws, { t: 'error', message: 'replaced' });
      previous.ws.close(4000, 'replaced');
      dropAgent(previous.ws);
    }

    const agent = { ws, tokenHash, routingId: previous?.routingId ?? null, name: 'Herdr Desktop', proto: 1, connectedAt: Date.now() };
    agents.set(tokenHash, agent);
    ws.alive = true;

    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const record = decodeRecord(data);
        if (record) routeFromAgent(ws, record);
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      onAgentControl(ws, agent, message);
    });
    ws.on('close', () => {
      if (agents.get(tokenHash)?.ws === ws) agents.delete(tokenHash);
      dropAgent(ws);
      log('agent disconnected');
    });
    ws.on('error', () => {});
  }

  function onAgentControl(ws, agent, message) {
    switch (message.t) {
      case 'register': {
        if (message.tokenHash && message.tokenHash !== agent.tokenHash) {
          sendJson(ws, { t: 'error', message: 'token mismatch' });
          ws.close(4401, 'token mismatch');
          return;
        }
        agent.name = String(message.name || 'Alma Desktop');
        agent.proto = Number(message.proto) || 1;
        // Alma's desktop app sends only the token hash; the routing id is
        // recovered by hashing the id the phone puts in its path.
        if (typeof message.routingId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(message.routingId)) {
          bindRoute(agent, message.routingId);
        }
        log(`agent registered (${agent.name})`);
        sendJson(ws, { t: 'registered', proto: 2 });
        return;
      }
      case 'wopened':
      case 'werr': {
        const phone = tunnelByAgent.get(ws)?.phones.get(String(message.id));
        if (!phone) return;
        phone.opening = false;
        if (message.t === 'wopened') {
          sendJson(phone.ws, { t: 'ready' });
        } else {
          sendJson(phone.ws, { t: 'error', message: String(message.message || 'desktop rejected the tunnel') });
          phone.ws.close(4412, 'upstream rejected');
        }
        return;
      }
      case 'hres':
      case 'hchunk':
      case 'hend':
      case 'herr': {
        const tunnel = tunnelByAgent.get(ws);
        const mapped = tunnel?.requests.get(String(message.id));
        if (!mapped) return;
        if (mapped.origCode) message.code = mapped.origCode;
        const forwarded = { ...message, id: mapped.phoneId };
        if (message.t === 'hend' || message.t === 'herr') tunnel.requests.delete(String(message.id));
        sendJson(mapped.phoneWs, forwarded);
        return;
      }
      case 'wmsg': {
        const phone = tunnelByAgent.get(ws)?.phones.get(String(message.id));
        if (!phone) return;
        if (typeof message.s === 'string') phone.ws.send(message.s);
        else if (typeof message.b === 'string') phone.ws.send(Buffer.from(message.b, 'base64'));
        return;
      }
      case 'wclose': {
        const tunnel = tunnelByAgent.get(ws);
        const phone = tunnel?.phones.get(String(message.id));
        if (!phone) return;
        tunnel.phones.delete(String(message.id));
        phone.ws.close(Number(message.code) || 1000, String(message.reason || ''));
        return;
      }
      case 'pushed':
        return;
      default:
        return;
    }
  }

  function routeFromAgent(ws, record) {
    const phone = tunnelByAgent.get(ws)?.phones.get(record.id);
    if (!phone) return;
    if (record.kind === KIND_SOCKET_TEXT) phone.ws.send(record.data.toString('utf8'));
    else if (record.kind === KIND_SOCKET_BINARY) phone.ws.send(record.data);
  }

  function dropAgent(ws) {
    for (const [routingId, tunnel] of routes) {
      if (tunnel.agentWs !== ws) continue;
      routes.delete(routingId);
      tunnelByAgent.delete(ws);
      for (const phone of tunnel.phones.values()) phone.ws.close(4411, 'desktop offline');
    }
  }

  // --- phone side ----------------------------------------------------------

  function onPhone(ws, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const routingId = segments[1] || '';
    const forwardPath = `/${segments.slice(2).join('/')}` || '/__alma_e2e__';
    const agent = findAgentByRoutingId(routingId);
    if (!agent) {
      sendJson(ws, { t: 'error', message: 'no desktop is online for this pairing code' });
      ws.close(4410, 'desktop offline');
      return;
    }
    const tunnel = getTunnel(agent, routingId);
    const channelId = `p${tunnel.counter++}`;
    const phone = { ws, opening: true };
    tunnel.phones.set(channelId, phone);
    log(`phone connected on ${forwardPath}`);

    const idleTimer = setTimeout(() => ws.close(4408, 'idle'), MAX_PHONE_SOCKET_IDLE_MS);
    idleTimer.unref?.();

    sendJson(tunnel.agentWs, { t: 'wopen', id: channelId, path: forwardPath });

    ws.on('message', (data, isBinary) => {
      if (tunnel.agentWs.readyState !== 'open') return;
      if (isBinary) {
        tunnel.agentWs.send(encodeRecord(KIND_SOCKET_BINARY, channelId, Buffer.from(data)));
        return;
      }
      const text = String(data);
      // Plain (non-E2E) mode: the phone speaks Alma's relay frames directly.
      if (text.startsWith('{"t":"h') || text.startsWith('{"t":"hcancel"')) {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame && typeof frame.t === 'string' && frame.t.startsWith('h')) {
          const relayId = `${channelId}:${frame.id}`;
          if (frame.t === 'hreq') {
            tunnel.requests.set(relayId, { phoneWs: ws, phoneId: frame.id });
            sendJson(tunnel.agentWs, { ...frame, id: relayId });
            return;
          }
          if (frame.t === 'hcancel') {
            sendJson(tunnel.agentWs, { ...frame, id: relayId });
            tunnel.requests.delete(relayId);
            return;
          }
        }
      }
      sendJson(tunnel.agentWs, { t: 'wmsg', id: channelId, s: text });
    });
    ws.on('close', (code) => {
      clearTimeout(idleTimer);
      tunnel.phones.delete(channelId);
      if (tunnel.agentWs.readyState === 'open') {
        sendJson(tunnel.agentWs, { t: 'wclose', id: channelId, code: code || 1000 });
      }
    });
    ws.on('error', () => {});
  }

  function findAgentByRoutingId(routingId) {
    // Alma keys the desktop by `sha256hex(routingId)` (its `tokenHash`), so the
    // phone's path id can be matched without the relay ever learning the code.
    const byHash = agents.get(createHash('sha256').update(routingId).digest('hex'));
    if (byHash) return byHash;
    for (const agent of agents.values()) {
      if (agent.routingId && agent.routingId === routingId) return agent;
    }
    return null;
  }

  function getTunnel(agent, routingId) {
    let tunnel = routes.get(routingId);
    if (!tunnel || tunnel.agentWs !== agent.ws) {
      tunnel = { routingId, agentWs: agent.ws, phones: new Map(), requests: new Map(), counter: 0 };
      routes.set(routingId, tunnel);
      tunnelByAgent.set(agent.ws, tunnel);
    }
    return tunnel;
  }

  function bindRoute(agent, routingId) {
    agent.routingId = routingId;
    const existing = routes.get(routingId);
    if (existing && existing.agentWs !== agent.ws) {
      for (const phone of existing.phones.values()) phone.ws.close(4413, 'desktop replaced');
      routes.delete(routingId);
    }
    getTunnel(agent, routingId);
  }

  // --- http ----------------------------------------------------------------

  async function handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://relay.local');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: agents.size, tunnels: routes.size }));
      return;
    }
    if (url.pathname === '/relay/pair') {
      // Hands the phone the relay origin it is already talking to. The code is
      // never sent to the relay: the phone derives the routing id locally.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, wsBase: `ws${req.socket.encrypted ? 's' : ''}://${req.headers.host}` }));
      return;
    }
    if (!webRoot) {
      res.writeHead(404).end();
      return;
    }
    await serveStatic(url.pathname, res);
  }

  async function serveStatic(pathname, res) {
    const root = resolve(webRoot);
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '');
    let filePath = join(root, rel);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, 'index.html');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  return {
    server,
    agents,
    routes,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolvePromise) => {
        server.listen(port, host, () => resolvePromise(server.address()));
      });
    },
    close() {
      for (const agent of agents.values()) agent.ws.terminate();
      clearInterval(heartbeat);
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
