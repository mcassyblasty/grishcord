function asId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function revokeSocket(ws, { code = 1008, reason = 'session_revoked' } = {}) {
  if (!ws) return;
  ws.authRevoked = true;
  try {
    if (typeof ws.close === 'function') ws.close(code, reason);
  } catch {}
}

export function revokeSocketsForUser(wss, userId, opts = {}) {
  const uid = asId(userId);
  if (!uid || !wss?.clients) return 0;
  let count = 0;
  for (const ws of wss.clients) {
    if (asId(ws?.userId) !== uid) continue;
    revokeSocket(ws, opts);
    count += 1;
  }
  return count;
}

export function ensureSocketAuthorizedForSend(ws) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.authRevoked === true) {
    revokeSocket(ws);
    return false;
  }
  if (!asId(ws.userId) || !asId(ws.sessionVersion)) {
    revokeSocket(ws, { reason: 'unauthorized' });
    return false;
  }
  return true;
}
