import type { CommandCtx } from './commands.js';
import { activeRecipe, getItem } from './catalog.js';
import { consumeReservations, releaseReservations, reserve, reverseLineMovements } from './inventory.js';
import { forbidden, invalidState, validation } from './errors.js';
import { getPolicy, isApproved, requestApproval } from './approvals.js';
import { issueInvoiceAndPay, PaymentIn, refundInvoice } from './payments.js';
import { audit } from './audit.js';

export interface LineIn { itemId: string; qty: number; unitPrice?: number; prepRequired?: boolean; serialNo?: string; actualQty?: number; note?: string }

async function event(cc: CommandCtx, orderId: string, from: string | null, to: string, note?: string) {
  await cc.client.query(
    `INSERT INTO order_events (tenant_id, order_id, from_state, to_state, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [cc.tenantId, orderId, from, to, cc.userId ?? null, note ?? null]);
}
async function setOrderState(cc: CommandCtx, orderId: string, from: string, to: string, note?: string) {
  const r = await cc.client.query(`UPDATE sales_orders SET state=$3 WHERE id=$1 AND state=$2`, [orderId, from, to]);
  if (r.rowCount === 0) throw invalidState(`order ${orderId} is not in state ${from}`);
  await event(cc, orderId, from, to, note);
}
async function getOrder(cc: CommandCtx, orderId: string) {
  const r = await cc.client.query(`SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [orderId]);
  if (!r.rows[0]) throw validation(`order not found: ${orderId}`);
  return r.rows[0];
}
async function getLine(cc: CommandCtx, lineId: string) {
  const r = await cc.client.query(`SELECT * FROM sales_order_lines WHERE id=$1 FOR UPDATE`, [lineId]);
  if (!r.rows[0]) throw validation(`line not found: ${lineId}`);
  return r.rows[0];
}

export async function recalcTotal(cc: CommandCtx, orderId: string) {
  await cc.client.query(
    `UPDATE sales_orders o SET total = round(COALESCE((SELECT sum(line_total) FROM sales_order_lines
         WHERE order_id=o.id AND state <> 'void'),0) * (1 - o.discount_pct/100), 2) WHERE o.id=$1`, [orderId]);
}

/** What a line needs from stock, by fulfillment mode (design 5.2). */
async function requirements(cc: CommandCtx, line: any): Promise<{ itemId: string; qty: number; serialNo?: string }[]> {
  const item = await getItem(cc.client, line.item_id);
  const qty = Number(line.actual_qty ?? line.ordered_qty);
  if (item.fulfillment === 'stock') return [{ itemId: item.id, qty, serialNo: line.serial_no ?? undefined }];
  if (item.fulfillment === 'backflush') {
    const rec = await activeRecipe(cc.client, item.id);
    return rec.lines.map((l) => ({ itemId: l.component_item_id, qty: Math.round(Number(l.qty_per_unit) * qty * 1e4) / 1e4 }));
  }
  return [];
}
const movementType = (fulfillment: string) => (fulfillment === 'backflush' ? 'backflush_consume' : 'sale') as 'sale' | 'backflush_consume';

async function reserveLine(cc: CommandCtx, order: any, line: any) {
  for (const r of await requirements(cc, line)) {
    await reserve(cc, { lineId: line.id, branchId: order.branch_id, itemId: r.itemId, qty: r.qty, serialNo: r.serialNo });
  }
}

