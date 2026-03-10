export async function consumeRecoveryReset({ pool, tokenHash, passwordHash }) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const redeemed = await client.query(
      'UPDATE recovery_tokens SET used_at = now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id',
      [tokenHash]
    );
    const userId = redeemed.rows[0]?.user_id;
    if (!userId) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return null;
    }
    await client.query('UPDATE users SET password_hash=$1, session_version = session_version + 1 WHERE id=$2', [passwordHash, userId]);
    await client.query('COMMIT');
    inTransaction = false;
    return userId;
  } catch (e) {
    if (inTransaction) await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
