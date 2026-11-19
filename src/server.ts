import http from 'node:http';
import { makePool } from './db.js';

/**
 * Deployment shell: liveness + readiness only. It intentionally exposes NO business endpoints
 * until authentication and tenant resolution exist, so a deployment can never leak shop data.
 */
const port = Number(process.env.PORT ?? 3000);
const version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? 'dev';
const pool = makePool('runtime', 3);

async function readiness() {
  const role = (await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const unprotected = (await pool.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows[0].n;
  const migrated = (await pool.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations'`)).rows[0].n;
  return { db: true, rlsBypassPossible: Boolean(role.rolsuper || role.rolbypassrls), unprotectedTables: unprotected, migrated: migrated === 1 };
}

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', version });
    if (req.method === 'GET' && req.url === '/ready') {
      const r = await readiness();
      const ok = r.db && !r.rlsBypassPossible && r.unprotectedTables === 0 && r.migrated;
      return send(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', ...r, version });
    }
    return send(res, 404, { error: 'not_found' });
  } catch {
    return send(res, 503, { status: 'not_ready', db: false, version });
  }
}).listen(port, () => console.log(`tijara-os listening on :${port} (${version})`));
