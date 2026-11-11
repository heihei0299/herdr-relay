// LAN direct server, mirroring Alma's `LanDirect`: the phone fetches
// `/__alma_lan__` through the relay, then dials this desktop directly on the
// local network with the same E2E handshake. The relay is not involved.

import http from 'node:http';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { acceptUpgrade } from '../protocol/ws.mjs';
import { createE2ETunnel } from './tunnel.mjs';

const DEFAULT_PORT = 23019;
const MAX_CLIENTS = 16;
const MAX_PAYLOAD = 64 * 1024 * 1024;

function isPrivateIPv4(address) {
  const [a, b] = String(address).split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Hostnames the phone can try: `<hostname>.local` plus private IPv4 addresses. */
export function lanCandidates() {
  const hosts = [];
  const short = os.hostname().replace(/\.local\.?$/i, '').split('.')[0];
  if (short) hosts.push(`${short}.local`);
  const interfaces = Object.entries(os.networkInterfaces()).sort(([a], [b]) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0));
  for (const [, entries] of interfaces) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateIPv4(entry.address)) continue;
      if (!hosts.includes(entry.address)) hosts.push(entry.address);
    }
  }
  return hosts;
}

function firewallName() {
  if (process.platform !== 'linux') return Promise.resolve(null);
  try {
    if (/^\s*ENABLED\s*=\s*"?yes"?\s*$/im.test(readFileSync('/etc/ufw/ufw.conf', 'utf8'))) return Promise.resolve('ufw');
  } catch {
    /* ignore */
  }
  return new Promise((resolvePromise) => {
    execFile('systemctl', ['is-active', '--quiet', 'firewalld'], { timeout: 3000 }, (error) => {
      resolvePromise(error ? null : 'firewalld');
    });
  });
}

export function createLanDirect({ code, localOrigin, log = () => {}, fetchImpl, port = DEFAULT_PORT } = {}) {
  let server = null;
  let listeningPort = null;
  let firewallFound = null;
  let pingTimer = null;
  const clients = new Set();

  const candidates = () => (listeningPort === null ? null : { port: listeningPort, hosts: lanCandidates() });

  function listen(instance, requestedPort) {
    return new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        instance.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        instance.off('error', onError);
        resolvePromise();
      };
      instance.once('error', onError);
      instance.once('listening', onListening);
      instance.listen(requestedPort, '0.0.0.0');
    });
  }

  async function start() {
    if (server) return;
    const instance = http.createServer((req, res) => {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
    });
    instance.on('upgrade', (req, socket, head) => {
      const pathname = String(req.url || '').split('?')[0];
      if (pathname !== '/__alma_e2e__') {
        socket.destroy();
        return;
      }
      if (clients.size >= MAX_CLIENTS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      acceptUpgrade(req, socket, head, { maxPayload: MAX_PAYLOAD, onConnection: (ws) => onConnection(ws) });
    });
    server = instance;
    try {
      await listen(instance, port);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || server !== instance) {
        if (server === instance) stop();
        throw error;
      }
      await listen(instance, 0);
    }
    if (server !== instance) {
      instance.close();
      return;
    }
    const address = instance.address();
    listeningPort = address && typeof address === 'object' ? address.port : null;
    pingTimer = setInterval(() => {
      for (const client of clients) {
        if (client.alive) {
          client.alive = false;
          client.ping();
        } else {
          client.terminate();
        }
      }
    }, 20000);
    pingTimer.unref?.();
    firewallName().then((name) => {
      if (server !== instance) return;
      firewallFound = name;
      if (name) log(`${name} is on; the phone reaches tcp/${listeningPort} only if it is allowed`);
    });
  }

  function onConnection(ws) {
    clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    const tunnel = createE2ETunnel({
      id: `lan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      code,
      localOrigin,
      fetchImpl,
      lan: candidates,
      drain: async () => {
        while (ws.readyState === 'open' && ws.bufferedAmount > 262144) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      },
      sendRaw: (payload) => {
        if (ws.readyState !== 'open') return;
        if (typeof payload === 'string') ws.send(payload);
        else ws.send(Buffer.from(payload), { binary: true });
      },
      onError: (reason) => {
        log(`LAN tunnel error: ${reason}`);
      },
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        tunnel.onMessage(String(data));
        return;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      tunnel.onMessage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
    ws.on('close', () => {
      clients.delete(ws);
      tunnel.destroy('LAN client closed');
    });
    ws.on('error', () => {
      tunnel.destroy('LAN client error');
    });
  }

  function stop() {
    clearInterval(pingTimer);
    pingTimer = null;
    for (const client of clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    server?.close();
    server = null;
    listeningPort = null;
  }

  return {
    start,
    stop,
    candidates,
    get port() {
      return listeningPort;
    },
    get firewall() {
      return listeningPort === null ? null : firewallFound;
    },
  };
}
