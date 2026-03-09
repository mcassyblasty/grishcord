function asId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function revokeSocket(ws, reason = 'session_revoked') {
  if (!ws) return;
  ws.authRevoked = true;
  try {
    if (typeof ws.close === 'function') ws.close(1008, reason);
  } catch {}
}

export function revokeSocketsForUser(wss, userId, opts = {}) {
  const uid = asId(userId);
  if (!uid || !wss?.clients) return 0;
  let closed = 0;
  const reason = opts.reason || 'session_revoked';
  for (const ws of wss.clients) {
    if (asId(ws.userId) !== uid) continue;
    revokeSocket(ws, reason);
    closed += 1;
  }
  return closed;
}

export async function ensureSocketAuthorizedForSend(ws, { validateSocketAuthState } = {}) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.authRevoked === true) {
    revokeSocket(ws, 'session_revoked');
    return false;
  }
  const userId = asId(ws.userId);
  const sessionVersion = asId(ws.sessionVersion);
  if (!userId || !sessionVersion) {
    revokeSocket(ws, 'unauthorized');
    return false;
  }

  if (typeof validateSocketAuthState === 'function') {
    const ok = await validateSocketAuthState(ws);
    if (!ok) {
      revokeSocket(ws, 'session_revoked');
      return false;
    }
  }

  return true;
}
