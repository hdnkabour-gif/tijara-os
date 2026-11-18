import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { addMember, createUser } from '../src/tenancy.js';
import { audit } from '../src/audit.js';
import { newTenant, runtime, platform, owner, items, stock, cmd, q } from './helpers.js';

afterAll(async () => { /* pools closed in last file via process exit */ });

describe('tenant isolation (RLS) — T9, T10, T11', () => {
  it('T9: tenant B sees/writes nothing of tenant A, even on direct SQL with the runtime role', async () => {
    const A = await newTenant(), B = await newTenant();
    const ids = await items(A, { beef: { sku: 'BEEF', name: 'Beef', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 100 } });
    const custA = (await withTenant(runtime, A.ctx(), (c) => c.query(
      `INSERT INTO customers (tenant_id, name) VALUES ($1,'cust A') RETURNING id`, [A.tenantId]))).rows[0].id;
    await withTenant(runtime, A.ctx(), (c) => audit(c, A.tenantId, A.ownerUserId, 'test.event'));

    // read isolation
    expect(await q(B, `SELECT * FROM items`)).toHaveLength(0);
    expect(await q(B, `SELECT * FROM customers`)).toHaveLength(0);
    expect(await q(B, `SELECT * FROM audit_log`)).toHaveLength(0);
    expect((await q(A, `SELECT * FROM audit_log`)).length).toBeGreaterThan(0);
    expect((await q(B, `SELECT id FROM tenants`)).map((r) => r.id)).toEqual([B.tenantId]);

    // no tenant context at all => no rows
    const bare = await runtime.query(`SELECT count(*)::int AS n FROM items`);
    expect(bare.rows[0].n).toBe(0);

    // write isolation: cannot insert a row for another tenant
    await expect(withTenant(runtime, B.ctx(), (c) => c.query(
      `INSERT INTO items (tenant_id, sku, name, kind, track_quantity, fulfillment) VALUES ($1,'X','X','goods',true,'stock')`, [A.tenantId])))
      .rejects.toMatchObject({ code: '42501' });

    // cannot touch another tenant's row
    const upd = await withTenant(runtime, B.ctx(), (c) => c.query(`UPDATE items SET name='hacked' WHERE id=$1`, [ids.beef]));
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(runtime, B.ctx(), (c) => c.query(`DELETE FROM items WHERE id=$1`, [ids.beef]));
    expect(del.rowCount).toBe(0);
    expect((await q(A, `SELECT name FROM items WHERE id=$1`, [ids.beef]))[0].name).toBe('Beef');

    // composite FK: B cannot reference A's customer, even by guessing its id
    await expect(withTenant(runtime, B.ctx(), (c) => c.query(
      `INSERT INTO sales_orders (tenant_id, branch_id, customer_id) VALUES ($1,$2,$3)`, [B.tenantId, B.branchId, custA])))
      .rejects.toMatchObject({ code: '23503' });
    // ...nor A's item from a B order line
    const ord = (await withTenant(runtime, B.ctx(), (c) => c.query(
      `INSERT INTO sales_orders (tenant_id, branch_id) VALUES ($1,$2) RETURNING id`, [B.tenantId, B.branchId]))).rows[0].id;
    await expect(withTenant(runtime, B.ctx(), (c) => c.query(
      `INSERT INTO sales_order_lines (tenant_id, order_id, line_no, item_id, fulfillment, ordered_qty, unit_price)
       VALUES ($1,$2,1,$3,'stock',1,1)`, [B.tenantId, ord, ids.beef]))).rejects.toMatchObject({ code: '23503' });
  });

  it('T10: runtime role cannot bypass RLS, owns nothing, cannot create tenants; all tenant tables are FORCE-RLS', async () => {
    const role = (await owner.query(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='app_runtime'`)).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    const owned = (await owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner='app_runtime'`)).rows[0].n;
    expect(owned).toBe(0);
    await expect(runtime.query(`SELECT create_tenant('x','x-slug','pro')`)).rejects.toMatchObject({ code: '42501' });
    const unprotected = (await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows;
    expect(unprotected).toEqual([]);
  });

  it('T11: a user in two tenants sees each tenant only through its own context', async () => {
    const A = await newTenant(), B = await newTenant();
    const u = await createUser(platform, `multi.${A.tenantId}@test.local`, 'Multi');
    await addMember(runtime, A.tenantId, u, A.roles.cashier);
    await addMember(runtime, B.tenantId, u, B.roles.manager);

    const inA = await withTenant(runtime, { tenantId: A.tenantId, userId: u }, async (c) => ({
      tenants: (await c.query(`SELECT id FROM tenants ORDER BY id`)).rows.map((r) => r.id),
      memberships: (await c.query(`SELECT tenant_id, user_id FROM memberships`)).rows,
      roles: (await c.query(`SELECT id FROM roles`)).rows.map((r) => r.id),
    }));
    // the user can discover their own tenants...
    expect(inA.tenants.sort()).toEqual([A.tenantId, B.tenantId].sort());
    // ...but in A's context sees only A's roles and never other users of B
    expect(new Set(inA.roles)).toEqual(new Set(Object.values(A.roles)));
    expect(inA.memberships.every((m: any) => m.tenant_id === A.tenantId || m.user_id === u)).toBe(true);
    expect(inA.memberships.some((m: any) => m.tenant_id === B.tenantId && m.user_id !== u)).toBe(false);
    // tenant data of B is invisible in A's context
    await items(B, { z: { sku: 'Z', name: 'Z', kind: 'goods', trackQuantity: true, fulfillment: 'stock' } });
    expect(await q({ ...A, ctx: () => ({ tenantId: A.tenantId, userId: u }) }, `SELECT * FROM items`)).toHaveLength(0);
  });
});

describe('append-only ledger — T17', () => {
  it('runtime cannot UPDATE/DELETE stock_movements or audit_log; trigger blocks even the owner', async () => {
    const t = await newTenant();
    const ids = await items(t, { a: { sku: 'A', name: 'A', kind: 'goods', trackQuantity: true, fulfillment: 'stock' } });
    await stock(t, ids.a, 5, 10);
    await withTenant(runtime, t.ctx(), (c) => audit(c, t.tenantId, t.ownerUserId, 'x'));
    await expect(withTenant(runtime, t.ctx(), (c) => c.query(`UPDATE stock_movements SET qty_delta = 99`))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(runtime, t.ctx(), (c) => c.query(`DELETE FROM stock_movements`))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(runtime, t.ctx(), (c) => c.query(`UPDATE audit_log SET action = 'x'`))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(owner, t.ctx(), (c) => c.query(`UPDATE stock_movements SET qty_delta = 99`))).rejects.toThrow(/append-only/);
    await expect(withTenant(owner, t.ctx(), (c) => c.query(`DELETE FROM audit_log`))).rejects.toThrow(/append-only/);
  });
});

describe('plan quotas — T24 and item model constraints', () => {
  it('T24: plan limits are enforced in the database', async () => {
    const t = await newTenant('tiny', false);
    const u1 = await createUser(platform, `q1.${t.tenantId}@t.local`, 'q1');
    const u2 = await createUser(platform, `q2.${t.tenantId}@t.local`, 'q2');
    const u3 = await createUser(platform, `q3.${t.tenantId}@t.local`, 'q3');
    await addMember(runtime, t.tenantId, u1, t.roles.owner);
    await addMember(runtime, t.tenantId, u2, t.roles.cashier);
    await expect(addMember(runtime, t.tenantId, u3, t.roles.cashier)).rejects.toThrow(/user limit/);
    for (let i = 0; i < 6; i++) {
      await items(t, { x: { sku: `S${i}`, name: `S${i}`, kind: 'goods', trackQuantity: false, fulfillment: 'none' } });
    }
    await expect(items(t, { x: { sku: 'S7', name: 'S7', kind: 'goods', trackQuantity: false, fulfillment: 'none' } })).rejects.toThrow(/item limit/);
  });

  it('item capability rules are enforced (a service never holds stock; serial implies tracked quantity)', async () => {
    const t = await newTenant();
    await expect(items(t, { s: { sku: 'SV', name: 'SV', kind: 'service', trackQuantity: true, fulfillment: 'stock' } })).rejects.toMatchObject({ code: '23514' });
    await expect(items(t, { s: { sku: 'SV2', name: 'SV2', kind: 'goods', trackQuantity: false, fulfillment: 'stock' } })).rejects.toMatchObject({ code: '23514' });
    await expect(items(t, { s: { sku: 'SV3', name: 'SV3', kind: 'goods', trackQuantity: false, fulfillment: 'none', serialTracking: true } })).rejects.toMatchObject({ code: '23514' });
    await expect(items(t, { s: { sku: 'SV4', name: 'SV4', kind: 'composite', trackQuantity: true, fulfillment: 'backflush' } })).rejects.toMatchObject({ code: '23514' });
    // valid ones pass
    await items(t, { ok1: { sku: 'OK1', name: 'ok', kind: 'service', trackQuantity: false, fulfillment: 'none' },
                     ok2: { sku: 'OK2', name: 'ok', kind: 'composite', trackQuantity: false, fulfillment: 'backflush' } });
  });
});
