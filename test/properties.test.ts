import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { adjustStock, reconcile } from '../src/inventory.js';
import { runProduction } from '../src/production.js';
import { cancelOrder, confirmOrder, createOrder, payOrder, quickSale } from '../src/sales.js';
import { cmd, items, newTenant, q, runtime, stock } from './helpers.js';

// small deterministic PRNG so failures are reproducible
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const DOMAIN = new Set(['INSUFFICIENT_STOCK', 'INVALID_STATE', 'VALIDATION', 'FORBIDDEN', 'CONFLICT']);

describe('ledger invariants under random mixed operations (T18)', () => {
  for (const seed of [1, 7, 42]) {
    it(`T18 seed=${seed}: balances always equal the ledger, never negative, reserved never exceeds on_hand, mass conserved`, async () => {
      const rnd = rng(seed);
      const t = await newTenant();
      const ids = await items(t, {
        beef: { sku: 'BEEF', name: 'Beef', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 130 },
        kafta: { sku: 'KAFTA', name: 'Kafta', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 140 },
        bread: { sku: 'BREAD', name: 'Bread', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 2 },
      });
      await stock(t, ids.beef, 40, 100); await stock(t, ids.kafta, 10, 110); await stock(t, ids.bread, 50, 1);
      const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
      const kgs = () => Math.round((0.25 + rnd() * 3) * 100) / 100;
      const open: string[] = [];
      let ok = 0, refused = 0;

      const op = async () => {
        const r = rnd();
        try {
          if (r < 0.35) {
            const item = pick([ids.beef, ids.kafta, ids.bread]); const qty = item === ids.bread ? 1 + Math.floor(rnd() * 3) : kgs();
            await cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: item, qty }], payments: [{ method: 'cash', amount: Math.round(qty * 200 * 100) / 100 }] }));
          } else if (r < 0.5) {
            const item = pick([ids.beef, ids.kafta]); const qty = kgs();
            const o = await cmd(t.ctx(), async (cc) => { const x = await createOrder(cc, { branchId: t.branchId, lines: [{ itemId: item, qty }] }); await confirmOrder(cc, x.orderId); return x; });
            open.push(o.orderId);
          } else if (r < 0.6 && open.length) {
            const id = open.pop()!;
            await cmd(t.ctx(), (cc) => cancelOrder(cc, { orderId: id, reason: 'random' }));
          } else if (r < 0.7 && open.length) {
            const id = open.pop()!;
            const tot = Number((await q(t, `SELECT total FROM sales_orders WHERE id=$1`, [id]))[0].total);
            await cmd(t.ctx(), (cc) => payOrder(cc, { orderId: id, payments: [{ method: 'cash', amount: tot }] }));
          } else if (r < 0.85) {
            const inQty = kgs() + 1, waste = Math.round(inQty * 0.1 * 100) / 100, out = Math.round((inQty - waste) * 100) / 100;
            await cmd(t.ctx(), (cc) => runProduction(cc, { branchId: t.branchId, type: 'transform', inputs: [{ itemId: ids.beef, qty: inQty }],
              outputs: [{ itemId: ids.kafta, qty: out }], waste: [{ qty: Math.round((inQty - out) * 10000) / 10000, reason: 'trim' }] }));
          } else if (r < 0.93) {
            await stock(t, pick([ids.beef, ids.kafta]), kgs() * 2, 100);
          } else {
            await cmd(t.ctx(), (cc) => adjustStock(cc, { branchId: t.branchId, itemId: pick([ids.beef, ids.kafta]), delta: -kgs(), reason: 'count' }));
          }
          ok++;
        } catch (e: any) {
          if (!DOMAIN.has(e?.code)) throw e;       // only expected business refusals are allowed
          refused++;
        }
      };
      for (let i = 0; i < 60; i++) {
        if (rnd() < 0.3) await Promise.all([op(), op(), op()]); else await op();   // some concurrency
      }

      expect(ok).toBeGreaterThan(20);
      expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);                      // balances == Σ ledger
      const bad = await q(t, `SELECT 1 FROM stock_balances WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand`);
      expect(bad).toHaveLength(0);
      // reservations on open orders account exactly for the reserved column
      const res = await q(t, `SELECT COALESCE(sum(qty),0) AS r FROM stock_reservations WHERE status='active'`);
      const bal = await q(t, `SELECT COALESCE(sum(reserved),0) AS r FROM stock_balances`);
      expect(Number(bal[0].r)).toBeCloseTo(Number(res[0].r), 4);
      // every production order conserves mass: consumed = produced + waste
      const po = await q(t, `
        SELECT o.id,
          COALESCE(sum(l.qty) FILTER (WHERE l.kind='input'),0) AS i,
          COALESCE(sum(l.qty) FILTER (WHERE l.kind IN ('output','byproduct','waste')),0) AS o
        FROM production_orders o JOIN production_lines l ON l.production_order_id = o.id GROUP BY o.id`);
      for (const p of po) expect(Math.abs(Number(p.i) - Number(p.o))).toBeLessThan(0.001);
      // every invoice is covered by its allocations or sits on a customer account (here: always fully paid)
      const unpaid = await q(t, `SELECT i.id FROM invoices i WHERE i.status='issued'
        AND i.total <> COALESCE((SELECT sum(amount) FROM payment_allocations WHERE invoice_id=i.id),0)`);
      expect(unpaid).toHaveLength(0);
      console.log(`  seed ${seed}: ${ok} ok / ${refused} refused`);
    });
  }
});
