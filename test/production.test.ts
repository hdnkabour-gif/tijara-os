import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { addPolicyVersion, createCostPolicy } from '../src/catalog.js';
import { consumeDirect, receiveStock, reconcile } from '../src/inventory.js';
import { runProduction } from '../src/production.js';
import { balance, cmd, items, newTenant, q, runtime, stock } from './helpers.js';

const kg = (sku: string, price = 0, extra: object = {}) =>
  ({ sku, name: sku, kind: 'goods' as const, trackQuantity: true, fulfillment: 'stock' as const, baseUom: 'kg', price, ...extra });

describe('transform with loss (T2)', () => {
  it('T2: 5kg beef -> 4.6kg kafta + 0.4kg waste: raw is deducted ONCE (5kg), waste is a document line', async () => {
    const t = await newTenant();
    const ids = await items(t, { beef: kg('BEEF', 130), kafta: kg('KAFTA', 130) });
    await stock(t, ids.beef, 10, 100);
    const r = await cmd(t.ctx(), (cc) => runProduction(cc, {
      branchId: t.branchId, type: 'transform',
      inputs: [{ itemId: ids.beef, qty: 5 }], outputs: [{ itemId: ids.kafta, qty: 4.6 }],
      waste: [{ qty: 0.4, reason: 'bones and fat' }],
    }));
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 5 });          // 10 - 5, NOT 10 - 5 - 0.4
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 4.6 });
    const mv = await q(t, `SELECT movement_type, item_id, qty_delta FROM stock_movements WHERE source_doc_id=$1 ORDER BY command_seq`, [r.productionOrderId]);
    expect(mv.map((m) => m.movement_type)).toEqual(['production_consume', 'production_output']);   // no waste movement on raw
    expect(mv.map((m) => Number(m.qty_delta))).toEqual([-5, 4.6]);
    expect(r.totalInputCost).toBe(500);
    expect(r.outputs[0].unitCost).toBeCloseTo(500 / 4.6, 3);                  // yield loss absorbed by the output
    expect(r.wasteCost).toBe(40);                                             // memo: 0.4kg x 100
    const lines = await q(t, `SELECT kind, qty, memo_cost FROM production_lines WHERE production_order_id=$1 ORDER BY kind`, [r.productionOrderId]);
    expect(lines.find((l) => l.kind === 'waste')).toMatchObject({ qty: '0.4000', memo_cost: '40.0000' });
    expect(await withTenant(runtime, t.ctx(), (c) => reconcile(c))).toEqual([]);
  });

  it('rejects an unbalanced order (inputs must equal outputs + by-products + waste) and persists nothing', async () => {
    const t = await newTenant();
    const ids = await items(t, { beef: kg('BEEF'), kafta: kg('KAFTA') });
    await stock(t, ids.beef, 10, 100);
    await expect(cmd(t.ctx(), (cc) => runProduction(cc, {
      branchId: t.branchId, type: 'transform', inputs: [{ itemId: ids.beef, qty: 5 }],
      outputs: [{ itemId: ids.kafta, qty: 4.6 }], waste: [{ qty: 0.3, reason: 'x' }],
    }))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 10 });
    expect(await q(t, `SELECT 1 FROM production_orders`)).toHaveLength(0);
  });

  it('cannot consume more than is available; failure leaves stock untouched', async () => {
    const t = await newTenant();
    const ids = await items(t, { beef: kg('BEEF'), kafta: kg('KAFTA') });
    await stock(t, ids.beef, 3, 100);
    await expect(cmd(t.ctx(), (cc) => runProduction(cc, {
      branchId: t.branchId, type: 'transform', inputs: [{ itemId: ids.beef, qty: 5 }], outputs: [{ itemId: ids.kafta, qty: 5 }],
    }))).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balance(t, ids.beef)).toMatchObject({ onHand: 3 });
    expect(await balance(t, ids.kafta)).toMatchObject({ onHand: 0 });
  });

  it('by-products with stock (bones for broth) are outputs, not waste; relative-value allocation splits cost by value', async () => {
    const t = await newTenant();
    const { policyId } = await withTenant(runtime, t.ctx(), (c) =>
      createCostPolicy(c, t.tenantId, 'cuts', { selection: 'fefo', valuation: 'weighted_average', allocation: 'by_relative_value' }));
    const ids = await items(t, { beef: kg('BEEF'), filet: kg('FILET', 0, { costPolicyId: policyId }), kafta: kg('KAFTA', 0, { costPolicyId: policyId }), bones: kg('BONES', 0, { costPolicyId: policyId }) });
    await stock(t, ids.beef, 10, 100);
    const r = await cmd(t.ctx(), (cc) => runProduction(cc, {
      branchId: t.branchId, type: 'transform', inputs: [{ itemId: ids.beef, qty: 4.5 }],
      outputs: [{ itemId: ids.filet, qty: 1, relativeValue: 200 }, { itemId: ids.kafta, qty: 3, relativeValue: 100 }],
      byproducts: [], waste: [{ qty: 0.5, reason: 'trim' }],
    }));
    const u = Object.fromEntries(r.outputs.map((o: any) => [o.itemId, o.unitCost]));
    expect(u[ids.filet]).toBeCloseTo(180, 3);      // 450 * 200/500
    expect(u[ids.kafta]).toBeCloseTo(90, 3);       // 450 * 300/500 / 3kg
    // a by-product that has stock is recorded as an output movement
    const r2 = await cmd(t.ctx(), (cc) => runProduction(cc, {
      branchId: t.branchId, type: 'transform', inputs: [{ itemId: ids.beef, qty: 2 }],
      outputs: [{ itemId: ids.kafta, qty: 1.5, relativeValue: 100 }], byproducts: [{ itemId: ids.bones, qty: 0.5, relativeValue: 10 }],
    }));
    expect(await balance(t, ids.bones)).toMatchObject({ onHand: 0.5 });
    expect(r2.totalInputCost).toBe(200);
  });
});

