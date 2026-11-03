import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALMA,
  BRIDGE,
  applyHubMessage,
  detectBackend,
  errorMessage,
  panesFromSnapshot,
  parseHubMessage,
  readText,
  rpcPath,
} from '../web/lib/backend.js';

// Message shapes below are the ones the shipped Alma 0.4.400 hub emits:
//   {type:"herdr",online,reason} / {type:"snapshot",snapshot} / {type:"status",change}

test('backend detection distinguishes the bridge from the Alma app', () => {
  assert.equal(detectBackend(200, { snapshot: { panes: [] } }), BRIDGE);
  assert.equal(detectBackend(404, null), ALMA);
  assert.equal(detectBackend(403, { error: { message: 'nope' } }), ALMA);
  assert.equal(detectBackend(500, null), null);
  assert.equal(rpcPath(BRIDGE), '/api/rpc');
  assert.equal(rpcPath(ALMA), '/api/herdr/rpc');
});

test('hub messages are parsed only for the three known types', () => {
  assert.deepEqual(parseHubMessage('{"type":"herdr","online":true}'), { type: 'herdr', online: true });
  assert.equal(parseHubMessage('{"type":"snapshot","snapshot":{}}').type, 'snapshot');
  assert.equal(parseHubMessage('{"type":"event","event":"x"}'), null);
  assert.equal(parseHubMessage('not json'), null);
  assert.equal(parseHubMessage(undefined), null);
});

test('snapshot pans are normalized and the focused pane comes first', () => {
  const panes = panesFromSnapshot({
    panes: [
      { pane_id: 'wA:p1', terminal_title: 'one', workspace_id: 'wA' },
      { pane_id: 'wA:p2', terminal_title: 'two', focused: true },
    ],
  });
  assert.deepEqual(
    panes.map((pane) => pane.id),
    ['wA:p2', 'wA:p1'],
  );
  assert.equal(panes[0].title, 'two');
  assert.equal(panes[0].focused, true);
  assert.deepEqual(panesFromSnapshot(null), []);
  assert.deepEqual(panesFromSnapshot({ panes: 'nope' }), []);
});

test('applying hub messages tracks connectivity and panes', () => {
  const state = { panes: [], online: true, reason: null, dirty: false };
  applyHubMessage(state, { type: 'herdr', online: false, reason: 'herdr-core offline' });
  assert.equal(state.online, false);
  assert.equal(state.reason, 'herdr-core offline');
  assert.deepEqual(state.panes, []);

  applyHubMessage(state, { type: 'snapshot', snapshot: { panes: [{ pane_id: 'wA:p3', terminal_title: 'three' }] } });
  assert.equal(state.online, true);
  assert.deepEqual(state.panes.map((pane) => pane.id), ['wA:p3']);

  applyHubMessage(state, { type: 'status', change: { pane_id: 'wA:p3', to: 'working' } });
  assert.equal(state.panes.length, 1);
});

test('pane.read text is read from the Alma reply shape', () => {
  assert.equal(readText({ read: { text: 'hello' } }), 'hello');
  assert.equal(readText({ text: 'flat' }), 'flat');
  assert.equal(readText('raw'), 'raw');
  assert.equal(readText(null), '');
});

test('rpc errors are readable in both response shapes', () => {
  assert.equal(errorMessage({ error: { code: 'forbidden', message: 'pane.focus is not available from the phone' } }, 403), 'pane.focus is not available from the phone（forbidden）');
  assert.equal(errorMessage({ error: 'boom' }, 500), 'boom');
  assert.equal(errorMessage(null, 502), 'HTTP 502');
});
