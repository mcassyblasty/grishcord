import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revokeSocketsForUser, ensureSocketAuthorizedForSend } from '../src/ws-auth.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

function makeSocket({ userId = null, sessionVersion = null, readyState = 1 } = {}) {
  return {
    userId,
    sessionVersion,
    readyState,
    authRevoked: false,
    closed: false,
    closeCode: null,
    closeReason: null,
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3;
    }
  };
}

test('disable-user revocation closes already-open socket for that user', () => {
  const a = makeSocket({ userId: 10, sessionVersion: 2 });
  const b = makeSocket({ userId: 11, sessionVersion: 2 });
  const wss = { clients: [a, b] };
  const closed = revokeSocketsForUser(wss, 10, { reason: 'user_disabled' });
  assert.equal(closed, 1);
  assert.equal(a.closed, true);
  assert.equal(a.closeReason, 'user_disabled');
  assert.equal(b.closed, false);
});

test('session_version invalidation revokes already-open socket', () => {
  const a = makeSocket({ userId: 7, sessionVersion: 1 });
  const wss = { clients: [a] };
  revokeSocketsForUser(wss, 7, { reason: 'session_revoked' });
  assert.equal(a.closed, true);
  assert.equal(a.closeReason, 'session_revoked');
  assert.equal(a.authRevoked, true);
});

test('authorized socket remains send-eligible', async () => {
  const ws = makeSocket({ userId: 5, sessionVersion: 9 });
  assert.equal(await ensureSocketAuthorizedForSend(ws, { validateSocketAuthState: async () => true }), true);
  assert.equal(ws.closed, false);
});

test('defensive outbound check closes stale/unauthorized sockets', async () => {
  const missingSv = makeSocket({ userId: 5, sessionVersion: null });
  const revoked = makeSocket({ userId: 6, sessionVersion: 1 });
  const stale = makeSocket({ userId: 9, sessionVersion: 2 });
  revoked.authRevoked = true;

  assert.equal(await ensureSocketAuthorizedForSend(missingSv, { validateSocketAuthState: async () => true }), false);
  assert.equal(missingSv.closed, true);
  assert.equal(missingSv.closeReason, 'unauthorized');

  assert.equal(await ensureSocketAuthorizedForSend(revoked, { validateSocketAuthState: async () => true }), false);
  assert.equal(revoked.closed, true);
  assert.equal(revoked.closeReason, 'session_revoked');

  assert.equal(await ensureSocketAuthorizedForSend(stale, { validateSocketAuthState: async () => false }), false);
  assert.equal(stale.closed, true);
  assert.equal(stale.closeReason, 'session_revoked');
});


test('notification fan-out awaits async socket auth helper', () => {
  assert.match(source, /for \(const n of created\) \{[\s\S]*for \(const c of wss\.clients\) \{[\s\S]*await ensureSocketAuthorizedForSend\(c, \{ validateSocketAuthState \}\)/);
  assert.doesNotMatch(source, /for \(const n of created\) \{[\s\S]*for \(const c of wss\.clients\) \{[\s\S]*!ensureSocketAuthorizedForSend\(c\)/);
});
test('backend wires revocation hooks and outbound defensive checks', () => {
  assert.match(source, /revokeSocketsForUser\(wss, data\.sub, \{ reason: 'session_revoked' \}\)/);
  assert.match(source, /if \(disabled\) revokeSocketsForUser\(wss, targetId, \{ reason: 'user_disabled' \}\)/);
  assert.match(source, /revokeSocketsForUser\(wss, userId, \{ reason: 'session_revoked' \}\)/);
  assert.match(source, /revokeSocketsForUser\(wss, id, \{ reason: 'user_deleted' \}\)/);
  assert.match(source, /await ensureSocketAuthorizedForSend\(c, \{ validateSocketAuthState \}\)/);
  assert.match(source, /ws\.sessionVersion = Number\(u\.session_version\)/);
});
