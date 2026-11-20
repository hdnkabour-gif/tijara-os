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
  const admins = (await c.query('SELECT u.id, lower(u.email) AS email, (u.password_hash IS NOT NULL) AS claimed FROM platform_admins pa JOIN users u ON u.id = pa.user_id')).rows;
  if (admins.some((x) => x.claimed)) {
    log('bootstrap: a platform admin already exists - nothing to do (remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_INVITE)');
    return false;
  }
  // Admins exist but nobody ever set a password (invitation expired/lost): renew ONLY for that same address, never add another admin.
  if (admins.length > 0 && !admins.some((x) => x.email === email)) {
    throw new Error('an unclaimed platform admin with a different email already exists; use that email to renew the invitation');
  }
  const hash = crypto.createHash('sha256').update(invite).digest('hex');
  await c.query('BEGIN');
  try {
    let id = (await c.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0]?.id;
    if (!id) id = (await c.query(`INSERT INTO users (email, name) VALUES ($1,'Platform Admin') RETURNING id`, [email])).rows[0].id;
    await c.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL AND token_hash <> $2', [id, hash]);   // OTHER older invitations stop working
    // the same invitation re-submitted (every redeploy re-runs this job): refresh its window instead of failing on the unique hash
    await c.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '60 minutes')
                   ON CONFLICT (token_hash) DO UPDATE SET expires_at = now() + interval '60 minutes', used_at = NULL WHERE password_resets.user_id = EXCLUDED.user_id`, [id, hash]);
    await c.query(`INSERT INTO platform_audit (action, meta) VALUES ('platform_admin.bootstrapped', $1)`, [JSON.stringify({ userId: id })]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  log('bootstrap: invitation created, valid for 60 minutes, single use. Open /app/#/reset?token=<the invite you generated>. Nothing secret is logged.');
  return true;
}
