import crypto from 'node:crypto';
import type { CommandCtx } from './commands.js';
import { currentPolicyVersion, getItem } from './catalog.js';
import { consumeDirect, r4, receiveStock } from './inventory.js';
import { validation } from './errors.js';

export interface ProductionInput {
  branchId: string; type: 'transform' | 'prepare';
  inputs: { itemId: string; qty: number }[];
  outputs: { itemId: string; qty: number; relativeValue?: number }[];
  byproducts?: { itemId: string; qty: number; relativeValue?: number }[];
  waste?: { qty: number; reason: string }[];
  recipeVersionId?: string; tolerance?: number;
}

/**
 * Transform / prepare (design 5.3). Inputs are consumed ONCE (production_consume). Waste is a
 * document line with a memo cost: it is already inside the consumed quantity, so it never
 * produces a second stock deduction.
 */
export async function runProduction(cc: CommandCtx, p: ProductionInput) {
  const byproducts = p.byproducts ?? [], waste = p.waste ?? [], tol = p.tolerance ?? 0.0005;
  const qin = r4(p.inputs.reduce((a, x) => a + x.qty, 0));
  const qout = r4(p.outputs.reduce((a, x) => a + x.qty, 0));
  const qby = r4(byproducts.reduce((a, x) => a + x.qty, 0));
  const qw = r4(waste.reduce((a, x) => a + x.qty, 0));
  if (p.inputs.length === 0 || p.outputs.length === 0) throw validation('production needs inputs and outputs');
  if (Math.abs(qin - (qout + qby + qw)) > tol) {
    throw validation(`mass balance violated: inputs ${qin} != outputs ${qout} + byproducts ${qby} + waste ${qw}`);
  }
  const uoms = new Set<string>();
  for (const x of [...p.inputs, ...p.outputs, ...byproducts]) uoms.add((await getItem(cc.client, x.itemId)).base_uom);
  if (uoms.size > 1) throw validation(`mixed units in a mass-balanced order: ${[...uoms].join(',')}`);

  const orderId = crypto.randomUUID();
  const outPolicy = await currentPolicyVersion(cc.client, p.outputs[0].itemId);
  await cc.client.query(
    `INSERT INTO production_orders (id, tenant_id, branch_id, type, command_id, recipe_version_id,
        cost_policy_version_id, allocation_method, total_input_cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)`,
    [orderId, cc.tenantId, p.branchId, p.type, cc.commandId, p.recipeVersionId ?? null, outPolicy.id,
     outPolicy.allocation_method, cc.userId ?? null]);

  let totalCost = 0;
  for (const i of p.inputs) {
    const c = await consumeDirect(cc, { branchId: p.branchId, itemId: i.itemId, qty: i.qty,
      type: 'production_consume', sourceType: 'production_order', sourceId: orderId });
    totalCost += c.totalCost;
    await cc.client.query(
      `INSERT INTO production_lines (tenant_id, production_order_id, kind, item_id, qty, unit_cost)
       VALUES ($1,$2,'input',$3,$4,$5)`, [cc.tenantId, orderId, i.itemId, i.qty, r4(c.totalCost / i.qty)]);
    cc.fault('after_input_consumed');
  }
  totalCost = r4(totalCost);

  const useful = [...p.outputs.map((o) => ({ ...o, kind: 'output' as const })),
                  ...byproducts.map((o) => ({ ...o, kind: 'byproduct' as const }))];
  const unitCost = new Map<number, number>();
  if (outPolicy.allocation_method === 'by_relative_value') {
    if (useful.some((u) => u.relativeValue == null)) throw validation('by_relative_value needs relativeValue on every output');
    const totalValue = useful.reduce((a, u) => a + u.qty * u.relativeValue!, 0);
    useful.forEach((u, idx) => unitCost.set(idx, (totalCost * (u.qty * u.relativeValue!) / totalValue) / u.qty));
  } else {
    // by weight: the useful outputs absorb the whole input cost; by-products carry zero cost
    useful.forEach((u, idx) => unitCost.set(idx, u.kind === 'output' ? totalCost / qout : 0));
  }

  const outputsOut: { itemId: string; unitCost: number }[] = [];
  for (let idx = 0; idx < useful.length; idx++) {
    const u = useful[idx], uc = r4(unitCost.get(idx)!);
    const item = await getItem(cc.client, u.itemId);
    await receiveStock(cc, {
      branchId: p.branchId, itemId: u.itemId, qty: u.qty, unitCost: uc, type: 'production_output',
      batchNo: item.batch_tracking === 'none' ? undefined : `PRD-${orderId.slice(0, 8)}`,
      sourceType: 'production_order', sourceId: orderId,
    });
    await cc.client.query(
      `INSERT INTO production_lines (tenant_id, production_order_id, kind, item_id, qty, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6)`, [cc.tenantId, orderId, u.kind, u.itemId, u.qty, uc]);
    outputsOut.push({ itemId: u.itemId, unitCost: uc });
  }
  const inputUnit = qin > 0 ? totalCost / qin : 0;
  let wasteCost = 0;
  for (const w of waste) {
    const memo = r4(w.qty * inputUnit);
    wasteCost += memo;
    await cc.client.query(
      `INSERT INTO production_lines (tenant_id, production_order_id, kind, qty, memo_cost, reason)
       VALUES ($1,$2,'waste',$3,$4,$5)`, [cc.tenantId, orderId, w.qty, memo, w.reason]);
  }
  await cc.client.query(`UPDATE production_orders SET total_input_cost=$1 WHERE id=$2`, [totalCost, orderId]);
  return { productionOrderId: orderId, totalInputCost: totalCost, outputs: outputsOut, wasteCost: r4(wasteCost) };
}
