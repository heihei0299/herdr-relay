// A stand-in for the installed Alma desktop, used to verify the phone client's
// `/ws/herdr` adaptation without touching the real app.
//
// Shapes mirror the shipped Alma 0.4.400 bundle:
//   hub messages   {type:"herdr",online,reason} | {type:"snapshot",snapshot} | {type:"status",change}
//   rpc            POST /api/herdr/rpc  {method,params} -> {result} | 403 {error:{code,message}}
//   phone allowlist (yT): pane.read, pane.send_text, pane.send_keys, pane.list, …

import http from 'node:http';
import { acceptUpgrade } from '../../src/protocol/ws.mjs';

export function createFakeAlma({ panes, snapshotTitle = 'fake-alma' } = {}) {
  const state = {
    panes: panes ?? [
      { pane_id: 'wA:p1', terminal_title: 'π - demo', workspace_id: 'wA', focused: true, agent: 'pi' },
      { pane_id: 'wA:p2', terminal_title: 'zsh', workspace_id: 'wA', focused: false },
    ],
    texts: new Map(),
    typed: [],
  };
  const clients = new Set();

  const snapshot = () => ({ version: 'herdr-core', workspaces: [{ id: 'wA', name: snapshotTitle }], panes: state.panes, agents: [] });
  const broadcast = (message) => {
    for (const ws of clients) if (ws.readyState === 'open') ws.send(JSON.stringify(message));
  };
  const setText = (paneId, text) => {
    state.texts.set(paneId, text);
  };
  for (const pane of state.panes) setText(pane.pane_id, `fake Alma terminal for ${pane.terminal_title}\n$ `);

  function rpc(method, params = {}) {
    if (method === 'pane.list') return { panes: state.panes };
    if (method === 'session.snapshot') return { snapshot: snapshot() };
    if (method === 'pane.read') {
      return { read: { pane_id: params.pane_id, source: params.source ?? 'visible', text: state.texts.get(params.pane_id) ?? '' } };
    }
    if (method === 'pane.send_text') {
      state.typed.push({ method, params });
      const pane = state.panes.find((candidate) => candidate.pane_id === params.pane_id);
      setText(params.pane_id, `${state.texts.get(params.pane_id) ?? ''}${params.text}`);
      if (pane) broadcast({ type: 'status', change: { pane_id: pane.pane_id, to: 'working' } });
      return { ok: true };
    }
    if (method === 'pane.send_keys') {
      state.typed.push({ method, params });
      const keys = Array.isArray(params.keys) ? params.keys : [];
      if (keys.includes('Enter')) setText(params.pane_id, `${state.texts.get(params.pane_id) ?? ''}\n`);
      return { ok: true };
    }
    const error = new Error(`${method} is not available from the phone`);
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://alma.local');
    if (url.pathname === '/api/herdr/rpc' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'bad_request', message: 'expected {method, params}' } }));
          return;
        }
        try {
          const result = rpc(String(parsed.method || ''), parsed.params ?? {});
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: error.code ?? 'error', message: error.message } }));
        }
      });
      return;
    }
    if (url.pathname === '/debug/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hubClients: clients.size, typed: state.typed, panes: state.panes }));
      return;
    }
    if (url.pathname === '/api/mobile-relay/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ enabled: false, state: 'stopped' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://alma.local');
    if (url.pathname !== '/ws/herdr') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    acceptUpgrade(req, socket, head, {
      onConnection: (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'herdr', online: true, reason: null }));
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: snapshot() }));
        ws.on('close', () => clients.delete(ws));
      },
    });
  });

  return {
    server,
    state,
    get hubClients() {
      return clients.size;
    },
    snapshot,
    broadcast,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      for (const ws of clients) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 23100);
  const alma = createFakeAlma();
  const address = await alma.listen(port, '127.0.0.1');
  console.log(`fake Alma desktop on http://127.0.0.1:${address.port} (hub /ws/herdr, rpc /api/herdr/rpc)`);
}
