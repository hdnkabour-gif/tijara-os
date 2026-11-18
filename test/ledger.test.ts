import { describe, expect, it } from 'vitest';
import { confirmOrder, createOrder, quickSale } from '../src/sales.js';
import { balance, cmd, items, key, newTenant, q, stock, TestTenant } from './helpers.js';

async function setup(qty: number) {
  const t = await newTenant();
  const ids = await items(t, { beef: { sku: 'BEEF', name: 'Beef', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 100 } });
  await stock(t, ids.beef, qty, 60);
  return { t, beef: ids.beef };
}
const sellKg = (t: TestTenant, itemId: string, kg: number, opts: { key?: string; fault?: (p: string) => void } = {}) =>
  cmd(t.ctx(t.cashierUserId), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId, qty: kg }], payments: [{ method: 'cash', amount: kg * 100 }] }),
    { key: opts.key, type: 'quick_sale', payload: { itemId, kg }, fault: opts.fault });

describe('availability: on_hand vs reserved vs available (T7)', () => {
  it('T7: 10kg on hand, 7kg reserved by a confirmed order => a 5kg order is refused, 3kg is allowed', async () => {
    const { t, beef } = await setup(10);
    const o1 = await cmd(t.ctx(), async (cc) => { const r = await createOrder(cc, { branchId: t.branchId, lines: [{ itemId: beef, qty: 7 }] }); await confirmOrder(cc, r.orderId); return r; });
    expect(await balance(t, beef)).toEqual({ onHand: 10, reserved: 7, available: 3 });

    const o2 = cmd(t.ctx(), async (cc) => { const r = await createOrder(cc, { branchId: t.branchId, lines: [{ itemId: beef, qty: 5 }] }); await confirmOrder(cc, r.orderId); });
    await expect(o2).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balance(t, beef)).toEqual({ onHand: 10, reserved: 7, available: 3 });   // failed attempt left no trace
    expect(await q(t, `SELECT 1 FROM stock_reservations WHERE status='active'`)).toHaveLength(1);

    await cmd(t.ctx(), async (cc) => { const r = await createOrder(cc, { branchId: t.branchId, lines: [{ itemId: beef, qty: 3 }] }); await confirmOrder(cc, r.orderId); });
    expect(await balance(t, beef)).toEqual({ onHand: 10, reserved: 10, available: 0 });
    expect(o1.orderId).toBeTruthy();
  });

  it('damaged stock is never available for sale', async () => {
    const { t, beef } = await setup(2);
    await q(t, `INSERT INTO stock_balances (tenant_id, branch_id, item_id, stock_status, on_hand) VALUES ($1,$2,$3,'damaged',50)`, [t.tenantId, t.branchId, beef]);
    await expect(sellKg(t, beef, 3)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });
});

describe('concurrent selling (T8)', () => {
  it('T8: two registers race for the last 2kg — exactly one wins, stock never goes negative', async () => {
    for (let round = 0; round < 5; round++) {
      const { t, beef } = await setup(2);
      const res = await Promise.allSettled([sellKg(t, beef, 2), sellKg(t, beef, 2)]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason.code).toBe('INSUFFICIENT_STOCK');
      expect(await balance(t, beef)).toEqual({ onHand: 0, reserved: 0, available: 0 });
      expect(await q(t, `SELECT 1 FROM sales_orders WHERE state='closed'`)).toHaveLength(1);
    }
  });

  it('T8b: 8 concurrent 1kg buyers on 3kg => exactly 3 succeed, 5 refused', async () => {
    const { t, beef } = await setup(3);
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => sellKg(t, beef, 1)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of res.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) expect(r.reason.code).toBe('INSUFFICIENT_STOCK');
    expect(await balance(t, beef)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });
});

