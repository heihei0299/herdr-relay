// Backend adapters: the same phone UI drives either
//
//   * herdr-relay's own bridge     ->  GET /api/snapshot, POST /api/rpc
//   * the installed Alma desktop   ->  WS /ws/herdr (hub) + POST /api/herdr/rpc
//
// Shapes below are copied from the shipped Alma 0.4.400 main bundle
// (hub messages: {type:"herdr",online,reason}, {type:"snapshot",snapshot},
//  {type:"status",change}; rpc replies {result} with pane.read / pane.list
//  and the phone allowlist yT).

export const BRIDGE = 'bridge';
export const ALMA = 'alma';

export function normalizePane(pane) {
  const id = pane?.pane_id ?? pane?.id ?? '';
  return {
    id,
    title: pane?.terminal_title ?? pane?.title ?? pane?.name ?? id,
    workspaceId: pane?.workspace_id ?? null,
    focused: pane?.focused === true,
    agent: pane?.agent ?? null,
    agentStatus: pane?.agent_status ?? null,
  };
}

export function panesFromSnapshot(snapshot) {
  const panes = snapshot?.panes;
  if (!Array.isArray(panes)) return [];
  const list = panes.map(normalizePane).filter((pane) => pane.id);
  const focused = list.find((pane) => pane.focused);
  return focused ? [focused, ...list.filter((pane) => pane !== focused)] : list;
}

export function readText(result) {
  if (typeof result === 'string') return result;
  return result?.read?.text ?? result?.text ?? result?.pane?.text ?? '';
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Returns a hub message for known types, otherwise null. */
export function parseHubMessage(data) {
  const message = typeof data === 'string' ? parseJson(data) : null;
  if (!message || typeof message.type !== 'string') return null;
  if (message.type !== 'herdr' && message.type !== 'snapshot' && message.type !== 'status') return null;
  return message;
}

/**
 * Fold one hub message into UI state.
 * state: { panes: [], online: boolean, reason: string|null, dirty: boolean }
 */
export function applyHubMessage(state, message) {
  switch (message.type) {
    case 'herdr':
      state.online = message.online === true;
      state.reason = typeof message.reason === 'string' ? message.reason : null;
      if (!state.online) state.panes = [];
      state.dirty = true;
      return state;
    case 'snapshot':
      state.online = true;
      state.panes = panesFromSnapshot(message.snapshot);
      state.dirty = true;
      return state;
    case 'status':
      // A pane reported a new agent status: the list titles stay valid, but the
      // caller should refresh the visible pane.
      state.dirty = true;
      return state;
    default:
      return state;
  }
}

/** Which backend answered: /api/snapshot exists only on herdr-relay's bridge. */
export function detectBackend(status, body) {
  if (status === 200 && body && typeof body === 'object' && 'snapshot' in body) return BRIDGE;
  if (status === 404 || status === 403) return ALMA;
  return null;
}

export function rpcPath(backend) {
  return backend === ALMA ? '/api/herdr/rpc' : '/api/rpc';
}

export function errorMessage(payload, status) {
  if (!payload) return `HTTP ${status}`;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') {
    return payload.error.code ? `${payload.error.message}（${payload.error.code}）` : payload.error.message;
  }
  return `HTTP ${status}`;
}