describe('batches, expiry, FEFO/FIFO (T19)', () => {
  const day = 86400_000;
  const iso = (d: number) => new Date(Date.now() + d * day).toISOString();

  it('T19: FEFO consumes the nearest expiry first; expired batches are never sold; batch required', async () => {
    const t = await newTenant();
    const { policyId } = await withTenant(runtime, t.ctx(), (c) =>
      createCostPolicy(c, t.tenantId, 'dairy', { selection: 'fefo', valuation: 'batch_actual', allocation: 'by_weight' }));
    const ids = await items(t, { yogurt: { sku: 'YOG', name: 'Yogurt', kind: 'goods', trackQuantity: true, fulfillment: 'stock', batchTracking: 'required', costPolicyId: policyId } });
    await stock(t, ids.yogurt, 5, 2, { batchNo: 'B1-long', expiresAt: iso(10) });
    await stock(t, ids.yogurt, 5, 3, { batchNo: 'B2-short', expiresAt: iso(3) });
    await stock(t, ids.yogurt, 5, 1, { batchNo: 'B3-expired', expiresAt: iso(-1) });
    await expect(stock(t, ids.yogurt, 1, 1)).rejects.toMatchObject({ code: 'VALIDATION' });   // batch required

    const r = await cmd(t.ctx(), async (cc) => consumeDirect(cc, { branchId: t.branchId, itemId: ids.yogurt, qty: 7, type: 'production_consume', sourceType: 't', sourceId: t.branchId }));
    const mv = await q(t, `SELECT b.batch_no, -m.qty_delta AS qty, m.unit_cost FROM stock_movements m JOIN batches b ON b.id=m.batch_id WHERE m.movement_type='production_consume' ORDER BY m.command_seq`);
    expect(mv.map((m) => [m.batch_no, Number(m.qty), Number(m.unit_cost)])).toEqual([['B2-short', 5, 3], ['B1-long', 2, 2]]);
    expect(r.totalCost).toBe(5 * 3 + 2 * 2);
    // only B1 has 3 left sellable; the expired batch must not satisfy a request
    await expect(cmd(t.ctx(), (cc) => consumeDirect(cc, { branchId: t.branchId, itemId: ids.yogurt, qty: 4, type: 'production_consume', sourceType: 't', sourceId: t.branchId })))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const left = await q(t, `SELECT b.batch_no, sb.on_hand FROM stock_balances sb JOIN batches b ON b.id=sb.batch_id ORDER BY b.batch_no`);
    expect(left.map((l) => [l.batch_no, Number(l.on_hand)])).toEqual([['B1-long', 3], ['B2-short', 0], ['B3-expired', 5]]);
  });

  it('FIFO policy picks the oldest received batch even when a newer one expires sooner', async () => {
    const t = await newTenant();
    const { policyId } = await withTenant(runtime, t.ctx(), (c) =>
      createCostPolicy(c, t.tenantId, 'fifo', { selection: 'fifo', valuation: 'batch_actual', allocation: 'by_weight' }));
    const ids = await items(t, { rice: { sku: 'RICE', name: 'Rice', kind: 'goods', trackQuantity: true, fulfillment: 'stock', batchTracking: 'required', costPolicyId: policyId } });
    await stock(t, ids.rice, 5, 7, { batchNo: 'OLD', expiresAt: iso(100) });
    await new Promise((r) => setTimeout(r, 20));
    await stock(t, ids.rice, 5, 8, { batchNo: 'NEW', expiresAt: iso(5) });
    await cmd(t.ctx(), (cc) => consumeDirect(cc, { branchId: t.branchId, itemId: ids.rice, qty: 2, type: 'production_consume', sourceType: 't', sourceId: t.branchId }));
    const mv = await q(t, `SELECT b.batch_no FROM stock_movements m JOIN batches b ON b.id=m.batch_id WHERE m.movement_type='production_consume'`);
    expect(mv.map((m) => m.batch_no)).toEqual(['OLD']);
  });
});

