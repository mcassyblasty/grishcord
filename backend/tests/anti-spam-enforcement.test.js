import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAntiSpamPreset, enforceAntiSpamForUser } from '../src/anti-spam.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

const presets = {
  5: { burst: 8, sustained: 25, cooldown: 30 }
};

test('anti-spam disabled mode allows normal posting', () => {
  const state = new Map();
  const preset = resolveAntiSpamPreset(0, presets);
  assert.equal(preset, null);
  const result = enforceAntiSpamForUser(state, 1, preset, 0);
  assert.equal(result.ok, true);
});

test('burst limit is enforced with cooldown/retry-after', () => {
  const state = new Map();
  const preset = { burst: 2, sustained: 100, cooldown: 10 };
  assert.equal(enforceAntiSpamForUser(state, 1, preset, 0).ok, true);
  assert.equal(enforceAntiSpamForUser(state, 1, preset, 100).ok, true);
  const blocked = enforceAntiSpamForUser(state, 1, preset, 200);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'burst');
  assert.equal(blocked.retryAfterSeconds, 10);

  const stillBlocked = enforceAntiSpamForUser(state, 1, preset, 9_500);
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.retryAfterSeconds, 1);

  const resumed = enforceAntiSpamForUser(state, 1, preset, 10_300);
  assert.equal(resumed.ok, true);
});

test('sustained limit is enforced when minute budget is exceeded', () => {
  const state = new Map();
  const preset = { burst: 100, sustained: 3, cooldown: 12 };
  assert.equal(enforceAntiSpamForUser(state, 2, preset, 0).ok, true);
  assert.equal(enforceAntiSpamForUser(state, 2, preset, 20_000).ok, true);
  assert.equal(enforceAntiSpamForUser(state, 2, preset, 40_000).ok, true);
  const blocked = enforceAntiSpamForUser(state, 2, preset, 59_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'sustained');
  assert.equal(blocked.retryAfterSeconds, 12);
});

test('different users are limited independently', () => {
  const state = new Map();
  const preset = { burst: 1, sustained: 100, cooldown: 5 };
  assert.equal(enforceAntiSpamForUser(state, 10, preset, 0).ok, true);
  const blockedUser10 = enforceAntiSpamForUser(state, 10, preset, 50);
  assert.equal(blockedUser10.ok, false);
  assert.equal(enforceAntiSpamForUser(state, 11, preset, 50).ok, true);
});

test('normal posting resumes once burst window expires', () => {
  const state = new Map();
  const preset = { burst: 2, sustained: 100, cooldown: 1 };
  assert.equal(enforceAntiSpamForUser(state, 3, preset, 0).ok, true);
  assert.equal(enforceAntiSpamForUser(state, 3, preset, 100).ok, true);
  assert.equal(enforceAntiSpamForUser(state, 3, preset, 200).ok, false);
  assert.equal(enforceAntiSpamForUser(state, 3, preset, 5_400).ok, true);
});

test('backend message route enforces selected anti-spam with 429 and retry metadata', () => {
  assert.match(source, /const antiSpam = await getEffectiveAntiSpamPolicy\(\)/);
  assert.match(source, /const antiSpamResult = enforceAntiSpamForUser\(antiSpamState, req\.user\.sub, antiSpam\.antiSpamEffective\)/);
  assert.match(source, /res\.setHeader\('Retry-After', String\(antiSpamResult\.retryAfterSeconds\)\)/);
  assert.match(source, /return res\.status\(429\)\.json\(\{ error: 'rate_limited', retryAfterSeconds: antiSpamResult\.retryAfterSeconds, antiSpamLevel: antiSpam\.antiSpamLevel, antiSpamEffective: antiSpam\.antiSpamEffective \}\)/);
});
