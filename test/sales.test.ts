import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { createRecipe } from '../src/catalog.js';
import { decide, setPolicy } from '../src/approvals.js';
import { requestApproval } from '../src/approvals.js';
import { addMember, createUser } from '../src/tenancy.js';
import { reconcile } from '../src/inventory.js';
import { applyDiscount, cancelOrder, confirmOrder, createOrder, markReady, payOrder, quickSale, startPreparation, weighLine } from '../src/sales.js';
import { collectPayment } from '../src/payments.js';
import { customerBalance } from '../src/payments.js';
import { balance, cmd, items, newTenant, platform, q, runtime, stock, TestTenant } from './helpers.js';

const kg = (sku: string, price: number, extra: object = {}) =>
  ({ sku, name: sku, kind: 'goods' as const, trackQuantity: true, fulfillment: 'stock' as const, baseUom: 'kg', price, ...extra });

async function butcher() {
  const t = await newTenant();
  const ids = await items(t, {
    beef: kg('BEEF', 130), kafta: kg('KAFTA', 130), charcoal: kg('CHARCOAL', 0),
    bread: { sku: 'BREAD', name: 'Bread', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 2 },
    grill: { sku: 'GRILL', name: 'Grilling service', kind: 'service', trackQuantity: false, fulfillment: 'none', price: 20 },
    grillMat: { sku: 'GRILL-MAT', name: 'Grilling (uses charcoal)', kind: 'composite', trackQuantity: false, fulfillment: 'backflush', price: 20 },
    plate: { sku: 'PLATE', name: 'Grilled kafta plate', kind: 'composite', trackQuantity: false, fulfillment: 'backflush', price: 60 },
  });
  await withTenant(runtime, t.ctx(), async (c) => {
    await createRecipe(c, t.tenantId, ids.grillMat, [{ componentItemId: ids.charcoal, qtyPerUnit: 0.1 }]);
    await createRecipe(c, t.tenantId, ids.plate, [{ componentItemId: ids.kafta, qtyPerUnit: 0.25 }, { componentItemId: ids.bread, qtyPerUnit: 1 }]);
  });
  await stock(t, ids.beef, 20, 100); await stock(t, ids.kafta, 10, 100);
  await stock(t, ids.charcoal, 50, 5); await stock(t, ids.bread, 100, 1);
  return { t, ids };
}
const movementsFor = (t: TestTenant, lineIds: string[]) =>
  q(t, `SELECT item_id, movement_type, qty_delta, stock_status FROM stock_movements WHERE source_doc_id = ANY($1::uuid[]) ORDER BY command_seq`, [lineIds]);

