import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, parsePositiveId, requireStringField, validateUsername, validatePassword } from '../src/http-helpers.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

test('malformed numeric ids are rejected by shared validator', () => {
  assert.throws(() => parsePositiveId('abc', 'id'), (err) => err instanceof HttpError && err.code === 'invalid_id');
  assert.throws(() => parsePositiveId(0, 'channel_id'), (err) => err instanceof HttpError && err.code === 'invalid_channel_id');
  assert.equal(parsePositiveId('42', 'id'), 42);
});

test('missing required fields are rejected early by validators', () => {
  assert.throws(() => requireStringField({}, 'token', { min: 16 }), (err) => err instanceof HttpError && err.code === 'token_required');
  assert.throws(() => requireStringField({ token: 'short' }, 'token', { min: 16 }), (err) => err instanceof HttpError && err.code === 'token_required');
  assert.equal(requireStringField({ token: 'abcdefghijklmnop' }, 'token', { min: 16 }), 'abcdefghijklmnop');
});

test('auth/recovery payload validators enforce username/password constraints', () => {
  assert.throws(() => validateUsername('a'), (err) => err instanceof HttpError && err.code === 'invalid_username');
  assert.throws(() => validatePassword('short'), (err) => err instanceof HttpError && err.code === 'invalid_password');
  assert.equal(validateUsername('user.name-1'), 'user.name-1');
  assert.equal(validatePassword('12345678'), '12345678');
});

test('sensitive routes use asyncRoute + shared validation helpers', () => {
  assert.match(source, /app\.post\('\/api\/register'.*asyncRoute\(async \(req, res\) => \{/s);
  assert.match(source, /app\.post\('\/api\/recovery\/redeem'.*requireStringField\(req\.body, 'token'/s);
  assert.match(source, /app\.post\('\/api\/recovery\/reset'.*validatePassword\(req\.body\?\.password\)/s);
  assert.match(source, /app\.patch\('\/api\/messages\/:id'.*parsePositiveId\(req\.params\.id, 'id'\)/s);
  assert.match(source, /if \(uploadIdsRaw !== undefined && !Array\.isArray\(uploadIdsRaw\)\) throw new HttpError\(400, 'invalid_upload_ids'\)/);
  assert.match(source, /app\.post\('\/api\/upload-image'.*asyncRoute\(async \(req, res\) => \{/s);
});

test('centralized error middleware returns safe non-leaky response', () => {
  assert.match(source, /app\.use\(\(err, _req, res, _next\) => \{/);
  assert.match(source, /if \(err instanceof HttpError\) return res\.status\(err\.status\)\.json\(\{ error: err\.code \}\)/);
  assert.match(source, /return res\.status\(500\)\.json\(\{ error: 'internal_error' \}\)/);
  assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{[^}]*stack/i);
  assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{[^}]*message/i);
});
