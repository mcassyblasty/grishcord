import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWithSingleUseInvite } from '../src/invite.js';

function createFakePool({ invites = [], users = [] } = {}) {
  const state = {
    invites: invites.map((row) => ({ ...row })),
    users: users.map((row) => ({ ...row })),
    nextUserId: users.reduce((max, u) => Math.max(max, u.id || 0), 0) + 1
  };

  const pool = {
    async connect() {
      let inTx = false;
      const txInvites = new Map();
      const txUsers = [];

      function snapshotInvite(invite) {
        if (!txInvites.has(invite.id)) txInvites.set(invite.id, { ...invite });
      }

      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            inTx = true;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            assert.equal(inTx, true);
            inTx = false;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            for (const [id, original] of txInvites.entries()) {
              const idx = state.invites.findIndex((i) => i.id === id);
              state.invites[idx] = original;
            }
            for (const id of txUsers.map((u) => u.id)) {
              const idx = state.users.findIndex((u) => u.id === id);
              if (idx >= 0) state.users.splice(idx, 1);
            }
            inTx = false;
            return { rows: [] };
          }

          if (sql.includes('UPDATE invites') && sql.includes('SET used_at = now()')) {
            assert.equal(inTx, true);
            const tokenHash = params[0];
            const now = Date.now();
            const row = state.invites.find((inv) => inv.token_hash === tokenHash && !inv.revoked_at && !inv.used_at && inv.expires_at > now);
            if (!row) return { rows: [] };
            snapshotInvite(row);
            row.used_at = now;
            return { rows: [{ id: row.id }] };
          }

          if (sql.startsWith('INSERT INTO users')) {
            assert.equal(inTx, true);
            const [username, display_name, display_color, password_hash] = params;
            if (state.users.some((u) => u.username === username)) {
              const err = new Error('duplicate key value violates unique constraint "users_username_key"');
              err.code = '23505';
              throw err;
            }
            const row = { id: state.nextUserId++, username, display_name, display_color, password_hash };
            state.users.push(row);
            txUsers.push(row);
            return { rows: [{ id: row.id }] };
          }

          if (sql.startsWith('UPDATE invites SET used_by = $1 WHERE id = $2')) {
            assert.equal(inTx, true);
            const [usedBy, inviteId] = params;
            const invite = state.invites.find((i) => i.id === inviteId);
            if (!invite) return { rows: [] };
            snapshotInvite(invite);
            invite.used_by = usedBy;
            return { rows: [{ id: invite.id }] };
          }

          throw new Error(`Unhandled SQL: ${sql}`);
        },
        release() {}
      };
    }
  };

  return { pool, state };
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(testDir, '..', 'src', 'index.js'), 'utf8');

test('single-use invite registration succeeds once', async () => {
  const { pool, state } = createFakePool({
    invites: [{ id: 1, token_hash: 't1', revoked_at: null, used_at: null, used_by: null, expires_at: Date.now() + 60000 }],
    users: []
  });

  const userId = await registerWithSingleUseInvite({
    pool,
    tokenHash: 't1',
    username: 'u1',
    displayName: 'U1',
    displayColor: '#fff',
    passwordHash: 'pw'
  });

  assert.equal(userId, 1);
  assert.equal(Boolean(state.invites[0].used_at), true);
  assert.equal(state.invites[0].used_by, 1);
});

test('second use of the same single-use invite fails', async () => {
  const { pool } = createFakePool({
    invites: [{ id: 1, token_hash: 't1', revoked_at: null, used_at: null, used_by: null, expires_at: Date.now() + 60000 }],
    users: []
  });

  const first = await registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u1', displayName: 'U1', displayColor: '#fff', passwordHash: 'pw1' });
  const second = await registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u2', displayName: 'U2', displayColor: '#000', passwordHash: 'pw2' });

  assert.equal(first, 1);
  assert.equal(second, null);
});

test('concurrent registration attempts against one invite only allow one success', async () => {
  const { pool } = createFakePool({
    invites: [{ id: 1, token_hash: 't1', revoked_at: null, used_at: null, used_by: null, expires_at: Date.now() + 60000 }],
    users: []
  });

  const [a, b] = await Promise.all([
    registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u1', displayName: 'U1', displayColor: '#fff', passwordHash: 'pw1' }),
    registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u2', displayName: 'U2', displayColor: '#000', passwordHash: 'pw2' })
  ]);

  assert.equal([a, b].filter((v) => Number.isFinite(v)).length, 1);
});

test('deleting invite-consuming user does not reactivate invite when used_by is cleared', async () => {
  const { pool, state } = createFakePool({
    invites: [{ id: 1, token_hash: 't1', revoked_at: null, used_at: null, used_by: null, expires_at: Date.now() + 60000 }],
    users: []
  });

  const userId = await registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u1', displayName: 'U1', displayColor: '#fff', passwordHash: 'pw1' });
  assert.equal(userId, 1);

  state.invites[0].used_by = null;

  const again = await registerWithSingleUseInvite({ pool, tokenHash: 't1', username: 'u2', displayName: 'U2', displayColor: '#000', passwordHash: 'pw2' });
  assert.equal(again, null);
});

test('registration route uses durable used_at state and atomic invite helper', () => {
  assert.match(source, /const userId = await registerWithSingleUseInvite\(\{/);
  assert.match(source, /if \(!userId\) return res\.status\(400\)\.json\(\{ error: 'invalid_invite' \}\)/);
  assert.doesNotMatch(source, /used_by IS NULL AND expires_at > now\(\)/);
});

test('user deletion clears used_by only and does not reset invite usage timestamp', () => {
  assert.match(source, /UPDATE invites SET used_by = NULL WHERE used_by = \$1/);
  assert.doesNotMatch(source, /UPDATE invites SET used_at = NULL/);
});
