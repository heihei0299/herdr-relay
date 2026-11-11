// Relay server: a faithful port of the official `alma-relay` 1.2.0 Node
// edition (github.com/yetone/alma-relay, MIT) onto this project's dependency-
// free WebSocket layer.
//
//   desktop (agent)  --outbound WSS-->  relay  <--HTTPS/WSS--  phone (client)
//
// The desktop dials the relay and registers with sha256_hex(token). Phones
// speak ordinary HTTP/WebSocket to /c/<token>/...: every HTTP request becomes
// an `hreq` frame on the agent socket, every WebSocket becomes `wopen`. The
// relay only ever sees ciphertext when the desktop enables end-to-end
// encryption; the E2E session runs inside one bridged `/__alma_e2e__` socket.
//
// Wire protocol: docs/PROTOCOL.md in yetone/alma-relay. Protocol 2 adds binary
// payload frames and streamed request bodies.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as http2Connect, constants as http2Constants } from 'node:http2';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { acceptUpgrade } from '../protocol/ws.mjs';
import {
  apnsSignerFromEnv,
  apnsTopic,
  apnsHost,
  apnsRequestHeaders,
  clampBatch,
  validateNotification,
  resultFromResponse,
} from './apns.mjs';
import { fcmSenderFromEnv, deliverPush } from './fcm.mjs';
import {
  BIN,
  BODY_SLICE,
  BODY_WINDOW,
  VERSION,
  authorize,
  bearerOf,
  decodeBinary,
  encodeBinary,
  isTokenHash,
  negotiateProtocol,
  parseClientPath,
  sanitizeCloseCode,
  turnCredentials,
} from './shared.mjs';

const MB = 1024 * 1024;
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