describe('sale of meat with a grilling service (T1)', () => {
  it('T1: 1.47kg kafta @130 + grilling @20/kg = 220.50; the meat leaves stock ONCE; weighing alone never touches the ledger', async () => {
    const { t, ids } = await butcher();
    const ctx = t.ctx(t.cashierUserId);
    const { orderId, lineIds } = await cmd(ctx, (cc) => createOrder(cc, { branchId: t.branchId, lines: [
      { itemId: ids.kafta, qty: 1.5, prepRequired: true }, { itemId: ids.grill, qty: 1.5 }] }));
    await cmd(ctx, (cc) => confirmOrder(cc, orderId));
    expect(await balance(t, ids.kafta)).toEqual({ onHand: 10, reserved: 1.5, available: 8.5 });   // reserved the estimate

    await cmd(ctx, async (cc) => { await weighLine(cc, orderId, lineIds[0], 1.47); await weighLine(cc, orderId, lineIds[1], 1.47); });
    expect(await balance(t, ids.kafta)).toEqual({ onHand: 10, reserved: 1.47, available: 8.53 }); // resized to the actual weight
    expect(await movementsFor(t, lineIds)).toHaveLength(0);                                       // weighing is NOT a sale
    expect((await q(t, `SELECT total FROM sales_orders WHERE id=$1`, [orderId]))[0].total).toBe('220.50');

    await cmd(ctx, (cc) => startPreparation(cc, orderId));                                         // commit point for prepared lines
    const mv = await movementsFor(t, lineIds);
    expect(mv).toHaveLength(1);                                                                     // ONE ledger movement: the meat
    expect(mv[0]).toMatchObject({ item_id: ids.kafta, movement_type: 'sale', qty_delta: '-1.4700' });
    expect(await balance(t, ids.kafta)).toEqual({ onHand: 8.53, reserved: 0, available: 8.53 });

    await cmd(ctx, (cc) => markReady(cc, orderId));
    const paid = await cmd(ctx, (cc) => payOrder(cc, { orderId, payments: [{ method: 'cash', amount: 220.5 }] }));
    expect(paid).toMatchObject({ total: 220.5, paid: 220.5, due: 0 });
    expect(await movementsFor(t, lineIds)).toHaveLength(1);                                         // payment adds no stock effect
    expect((await q(t, `SELECT state FROM sales_orders WHERE id=$1`, [orderId]))[0].state).toBe('closed');
    expect((await q(t, `SELECT from_state, to_state FROM order_events WHERE order_id=$1 ORDER BY at, id`, [orderId])).map((e) => e.to_state))
      .toEqual(expect.arrayContaining(['draft', 'confirmed', 'in_preparation', 'ready', 'closed']));
    expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);
  });

  it('invalid transitions are refused (confirm twice, weigh after commit)', async () => {
    const { t, ids } = await butcher();
    const { orderId, lineIds } = await cmd(t.ctx(), (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 1, prepRequired: true }] }));
    await cmd(t.ctx(), (cc) => confirmOrder(cc, orderId));
    await expect(cmd(t.ctx(), (cc) => confirmOrder(cc, orderId))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await cmd(t.ctx(), (cc) => startPreparation(cc, orderId));
    await expect(cmd(t.ctx(), (cc) => weighLine(cc, orderId, lineIds[0], 2))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('cancellation and correction (T3–T6)', () => {
  it('T3/T4: cancelling before commit (even after weighing) only releases the reservation — no ledger movement', async () => {
    const { t, ids } = await butcher();
    const base = (await q(t, `SELECT count(*)::int AS n FROM stock_movements`))[0].n;
    for (const weighFirst of [false, true]) {
      const { orderId, lineIds } = await cmd(t.ctx(), (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 5 }] }));
      await cmd(t.ctx(), (cc) => confirmOrder(cc, orderId));
      if (weighFirst) await cmd(t.ctx(), (cc) => weighLine(cc, orderId, lineIds[0], 4.8));
      expect((await balance(t, ids.beef)).reserved).toBeGreaterThan(0);
      await cmd(t.ctx(), (cc) => cancelOrder(cc, { orderId, reason: 'customer changed mind' }));
      expect(await balance(t, ids.beef)).toEqual({ onHand: 20, reserved: 0, available: 20 });
      expect((await q(t, `SELECT state FROM sales_orders WHERE id=$1`, [orderId]))[0].state).toBe('cancelled');
    }
    expect((await q(t, `SELECT count(*)::int AS n FROM stock_movements`))[0].n).toBe(base);
  });

  it('T5: cancelling a paid, committed line: return to stock needs approval; otherwise it is written off; invoice voided and refunded', async () => {
    const { t, ids } = await butcher();
    const sale = await cmd(t.ctx(t.cashierUserId), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 2 }], payments: [{ method: 'cash', amount: 260 }] }));
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 18 });

    // asking to return without an approved request is refused
    await expect(cmd(t.ctx(t.cashierUserId), (cc) => cancelOrder(cc, { orderId: sale.orderId, reason: 'wrong order', committed: 'return' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 18 });

    // cashier requests, manager approves
    const reqId = await withTenant(runtime, t.ctx(), (c) => requestApproval(c, { tenantId: t.tenantId, userId: t.cashierUserId }, { action: 'sale.return', refType: 'sales_order', refId: sale.orderId }));
    await withTenant(runtime, t.ctx(), (c) => decide(c, { tenantId: t.tenantId, userId: t.managerUserId }, { requestId: reqId, decision: 'approved' }));
    await cmd(t.ctx(t.cashierUserId), (cc) => cancelOrder(cc, { orderId: sale.orderId, reason: 'wrong order', committed: 'return' }));

    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 20 });                              // back in sellable stock
    const types = (await q(t, `SELECT movement_type FROM stock_movements WHERE source_doc_id=$1 ORDER BY command_seq`, [sale.lineIds[0]])).map((m) => m.movement_type);
    expect(types).toEqual(['sale', 'return_in']);                                                  // original sale kept, never deleted
    expect((await q(t, `SELECT status FROM invoices WHERE order_id=$1`, [sale.orderId]))[0].status).toBe('void');
    expect(Number((await q(t, `SELECT sum(amount) AS s FROM payments`))[0].s)).toBe(0);           // 260 paid, 260 refunded
    expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);

    // default handling of a committed line is write-off (nothing is silently put back on the shelf)
    const sale2 = await cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 1 }], payments: [{ method: 'cash', amount: 130 }] }));
    await cmd(t.ctx(), (cc) => cancelOrder(cc, { orderId: sale2.orderId, reason: 'dropped on floor' }));
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 19 });
    expect(await balance(t, ids.beef, 'damaged')).toMatchObject({ onHand: 0 });                   // reversal + waste net to zero
    expect((await q(t, `SELECT movement_type FROM stock_movements WHERE source_doc_id=$1 ORDER BY command_seq`, [sale2.lineIds[0]])).map((m) => m.movement_type))
      .toEqual(['sale', 'reversal', 'waste']);
  });

  it('T6: cancelling while it is already on the grill => write-off (never returned to stock)', async () => {
    const { t, ids } = await butcher();
    const { orderId, lineIds } = await cmd(t.ctx(), (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.kafta, qty: 2, prepRequired: true }] }));
    await cmd(t.ctx(), (cc) => confirmOrder(cc, orderId));
    await cmd(t.ctx(), (cc) => startPreparation(cc, orderId));
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 8 });
    await expect(cmd(t.ctx(), (cc) => cancelOrder(cc, { orderId, reason: 'x', committed: 'return' }))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await cmd(t.ctx(), (cc) => cancelOrder(cc, { orderId, reason: 'customer left while grilling' }));
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 8 });                              // still gone
    expect((await movementsFor(t, lineIds)).map((m) => m.movement_type)).toEqual(['sale', 'reversal', 'waste']);
    expect(await q(t, `SELECT reason_code FROM stock_movements WHERE movement_type='waste'`)).toEqual([{ reason_code: 'customer left while grilling' }]);
    expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);
  });
});

