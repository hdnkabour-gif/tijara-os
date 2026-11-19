import pg from 'pg';

export type Role = 'runtime' | 'platform' | 'owner';
export type Ctx = { tenantId: string; userId?: string };

const DEV_PW: Record<Role, string> = { runtime: 'runtime_dev_pw', platform: 'platform_dev_pw', owner: 'owner_dev_pw' };
const USER: Record<Role, string> = { runtime: 'app_runtime', platform: 'app_platform', owner: 'app_owner' };

/** In APP_ENV=production a missing role password is a hard error: dev defaults are never used there. */
function password(role: Role): string {
  const v = process.env[`APP_${role.toUpperCase()}_PASSWORD`];
  if (v) return v;
  if (process.env.APP_ENV === 'production') throw new Error(`APP_${role.toUpperCase()}_PASSWORD is required in production`);
  return DEV_PW[role];
}

function target() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1) };
  }
  return { host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE ?? 'tijara_test' };
}

export function makePool(role: Role, max = 10): pg.Pool {
  return new pg.Pool({ ...target(), user: USER[role], password: password(role), max });
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/** Run fn in one transaction with tenant (and optionally user) context set via SET LOCAL semantics. */
export async function withTenant<T>(
  pool: pg.Pool, ctx: Ctx, fn: (c: pg.PoolClient) => Promise<T>, retries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [ctx.tenantId, ctx.userId ?? '']);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(e?.code) && attempt < retries) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

export const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
