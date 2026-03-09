import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export function resolveDetectedUploadType({ detectedType, originalName }) {
  const allowed = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'], ['application/zip', 'zip']
  ]);
  const fallbackZip = String(originalName || '').toLowerCase().endsWith('.zip') ? { mime: 'application/zip', ext: 'zip' } : null;
  const resolved = detectedType || fallbackZip;
  if (!resolved || !allowed.has(resolved.mime)) return null;
  return { mime: resolved.mime, ext: allowed.get(resolved.mime) };
}

export async function commitUploadedTempFile({
  tempPath,
  originalName,
  fileSize,
  uploadsDir,
  ownerId,
  detectType,
  insertUploadRow,
  moveFile,
  removeFile
}) {
  const detectedType = await detectType(tempPath);
  const resolvedType = resolveDetectedUploadType({ detectedType, originalName });
  if (!resolvedType) {
    await removeFile(tempPath);
    return { ok: false, status: 400, error: 'unsupported_upload_type' };
  }

  const storageName = `${uuidv4()}.${resolvedType.ext}`;
  const finalPath = path.join(uploadsDir, storageName);
  try {
    await moveFile(tempPath, finalPath);
  } catch (e) {
    await removeFile(tempPath);
    throw e;
  }

  try {
    const created = await insertUploadRow({
      storageName,
      contentType: resolvedType.mime,
      byteSize: fileSize,
      ownerId
    });
    return { ok: true, uploadId: created.id };
  } catch (e) {
    await removeFile(finalPath);
    throw e;
  }
}