describe('mixed activities in one order (T21)', () => {
  it('T21: raw meat + grilling service with charcoal + plated meals — each component leaves stock exactly once', async () => {
    const { t, ids } = await butcher();
    const r = await cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [
      { itemId: ids.beef, qty: 2 }, { itemId: ids.grillMat, qty: 2 }, { itemId: ids.plate, qty: 2 }],
      payments: [{ method: 'cash', amount: 420 }] }));
    expect(r.total).toBe(420);                                                                     // 260 + 40 + 120
    const mv = await movementsFor(t, r.lineIds);
    const by = (item: string) => mv.filter((m) => m.item_id === item);
    expect(by(ids.beef).map((m) => [m.movement_type, Number(m.qty_delta)])).toEqual([['sale', -2]]);
    expect(by(ids.charcoal).map((m) => [m.movement_type, Number(m.qty_delta)])).toEqual([['backflush_consume', -0.2]]);
    expect(by(ids.kafta).map((m) => [m.movement_type, Number(m.qty_delta)])).toEqual([['backflush_consume', -0.5]]);
    expect(by(ids.bread).map((m) => [m.movement_type, Number(m.qty_delta)])).toEqual([['backflush_consume', -2]]);
    expect(mv).toHaveLength(4);                                                                    // nothing else, nothing twice
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 18 });
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 9.5 });
    expect(await balance(t, ids.plate)).toMatchObject({ onHand: 0 });                              // the meal itself never has stock
    expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);
  });

  it('a backflush meal fails atomically if a component is missing', async () => {
    const { t, ids } = await butcher();
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.plate, qty: 60 }], payments: [{ method: 'cash', amount: 3600 }] })))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });                                       // 60 x 0.25 = 15kg > 10kg
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 10, reserved: 0 });
    expect(await balance(t, ids.bread)).toMatchObject({ onHand: 100, reserved: 0 });
  });
});

