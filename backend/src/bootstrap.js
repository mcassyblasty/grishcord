const BOOTSTRAP_INIT_LOCK_ID = 94811237;

export async function createRootAdminIfFirst({ pool, username, displayName, displayColor, passwordHash }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_INIT_LOCK_ID]);

    const existing = await client.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const created = await client.query(
      'INSERT INTO users (username, display_name, display_color, password_hash, is_admin) VALUES ($1,$2,$3,$4,true) RETURNING id, username, display_name, is_admin',
      [username, displayName, displayColor, passwordHash]
    );

    await client.query('COMMIT');
    return created.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
