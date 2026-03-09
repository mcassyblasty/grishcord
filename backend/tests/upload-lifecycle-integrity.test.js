import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnreferencedUploadsByIds, deleteUnreferencedUploadsByIds, findStaleUnattachedUploads } from '../src/upload-lifecycle.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

function makeClient({ uploads = [], referenced = [] } = {}) {
  const state = {
    uploads: uploads.map((u) => ({ ...u })),
    refs: new Set(referenced.map((v) => Number(v)))
  };

  return {
    state,
    async query(sql, params = []) {
      if (sql.includes('WHERE u.id = ANY($1::bigint[])') && sql.includes('SELECT u.id, u.storage_name')) {
        const ids = new Set(params[0].map((v) => Number(v)));
        return {
          rows: state.uploads.filter((u) => ids.has(Number(u.id)) && !state.refs.has(Number(u.id))).map((u) => ({ id: u.id, storage_name: u.storage_name }))
        };
      }
      if (sql.includes('DELETE FROM uploads u') && sql.includes('RETURNING u.id, u.storage_name')) {
        const ids = new Set(params[0].map((v) => Number(v)));
        const toDelete = state.uploads.filter((u) => ids.has(Number(u.id)) && !state.refs.has(Number(u.id)));
        state.uploads = state.uploads.filter((u) => !toDelete.some((d) => Number(d.id) === Number(u.id)));
        return { rows: toDelete.map((u) => ({ id: u.id, storage_name: u.storage_name })) };
      }
      if (sql.includes('u.created_at < to_timestamp($1 / 1000.0)')) {
        const [cutoff, limit] = params;
        const rows = state.uploads
          .filter((u) => Number(u.created_at_ms) < Number(cutoff) && !state.refs.has(Number(u.id)))
          .sort((a, b) => Number(a.created_at_ms) - Number(b.created_at_ms))
          .slice(0, Number(limit))
          .map((u) => ({ id: u.id, storage_name: u.storage_name }));
        return { rows };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    }
  };
}

test('deleting a message cleans up unique unreferenced attachment rows', async () => {
  const client = makeClient({ uploads: [{ id: 1, storage_name: 'a.png' }], referenced: [] });
  const candidates = await findUnreferencedUploadsByIds(client, [1]);
  const deleted = await deleteUnreferencedUploadsByIds(client, candidates.map((r) => r.id));
  assert.deepEqual(deleted.map((r) => r.id), [1]);
  assert.equal(client.state.uploads.length, 0);
});

test('shared attachment is preserved when still referenced elsewhere', async () => {
  const client = makeClient({ uploads: [{ id: 2, storage_name: 'b.png' }], referenced: [2] });
  const candidates = await findUnreferencedUploadsByIds(client, [2]);
  assert.deepEqual(candidates, []);
  const deleted = await deleteUnreferencedUploadsByIds(client, [2]);
  assert.deepEqual(deleted, []);
  assert.equal(client.state.uploads.length, 1);
});

test('editing/replacing attachments removes only old unreferenced uploads', async () => {
  const client = makeClient({
    uploads: [{ id: 10, storage_name: 'old.png' }, { id: 11, storage_name: 'new.png' }],
    referenced: [11]
  });
  const deleted = await deleteUnreferencedUploadsByIds(client, [10, 11]);
  assert.deepEqual(deleted.map((r) => r.id), [10]);
  assert.deepEqual(client.state.uploads.map((u) => u.id), [11]);
});

test('unattached upload reaping finds stale unreferenced uploads', async () => {
  const client = makeClient({
    uploads: [
      { id: 20, storage_name: 'old-unattached.png', created_at_ms: 1_000 },
      { id: 21, storage_name: 'new-unattached.png', created_at_ms: 99_000 },
      { id: 22, storage_name: 'old-but-referenced.png', created_at_ms: 1_000 }
    ],
    referenced: [22]
  });
  const stale = await findStaleUnattachedUploads(client, { olderThanMs: 10_000, limit: 50 });
  assert.deepEqual(stale.map((r) => r.id), [20]);
});

test('retention wiring cleans rows/files consistently and preserves referenced uploads', () => {
  assert.match(source, /const refs = await pool\.query\('SELECT DISTINCT upload_id FROM message_uploads WHERE message_id = ANY\(\$1::bigint\[\]\)'/);
  assert.match(source, /await cleanupUnreferencedUploads\(refIds\)/);
  assert.match(source, /await reapStaleUnattachedUploads\(\)/);
});

test('message delete/edit paths invoke reference-safe cleanup hooks', () => {
  assert.match(source, /const attached = await pool\.query\('SELECT upload_id FROM message_uploads WHERE message_id = \$1'/);
  assert.match(source, /await cleanupUnreferencedUploads\(attachedUploadIds\)/);
  assert.match(source, /const prev = await pool\.query\('SELECT upload_id FROM message_uploads WHERE message_id = \$1'/);
  assert.match(source, /const cleanupIds = previousUploadIds\.filter\(\(v\) => !preserved\.has\(v\)\)/);
  assert.match(source, /await cleanupUnreferencedUploads\(cleanupIds\)/);
});
