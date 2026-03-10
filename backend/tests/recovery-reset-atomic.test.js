import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeRecoveryReset } from '../src/recovery.js';

function createFakePool({ tokens = [], users = [] } = {}) {
  const state = {
    tokens: tokens.map((t) => ({ ...t })),
    users: users.map((u) => ({ ...u }))
  };

  const pool = {
    async connect() {
      let inTx = false;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            inTx = true;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            inTx = false;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            inTx = false;
            return { rows: [] };
          }

          if (sql.startsWith('UPDATE recovery_tokens SET used_at = now()')) {
            assert.equal(inTx, true);
            const tokenHash = params[0];
            const now = Date.now();
            const row = state.tokens.find((t) => t.token_hash === tokenHash && t.used_at === null && t.expires_at > now);
            if (!row) return { rows: [] };
            row.used_at = now;
            return { rows: [{ user_id: row.user_id }] };
          }

          if (sql.startsWith('UPDATE users SET password_hash=$1, session_version = session_version + 1 WHERE id=$2')) {
            assert.equal(inTx, true);
            const [passwordHash, userId] = params;
            const user = state.users.find((u) => u.id === userId);
            if (!user) throw new Error('missing_user');
            user.password_hash = passwordHash;
            user.session_version += 1;
            return { rows: [] };
          }

          throw new Error(`Unhandled SQL: ${sql}`);
        },
        release() {}
      };
    }
  };

  return { pool, state };
}

const HOUR = 60 * 60 * 1000;

test('valid token resets password and bumps session_version once', async () => {
  const { pool, state } = createFakePool({
    tokens: [{ token_hash: 't1', user_id: 1, used_at: null, expires_at: Date.now() + HOUR }],
    users: [{ id: 1, password_hash: 'old', session_version: 2 }]
  });

  const userId = await consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhash' });

  assert.equal(userId, 1);
  assert.equal(state.users[0].password_hash, 'newhash');
  assert.equal(state.users[0].session_version, 3);
  assert.notEqual(state.tokens[0].used_at, null);
});

test('invalid token fails with no password/session mutation', async () => {
  const { pool, state } = createFakePool({
    tokens: [{ token_hash: 't1', user_id: 1, used_at: null, expires_at: Date.now() + HOUR }],
    users: [{ id: 1, password_hash: 'old', session_version: 2 }]
  });

  const userId = await consumeRecoveryReset({ pool, tokenHash: 'missing', passwordHash: 'newhash' });

  assert.equal(userId, null);
  assert.equal(state.users[0].password_hash, 'old');
  assert.equal(state.users[0].session_version, 2);
  assert.equal(state.tokens[0].used_at, null);
});

test('expired token fails', async () => {
  const { pool, state } = createFakePool({
    tokens: [{ token_hash: 't1', user_id: 1, used_at: null, expires_at: Date.now() - 1 }],
    users: [{ id: 1, password_hash: 'old', session_version: 2 }]
  });

  const userId = await consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhash' });

  assert.equal(userId, null);
  assert.equal(state.users[0].session_version, 2);
});

test('used token fails on reuse', async () => {
  const { pool, state } = createFakePool({
    tokens: [{ token_hash: 't1', user_id: 1, used_at: null, expires_at: Date.now() + HOUR }],
    users: [{ id: 1, password_hash: 'old', session_version: 2 }]
  });

  const first = await consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhash1' });
  const second = await consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhash2' });

  assert.equal(first, 1);
  assert.equal(second, null);
  assert.equal(state.users[0].password_hash, 'newhash1');
  assert.equal(state.users[0].session_version, 3);
});

test('two simultaneous attempts with same token only allow one success', async () => {
  const { pool, state } = createFakePool({
    tokens: [{ token_hash: 't1', user_id: 1, used_at: null, expires_at: Date.now() + HOUR }],
    users: [{ id: 1, password_hash: 'old', session_version: 2 }]
  });

  const [a, b] = await Promise.all([
    consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhashA' }),
    consumeRecoveryReset({ pool, tokenHash: 't1', passwordHash: 'newhashB' })
  ]);

  const successes = [a, b].filter((v) => v === 1).length;
  assert.equal(successes, 1);
  assert.equal(state.users[0].session_version, 3);
  assert.match(state.users[0].password_hash, /^newhash[AB]$/);
});