describe('idempotent business commands (T12, T13)', () => {
  it('T12: retrying the same multi-movement command returns the saved result and duplicates nothing', async () => {
    const t = await newTenant();
    const ids = await items(t, {
      a: { sku: 'A', name: 'A', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 10 },
      b: { sku: 'B', name: 'B', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 20 },
    });
    await stock(t, ids.a, 10, 5); await stock(t, ids.b, 10, 5);
    const k = key();
    const run = () => cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.a, qty: 2 }, { itemId: ids.b, qty: 3 }], payments: [{ method: 'cash', amount: 80 }] }),
      { key: k, type: 'quick_sale', payload: { n: 1 } });
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(await q(t, `SELECT 1 FROM invoices`)).toHaveLength(1);
    expect(await q(t, `SELECT 1 FROM payments`)).toHaveLength(1);
    expect(await q(t, `SELECT 1 FROM stock_movements WHERE movement_type='sale'`)).toHaveLength(2);   // 2 movements, ONE command
    expect(await balance(t, ids.a)).toMatchObject({ onHand: 8 });
    expect(await balance(t, ids.b)).toMatchObject({ onHand: 7 });
    // concurrent duplicate submit (double click / network retry) still executes once
    const k2 = key();
    const dup = () => cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.a, qty: 1 }], payments: [{ method: 'cash', amount: 10 }] }),
      { key: k2, type: 'quick_sale', payload: { n: 2 } });
    const [x, y] = await Promise.all([dup(), dup()]);
    expect(x).toEqual(y);
    expect(await balance(t, ids.a)).toMatchObject({ onHand: 7 });
  });

  it('T13: reusing a key with a different request is rejected with a conflict', async () => {
    const { t, beef } = await setup(10);
    const k = key();
    await sellKg(t, beef, 1, { key: k });
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: beef, qty: 2 }], payments: [{ method: 'cash', amount: 200 }] }),
      { key: k, type: 'quick_sale', payload: { itemId: beef, kg: 2 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await balance(t, beef)).toMatchObject({ onHand: 9 });
  });
});

describe('atomicity (T14)', () => {
  for (const point of ['after_commit_line', 'after_invoice']) {
    it(`T14: failure injected at "${point}" rolls back invoice, payment, ledger, reservations and the command record`, async () => {
      const { t, beef } = await setup(10);
      const k = key();
      await expect(sellKg(t, beef, 4, { key: k, fault: (p) => { if (p === point) throw new Error(`injected failure at ${point}`); } }))
        .rejects.toThrow(/injected failure/);
      expect(await balance(t, beef)).toEqual({ onHand: 10, reserved: 0, available: 10 });
      for (const tbl of ['sales_orders', 'sales_order_lines', 'invoices', 'payments', 'stock_reservations', 'receivable_entries', 'invoice_counters']) {
        expect(await q(t, `SELECT 1 FROM ${tbl}`), tbl).toHaveLength(0);
      }
      expect(await q(t, `SELECT 1 FROM stock_movements WHERE movement_type='sale'`)).toHaveLength(0);
      expect(await q(t, `SELECT 1 FROM business_commands WHERE idempotency_key=$1`, [k])).toHaveLength(0);
      // the same key can be retried safely afterwards and then succeeds exactly once
      const ok = await sellKg(t, beef, 4, { key: k });
      expect(Number(ok.total)).toBe(400);
      expect(await balance(t, beef)).toMatchObject({ onHand: 6, reserved: 0 });
    });
  }

  it('T14b: second line short of stock after the first was reserved => nothing persists', async () => {
    const t = await newTenant();
    const ids = await items(t, {
      a: { sku: 'A', name: 'A', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 10 },
      b: { sku: 'B', name: 'B', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 10 },
    });
    await stock(t, ids.a, 5, 1); await stock(t, ids.b, 1, 1);
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.a, qty: 3 }, { itemId: ids.b, qty: 2 }], payments: [{ method: 'cash', amount: 50 }] })))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balance(t, ids.a)).toEqual({ onHand: 5, reserved: 0, available: 5 });
    expect(await q(t, `SELECT 1 FROM sales_orders`)).toHaveLength(0);
  });
});
