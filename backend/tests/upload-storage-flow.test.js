import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitUploadedTempFile, resolveDetectedUploadType } from '../src/upload-storage.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(testDir, '..', 'src', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

test('successful upload commit moves temp file and returns metadata row id', async () => {
  const calls = [];
  const result = await commitUploadedTempFile({
    tempPath: '/tmp/a.upload',
    originalName: 'photo.png',
    fileSize: 1234,
    uploadsDir: '/uploads',
    ownerId: 9,
    detectType: async () => ({ mime: 'image/png' }),
    insertUploadRow: async (row) => {
      calls.push(['insert', row]);
      return { id: 77 };
    },
    moveFile: async (src, dst) => calls.push(['move', src, dst]),
    removeFile: async (p) => calls.push(['remove', p])
  });

  assert.equal(result.ok, true);
  assert.equal(result.uploadId, 77);
  assert.equal(calls[0][0], 'move');
  assert.equal(calls[1][0], 'insert');
  assert.equal(calls[1][1].contentType, 'image/png');
  assert.equal(calls[1][1].byteSize, 1234);
  assert.equal(calls[1][1].ownerId, 9);
});

test('oversized uploads are rejected via multer limit handling in route', () => {
  assert.match(source, /new multer\.MulterError|instanceof multer\.MulterError/);
  assert.match(source, /err\.code === 'LIMIT_FILE_SIZE'/);
  assert.match(source, /res\.status\(413\)\.json\(\{ error: 'file_too_large'/);
});

test('unsupported upload type cleans up temp file', async () => {
  const removed = [];
  const result = await commitUploadedTempFile({
    tempPath: '/tmp/b.upload',
    originalName: 'unknown.bin',
    fileSize: 50,
    uploadsDir: '/uploads',
    ownerId: 1,
    detectType: async () => null,
    insertUploadRow: async () => ({ id: 1 }),
    moveFile: async () => {},
    removeFile: async (p) => removed.push(p)
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_upload_type');
  assert.deepEqual(removed, ['/tmp/b.upload']);
});

test('cleanup on failed upload commit removes destination file after db failure', async () => {
  const removed = [];
  await assert.rejects(() => commitUploadedTempFile({
    tempPath: '/tmp/c.upload',
    originalName: 'photo.jpg',
    fileSize: 42,
    uploadsDir: '/uploads',
    ownerId: 1,
    detectType: async () => ({ mime: 'image/jpeg' }),
    insertUploadRow: async () => { throw new Error('db_down'); },
    moveFile: async () => {},
    removeFile: async (p) => removed.push(p)
  }));
  assert.equal(removed.length, 1);
  assert.match(removed[0], /^\/uploads\/.+\.jpg$/);
});

test('route uses disk-based upload storage instead of memory storage', () => {
  assert.match(source, /const uploadStorage = multer\.diskStorage\(/);
  assert.match(source, /destination: \(_req, _file, cb\) => cb\(null, uploadsTempDir\)/);
  assert.match(source, /app\.post\('\/api\/upload-image', auth, enforceSessionVersion, uploadSingleImage/);
  assert.doesNotMatch(source, /memoryStorage\(\)/);
});

test('zip fallback metadata behavior stays compatible', () => {
  const z = resolveDetectedUploadType({ detectedType: null, originalName: 'archive.zip' });
  assert.deepEqual(z, { mime: 'application/zip', ext: 'zip' });
});