describe('approvals (T15, T16)', () => {
  it('T15: a discount above the limit blocks payment until a DIFFERENT authorised user approves it', async () => {
    const { t, ids } = await butcher();
    await withTenant(runtime, t.ctx(), (c) => setPolicy(c, t.tenantId, { action: 'sale.discount', maxValue: 10, approverPermission: 'approvals.decide' }));
    const cashier = t.ctx(t.cashierUserId);
    const { orderId } = await cmd(cashier, (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 2 }] }));
    await cmd(cashier, (cc) => confirmOrder(cc, orderId));

    expect(await cmd(cashier, (cc) => applyDiscount(cc, { orderId, pct: 5 }))).toEqual({ approvalRequired: false });
    const d = await cmd(cashier, (cc) => applyDiscount(cc, { orderId, pct: 25 })) as any;
    expect(d.approvalRequired).toBe(true);
    await expect(cmd(cashier, (cc) => payOrder(cc, { orderId, payments: [{ method: 'cash', amount: 195 }] }))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // the cashier has no approval permission
    await expect(withTenant(runtime, cashier, (c) => decide(c, { tenantId: t.tenantId, userId: t.cashierUserId }, { requestId: d.requestId, decision: 'approved' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withTenant(runtime, t.ctx(), (c) => decide(c, { tenantId: t.tenantId, userId: t.managerUserId }, { requestId: d.requestId, decision: 'approved' }));
    const paid = await cmd(cashier, (cc) => payOrder(cc, { orderId, payments: [{ method: 'cash', amount: 195 }] }));
    expect(paid.total).toBe(195);                                                                  // 260 less 25%
    expect(await q(t, `SELECT 1 FROM audit_log WHERE action='approval.approved'`)).toHaveLength(1);
  });

  it('T15b: a manager who requested a discount cannot approve it themselves when the team has other members', async () => {
    const { t, ids } = await butcher();
    await withTenant(runtime, t.ctx(), (c) => setPolicy(c, t.tenantId, { action: 'sale.discount', maxValue: 10, approverPermission: 'approvals.decide' }));
    const mgr = t.ctx(t.managerUserId);
    const { orderId } = await cmd(mgr, (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 1 }] }));
    await cmd(mgr, (cc) => confirmOrder(cc, orderId));
    const d = await cmd(mgr, (cc) => applyDiscount(cc, { orderId, pct: 30 })) as any;
    await expect(withTenant(runtime, mgr, (c) => decide(c, { tenantId: t.tenantId, userId: t.managerUserId }, { requestId: d.requestId, decision: 'approved', stepUp: true, reason: 'ok' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('T16: a sole owner may self-approve only with step-up + a written reason; it is flagged and audited', async () => {
    const t = await newTenant('pro', false);
    const only = await createUser(platform, `solo.${t.tenantId}@t.local`, 'solo');
    await addMember(runtime, t.tenantId, only, t.roles.owner);
    const ids = await items(t, { beef: kg('BEEF', 130) });
    await stock(t, ids.beef, 10, 100);
    await withTenant(runtime, t.ctx(only), (c) => setPolicy(c, t.tenantId, { action: 'sale.discount', maxValue: 10, approverPermission: 'approvals.decide' }));
    const ctx = t.ctx(only);
    const { orderId } = await cmd(ctx, (cc) => createOrder(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 1 }] }));
    await cmd(ctx, (cc) => confirmOrder(cc, orderId));
    const d = await cmd(ctx, (cc) => applyDiscount(cc, { orderId, pct: 20 })) as any;
    const me = { tenantId: t.tenantId, userId: only };
    await expect(withTenant(runtime, ctx, (c) => decide(c, me, { requestId: d.requestId, decision: 'approved' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(withTenant(runtime, ctx, (c) => decide(c, me, { requestId: d.requestId, decision: 'approved', stepUp: true }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withTenant(runtime, ctx, (c) => decide(c, me, { requestId: d.requestId, decision: 'approved', stepUp: true, reason: 'regular customer, owner decision' }));
    const row = (await q(t, `SELECT self_approved, status FROM approval_requests WHERE id=$1`, [d.requestId]))[0];
    expect(row).toEqual({ self_approved: true, status: 'approved' });
    const a = (await q(t, `SELECT meta FROM audit_log WHERE action='approval.approved'`))[0];
    expect(a.meta).toMatchObject({ selfApproved: true, reason: 'regular customer, owner decision' });
    expect((await cmd(ctx, (cc) => payOrder(cc, { orderId, payments: [{ method: 'cash', amount: 104 }] }))).total).toBe(104);
  });
});

describe('partial payments and simple credit (T22)', () => {
  it('T22: partial payment, later collection, balance and allocations always agree; limits enforced', async () => {
    const { t, ids } = await butcher();
    const cust = (await withTenant(runtime, t.ctx(), (c) => c.query(
      `INSERT INTO customers (tenant_id, name, credit_limit) VALUES ($1,'Restaurant Atlas',500) RETURNING id`, [t.tenantId]))).rows[0].id;
    const balanceOf = () => withTenant(runtime, t.ctx(), (c) => customerBalance(c, cust));

    const s = await cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, customerId: cust, lines: [{ itemId: ids.beef, qty: 2 }], payments: [{ method: 'cash', amount: 100 }] }));
    expect(s).toMatchObject({ total: 260, paid: 100, due: 160 });
    expect(await balanceOf()).toBe(160);

    await expect(cmd(t.ctx(), (cc) => collectPayment(cc, { invoiceId: s.invoiceId, payment: { method: 'cash', amount: 200 } }))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await cmd(t.ctx(), (cc) => collectPayment(cc, { invoiceId: s.invoiceId, payment: { method: 'transfer', amount: 110 } }))).toEqual({ due: 50 });
    expect(await balanceOf()).toBe(50);
    expect(await cmd(t.ctx(), (cc) => collectPayment(cc, { invoiceId: s.invoiceId, payment: { method: 'cash', amount: 50 } }))).toEqual({ due: 0 });
    expect(await balanceOf()).toBe(0);
    expect(Number((await q(t, `SELECT sum(amount) AS s FROM payment_allocations WHERE invoice_id=$1`, [s.invoiceId]))[0].s)).toBe(260);
    await expect(cmd(t.ctx(), (cc) => collectPayment(cc, { invoiceId: s.invoiceId, payment: { method: 'cash', amount: 1 } }))).rejects.toMatchObject({ code: 'VALIDATION' });

    // credit limit (500) and anonymous-credit rules
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, customerId: cust, lines: [{ itemId: ids.beef, qty: 5 }], payments: [] })))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });                                            // 650 due > 500 limit
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.beef, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] })))
      .rejects.toMatchObject({ code: 'VALIDATION' });                                               // unpaid without identified customer
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 18, reserved: 0 });                  // failed sales left no trace
  });
});

