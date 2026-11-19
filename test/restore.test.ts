import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { Api, PW, createShop, key, platformAdmin, startApp, uniq } from './api-helpers.js';

// Real backup -> restore drill. Uses a dedicated backup role (pg_dump needs BYPASSRLS to read every tenant).
const bin = (n: string) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, n) : n);
const host = process.env.PGHOST ?? '127.0.0.1';
const srcDb = process.env.PGDATABASE ?? 'tijara_test';
const adminEnv = { ...process.env, PGPASSWORD: process.env.BACKUP_PASSWORD ?? 'backup_dev_pw' };
const admin = (db: string) => new pg.Client({ host, database: db, user: 'backup_admin', password: adminEnv.PGPASSWORD });
const as = (role: 'app_runtime' | 'app_owner', db: string) =>
  new pg.Client({ host, database: db, user: role, password: role === 'app_runtime' ? 'runtime_dev_pw' : 'owner_dev_pw' });

const restoreDb = `tijara_restore_${uniq('r').toLowerCase()}`;
const dumpFile = `/tmp/claude-0/${restoreDb}.dump`;
let api: Api;
afterAll(async () => {
  await api?.close();
  const c = admin('postgres'); await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${restoreDb}`); await c.end();
});

async function fingerprint(db: string, tenantId: string) {
  const c = as('app_runtime', db); await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
    const q = async (sql: string) => (await c.query(sql)).rows[0];
    const out = {
      items: (await q('SELECT count(*)::int n FROM items')).n,
      movements: (await q('SELECT count(*)::int n, COALESCE(sum(qty_delta),0)::text s FROM stock_movements')),
      balances: (await q('SELECT COALESCE(sum(on_hand),0)::text on_hand, COALESCE(sum(reserved),0)::text reserved FROM stock_balances')),
      invoices: (await q(`SELECT count(*)::int n, COALESCE(sum(total),0)::text total FROM invoices`)),
      payments: (await q('SELECT COALESCE(sum(amount),0)::text s FROM payments')),
      receivables: (await q('SELECT COALESCE(sum(amount),0)::text s FROM receivable_entries')),
      audit: (await q('SELECT count(*)::int n FROM audit_log')).n,
      ledgerMismatches: (await c.query(
        `SELECT 1 FROM (SELECT item_id, stock_status, COALESCE(batch_id,'00000000-0000-0000-0000-000000000000') b, sum(qty_delta) q FROM stock_movements GROUP BY 1,2,3) l
           FULL JOIN (SELECT item_id, stock_status, COALESCE(batch_id,'00000000-0000-0000-0000-000000000000') b, sum(on_hand) q FROM stock_balances GROUP BY 1,2,3) s USING (item_id, stock_status, b)
          WHERE COALESCE(l.q,0) <> COALESCE(s.q,0)`)).rowCount,
    };
    await c.query('COMMIT');
    return out;
  } finally { await c.end(); }
}

describe('backup and restore drill', () => {
  it('R1: a dump of live shop data restores into a fresh database with identical numbers, intact isolation and intact security', async () => {
    api = await startApp();
    const adm = await platformAdmin(api);
    const A = await createShop(api, adm, 'pro', 'Backup A'), B = await createShop(api, adm, 'pro', 'Backup B');
    for (const [s, sku] of [[A, 'MEAT'], [B, 'WRENCH']] as const) {
      const it = (await api.call('POST', '/items', { token: s.ownerToken, body: { sku, name: sku, kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 100 } })).json.id;
      await api.call('POST', '/stock/receive', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, itemId: it, qty: 20, unitCost: 60 } });
      const cust = (await api.call('POST', '/customers', { token: s.ownerToken, body: { name: 'Credit customer', creditLimit: 1000 } })).json.id;
      await api.call('POST', '/sales/quick', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, lines: [{ itemId: it, qty: 3.25 }], payments: [{ method: 'cash', amount: 100 }], customerId: cust } });
      await api.call('POST', '/sales/quick', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, lines: [{ itemId: it, qty: 1.5 }], payments: [{ method: 'card', amount: 150 }] } });
    }
    const before = { A: await fingerprint(srcDb, A.tenantId), B: await fingerprint(srcDb, B.tenantId) };
    expect(before.A.invoices.n).toBe(2); expect(Number(before.A.receivables.s)).toBeGreaterThan(0);

    // backup
    execFileSync(bin('pg_dump'), ['-h', host, '-U', 'backup_admin', '-d', srcDb, '-Fc', '-f', dumpFile], { env: adminEnv });
    // restore into a brand new database
    const root = admin('postgres'); await root.connect();
    await root.query(`CREATE DATABASE ${restoreDb} OWNER app_owner`); await root.end();
    execFileSync(bin('pg_restore'), ['-h', host, '-U', 'backup_admin', '-d', restoreDb, '--exit-on-error', dumpFile], { env: adminEnv });

    // 1) numbers identical, per tenant
    expect(await fingerprint(restoreDb, A.tenantId)).toEqual(before.A);
    expect(await fingerprint(restoreDb, B.tenantId)).toEqual(before.B);
    expect(before.A.ledgerMismatches).toBe(0);

    // 2) isolation still holds in the restored database
    const rt = as('app_runtime', restoreDb); await rt.connect();
    await rt.query('BEGIN'); await rt.query(`SELECT set_config('app.tenant_id',$1,true)`, [A.tenantId]);
    expect((await rt.query(`SELECT DISTINCT tenant_id FROM items`)).rows.map((r) => r.tenant_id)).toEqual([A.tenantId]);
    expect((await rt.query('SELECT count(*)::int n FROM items WHERE tenant_id=$1', [B.tenantId])).rows[0].n).toBe(0);
    await rt.query('ROLLBACK');
    expect((await rt.query('SELECT count(*)::int n FROM items')).rows[0].n).toBe(0);                    // no context -> nothing
    await rt.end();

    // 3) security posture survived: roles, FORCE RLS everywhere, append-only ledger, credential tables closed
    const c = admin(restoreDb); await c.connect();
    const unprotected = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows;
    expect(unprotected).toEqual([]);
    const triggers = (await c.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_ledger_immutable','trg_audit_immutable','trg_platform_audit_immutable')`)).rowCount;
    expect(triggers).toBe(3);
    await c.end();
    const rt2 = as('app_runtime', restoreDb); await rt2.connect();
    await expect(rt2.query('UPDATE stock_movements SET qty_delta = 1')).rejects.toMatchObject({ code: '42501' });
    await expect(rt2.query('SELECT password_hash FROM users')).rejects.toMatchObject({ code: '42501' });
    await expect(rt2.query('SELECT token_hash FROM sessions')).rejects.toMatchObject({ code: '42501' });
    // credentials still work after restore: a restored owner can authenticate through the definer function
    const u = (await rt2.query('SELECT * FROM auth_get_user($1)', [A.ownerEmail])).rows[0];
    expect(u?.password_hash).toMatch(/^scrypt\$/);
    await rt2.end();
    expect(PW).toBeTruthy();
  }, 120_000);
});
