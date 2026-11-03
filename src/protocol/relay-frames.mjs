// Relay wire format between the desktop agent and the relay.
//
// Control frames are JSON text; bulk payloads are binary records:
//   [kind u8][idLen u8][id utf8][payload]
// kinds: 1 = HTTP body chunk, 2 = ack (unused here), 3 = socket binary, 4 = socket text
//
// This mirrors the framing the Alma desktop builds in out/main/index.js
// (`sendBinary` / `handleBinaryFrame`).

export const KIND_BODY = 1;
export const KIND_ACK = 2;
export const KIND_SOCKET_BINARY = 3;
export const KIND_SOCKET_TEXT = 4;

export function encodeRecord(kind, id, payload) {
  const idBytes = Buffer.from(String(id), 'utf8');
  if (idBytes.length > 255) throw new Error('relay frame id too long');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload ?? []);
  const out = Buffer.allocUnsafe(2 + idBytes.length + body.length);
  out[0] = kind;
  out[1] = idBytes.length;
  idBytes.copy(out, 2);
  body.copy(out, 2 + idBytes.length);
  return out;
}

export function decodeRecord(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length < 2) return null;
  const idLength = bytes[1];
  if (bytes.length < 2 + idLength) return null;
  return {
    kind: bytes[0],
    id: bytes.toString('utf8', 2, 2 + idLength),
    data: bytes.subarray(2 + idLength),
  };
}

export function sendJson(ws, message) {
  return ws.send(JSON.stringify(message));
}

export function sendBinary(ws, kind, id, payload) {
  return ws.send(encodeRecord(kind, id, payload));
}
