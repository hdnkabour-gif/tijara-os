import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { bootstrapAdmin } from './bootstrap.js';

/**
 * Production-safe migration runner.
 * - Connects with an ADMIN url (hosting provider superuser) ONLY for this step.
 * - Creates/rotates three NOSUPERUSER NOBYPASSRLS roles from env passwords (no defaults).
 * - Applies db/migrations/*.sql exactly once, as app_owner (so FORCE RLS binds the owner too).
 * - Verifies the security posture afterwards and exits non-zero if anything is off.
 */
const need = (n: string) => {
  const v = process.env[n];
  if (!v || v.length < 16) throw new Error(`${n} must be set and at least 16 characters`);
  return v;
};

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required');
  const pw = { app_owner: need('APP_OWNER_PASSWORD'), app_runtime: need('APP_RUNTIME_PASSWORD'), app_platform: need('APP_PLATFORM_PASSWORD') };
  const dir = path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');

  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const db = (await c.query('SELECT current_database() AS d')).rows[0].d as string;
    for (const [role, password] of Object.entries(pw)) {
      const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
      const stmt = (await c.query(
        `SELECT format('%s ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', $1::text, $2::text, $3::text) AS s`,
        [exists ? 'ALTER' : 'CREATE', role, password])).rows[0].s;
      await c.query(stmt);
    }
    await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO app_runtime, app_platform, app_owner`);
    await c.query('ALTER SCHEMA public OWNER TO app_owner');
    await c.query('GRANT app_owner TO CURRENT_USER');

    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_owner');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const f of files) {
      if (applied.has(f)) continue;
      await c.query(readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      console.log(`migration applied: ${f}`);
      ran++;
    }
    // always (idempotent): runtime reads the bookkeeping table, never writes it - regardless of what earlier migrations granted
    await c.query('REVOKE ALL ON schema_migrations FROM app_runtime, app_platform');
    await c.query('GRANT SELECT ON schema_migrations TO app_runtime');
    await c.query('COMMIT');
    if (ran === 0) console.log('migrations: nothing to apply');

    // ── verify posture ──
    const roles = (await c.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_owner','app_runtime','app_platform')`)).rows;
    const badRole = roles.filter((r) => r.rolsuper || r.rolbypassrls);
    const unprotected = (await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows;
    const ownedByRuntime = (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner='app_runtime'`)).rows[0].n;
    if (roles.length !== 3 || badRole.length || unprotected.length || ownedByRuntime) {
      throw new Error(`security posture check failed: ${JSON.stringify({ roles: roles.length, badRole, unprotected, ownedByRuntime })}`);
    }
    console.log('security posture OK: 3 non-bypass roles, all tenant tables FORCE RLS');
    if (process.env.BOOTSTRAP_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_INVITE) {
      if (!process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_INVITE) throw new Error('set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_INVITE together');
      await bootstrapAdmin(c, process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_INVITE);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
