import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

function routeBlock(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing route start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing route end after ${startNeedle}`);
  return source.slice(start, end);
}

const sinceRoute = routeBlock("app.get('/api/messages/since/:id'", "app.get('/api/messages/recent'");
const recentRoute = routeBlock("app.get('/api/messages/recent'", "app.get('/api/messages/window/:id'");
const windowRoute = routeBlock("app.get('/api/messages/window/:id'", 'async function resolveAccessibleUpload');

test('scoped routes use shared scope guard', () => {
  for (const block of [sinceRoute, recentRoute, windowRoute]) {
    assert.match(block, /resolveMessageScopeOrError\(req, res\)/);
    assert.match(block, /if \(!scope\) return;/);
  }
});

test('scoped routes parse and cap limit consistently via helper', () => {
  assert.match(source, /function parseMessageLimit\(rawValue, defaultLimit, maxLimit\)/);
  assert.match(source, /Math\.max\(1, Math\.min\(maxLimit, Math\.floor\(parsed\)\)\)/);
  assert.match(sinceRoute, /parseMessageLimit\(null, 500, 500\)/);
  assert.match(recentRoute, /parseMessageLimit\(req\.query\.limit, 100, 200\)/);
  assert.match(windowRoute, /parseMessageLimit\(req\.query\.limit, 10, 100\)/);
});

test('recent route has no trigger-specific assumptions', () => {
  assert.doesNotMatch(recentRoute, /triggerId/);
  assert.doesNotMatch(recentRoute, /hasTrigger/);
});

test('dm scope SQL is participant-bounded in all scoped routes', () => {
  for (const block of [sinceRoute, recentRoute, windowRoute]) {
    assert.match(block, /\(m\.author_id = \$\d+ AND m\.dm_peer_id = \$\d+\) OR \(m\.author_id = \$\d+ AND m\.dm_peer_id = \$\d+\)/);
  }
});

test('recent route success-path query shape stays ordered ascending and capped', () => {
  assert.match(recentRoute, /ORDER BY m\.id DESC/);
  assert.match(recentRoute, /ORDER BY r\.id ASC/);
  assert.match(recentRoute, /LIMIT \$2/);
  assert.match(recentRoute, /LIMIT \$3/);
});
