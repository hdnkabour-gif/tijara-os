import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * One-time platform admin bootstrap (run by the privileged migration job only).
 * - NO password exists. The operator generates a random invitation token LOCALLY and supplies it as a deployment secret
 *   (BOOTSTRAP_ADMIN_INVITE). Only its hash is stored. The token is NEVER printed or logged anywhere by this code.
 * - The invitation is single-use and expires after 60 minutes. No-op when a platform admin already exists.
 */
export const INVITE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export async function bootstrapAdmin(c: pg.Client, rawEmail: string, invite: string, log: (m: string) => void = console.log) {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email');
  if (!INVITE_RE.test(invite)) throw new Error('BOOTSTRAP_ADMIN_INVITE must be 32-128 URL-safe characters (generate with: openssl rand -base64 32 | tr "+/" "-_" | tr -d "=")');
  if ((await c.query('SELECT 1 FROM platform_admins LIMIT 1')).rowCount) {
    log('bootstrap: a platform admin already exists - nothing to do (remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_INVITE)');
    return false;
  }
  const hash = crypto.createHash('sha256').update(invite).digest('hex');
  await c.query('BEGIN');
  try {
    let id = (await c.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0]?.id;
    if (!id) id = (await c.query(`INSERT INTO users (email, name) VALUES ($1,'Platform Admin') RETURNING id`, [email])).rows[0].id;
    await c.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [id]);
    await c.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '60 minutes')`, [id, hash]);
    await c.query(`INSERT INTO platform_audit (action, meta) VALUES ('platform_admin.bootstrapped', $1)`, [JSON.stringify({ userId: id })]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  log('bootstrap: invitation created, valid for 60 minutes, single use. Open /app/#/reset?token=<the invite you generated>. Nothing secret is logged.');
  return true;
}
