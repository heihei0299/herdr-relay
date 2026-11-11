#!/usr/bin/env node
// herdr-relay CLI
//
//   herdr-relay relay    [--port 8787] [--host 0.0.0.0]
//   herdr-relay bridge   [--port 23020] [--socket /path/to/herdr.sock]
//   herdr-relay desktop  [--relay http://HOST:8787] [--code CODE] [--local http://127.0.0.1:23020]
//   herdr-relay all      # bridge + desktop + relay on one machine (demo / single host)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPairingCode, isValidPairingCode, routingIdForCode } from '../web/lib/e2e.js';
import { createRelay } from './relay/server.mjs';
import { createBridge, defaultSocketPath } from './desktop/herdr-bridge.mjs';
import { createConnector } from './desktop/connector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', 'web');

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

async function runRelay(args) {
  const relay = createRelay({ webRoot, log });
  const port = Number(args.port ?? process.env.PORT ?? 8787);
  const host = args.host ?? process.env.HOST ?? '127.0.0.1';
  const address = await relay.listen(port, host);
  log(`relay listening on http://${address.address}:${address.port} (phone UI at /)`);
  return relay;
}

async function runBridge(args) {
  const socketPath = args.socket ?? defaultSocketPath();
  const bridge = createBridge({ socketPath, log, allowAll: args['allow-all'] === true });
  const address = await bridge.listen(Number(args.port ?? 23020), args.host ?? '127.0.0.1');
  log(`herdr bridge on http://${address.address}:${address.port} -> ${socketPath}`);
  return bridge;
}

