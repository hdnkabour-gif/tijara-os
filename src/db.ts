import pg from 'pg';

export type Role = 'runtime' | 'platform' | 'owner';
export type Ctx = { tenantId: string; userId?: string };

const CREDS: Record<Role, { user: string; password: string }> = {
  runtime: { user: 'app_runtime', password: process.env.PG_RUNTIME_PW ?? 'runtime_dev_pw' },
  platform: { user: 'app_platform', password: process.env.PG_PLATFORM_PW ?? 'platform_dev_pw' },
  owner: { user: 'app_owner', password: process.env.PG_OWNER_PW ?? 'owner_dev_pw' },
};

export function makePool(role: Role, max = 10): pg.Pool {
  const c = CREDS[role];
  return new pg.Pool({
    host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'tijara_test', user: c.user, password: c.password, max,
  });
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
