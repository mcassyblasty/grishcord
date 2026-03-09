import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canUserReadArchivedChannel } from '../src/channel-access.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

const scopeBlockStart = source.indexOf('async function canUserReadChannelScope');
const sinceRouteStart = source.indexOf("app.get('/api/messages/since/:id'");
const recentRouteStart = source.indexOf("app.get('/api/messages/recent'");
const windowRouteStart = source.indexOf("app.get('/api/messages/window/:id'");
const messagesByIdStart = source.indexOf("app.get('/api/messages/:id'");

const scopeBlock = source.slice(scopeBlockStart, sinceRouteStart);
const sinceRoute = source.slice(sinceRouteStart, recentRouteStart);
const recentRoute = source.slice(recentRouteStart, windowRouteStart);
const windowRoute = source.slice(windowRouteStart, source.indexOf('async function resolveAccessibleUpload'));
const messagesByIdRoute = source.slice(messagesByIdStart, source.indexOf("wss.on('connection'", messagesByIdStart));

test('ordinary users are denied archived channels while non-archived remain readable', () => {
  assert.equal(canUserReadArchivedChannel({ archived: true, isAdmin: false }), false);
  assert.equal(canUserReadArchivedChannel({ archived: true, isAdmin: true }), true);
  assert.equal(canUserReadArchivedChannel({ archived: false, isAdmin: false }), true);
});

test('channel scope check queries archived state and applies admin-aware policy', () => {
  assert.match(scopeBlock, /SELECT id, archived FROM channels WHERE id = \$1/);
  assert.match(scopeBlock, /canUserReadArchivedChannel\(\{ archived: ch\.archived === true, isAdmin: userCanAdmin\(userDb\) \}\)/);
});

test('all channel history endpoints use archived-aware scope resolution', () => {
  for (const block of [sinceRoute, recentRoute, windowRoute]) {
    assert.match(block, /await resolveMessageScopeOrError\(req, res\)/);
  }
});

test('posting to archived channels remains blocked', () => {
  assert.match(source, /SELECT id, announcement_only FROM channels WHERE id = \$1 AND archived = false/);
});

test('message metadata and upload access enforce channel archived policy', () => {
  assert.match(messagesByIdRoute, /const canReadChannel = await canUserReadChannelScope\(\{ userId: req\.user\.sub, userDb: req\.userDb, channelId: m\.channel_id \}\)/);
  assert.match(messagesByIdRoute, /if \(!canReadChannel\) return res\.status\(403\)\.json\(\{ error: 'forbidden' \}\)/);
  assert.match(source, /const u = await resolveAccessibleUpload\(\{ userId: req\.user\.sub, userDb: req\.userDb, uploadId \}\)/);
});