describe('equipment with serial numbers + installation service (T20)', () => {
  it('T20: a serial-numbered pump is sold once; the installation service touches no stock; warranty is recorded', async () => {
    const t = await newTenant();
    const ids = await items(t, {
      pump: { sku: 'PUMP', name: 'Water pump', kind: 'goods', trackQuantity: true, serialTracking: true, fulfillment: 'stock', price: 1000 },
      install: { sku: 'INST', name: 'Installation', kind: 'service', trackQuantity: false, fulfillment: 'none', price: 150 },
    });
    await expect(stock(t, ids.pump, 2, 700, { serials: [{ serialNo: 'S1' }] })).rejects.toMatchObject({ code: 'VALIDATION' });   // one serial per unit
    await cmd(t.ctx(), (cc) => import('../src/inventory.js').then((m) => m.receiveStock(cc, { branchId: t.branchId, itemId: ids.pump, qty: 2, unitCost: 700,
      serials: [{ serialNo: 'S1', warrantyUntil: '2027-12-31' }, { serialNo: 'S2', warrantyUntil: '2027-12-31' }] })));
    const sale = await cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.pump, qty: 1, serialNo: 'S1' }, { itemId: ids.install, qty: 1 }], payments: [{ method: 'card', amount: 1150 }] }));
    expect(sale.total).toBe(1150);
    expect((await q(t, `SELECT serial_no, status, warranty_until::text AS w FROM serials ORDER BY serial_no`)))
      .toEqual([{ serial_no: 'S1', status: 'sold', w: '2027-12-31' }, { serial_no: 'S2', status: 'in_stock', w: '2027-12-31' }]);
    expect((await movementsFor(t, sale.lineIds)).map((m) => m.movement_type)).toEqual(['sale']);                                 // service line: no movement
    expect(await balance(t, ids.pump)).toMatchObject({ onHand: 1 });
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.pump, qty: 1, serialNo: 'S1' }], payments: [{ method: 'cash', amount: 1000 }] })))
      .rejects.toMatchObject({ code: 'CONFLICT' });                                                                               // same serial cannot be sold twice
    await expect(cmd(t.ctx(), (cc) => quickSale(cc, { branchId: t.branchId, lines: [{ itemId: ids.pump, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] })))
      .rejects.toMatchObject({ code: 'VALIDATION' });                                                                             // serial item needs a serial no.
    expect(await balance(t, ids.pump)).toMatchObject({ onHand: 1, reserved: 0 });
  });
});
