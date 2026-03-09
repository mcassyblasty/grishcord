import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNotificationRecipientEligible, filterNotificationFeedRows } from '../src/notification-privacy.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

test('DM mention of third party is not eligible for notifications', () => {
  const msg = { dm_peer_id: 2, channel_id: null };
  assert.equal(isNotificationRecipientEligible(msg, 1, 3), false);
});

test('DM participant receives notification eligibility while sender does not', () => {
  const msg = { dm_peer_id: 2, channel_id: null };
  assert.equal(isNotificationRecipientEligible(msg, 1, 2), true);
  assert.equal(isNotificationRecipientEligible(msg, 1, 1), false);
});

test('channel mention behavior remains eligible for non-sender users', () => {
  const msg = { dm_peer_id: null, channel_id: 10 };
  assert.equal(isNotificationRecipientEligible(msg, 1, 2), true);
  assert.equal(isNotificationRecipientEligible(msg, 1, 3), true);
  assert.equal(isNotificationRecipientEligible(msg, 1, 1), false);
});

test('/api/notifications defensive filter strips unauthorized DM preview rows', () => {
  const rows = [
    { id: 1, dm_peer_id: 2, author_id: 1, body: 'visible dm' },
    { id: 2, dm_peer_id: 2, author_id: 4, body: 'leaked dm' },
    { id: 3, dm_peer_id: null, author_id: 4, body: 'channel' }
  ];
  const filtered = filterNotificationFeedRows(rows, 1);
  assert.deepEqual(filtered.map((r) => r.id), [1, 3]);
});

test('backend wires DM privacy helper into recipient creation and notifications feed', () => {
  assert.match(source, /if \(!isNotificationRecipientEligible\(msg, authorId, userId\)\) continue;/);
  assert.match(source, /const visibleRows = filterNotificationFeedRows\(rows, req\.user\.sub\)/);
  assert.match(source, /m\.author_id,/);
});
