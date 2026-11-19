import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * One-time platform admin bootstrap (run by the privileged migration job only).
 * - Creates NO password. It issues a single-use, 60-minute invitation token (only its hash is stored).
 * - No-op when a platform admin already exists, so leaving BOOTSTRAP_ADMIN_EMAIL set is harmless.
 */
export async function bootstrapAdmin(c: pg.Client, rawEmail: string, log: (m: string) => void = console.log) {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email');
  if ((await c.query('SELECT 1 FROM platform_admins LIMIT 1')).rowCount) {
    log('bootstrap: a platform admin already exists - nothing to do (remove BOOTSTRAP_ADMIN_EMAIL)');
    return null;
  }
  const token = 'tj_' + crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await c.query('BEGIN');
  try {
    let id = (await c.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0]?.id;
    if (!id) id = (await c.query(`INSERT INTO users (email, name) VALUES ($1,'Platform Admin') RETURNING id`, [email])).rows[0].id;
    await c.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [id]);
    await c.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '60 minutes')`, [id, hash]);
    await c.query(`INSERT INTO platform_audit (action, meta) VALUES ('platform_admin.bootstrapped', $1)`, [JSON.stringify({ userId: id })]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  log(`bootstrap: platform admin invited. Open /#/reset?token=${token} within 60 minutes to choose a password (single use).`);
  return token;
}