/** A non-negative number from the environment, or the default. 0 means "no limit". */
const limit = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function createRelay({ webRoot = null, log = () => {}, env = process.env } = {}) {
  const PORT = Number(env.PORT || 8787);
  const HOST = env.HOST || '0.0.0.0';
  const MAX_BODY = limit(env.MAX_BODY_MB, 128) * MB || Infinity; // one request body
  const MAX_BUFFERED = limit(env.MAX_BUFFERED_MB, 512) * MB; // all request bodies being buffered at once
  const MAX_AGENTS = limit(env.MAX_AGENTS, 10_000);
  const MAX_REQUESTS_PER_AGENT = limit(env.MAX_REQUESTS_PER_AGENT, 256); // concurrent HTTP requests
  const MAX_SOCKETS_PER_AGENT = limit(env.MAX_SOCKETS_PER_AGENT, 256); // concurrent bridged WebSockets
  const MAX_CONNECTIONS = limit(env.MAX_CONNECTIONS, 0); // TCP connections to this process
  const STALL_MS = limit(env.STALL_TIMEOUT_S, 60) * 1000; // a phone that drains nothing for this long is cut off
  const RELAY_PROTOCOL = negotiateProtocol(env.RELAY_PROTOCOL || 2);
  const HEAD_TIMEOUT_MS = 120_000; // waiting for the desktop to answer
  const REGISTER_TIMEOUT_MS = 10_000; // an agent socket must register within this
  const PING_INTERVAL_MS = 30_000;
  // Frame caps. They match the Cloudflare edition (Durable Object messages are
  // capped at 32 MiB), so a desktop that works with one works with the other.
  const AGENT_MAX_FRAME = 32 * MB;
  const CLIENT_MAX_MESSAGE = 24 * MB; // base64 makes it at most 32 MiB in a wmsg frame
  const OPEN_QUEUE_MAX = 4 * MB; // phone bytes held while the desktop opens its side
  // Flow control: above HIGH_WATER buffered bytes the sender is paused until
  // the buffer drains below LOW_WATER.
  const HIGH_WATER = 8 * MB;
  const LOW_WATER = 1 * MB;
  const FLOW_TICK_MS = 25;

  // ---------------------------------------------------------------------------
  // Push (optional). With no key the relay answers `unsupported` and the
  // desktop stops asking.
  // ---------------------------------------------------------------------------
  const apnsEnv = {
    ...env,
    APNS_KEY: env.APNS_KEY || (env.APNS_KEY_FILE ? readFileSync(env.APNS_KEY_FILE, 'utf8') : ''),
  };
  let apnsSigner = null;
  try {
    apnsSigner = apnsSignerFromEnv(apnsEnv);
  } catch (error) {
    log(`APNs key misconfigured: ${error instanceof Error ? error.message : error}`);
  }
  const APNS_TOPIC = apnsTopic(apnsEnv);

  let fcmSender = null;
  try {
    fcmSender = fcmSenderFromEnv({
      ...env,
      FCM_SERVICE_ACCOUNT:
        env.FCM_SERVICE_ACCOUNT || (env.FCM_SERVICE_ACCOUNT_FILE ? readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : ''),
    });
  } catch (error) {
    log(`FCM service account misconfigured: ${error instanceof Error ? error.message : error}`);
  }

  /** One notification over a fresh HTTP/2 session (Node's fetch is HTTP/1.1 only). */
  function apnsPostHttp2(host, path, headers, body) {
    return new Promise((resolvePromise, reject) => {
      const session = http2Connect(`https://${host}`);
      const finish = (fn) => (value) => {
        session.close();
        fn(value);
      };
      session.on('error', finish(reject));
      const request = session.request({
        ...headers,
        [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
        [http2Constants.HTTP2_HEADER_PATH]: path,
      });
      let status = 0;
      const chunks = [];
      request.on('response', (header) => {
        status = Number(header[http2Constants.HTTP2_HEADER_STATUS] || 0);
      });
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', finish(() => resolvePromise({ status, body: Buffer.concat(chunks).toString('utf8') })));
      request.on('error', finish(reject));
      request.setTimeout(15_000, () => request.close(http2Constants.NGHTTP2_CANCEL));
      request.end(body);
    });
  }

  async function sendPushBatch(notifications) {
    const results = [];
    for (const notification of clampBatch(notifications)) {
      const invalid = validateNotification(notification);
      if (invalid) {
        results.push({
          token: typeof notification?.token === 'string' ? notification.token : '',
          status: 400,
          reason: invalid,
        });
        continue;
      }
      try {
        const auth = await apnsSigner.token();
        const { status, body } = await apnsPostHttp2(
          apnsHost(notification.environment),
          `/3/device/${notification.token}`,
          apnsRequestHeaders(auth, APNS_TOPIC, notification),
          JSON.stringify(notification.payload),
        );
        results.push({ token: notification.token, ...resultFromResponse(status, body) });
      } catch (error) {
        results.push({
          token: notification.token,
          status: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /** tokenHash -> Agent */
  const agents = new Map();
  /** Every live bridged phone WebSocket, so close() can release them. */
  const clientSockets = new Set();
  /** Bytes of phone request bodies held in memory right now (see MAX_BUFFERED). */
  let bufferedBodies = 0;

  const sha256 = (s) => createHash('sha256').update(s).digest('hex');

  class Agent {
    constructor(ws, tokenHash, name, proto = 1) {
      this.ws = ws;
      this.tokenHash = tokenHash;
      this.name = String(name || 'desktop').slice(0, 64);
      this.proto = proto;
      this.nextId = 1;
      this.http = new Map();
      this.sockets = new Map();
      this.inflight = 0;
      this.isAlive = true;
      this.registeredAt = Date.now();
      this.lastSeenAt = Date.now();
      this.sinks = new Map();
      this.waiting = new Set();
      this.paused = false;
      this.flowTimer = null;
    }

    send(frame) {
      if (this.ws.readyState === 'open') {
        this.ws.send(JSON.stringify(frame));
      }
    }

    /** A binary frame (protocol 2 only). */
    sendBinary(kind, id, payload) {
      if (this.ws.readyState === 'open') {
        this.ws.send(encodeBinary(kind, id, payload), { binary: true });
      }
    }

    /** A phone WebSocket message, in the form this desktop speaks. */
    sendWs(id, data, isBinary) {
      if (this.proto >= 2) this.sendBinary(isBinary ? BIN.WBIN : BIN.WTEXT, id, data);
      else if (isBinary) this.send({ t: 'wmsg', id, b: Buffer.from(data).toString('base64') });
      else this.send({ t: 'wmsg', id, s: data.toString() });
    }

    id(prefix) {
      return `${prefix}${this.nextId++}`;
    }

    congested(key, level, kill) {
      if (!this.sinks.has(key)) this.sinks.set(key, { level, kill, last: level(), since: Date.now() });
      if (!this.paused) {
        this.paused = true;
        this.ws.pause();
      }
      this.startFlow();
    }

    throttle(source) {
      if (this.ws.bufferedAmount <= HIGH_WATER || this.waiting.has(source)) return;
      source.pause();
      this.waiting.add(source);
      this.startFlow();
    }

    startFlow() {
      if (!this.flowTimer) this.flowTimer = setInterval(() => this.flowTick(), FLOW_TICK_MS);
    }

    flowTick() {
      const now = Date.now();
      for (const [key, sink] of this.sinks) {
        const level = sink.level();
        if (level < LOW_WATER) {
          this.sinks.delete(key);
        } else if (level < sink.last) {
          sink.last = level;
          sink.since = now;
        } else if (STALL_MS && now - sink.since > STALL_MS) {
          this.sinks.delete(key);
          try {
            sink.kill();
          } catch {
            /* ignore */
          }
        }
      }
      if (this.paused && !this.sinks.size) {
        this.paused = false;
        this.isAlive = true; // pongs were not read while paused
        if (this.ws.readyState === 'open') this.ws.resume();
      }
      if (this.waiting.size && (this.ws.bufferedAmount < LOW_WATER || this.ws.readyState !== 'open')) {
        for (const source of this.waiting) source.resume();
        this.waiting.clear();
      }
      if (!this.sinks.size && !this.waiting.size) this.stopFlow();
    }

    stopFlow() {
      clearInterval(this.flowTimer);
      this.flowTimer = null;
    }

    /** Fail in-flight requests and close every bridged phone socket. */
    destroy(reason = 'Desktop disconnected') {
      this.stopFlow();
      this.sinks.clear();
      this.waiting.clear();
      for (const [id, entry] of this.http) {
        clearTimeout(entry.timer);
        entry.upload?.stop();
        if (!entry.headSent) {
          respondJson(entry.res, 502, { error: 'Desktop disconnected from relay' });
        } else {
          entry.res.destroy();
        }
        this.http.delete(id);
      }
      for (const [id, bridge] of this.sockets) {
        try {
          bridge.client.close(1012, reason);
        } catch {
          /* ignore */
        }
        this.sockets.delete(id);
      }
    }
  }

  /**
   * A phone's request body being streamed to a protocol-2 desktop. The relay
   * sends at most BODY_WINDOW bytes the desktop has not acknowledged (`hack`),
   * so a desktop that reads slowly slows the phone's upload down over TCP
   * instead of filling the relay's memory.
   */
  class Upload {
    constructor(req, onStall) {
      this.req = req;
      this.onStall = onStall;
      this.credit = BODY_WINDOW;
      this.holds = new Set();
      this.done = false;
      this.stallTimer = null;
    }

    hold(reason) {
      if (this.done || this.holds.has(reason)) return;
      if (!this.holds.size) this.req.pause();
      this.holds.add(reason);
    }

    release(reason) {
      if (this.holds.delete(reason) && !this.holds.size && !this.done) this.req.resume();
    }

    pause() {
      this.hold('socket');
    }

    resume() {
      this.release('socket');
    }

    spend(n) {
      this.credit -= n;
      if (this.credit > 0 || this.holds.has('credit')) return;
      this.hold('credit');
      if (STALL_MS) this.stallTimer = setTimeout(() => this.onStall(), STALL_MS);
    }

    refund(n) {
      if (!(n > 0)) return;
      this.credit = Math.min(BODY_WINDOW, this.credit + n);
      if (this.credit > 0 && this.holds.has('credit')) {
        clearTimeout(this.stallTimer);
        this.release('credit');
      }
    }

    stop() {
      if (this.done) return;
      this.done = true;
      clearTimeout(this.stallTimer);
      this.holds.clear();
      this.req.resume();
    }
  }

  function respondJson(res, status, obj, extraHeaders = {}) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extraHeaders });
    res.end(JSON.stringify(obj));
  }

  /**
   * Refuse the rest of a request body without losing the reply: a socket torn
   * down the moment the reply is written can reach a phone still uploading as
   * EPIPE instead of the status.
   */
  function dropAfterReply(req, res) {
    req.on('data', () => {});
    req.resume();
    const hangUp = () => setTimeout(() => req.destroy(), 1000).unref?.();
    if (res.writableFinished) hangUp();
    else res.once('finish', hangUp);
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  const server = createServer((req, res) => {
    const url = req.url || '';
    const pathname = url.split('?')[0];

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          edition: 'node',
          version: VERSION,
          protocol: RELAY_PROTOCOL,
          agents: agents.size,
          sockets: clientSockets.size,
        }),
      );
      return;
    }

    if (pathname === '/') {
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (webRoot && wantsHtml) {
        serveStatic(pathname, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `Alma relay ${VERSION} is running.\nUse this address in Alma → Settings → Remote Access → Use a self-hosted relay.\n`,
      );
      return;
    }

    if (pathname === '/turn') {
      if (req.method !== 'POST' && req.method !== 'GET') {
        respondJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      (async () => {
        const auth = await authorize(env, bearerOf(req.headers.authorization));
        if (!auth.ok) return respondJson(res, 401, { error: auth.message });
        const creds = await turnCredentials(env, auth.subject || bearerOf(req.headers.authorization));
        if (!creds) return respondJson(res, 404, { error: 'TURN not configured on this relay' });
        respondJson(res, 200, creds);
      })().catch(() => respondJson(res, 500, { error: 'TURN credentials failed' }));
      return;
    }

    const parsed = parseClientPath(url);
    if (!parsed) {
      if (webRoot) {
        serveStatic(pathname, res);
        return;
      }
      respondJson(res, 404, { error: 'Not found' });
      return;
    }

    const agent = agents.get(sha256(parsed.code));
    if (!agent) {
      respondJson(res, 502, { error: 'Desktop is offline or the connect code is invalid' });
      return;
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      respondJson(res, 413, { error: 'Request body too large' });
      req.resume();
      return;
    }
    if (MAX_REQUESTS_PER_AGENT && agent.inflight >= MAX_REQUESTS_PER_AGENT) {
      respondJson(res, 503, { error: 'Too many concurrent requests to this desktop' });
      req.resume();
      return;
    }
    agent.inflight++;
    res.on('close', () => agent.inflight--);

    if (agent.proto >= 2) {
      streamRequest(agent, req, res, parsed.rest);
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    let held = 0;
    const release = () => {
      bufferedBodies -= held;
      held = 0;
    };
    res.on('close', release);

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        release();
        respondJson(res, 413, { error: 'Request body too large' }, { Connection: 'close' });
        dropAfterReply(req, res);
        return;
      }
      if (MAX_BUFFERED && bufferedBodies + chunk.length > MAX_BUFFERED) {
        aborted = true;
        release();
        respondJson(res, 503, { error: 'Relay is busy, try again shortly' }, { Connection: 'close' });
        dropAfterReply(req, res);
        return;
      }
      bufferedBodies += chunk.length;
      held += chunk.length;
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      if (agents.get(agent.tokenHash) !== agent || agent.ws.readyState !== 'open') {
        release();
        respondJson(res, 502, { error: 'Desktop disconnected from relay' });
        return;
      }
      const id = agent.id('h');
      const headers = tunneledHeaders(req);

      const timer = setTimeout(() => {
        const entry = agent.http.get(id);
        if (entry && !entry.headSent) {
          agent.http.delete(id);
          agent.send({ t: 'hcancel', id });
          respondJson(res, 504, { error: 'Desktop did not respond in time' });
        }
      }, HEAD_TIMEOUT_MS);

      agent.http.set(id, { res, headSent: false, timer });

      res.on('close', () => {
        if (agent.http.has(id)) {
          agent.http.delete(id);
          clearTimeout(timer);
          agent.send({ t: 'hcancel', id });
        }
      });

      const body = chunks.length ? Buffer.concat(chunks) : null;
      chunks.length = 0;
      agent.send({
        t: 'hreq',
        id,
        method: req.method,
        path: parsed.rest,
        headers,
        b: body ? body.toString('base64') : undefined,
      });
      release();
    });

    req.on('error', () => {});
  });

  function tunneledHeaders(req) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['accept-encoding']; // the agent requests identity to keep lengths honest
    return headers;
  }

  /**
   * Protocol 2: the desktop gets `hreq` as soon as the head arrives and the
   * body follows in HBODY frames, so nothing is buffered here.
   */
  function streamRequest(agent, req, res, path) {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    const id = agent.id('h');
    const entry = { res, headSent: false, timer: null, upload: null };
    agent.http.set(id, entry);
    const live = () => agent.http.get(id) === entry;

    const armHeadTimer = () => {
      entry.timer = setTimeout(() => {
        if (live() && !entry.headSent) fail(504, 'Desktop did not respond in time');
      }, HEAD_TIMEOUT_MS);
    };
    const fail = (status, message) => {
      if (!live()) return;
      agent.http.delete(id);
      clearTimeout(entry.timer);
      entry.upload?.stop();
      agent.send({ t: 'hcancel', id });
      if (entry.headSent) return res.destroy();
      respondJson(res, status, { error: message });
    };

    res.on('close', () => {
      if (!live()) return;
      agent.http.delete(id);
      clearTimeout(entry.timer);
      entry.upload?.stop();
      agent.send({ t: 'hcancel', id });
    });
    req.on('error', () => {});

    agent.send({
      t: 'hreq',
      id,
      method: req.method,
      path,
      headers: tunneledHeaders(req),
      ...(hasBody ? { stream: true } : {}),
    });
    if (!hasBody) {
      armHeadTimer();
      req.resume();
      return;
    }

    const upload = new Upload(req, () => fail(504, 'Desktop stopped reading the request body'));
    entry.upload = upload;
    let size = 0;
    req.on('data', (chunk) => {
      if (upload.done) return;
      if (!live()) return upload.stop();
      size += chunk.length;
      if (size > MAX_BODY) {
        res.setHeader('Connection', 'close');
        fail(413, 'Request body too large');
        dropAfterReply(req, res);
        return;
      }
      for (let offset = 0; offset < chunk.length; offset += BODY_SLICE) {
        agent.sendBinary(BIN.HBODY, id, chunk.subarray(offset, offset + BODY_SLICE));
      }
      upload.spend(chunk.length);
      agent.throttle(upload);
    });
    req.on('end', () => {
      if (upload.done) return;
      upload.stop();
      if (!live()) return;
      agent.send({ t: 'hreqend', id });
      if (!entry.headSent) armHeadTimer();
    });
  }

  // ---------------------------------------------------------------------------
  // WebSockets
  // ---------------------------------------------------------------------------

  function refuseUpgrade(socket, status) {
    socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url === '/agent' || url.startsWith('/agent?')) {
      acceptUpgrade(req, socket, head, { maxPayload: AGENT_MAX_FRAME, onConnection: (ws) => handleAgent(ws) });
      return;
    }
    const parsed = parseClientPath(url);
    if (parsed) {
      const agent = agents.get(sha256(parsed.code));
      if (!agent) return refuseUpgrade(socket, '502 Bad Gateway');
      if (MAX_SOCKETS_PER_AGENT && agent.sockets.size >= MAX_SOCKETS_PER_AGENT) {
        return refuseUpgrade(socket, '503 Service Unavailable');
      }
      acceptUpgrade(req, socket, head, {
        maxPayload: CLIENT_MAX_MESSAGE,
        onConnection: (ws) => handleClientSocket(ws, agent, parsed.rest),
      });
      return;
    }
    refuseUpgrade(socket, '404 Not Found');
  });

  function handleAgent(ws) {
    let agent = null;
    let registering = false;
    const registerTimer = setTimeout(() => {
      if (!agent) ws.terminate();
    }, REGISTER_TIMEOUT_MS);
    registerTimer.unref?.();

    ws.on('message', async (data, isBinary) => {
      if (isBinary && agent && agent.proto >= 2) {
        onBinaryFrame(agent, data);
        return;
      }
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }

      if (frame.t === 'register') {
        if (agent || registering) return;
        registering = true;
        const auth = await authorize(env, frame.key);
        if (!auth.ok) {
          ws.send(JSON.stringify({ t: 'error', message: auth.message }));
          ws.close(auth.code, auth.reason);
          return;
        }
        if (!isTokenHash(frame.tokenHash)) {
          ws.send(JSON.stringify({ t: 'error', message: 'Invalid token hash' }));
          ws.close(4002, 'Invalid token hash');
          return;
        }
        if (ws.readyState !== 'open') return;
        const existing = agents.get(frame.tokenHash);
        if (!existing && MAX_AGENTS && agents.size >= MAX_AGENTS) {
          ws.send(JSON.stringify({ t: 'error', message: 'This relay is full' }));
          ws.close(1013, 'Relay is full');
          return;
        }
        clearTimeout(registerTimer);
        if (existing) {
          existing.destroy('Desktop reconnected');
          try {
            existing.ws.close(4000, 'Replaced by a newer connection');
          } catch {
            /* ignore */
          }
        }
        const proto = negotiateProtocol(frame.proto, RELAY_PROTOCOL);
        agent = new Agent(ws, frame.tokenHash, frame.name, proto);
        agents.set(frame.tokenHash, agent);
        ws.send(JSON.stringify({ t: 'registered', proto }));
        log(`agent registered${auth.subject ? ` for ${auth.subject}` : ''}; agents=${agents.size}`);
        return;
      }

      if (!agent) return;
      agent.lastSeenAt = Date.now();

      switch (frame.t) {
        case 'push': {
          const id = String(frame.id || '');
          if (!apnsSigner && !fcmSender) {
            agent.send({ t: 'pushed', id, unsupported: true });
            return;
          }
          deliverPush(frame.notifications, {
            sendApns: apnsSigner ? sendPushBatch : null,
            fcm: fcmSender,
          }).then((results) => {
            const failed = results.filter((result) => result.status !== 200);
            if (failed.length) log(`push: ${failed.length}/${results.length} rejected`);
            agent.send({ t: 'pushed', id, results });
          });
          return;
        }
        case 'hres': {
          const entry = agent.http.get(frame.id);
          if (!entry) {
            agent.send({ t: 'hcancel', id: frame.id });
            return;
          }
          clearTimeout(entry.timer);
          entry.headSent = true;
          const headers = { ...(frame.headers || {}) };
          delete headers.connection;
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];
          try {
            entry.res.writeHead(frame.status || 200, headers);
            entry.res.flushHeaders();
          } catch {
            agent.http.delete(frame.id);
            agent.send({ t: 'hcancel', id: frame.id });
            try {
              entry.res.destroy();
            } catch {
              /* ignore */
            }
          }
          break;
        }
        case 'hchunk':
          writeResponseBody(agent, frame.id, Buffer.from(frame.b || '', 'base64'));
          break;
        case 'hack':
          agent.http.get(frame.id)?.upload?.refund(Number(frame.n));
          break;
        case 'hend': {
          const entry = agent.http.get(frame.id);
          if (!entry) return;
          agent.http.delete(frame.id);
          entry.upload?.stop();
          try {
            entry.res.end();
          } catch {
            /* ignore */
          }
          break;
        }
        case 'herr': {
          const entry = agent.http.get(frame.id);
          if (!entry) return;
          agent.http.delete(frame.id);
          clearTimeout(entry.timer);
          entry.upload?.stop();
          if (!entry.headSent) {
            respondJson(entry.res, 502, { error: frame.message || 'Upstream error' });
          } else {
            entry.res.destroy();
          }
          break;
        }
        case 'wopened': {
          const bridge = agent.sockets.get(frame.id);
          if (!bridge) {
            agent.send({ t: 'wclose', id: frame.id, code: 1000 });
            return;
          }
          bridge.opened = true;
          for (const queued of bridge.queue) agent.sendWs(frame.id, queued.data, queued.isBinary);
          bridge.queue = [];
          bridge.queued = 0;
          agent.throttle(bridge.client);
          break;
        }
        case 'werr': {
          const bridge = agent.sockets.get(frame.id);
          if (!bridge) return;
          agent.sockets.delete(frame.id);
          try {
            bridge.client.close(1011, 'Desktop could not open the socket');
          } catch {
            /* ignore */
          }
          break;
        }
        case 'wmsg':
          if (typeof frame.s === 'string') sendToPhone(agent, frame.id, frame.s, false);
          else if (typeof frame.b === 'string') sendToPhone(agent, frame.id, Buffer.from(frame.b, 'base64'), true);
          break;
        case 'wclose': {
          const bridge = agent.sockets.get(frame.id);
          if (!bridge) return;
          agent.sockets.delete(frame.id);
          try {
            bridge.client.close(sanitizeCloseCode(frame.code), String(frame.reason || '').slice(0, 120));
          } catch {
            /* ignore */
          }
          break;
        }
        default:
          break;
      }
    });

    ws.on('pong', () => {
      if (agent) agent.isAlive = true;
    });

    ws.on('close', () => {
      clearTimeout(registerTimer);
      if (agent) agent.stopFlow();
      if (agent && agents.get(agent.tokenHash) === agent) {
        agents.delete(agent.tokenHash);
        agent.destroy();
        log(`agent disconnected; agents=${agents.size}`);
      }
    });

    ws.on('error', () => {});
  }

  function onBinaryFrame(agent, data) {
    const frame = decodeBinary(data);
    if (!frame) return;
    switch (frame.kind) {
      case BIN.HCHUNK:
        return writeResponseBody(agent, frame.id, frame.data);
      case BIN.WBIN:
        return sendToPhone(agent, frame.id, frame.data, true);
      case BIN.WTEXT:
        return sendToPhone(agent, frame.id, frame.data, false);
      default:
        return;
    }
  }

  function writeResponseBody(agent, id, bytes) {
    const entry = agent.http.get(id);
    if (!entry) return;
    const { res } = entry;
    try {
      res.write(bytes);
    } catch {
      /* ignore */
    }
    if (res.writableLength > HIGH_WATER) {
      agent.congested(
        `h:${id}`,
        () => (res.destroyed ? -1 : res.writableLength),
        () => {
          agent.http.delete(id);
          agent.send({ t: 'hcancel', id });
          res.destroy();
        },
      );
    }
  }

  /** `data` is a string or bytes; a text message may arrive as UTF-8 bytes. */
  function sendToPhone(agent, id, data, isBinary) {
    const bridge = agent.sockets.get(id);
    if (!bridge || bridge.client.readyState !== 'open') return;
    const { client } = bridge;
    client.send(data, { binary: isBinary });
    if (client.bufferedAmount > HIGH_WATER) {
      agent.congested(
        `w:${id}`,
        () => (client.readyState === 'open' ? client.bufferedAmount : -1),
        () => client.terminate(),
      );
    }
  }

  function handleClientSocket(clientWs, agent, path) {
    clientSockets.add(clientWs);
    const id = agent.id('w');
    const bridge = { client: clientWs, opened: false, queue: [], queued: 0 };
    agent.sockets.set(id, bridge);
    agent.send({ t: 'wopen', id, path });

    clientWs.on('message', (data, isBinary) => {
      if (bridge.opened) {
        agent.sendWs(id, data, isBinary);
        agent.throttle(clientWs);
        return;
      }
      bridge.queued += Buffer.byteLength(data);
      if (bridge.queued > OPEN_QUEUE_MAX) {
        bridge.queue = [];
        clientWs.close(1009, 'Too much data before the desktop answered');
        return;
      }
      bridge.queue.push({ data, isBinary });
    });

    clientWs.on('close', (code, reason) => {
      clientSockets.delete(clientWs);
      if (agent.sockets.has(id)) {
        agent.sockets.delete(id);
        agent.send({ t: 'wclose', id, code: sanitizeCloseCode(code), reason: reason?.toString() });
      }
    });

    clientWs.on('error', () => {});
  }

  // ---------------------------------------------------------------------------
  // Static phone UI (optional)
  // ---------------------------------------------------------------------------

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

  // Terminate dead agent connections.
  const pinger = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.paused) continue;
      if (!agent.isAlive) {
        try {
          agent.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      agent.isAlive = false;
      try {
        agent.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, PING_INTERVAL_MS);
  pinger.unref?.();

  return {
    server,
    agents,
    get protocol() {
      return RELAY_PROTOCOL;
    },
    listen(port = PORT, host = HOST) {
      return new Promise((resolvePromise) => {
        server.listen(port, host, () => resolvePromise(server.address()));
      });
    },
    close() {
      clearInterval(pinger);
      for (const agent of agents.values()) {
        agent.destroy('Relay shutting down');
        try {
          agent.ws.close(1012, 'Relay restarting');
        } catch {
          /* ignore */
        }
      }
      for (const client of clientSockets) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      clientSockets.clear();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
