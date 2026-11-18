import crypto from 'node:crypto';
import { makePool, withTenant, Ctx } from '../src/db.js';
import { runCommand, CommandCtx } from '../src/commands.js';
import { addMember, createUser, provisionTenant } from '../src/tenancy.js';
import { createItem, ItemDef } from '../src/catalog.js';
import { receiveStock } from '../src/inventory.js';

export const runtime = makePool('runtime');
export const platform = makePool('platform', 3);
export const owner = makePool('owner', 3);

export interface TestTenant {
  tenantId: string; branchId: string; roles: Record<string, string>;
  ownerUserId: string; cashierUserId: string; managerUserId: string;
  ctx: (userId?: string) => Ctx;
}

let seq = 0;
export async function newTenant(plan = 'pro', members = true): Promise<TestTenant> {
  const slug = `t${Date.now().toString(36)}${(seq++).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const t = await provisionTenant(platform, runtime, { name: slug, slug, plan });
  const mk = async (role: string) => {
    const uid = await createUser(platform, `${role}.${slug}@test.local`, `${role} ${slug}`);
    if (members) await addMember(runtime, t.tenantId, uid, t.roles[role]);
    return uid;
  };
  const ownerUserId = await mk('owner');
  const managerUserId = members ? await mk('manager') : ownerUserId;
  const cashierUserId = members ? await mk('cashier') : ownerUserId;
  return { ...t, ownerUserId, cashierUserId, managerUserId, ctx: (u) => ({ tenantId: t.tenantId, userId: u ?? ownerUserId }) };
}

export const key = () => crypto.randomUUID();

/** Run a business command with a fresh idempotency key. */
export function cmd<T>(ctx: Ctx, handler: (cc: CommandCtx) => Promise<T>, opts: { key?: string; type?: string; payload?: unknown; fault?: (p: string) => void } = {}) {
  return runCommand(runtime, ctx, { key: opts.key ?? key(), type: opts.type ?? 'test', payload: opts.payload ?? {}, fault: opts.fault }, handler);
}

export function items(t: TestTenant, defs: Record<string, ItemDef>) {
  return withTenant(runtime, t.ctx(), async (c) => {
    const ids: Record<string, string> = {};
    for (const [k, d] of Object.entries(defs)) ids[k] = await createItem(c, t.tenantId, d);
    return ids;
  });
}

export function stock(t: TestTenant, itemId: string, qty: number, unitCost: number, extra: { batchNo?: string; expiresAt?: string; serials?: { serialNo: string }[] } = {}) {
  return cmd(t.ctx(), (cc) => receiveStock(cc, { branchId: t.branchId, itemId, qty, unitCost, ...extra }));
}

export async function balance(t: TestTenant, itemId: string, status = 'sellable') {
  return withTenant(runtime, t.ctx(), async (c) => {
    const r = await c.query(
      `SELECT COALESCE(sum(on_hand),0) AS on_hand, COALESCE(sum(reserved),0) AS reserved
         FROM stock_balances WHERE item_id=$1 AND stock_status=$2`, [itemId, status]);
    return { onHand: Number(r.rows[0].on_hand), reserved: Number(r.rows[0].reserved), available: Number(r.rows[0].on_hand) - Number(r.rows[0].reserved) };
  });
}

export async function q<T = any>(t: TestTenant, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenant(runtime, t.ctx(), async (c) => (await c.query(sql, params)).rows as T[]);
}

export const closeAll = async () => { await runtime.end(); await platform.end(); await owner.end(); };
