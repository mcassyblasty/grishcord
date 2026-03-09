export function normalizeUploadIds(uploadIds) {
  return [...new Set((Array.isArray(uploadIds) ? uploadIds : []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
}

export async function findUnreferencedUploadsByIds(client, uploadIds) {
  const ids = normalizeUploadIds(uploadIds);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT u.id, u.storage_name
     FROM uploads u
     WHERE u.id = ANY($1::bigint[])
       AND NOT EXISTS (SELECT 1 FROM message_uploads mu WHERE mu.upload_id = u.id)`,
    [ids]
  );
  return rows;
}

export async function deleteUnreferencedUploadsByIds(client, uploadIds) {
  const ids = normalizeUploadIds(uploadIds);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `DELETE FROM uploads u
     WHERE u.id = ANY($1::bigint[])
       AND NOT EXISTS (SELECT 1 FROM message_uploads mu WHERE mu.upload_id = u.id)
     RETURNING u.id, u.storage_name`,
    [ids]
  );
  return rows;
}

export async function findStaleUnattachedUploads(client, { olderThanMs, limit = 200 }) {
  const cutoff = Number(olderThanMs);
  if (!Number.isFinite(cutoff) || cutoff <= 0) return [];
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const { rows } = await client.query(
    `SELECT u.id, u.storage_name
     FROM uploads u
     WHERE u.created_at < to_timestamp($1 / 1000.0)
       AND NOT EXISTS (SELECT 1 FROM message_uploads mu WHERE mu.upload_id = u.id)
     ORDER BY u.created_at ASC
     LIMIT $2`,
    [cutoff, cap]
  );
  return rows;
}
