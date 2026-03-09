import test from 'node:test';
import assert from 'node:assert/strict';
import { createRootAdminIfFirst } from '../src/bootstrap.js';

function createFakePool({ users = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    nextId: users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1,
    lockBusy: false
  };

  const waiters = [];
  async function acquireLock() {
    if (!state.lockBusy) {
      state.lockBusy = true;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    state.lockBusy = true;
  }
  function releaseLock() {
    state.lockBusy = false;
    const next = waiters.shift();
    if (next) next();
  }

  const pool = {
    async connect() {
      let inTx = false;
      let lockHeld = false;
      const txUsers = [];
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            inTx = true;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            for (const id of txUsers) {
              const idx = state.users.findIndex((u) => u.id === id);
              if (idx >= 0) state.users.splice(idx, 1);
            }
            if (lockHeld) {
              lockHeld = false;
              releaseLock();
            }
            inTx = false;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            if (lockHeld) {
              lockHeld = false;
              releaseLock();
            }
            inTx = false;
            return { rows: [] };
          }

          if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
            assert.equal(inTx, true);
            await acquireLock();
            lockHeld = true;
            return { rows: [] };
          }

          if (sql === 'SELECT id FROM users ORDER BY id ASC LIMIT 1') {
            return { rows: state.users[0] ? [{ id: state.users[0].id }] : [] };
          }

          if (sql.startsWith('INSERT INTO users')) {
            const [username, displayName, displayColor, passwordHash] = params;
            const row = { id: state.nextId++, username, display_name: displayName, display_color: displayColor, password_hash: passwordHash, is_admin: true };
            state.users.push(row);
            txUsers.push(row.id);
            return { rows: [{ id: row.id, username: row.username, display_name: row.display_name, is_admin: true }] };
          }

          throw new Error(`Unhandled SQL: ${sql}`);
        },
        release() {}
      };
    }
  };

  return { pool, state };
}

test('fresh install bootstrap succeeds once with valid flow', async () => {
  const { pool, state } = createFakePool({ users: [] });
  const created = await createRootAdminIfFirst({ pool, username: 'root', displayName: 'Root', displayColor: '#FFFFFF', passwordHash: 'hash' });
  assert.equal(created.username, 'root');
  assert.equal(state.users.length, 1);
});

test('bootstrap fails once a user already exists', async () => {
  const { pool, state } = createFakePool({ users: [{ id: 1, username: 'existing' }] });
  const created = await createRootAdminIfFirst({ pool, username: 'root', displayName: 'Root', displayColor: '#FFFFFF', passwordHash: 'hash' });
  assert.equal(created, null);
  assert.equal(state.users.length, 1);
});

test('concurrent bootstrap attempts only allow one success', async () => {
  const { pool, state } = createFakePool({ users: [] });
  const [a, b] = await Promise.all([
    createRootAdminIfFirst({ pool, username: 'rootA', displayName: 'Root A', displayColor: '#AAAAAA', passwordHash: 'hashA' }),
    createRootAdminIfFirst({ pool, username: 'rootB', displayName: 'Root B', displayColor: '#BBBBBB', passwordHash: 'hashB' })
  ]);

  const successes = [a, b].filter(Boolean);
  assert.equal(successes.length, 1);
  assert.equal(state.users.length, 1);
});
