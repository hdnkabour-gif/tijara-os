import crypto from 'node:crypto';
import type pg from 'pg';

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const MIN_PASSWORD = 10;
const MAX_FAILURES = 5, LOCK_MINUTES = 15, SESSION_TTL_MIN = 12 * 60, RESET_TTL_MIN = 30;

// scrypt, per-password random salt, constant-time comparison
const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? rej(e) : res(k))));

// equalises timing for unknown users
const DUMMY = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16), N = 16384, r = 8, p = 1;
  const k = await scrypt(pw, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${k.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const [, n, r, p, salt, key] = (stored ?? DUMMY).split('$');
  const k = await scrypt(pw, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  const ok = crypto.timingSafeEqual(k, Buffer.from(key, 'base64'));
  return ok && stored !== null;
}

export const checkPasswordPolicy = (pw: unknown): string | null => {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 200) return 'password too long';
  if (new Set(pw).size < 4) return 'password too weak';
  return null;
};

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => {
  const token = 'tj_' + crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha(token) };
};

export interface SessionInfo { sessionId: string; userId: string; activeTenantId: string | null; name: string; email: string; isPlatformAdmin: boolean }
export interface TenantMembership { tenant_id: string; name: string; slug: string; role_name: string; branch_ids: string[] }

// identical error for unknown user / wrong password / locked / disabled account
const invalid = () => new AuthError(401, 'UNAUTHENTICATED', 'invalid credentials');

export async function login(pool: pg.Pool, a: { email: string; password: string; tenantId?: string; ip?: string; ua?: string }) {
  const u = (await pool.query('SELECT * FROM auth_get_user($1)', [a.email])).rows[0];
  const locked = Boolean(u?.locked_until && new Date(u.locked_until) > new Date());
  const usable = Boolean(u && !u.disabled && !locked);
  const ok = await verifyPassword(a.password, usable ? u.password_hash : null);
  if (!usable || !ok) {
    if (usable) await pool.query('SELECT auth_register_failure($1,$2,$3)', [u.id, MAX_FAILURES, LOCK_MINUTES]);
    throw invalid();
  }
  await pool.query('SELECT auth_register_success($1)', [u.id]);
  const tenants: TenantMembership[] = (await pool.query('SELECT * FROM auth_list_tenants($1)', [u.id])).rows;
  let active: string | null = null;
  if (a.tenantId) {
    if (!tenants.some((t) => t.tenant_id === a.tenantId)) throw invalid();
    active = a.tenantId;
  } else if (tenants.length === 1) active = tenants[0].tenant_id;
  const { token, hash } = newToken();
  await pool.query('SELECT auth_create_session($1,$2,$3,$4,$5,$6)', [u.id, hash, SESSION_TTL_MIN, a.ip ?? null, a.ua ?? null, active]);
  return { token, userId: u.id as string, name: u.name as string, activeTenantId: active, tenants };
}

export async function getSession(pool: pg.Pool, token: string): Promise<SessionInfo | null> {
  if (!/^tj_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const r = (await pool.query('SELECT * FROM auth_get_session($1)', [sha(token)])).rows[0];
  return r ? { sessionId: r.session_id, userId: r.user_id, activeTenantId: r.active_tenant_id, name: r.name, email: r.email, isPlatformAdmin: r.is_platform_admin } : null;
}
export const logout = (pool: pg.Pool, token: string) => pool.query('SELECT auth_revoke_session($1)', [sha(token)]);
export async function switchTenant(pool: pg.Pool, token: string, tenantId: string) {
  return (await pool.query('SELECT auth_set_tenant($1,$2) AS ok', [sha(token), tenantId])).rows[0].ok as boolean;
}
export const listTenants = async (pool: pg.Pool, userId: string): Promise<TenantMembership[]> =>
  (await pool.query('SELECT * FROM auth_list_tenants($1)', [userId])).rows;

export async function changePassword(pool: pg.Pool, s: SessionInfo, token: string, current: string, next: string) {
  const u = (await pool.query('SELECT * FROM auth_get_user($1)', [s.email])).rows[0];
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new AuthError(403, 'FORBIDDEN', 'current password is incorrect');
  const bad = checkPasswordPolicy(next);
  if (bad) throw new AuthError(400, 'VALIDATION', bad);
  await pool.query('SELECT auth_change_password($1,$2,$3)', [s.userId, await hashPassword(next), sha(token)]);
}

/** Returns the reset token so the caller can e-mail it; the HTTP layer never returns it in production. */
export async function requestReset(pool: pg.Pool, email: string): Promise<string | null> {
  const { token, hash } = newToken();
  const uid = (await pool.query('SELECT auth_create_reset($1,$2,$3) AS id', [email, hash, RESET_TTL_MIN])).rows[0].id;
  return uid ? token : null;
}
export async function consumeReset(pool: pg.Pool, token: string, next: string) {
  const bad = checkPasswordPolicy(next);
  if (bad) throw new AuthError(400, 'VALIDATION', bad);
  const ok = (await pool.query('SELECT auth_consume_reset($1,$2) AS ok', [sha(token), await hashPassword(next)])).rows[0].ok;
  if (!ok) throw new AuthError(400, 'VALIDATION', 'invalid or expired reset token');
}