describe('cost policy versions are not retroactive (T23)', () => {
  it('T23: changing the policy affects future movements only; old movements keep version and cost', async () => {
    const t = await newTenant();
    const { policyId, versionId: v1 } = await withTenant(runtime, t.ctx(), (c) =>
      createCostPolicy(c, t.tenantId, 'p', { selection: 'fefo', valuation: 'weighted_average', allocation: 'by_weight' }));
    const ids = await items(t, { x: { sku: 'X', name: 'X', kind: 'goods', trackQuantity: true, fulfillment: 'stock', batchTracking: 'required', costPolicyId: policyId } });
    await stock(t, ids.x, 10, 10, { batchNo: 'B1', expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString() });
    await stock(t, ids.x, 10, 20, { batchNo: 'B2', expiresAt: new Date(Date.now() + 50 * 86400_000).toISOString() });
    const take = () => cmd(t.ctx(), (cc) => consumeDirect(cc, { branchId: t.branchId, itemId: ids.x, qty: 1, type: 'production_consume', sourceType: 't', sourceId: t.branchId }));
    await take();                                                                                    // weighted average of 10 and 20 = 15
    const v2 = await withTenant(runtime, t.ctx(), (c) => addPolicyVersion(c, t.tenantId, policyId, { selection: 'fefo', valuation: 'batch_actual', allocation: 'by_weight' }));
    await take();                                                                                    // batch actual of B1 = 10
    const mv = await q(t, `SELECT unit_cost, cost_policy_version_id FROM stock_movements WHERE movement_type='production_consume' ORDER BY created_at, command_seq`);
    expect(mv.map((m) => [Number(m.unit_cost), m.cost_policy_version_id])).toEqual([[15, v1], [10, v2]]);
    expect(v1).not.toBe(v2);
  });
});