export async function createOrder(cc: CommandCtx, p: { branchId: string; customerId?: string; lines: LineIn[] }) {
  if (p.lines.length === 0) throw validation('order needs at least one line');
  const o = await cc.client.query(
    `INSERT INTO sales_orders (tenant_id, branch_id, customer_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [cc.tenantId, p.branchId, p.customerId ?? null, cc.userId ?? null]);
  const orderId: string = o.rows[0].id;
  let n = 0;
  const lineIds: string[] = [];
  for (const l of p.lines) {
    const item = await getItem(cc.client, l.itemId);
    if (!item.active) throw invalidState('archived items cannot be sold');
    const price = l.unitPrice ?? Number(item.price);
    const r = await cc.client.query(
      `INSERT INTO sales_order_lines (tenant_id, order_id, line_no, item_id, fulfillment, ordered_qty, unit_price,
          line_total, prep_required, serial_no, item_name_at_sale, item_sku_at_sale, base_uom_at_sale, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,round($6::numeric*$7::numeric,2),$8,$9,$10,$11,$12,$13) RETURNING id`,
      [cc.tenantId, orderId, ++n, l.itemId, item.fulfillment, l.qty, price, l.prepRequired ?? false, l.serialNo ?? null,
        item.name, item.sku, item.base_uom, l.note ?? null]);
    lineIds.push(r.rows[0].id);
  }
  await recalcTotal(cc, orderId);
  await event(cc, orderId, null, 'draft');
  return { orderId, lineIds };
}

export async function confirmOrder(cc: CommandCtx, orderId: string) {
  const order = await getOrder(cc, orderId);
  if (order.state !== 'draft') throw invalidState(`cannot confirm order in state ${order.state}`);
  const lines = (await cc.client.query(`SELECT * FROM sales_order_lines WHERE order_id=$1 ORDER BY line_no`, [orderId])).rows;
  for (const l of lines) {
    await reserveLine(cc, order, l);
    await cc.client.query(`UPDATE sales_order_lines SET state='reserved' WHERE id=$1`, [l.id]);
  }
  await setOrderState(cc, orderId, 'draft', 'confirmed');
}

/** Record the actual weighed quantity. This re-sizes the reservation; it does NOT touch the ledger (design 7.1). */
export async function weighLine(cc: CommandCtx, orderId: string, lineId: string, actualQty: number) {
  const order = await getOrder(cc, orderId);
  const line = await getLine(cc, lineId);
  if (!['confirmed', 'in_preparation'].includes(order.state)) throw invalidState(`cannot weigh in order state ${order.state}`);
  if (!['reserved', 'weighed'].includes(line.state)) throw invalidState(`cannot weigh a ${line.state} line`);
  if (actualQty <= 0) throw validation('actual quantity must be > 0');
  await releaseReservations(cc, lineId);
  await cc.client.query(
    `UPDATE sales_order_lines SET actual_qty=$2, line_total=round($2::numeric*unit_price,2), state='weighed' WHERE id=$1`,
    [lineId, actualQty]);
  await reserveLine(cc, order, { ...line, actual_qty: actualQty });
  await recalcTotal(cc, orderId);
}

async function commitLine(cc: CommandCtx, line: any) {
  await consumeReservations(cc, { lineId: line.id, type: movementType(line.fulfillment) });
  await cc.client.query(`UPDATE sales_order_lines SET state='committed' WHERE id=$1`, [line.id]);
}

/** Lines that need preparation are committed (stock leaves) when preparation starts. */
export async function startPreparation(cc: CommandCtx, orderId: string) {
  await getOrder(cc, orderId);
  const lines = (await cc.client.query(
    `SELECT * FROM sales_order_lines WHERE order_id=$1 AND prep_required AND state IN ('reserved','weighed') ORDER BY line_no`, [orderId])).rows;
  for (const l of lines) {
    await commitLine(cc, l);
    await cc.client.query(`UPDATE sales_order_lines SET prep_started=true WHERE id=$1`, [l.id]);
  }
  await setOrderState(cc, orderId, 'confirmed', 'in_preparation');
}

export async function markReady(cc: CommandCtx, orderId: string) {
  await getOrder(cc, orderId);
  await setOrderState(cc, orderId, 'in_preparation', 'ready');
}

export async function applyDiscount(cc: CommandCtx, p: { orderId: string; pct: number }) {
  const order = await getOrder(cc, p.orderId);
  if (!['draft', 'confirmed', 'in_preparation', 'ready'].includes(order.state)) throw invalidState('order not open');
  await cc.client.query(`UPDATE sales_orders SET discount_pct=$2 WHERE id=$1`, [p.orderId, p.pct]);
  await recalcTotal(cc, p.orderId);
  const pol = await getPolicy(cc.client, 'sale.discount');
  if (pol && p.pct > Number(pol.max_value)) {
    const id = await requestApproval(cc.client, { tenantId: cc.tenantId, userId: cc.userId! },
      { action: 'sale.discount', refType: 'sales_order', refId: p.orderId, value: p.pct });
    return { approvalRequired: true, requestId: id };
  }
  return { approvalRequired: false as const };
}

export async function payOrder(cc: CommandCtx, p: { orderId: string; payments: PaymentIn[] }) {
  const order = await getOrder(cc, p.orderId);
  if (!['confirmed', 'in_preparation', 'ready'].includes(order.state)) throw invalidState(`cannot pay order in state ${order.state}`);
  const pol = await getPolicy(cc.client, 'sale.discount');
  if (pol && Number(order.discount_pct) > Number(pol.max_value) && !(await isApproved(cc.client, 'sale.discount', p.orderId))) {
    throw forbidden('discount above policy limit requires approval');
  }
  const lines = (await cc.client.query(
    `SELECT * FROM sales_order_lines WHERE order_id=$1 AND state IN ('reserved','weighed') ORDER BY line_no`, [p.orderId])).rows;
  for (const l of lines) { await commitLine(cc, l); cc.fault('after_commit_line'); }
  await recalcTotal(cc, p.orderId);
  const fresh = (await cc.client.query(`SELECT * FROM sales_orders WHERE id=$1`, [p.orderId])).rows[0];
  const res = await issueInvoiceAndPay(cc, fresh, p.payments);
  cc.fault('after_invoice');
  await cc.client.query(`UPDATE sales_orders SET state='closed' WHERE id=$1`, [p.orderId]);
  await event(cc, p.orderId, order.state, 'closed');
  return res;
}

/** Counter sale in one command: create + confirm + weigh + pay (matrix O6). */
export async function quickSale(cc: CommandCtx, p: { branchId: string; customerId?: string; lines: LineIn[]; payments: PaymentIn[] }) {
  const { orderId, lineIds } = await createOrder(cc, p);
  await confirmOrder(cc, orderId);
  for (let i = 0; i < p.lines.length; i++) {
    if (p.lines[i].actualQty != null) await weighLine(cc, orderId, lineIds[i], p.lines[i].actualQty!);
  }
  const res = await payOrder(cc, { orderId, payments: p.payments });
  return { orderId, lineIds, ...res };
}

export type CommittedHandling = 'return' | 'waste';

/** Cancellation rules (design 7.2). Nothing is deleted; every stock effect is a new ledger movement. */
export async function cancelOrder(cc: CommandCtx, p: { orderId: string; reason: string; committed?: CommittedHandling; returnApprovalId?: string }) {
  const order = await getOrder(cc, p.orderId);
  if (['cancelled'].includes(order.state)) throw invalidState('order already cancelled');
  const lines = (await cc.client.query(`SELECT * FROM sales_order_lines WHERE order_id=$1 ORDER BY line_no`, [p.orderId])).rows;
  for (const l of lines) {
    if (['draft', 'reserved', 'weighed'].includes(l.state)) {
      await releaseReservations(cc, l.id);                       // before commit: release only, no ledger movement
    } else if (l.state === 'committed') {
      const mode: CommittedHandling = l.prep_started ? 'waste' : (p.committed ?? 'waste');
      if (l.prep_started && p.committed === 'return') throw invalidState('a line already in preparation cannot be returned to stock');
      if (mode === 'return') {
        if (!(await isApproved(cc.client, 'sale.return', p.orderId))) throw forbidden('returning committed stock requires approval');
      }
      await reverseLineMovements(cc, { lineId: l.id, mode, reason: p.reason });
    }
    if (l.state !== 'void') await cc.client.query(`UPDATE sales_order_lines SET state='void' WHERE id=$1`, [l.id]);
  }
  const inv = (await cc.client.query(`SELECT id FROM invoices WHERE order_id=$1 AND status='issued'`, [p.orderId])).rows[0];
  if (inv) await refundInvoice(cc, inv.id);
  await cc.client.query(`UPDATE sales_orders SET state='cancelled' WHERE id=$1`, [p.orderId]);
  await event(cc, p.orderId, order.state, 'cancelled', p.reason);
  await audit(cc.client, cc.tenantId, cc.userId, 'order.cancelled', { type: 'sales_order', id: p.orderId }, { state: order.state }, { state: 'cancelled' }, { reason: p.reason });
}
