import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBootstrapSecretConfigured, isBootstrapAuthorized } from '../src/bootstrap-auth.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

const validToken = '0123456789abcdef0123456789abcdef';

test('fresh install bootstrap auth accepts a valid configured token', () => {
  assert.equal(isBootstrapSecretConfigured(validToken), true);
  assert.equal(isBootstrapAuthorized(validToken, validToken), true);
});

test('bootstrap auth fails safely when authorization is missing', () => {
  assert.equal(isBootstrapAuthorized(validToken, ''), false);
});

test('bootstrap auth fails with invalid authorization token', () => {
  assert.equal(isBootstrapAuthorized(validToken, 'abcdef0123456789abcdef0123456789'), false);
});

test('bootstrap is disabled by default when secret is missing/invalid', () => {
  assert.equal(isBootstrapSecretConfigured(''), false);
  assert.equal(isBootstrapSecretConfigured('change-me'), false);
  assert.equal(isBootstrapSecretConfigured('short-token'), false);
});

test('backend route enforces bootstrap token and remains closed after initialization', () => {
  assert.match(source, /if \(!isBootstrapSecretConfigured\(BOOTSTRAP_ROOT_TOKEN\)\) return res\.status\(503\)\.json\(\{ error: 'bootstrap_disabled' \}\)/);
  assert.match(source, /if \(!isBootstrapAuthorized\(BOOTSTRAP_ROOT_TOKEN, providedBootstrapToken\)\) return res\.status\(403\)\.json\(\{ error: 'bootstrap_forbidden' \}\)/);
  assert.match(source, /const created = await createRootAdminIfFirst\(\{/);
  assert.match(source, /if \(!created\) return res\.status\(409\)\.json\(\{ error: 'already_initialized' \}\)/);
});