async function runDesktop(args) {
  const relayUrl = String(args.relay ?? process.env.RELAY_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const localOrigin = args.local ?? process.env.LOCAL_ORIGIN ?? 'http://127.0.0.1:23020';
  const code = args.code && args.code !== true ? String(args.code) : createPairingCode();
  if (!isValidPairingCode(code)) {
    throw new Error('invalid pairing code; expected 43 base64url characters');
  }
  const e2e = !(String(args.e2e ?? 'on') === 'off' || String(args.e2e ?? 'on') === 'false');
  const lan = args['no-lan'] !== true;
  const relayToken = args['relay-token'] ?? process.env.RELAY_TOKEN ?? null;
  const connector = createConnector({
    relayUrl,
    code,
    localOrigin,
    name: args.name ?? 'Herdr Desktop',
    relayToken,
    e2e,
    lan,
    log,
  });
  const routingId = await routingIdForCode(code);
  await connector.start();
  log('pairing code:  ' + code);
  log('relay:         ' + relayUrl);
  log('routing id:    ' + routingId);
  log(`mode:          ${e2e ? 'end-to-end encrypted' : 'plaintext (E2E off)'} · LAN direct ${lan ? 'on' : 'off'}`);
  log('phone URL:     ' + `${relayUrl}/#code=${code}${e2e ? '' : '&e2e=0'}`);
  log(
    'pairing uri:   ' +
      (e2e
        ? `alma://connect?u=${encodeURIComponent(relayUrl)}&k=${encodeURIComponent(code)}&e2e=1`
        : `alma://connect?u=${encodeURIComponent(`${relayUrl}/c/${code}`)}`),
  );
  connector.onStatus((status) => {
    if (status.status === 'connected') {
      log(`relay accepted the desktop (protocol ${status.proto}); waiting for the phone`);
      if (status.lanPort) log(`LAN direct endpoint: tcp/${status.lanPort}`);
    } else if (status.status === 'error') log('relay connection problem: ' + status.lastError);
    else if (status.status === 'replaced') log('another desktop took over this pairing code');
  });
  return connector;
}

// --- Alma desktop app adapter ---------------------------------------------

async function almaStatus(appUrl) {
  const response = await fetch(new URL('/api/mobile-relay/status', appUrl), { method: 'GET' });
  if (!response.ok) throw new Error(`Alma answered ${response.status}; is the desktop app running?`);
  return response.json();
}

async function almaEnable(appUrl, relayUrl, e2e = true, relayToken = null) {
  const response = await fetch(new URL('/api/mobile-relay/enable', appUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: relayUrl, e2eEncryption: e2e, ...(relayToken ? { relayToken } : {}) }),
  });
  if (!response.ok) throw new Error(`enable failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function almaSetE2E(appUrl, enabled) {
  const response = await fetch(new URL('/api/mobile-relay/e2e', appUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`e2e toggle failed: ${response.status}`);
  return response.json();
}

async function almaPost(appUrl, path, body = null) {
  const response = await fetch(new URL(path, appUrl), {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function almaDisable(appUrl) {
  const response = await fetch(new URL('/api/mobile-relay/disable', appUrl), { method: 'POST' });
  if (!response.ok) throw new Error(`disable failed: ${response.status}`);
  return response.json();
}

async function runAlma(args) {
  const appUrl = String(args.app ?? 'http://127.0.0.1:23001');
  const status = await almaStatus(appUrl);
  if (args.regenerate) {
    const next = await almaPost(appUrl, '/api/mobile-relay/regenerate');
    log(`new pairing code issued (state=${next.state ?? next.connection?.state ?? 'unknown'})`);
    if (next.pairingLink) log('pairing uri:  ' + next.pairingLink);
    if (next.connectUrl) log('connect url:  ' + next.connectUrl);
    return;
  }
  if (args.reconnect) {
    const next = await almaPost(appUrl, '/api/mobile-relay/reconnect');
    log(`Alma relay reconnecting (state=${next.state ?? next.connection?.state ?? 'unknown'})`);
    return;
  }
  if (args.token !== undefined) {
    const relayToken = args.token === true ? '' : String(args.token);
    const next = await almaPost(appUrl, '/api/mobile-relay/token', { relayToken });
    log(`Alma relay token ${relayToken ? 'updated' : 'cleared'} (state=${next.state ?? 'unknown'})`);
    return;
  }
  if (args.e2e && !args.enable) {
    const enabled = String(args.e2e) !== 'off' && String(args.e2e) !== 'false';
    const next = await almaSetE2E(appUrl, enabled);
    log(`Alma e2eEncryption=${next.e2eEncryption}`);
    return;
  }
  if (args.enable) {
    const relayUrl = String(args.relay ?? 'http://127.0.0.1:8787');
    const e2e = !(String(args.e2e ?? 'on') === 'off' || String(args.e2e ?? 'on') === 'false');
    const next = await almaEnable(appUrl, relayUrl, e2e, args['relay-token'] ?? null);
    log(`Alma now uses ${relayUrl} (e2e=${next.e2eEncryption})`);
    if (next.pairingLink) log('pairing uri:  ' + next.pairingLink);
    if (next.connectUrl) log('connect url:  ' + next.connectUrl);
    log('phone URL:    ' + `${relayUrl.replace(/\/+$/, '')}/`);
    log('re-pair the phone if it still uses the previous relay/code.');
    return;
  }
  if (args.disable) {
    const next = await almaDisable(appUrl);
    log(`Alma mobile relay disabled (state=${next.state ?? next.connection?.state ?? 'stopped'})`);
    return;
  }
  console.log(JSON.stringify(status, null, 2));
  if (status.pairingLink) log('pairing uri: ' + status.pairingLink);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'relay': {
      const relay = await runRelay(args);
      await new Promise(() => relay);
      return;
    }
    case 'bridge': {
      const bridge = await runBridge(args);
      await new Promise(() => bridge);
      return;
    }
    case 'desktop': {
      await runDesktop(args);
      await new Promise(() => {});
      return;
    }
    case 'all': {
      const bridge = await runBridge({ port: args['bridge-port'] ?? args.bridgePort ?? 23020, socket: args.socket });
      const relay = await runRelay({ port: args['relay-port'] ?? args.port ?? 8787, host: args.host ?? '127.0.0.1' });
      await runDesktop({
        relay: args.relay ?? `http://127.0.0.1:${relay.server.address().port}`,
        local: `http://127.0.0.1:${bridge.server.address().port}`,
        code: args.code,
        e2e: args.e2e,
        'no-lan': args['no-lan'],
        'relay-token': args['relay-token'],
        name: args.name,
      });
      await new Promise(() => {});
      return;
    }
    case 'alma': {
      await runAlma(args);
      return;
    }
    case 'code': {
      const code = createPairingCode();
      console.log(code);
      console.error('routing id: ' + (await routingIdForCode(code)));
      return;
    }
    default:
      console.log(
        [
          'usage: herdr-relay <command> [options]',
          '',
          '  relay     [--port 8787] [--host 127.0.0.1]   run the relay + phone web UI',
          '  bridge    [--port 23020] [--socket PATH]     expose the Herdr socket API on loopback',
          '            [--allow-all]                     do not restrict the phone to read-only calls',
          '  desktop   [--relay URL] [--code CODE]        register this computer and wait for a phone',
          '            [--local URL] [--e2e on|off] [--no-lan] [--relay-token TOKEN]',
          '  all       [--port 8787] [--host ...]         bridge + desktop + relay, one process',
          '  alma      [--app http://127.0.0.1:23001]     point the installed Alma app at this relay',
          '            [--enable --relay URL [--e2e on|off] | --disable | --e2e on|off]',
          '            [--regenerate | --reconnect | --token TOKEN]',
          '  code                                         print a fresh pairing code',
          '',
          'environment: RELAY_URL, LOCAL_ORIGIN, HERDR_SOCKET_PATH, HERDR_SESSION',
        ].join('\n'),
      );
  }
}

main().catch((error) => {
  console.error('fatal:', error?.message ?? error);
  process.exit(1);
});
