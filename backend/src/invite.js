export async function registerWithSingleUseInvite({ pool, tokenHash, username, displayName, displayColor, passwordHash }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const consumed = await client.query(`
      UPDATE invites
      SET used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id
    `, [tokenHash]);

    const inviteId = consumed.rows[0]?.id;
    if (!inviteId) {
      await client.query('ROLLBACK');
      return null;
    }

    const created = await client.query(
      'INSERT INTO users (username, display_name, display_color, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [username, displayName, displayColor, passwordHash]
    );

    await client.query('UPDATE invites SET used_by = $1 WHERE id = $2', [created.rows[0].id, inviteId]);
    await client.query('COMMIT');
    return created.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
