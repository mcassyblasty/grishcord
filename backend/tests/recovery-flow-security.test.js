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

const redeemRoute = routeBlock("app.post('/api/recovery/redeem'", "app.post('/api/recovery/reset'");
const resetRoute = routeBlock("app.post('/api/recovery/reset'", 'function normalizeMentionKey');

test('redeem route validates token but does not mint redeem id or invalidate sessions', () => {
  assert.match(redeemRoute, /token_hash=\$1 AND used_at IS NULL AND expires_at > now\(\)/);
  assert.match(redeemRoute, /res\.json\(\{ ok: true \}\)/);
  assert.doesNotMatch(redeemRoute, /redeemId/);
  assert.doesNotMatch(redeemRoute, /session_version\s*=\s*session_version\s*\+/);
});

test('reset route requires raw token and never accepts redeemId', () => {
  assert.match(resetRoute, /requireStringField\(req\.body, 'token'/);
  assert.match(resetRoute, /validatePassword\(req\.body\?\.password\)/);
  assert.match(resetRoute, /consumeRecoveryReset\(/);
  assert.match(resetRoute, /tokenHash: sha\(raw \|\| ''\)/);
  assert.doesNotMatch(resetRoute, /redeemId/);
});

test('reset route returns invalid_token on failed token consume', () => {
  assert.match(resetRoute, /if \(!userId\) return res\.status\(400\)\.json\(\{ error: 'invalid_token' \}\)/);
});
