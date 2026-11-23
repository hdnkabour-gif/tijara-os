import type pg from 'pg';
import type { CommandCtx } from './commands.js';
import { currentPolicyVersion, getItem, PolicyVersion } from './catalog.js';
import { conflict, insufficientStock, validation } from './errors.js';
import { localMidnight } from './clock.js';

const ZERO = '00000000-0000-0000-0000-000000000000';
export const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

interface BalRow { id: string; batch_id: string | null; on_hand: string; reserved: string; avg_cost: string }

export interface MovementInput {
  branchId: string; itemId: string; batchId?: string | null; serialId?: string | null;
  status?: 'sellable' | 'damaged' | 'quarantine'; qty: number; unitCost: number;
  type: string; sourceType?: string; sourceId?: string; reverses?: string; reason?: string;
  policyVersionId?: string | null;
}

export async function recordMovement(cc: CommandCtx, m: MovementInput): Promise<string> {
  const r = await cc.client.query(
    `INSERT INTO stock_movements (tenant_id, branch_id, item_id, batch_id, serial_id, stock_status, qty_delta,
        unit_cost, movement_type, command_id, command_seq, source_doc_type, source_doc_id,
        reverses_movement_id, reason_code, cost_policy_version_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [cc.tenantId, m.branchId, m.itemId, m.batchId ?? null, m.serialId ?? null, m.status ?? 'sellable', m.qty,
     m.unitCost, m.type, cc.commandId, cc.nextSeq(), m.sourceType ?? null, m.sourceId ?? null,
     m.reverses ?? null, m.reason ?? null, m.policyVersionId ?? null, cc.userId ?? null]);
  return r.rows[0].id;
}

async function addBalance(
  c: pg.PoolClient, tenantId: string,
  b: { branchId: string; itemId: string; batchId: string | null; status: string; qty: number; cost: number },
) {
  await c.query(
    `INSERT INTO stock_balances (tenant_id, branch_id, item_id, batch_id, stock_status, on_hand, avg_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, branch_id, item_id, (COALESCE(batch_id, '${ZERO}'::uuid)), stock_status)
     DO UPDATE SET
       avg_cost = CASE WHEN stock_balances.on_hand + EXCLUDED.on_hand = 0 THEN EXCLUDED.avg_cost
                  ELSE (stock_balances.on_hand * stock_balances.avg_cost + EXCLUDED.on_hand * EXCLUDED.avg_cost)
                       / (stock_balances.on_hand + EXCLUDED.on_hand) END,
       on_hand = stock_balances.on_hand + EXCLUDED.on_hand`,
    [tenantId, b.branchId, b.itemId, b.batchId, b.status, b.qty, b.cost]);
}

function orderBy(rule: PolicyVersion['selection_rule']) {
  return rule === 'fifo'
    ? 'b.received_at NULLS FIRST, sb.id'
    : 'b.expires_at NULLS LAST, b.received_at NULLS FIRST, sb.id';
}

/** Sellable, non-expired rows with free quantity, locked in policy order. */
async function lockSellable(c: pg.PoolClient, branchId: string, itemId: string, policy: PolicyVersion): Promise<BalRow[]> {
  const r = await c.query(
    `SELECT sb.id, sb.batch_id, sb.on_hand, sb.reserved, sb.avg_cost
       FROM stock_balances sb
       LEFT JOIN batches b ON b.tenant_id = sb.tenant_id AND b.id = sb.batch_id
      WHERE sb.branch_id=$1 AND sb.item_id=$2 AND sb.stock_status='sellable'
        AND sb.on_hand - sb.reserved > 0 AND (b.expires_at IS NULL OR b.expires_at > now())
      ORDER BY ${orderBy(policy.selection_rule)}
      FOR UPDATE OF sb`, [branchId, itemId]);
  return r.rows;
}

async function weightedAvg(c: pg.PoolClient, branchId: string, itemId: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(sum(on_hand*avg_cost)/NULLIF(sum(on_hand),0),0) AS w
       FROM stock_balances WHERE branch_id=$1 AND item_id=$2 AND stock_status='sellable'`, [branchId, itemId]);
  return Number(r.rows[0].w);
}

const costFor = (policy: PolicyVersion, row: BalRow, wavg: number) =>
  policy.valuation_method === 'batch_actual' ? Number(row.avg_cost) : wavg;

export async function availableQty(c: pg.PoolClient, branchId: string, itemId: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(sum(on_hand - reserved),0) AS q FROM stock_balances
      WHERE branch_id=$1 AND item_id=$2 AND stock_status='sellable'`, [branchId, itemId]);
  return Number(r.rows[0].q);
}

// ───────────── receipt / adjustment ─────────────
export async function receiveStock(cc: CommandCtx, p: {
  branchId: string; itemId: string; qty: number; unitCost: number; batchNo?: string; expiresAt?: string | null;
  serials?: { serialNo: string; warrantyUntil?: string }[]; type?: 'receipt' | 'production_output';
  sourceType?: string; sourceId?: string;
}) {
  const item = await getItem(cc.client, p.itemId);
  if (!item.track_quantity) throw validation(`item ${item.sku} does not track quantity`);
  if (item.batch_tracking === 'required' && !p.batchNo) throw validation(`item ${item.sku} requires a batch`);
  if (p.qty <= 0) throw validation('qty must be > 0');
  let batchId: string | null = null;
  // A calendar date 'YYYY-MM-DD' means "until the end of the previous local day": store the shop's local midnight,
  // not UTC midnight (01:00 in Casablanca), so the POS stops selling exactly when the local expiry day begins.
  const expiresAt = p.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(p.expiresAt) ? await localMidnight(cc.client, p.expiresAt) : p.expiresAt ?? null;
  if (p.batchNo) {
    const b = await cc.client.query(
      `INSERT INTO batches (tenant_id, item_id, batch_no, expires_at, unit_cost) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, item_id, batch_no) DO UPDATE SET batch_no = EXCLUDED.batch_no
       RETURNING id, expires_at, ($4::timestamptz IS NOT NULL AND expires_at IS DISTINCT FROM $4::timestamptz) AS expiry_differs`,
      [cc.tenantId, p.itemId, p.batchNo, expiresAt, p.unitCost]);
    batchId = b.rows[0].id;
    // A batch has ONE expiry. Receiving more of the same batch number with another date would silently keep the old date.
    if (b.rows[0].expiry_differs) {
      if (b.rows[0].expires_at !== null) throw conflict(`batch ${p.batchNo} is already recorded with another expiry date`);
      await cc.client.query('UPDATE batches SET expires_at=$2 WHERE id=$1', [batchId, expiresAt]);
    }
  }
  if (item.serial_tracking) {
    if (!p.serials || p.serials.length !== p.qty) throw validation('serial-tracked receipt needs one serial per unit');
    for (const s of p.serials) {
      await cc.client.query(
        `INSERT INTO serials (tenant_id, item_id, serial_no, warranty_until) VALUES ($1,$2,$3,$4)`,
        [cc.tenantId, p.itemId, s.serialNo, s.warrantyUntil ?? null]);
    }
  }
  const policy = await currentPolicyVersion(cc.client, p.itemId);
  await addBalance(cc.client, cc.tenantId, { branchId: p.branchId, itemId: p.itemId, batchId, status: 'sellable', qty: p.qty, cost: p.unitCost });
  const movementId = await recordMovement(cc, {
    branchId: p.branchId, itemId: p.itemId, batchId, qty: p.qty, unitCost: p.unitCost,
    type: p.type ?? 'receipt', sourceType: p.sourceType, sourceId: p.sourceId, policyVersionId: policy.id,
  });
  return { batchId, movementId };
}

export async function adjustStock(cc: CommandCtx, p: {
  branchId: string; itemId: string; batchId?: string | null; delta: number; reason: string;
}) {
  if (p.delta > 0) {
    await addBalance(cc.client, cc.tenantId, { branchId: p.branchId, itemId: p.itemId, batchId: p.batchId ?? null, status: 'sellable', qty: p.delta, cost: 0 });
  } else {
    const r = await cc.client.query(
      `UPDATE stock_balances SET on_hand = on_hand + $1
        WHERE branch_id=$2 AND item_id=$3 AND COALESCE(batch_id,'${ZERO}')=COALESCE($4::uuid,'${ZERO}') AND stock_status='sellable'
          AND on_hand - reserved >= $5`, [p.delta, p.branchId, p.itemId, p.batchId ?? null, -p.delta]);
    if (r.rowCount === 0) throw insufficientStock('adjustment exceeds available stock');
  }
  return recordMovement(cc, { branchId: p.branchId, itemId: p.itemId, batchId: p.batchId, qty: p.delta, unitCost: 0, type: 'adjustment', reason: p.reason });
}

// ───────────── reservations ─────────────
export async function reserve(cc: CommandCtx, p: { lineId: string; branchId: string; itemId: string; qty: number; serialNo?: string }) {
  const item = await getItem(cc.client, p.itemId);
  if (!item.track_quantity) return;
  const policy = await currentPolicyVersion(cc.client, p.itemId);
  let serialId: string | null = null;
  if (item.serial_tracking) {
    if (p.qty !== 1 || !p.serialNo) throw validation('serial-tracked line needs qty 1 and a serial number');
    const s = await cc.client.query(
      `UPDATE serials SET status='reserved' WHERE item_id=$1 AND serial_no=$2 AND status IN ('in_stock','returned') RETURNING id`,
      [p.itemId, p.serialNo]);
    if (s.rowCount === 0) throw conflict(`serial ${p.serialNo} is not available`);
    serialId = s.rows[0].id;
  }
  const rows = await lockSellable(cc.client, p.branchId, p.itemId, policy);
  let remaining = r4(p.qty);
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(r4(Number(row.on_hand) - Number(row.reserved)), remaining);
    const u = await cc.client.query(
      `UPDATE stock_balances SET reserved = reserved + $1 WHERE id=$2 AND on_hand - reserved >= $1`, [take, row.id]);
    if (u.rowCount === 0) throw insufficientStock(`concurrent reservation lost for ${item.sku}`);
    await cc.client.query(
      `INSERT INTO stock_reservations (tenant_id, order_line_id, branch_id, item_id, batch_id, qty, serial_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [cc.tenantId, p.lineId, p.branchId, p.itemId, row.batch_id, take, serialId]);
    remaining = r4(remaining - take);
  }
  if (remaining > 0) throw insufficientStock(`insufficient stock for ${item.sku}: short by ${remaining}`);
}

export async function releaseReservations(cc: CommandCtx, lineId: string) {
  const rs = await cc.client.query(
    `SELECT id, branch_id, item_id, batch_id, qty, serial_id FROM stock_reservations
      WHERE order_line_id=$1 AND status='active' FOR UPDATE`, [lineId]);
  for (const r of rs.rows) {
    await cc.client.query(
      `UPDATE stock_balances SET reserved = reserved - $1
        WHERE branch_id=$2 AND item_id=$3 AND COALESCE(batch_id,'${ZERO}')=COALESCE($4::uuid,'${ZERO}') AND stock_status='sellable'`,
      [r.qty, r.branch_id, r.item_id, r.batch_id]);
    await cc.client.query(`UPDATE stock_reservations SET status='released' WHERE id=$1`, [r.id]);
    if (r.serial_id) await cc.client.query(`UPDATE serials SET status='in_stock' WHERE id=$1`, [r.serial_id]);
  }
}

/** Turn a line's active reservations into ledger consumption (single place stock leaves for sales). */
export async function consumeReservations(cc: CommandCtx, p: { lineId: string; type: 'sale' | 'backflush_consume' }) {
  const rs = await cc.client.query(
    `SELECT id, branch_id, item_id, batch_id, qty, serial_id FROM stock_reservations
      WHERE order_line_id=$1 AND status='active' ORDER BY id FOR UPDATE`, [p.lineId]);
  const ids: string[] = [];
  for (const r of rs.rows) {
    const policy = await currentPolicyVersion(cc.client, r.item_id);
    const bal = await cc.client.query(
      `SELECT id, avg_cost FROM stock_balances
        WHERE branch_id=$1 AND item_id=$2 AND COALESCE(batch_id,'${ZERO}')=COALESCE($3::uuid,'${ZERO}') AND stock_status='sellable' FOR UPDATE`,
      [r.branch_id, r.item_id, r.batch_id]);
    const wavg = policy.valuation_method === 'weighted_average' ? await weightedAvg(cc.client, r.branch_id, r.item_id) : 0;
    const unit = policy.valuation_method === 'batch_actual' ? Number(bal.rows[0].avg_cost) : wavg;
    await cc.client.query(
      `UPDATE stock_balances SET on_hand = on_hand - $1, reserved = reserved - $1 WHERE id=$2`, [r.qty, bal.rows[0].id]);
    ids.push(await recordMovement(cc, {
      branchId: r.branch_id, itemId: r.item_id, batchId: r.batch_id, serialId: r.serial_id, qty: -Number(r.qty),
      unitCost: unit, type: p.type, sourceType: 'order_line', sourceId: p.lineId, policyVersionId: policy.id,
    }));
    await cc.client.query(`UPDATE stock_reservations SET status='consumed' WHERE id=$1`, [r.id]);
    if (r.serial_id) await cc.client.query(`UPDATE serials SET status='sold' WHERE id=$1`, [r.serial_id]);
  }
  return ids;
}

/** Direct consumption without a reservation (production inputs). Returns consumed cost. */
export async function consumeDirect(cc: CommandCtx, p: {
  branchId: string; itemId: string; qty: number; type: 'production_consume' | 'backflush_consume';
  sourceType: string; sourceId: string;
}) {
  const policy = await currentPolicyVersion(cc.client, p.itemId);
  const rows = await lockSellable(cc.client, p.branchId, p.itemId, policy);
  const wavg = policy.valuation_method === 'weighted_average' ? await weightedAvg(cc.client, p.branchId, p.itemId) : 0;
  let remaining = r4(p.qty), totalCost = 0;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(r4(Number(row.on_hand) - Number(row.reserved)), remaining);
    const u = await cc.client.query(
      `UPDATE stock_balances SET on_hand = on_hand - $1 WHERE id=$2 AND on_hand - reserved >= $1`, [take, row.id]);
    if (u.rowCount === 0) throw insufficientStock('concurrent consumption lost');
    const unit = costFor(policy, row, wavg);
    totalCost += take * unit;
    await recordMovement(cc, {
      branchId: p.branchId, itemId: p.itemId, batchId: row.batch_id, qty: -take, unitCost: unit,
      type: p.type, sourceType: p.sourceType, sourceId: p.sourceId, policyVersionId: policy.id,
    });
    remaining = r4(remaining - take);
  }
  if (remaining > 0) {
    const item = await getItem(cc.client, p.itemId);
    throw insufficientStock(`insufficient stock for ${item.sku}: short by ${remaining}`);
  }
  return { totalCost: r4(totalCost), policy };
}

/** Reverse the ledger effect of a committed line. 'return' => sellable again; 'waste' => written off. */
export async function reverseLineMovements(cc: CommandCtx, p: { lineId: string; mode: 'return' | 'waste'; reason: string }) {
  const ms = await cc.client.query(
    `SELECT m.* FROM stock_movements m
      WHERE m.source_doc_id=$1 AND m.movement_type IN ('sale','backflush_consume')
        AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id)
      ORDER BY m.command_seq`, [p.lineId]);
  for (const m of ms.rows) {
    const q = -Number(m.qty_delta);
    const cost = Number(m.unit_cost);
    if (p.mode === 'return') {
      await addBalance(cc.client, cc.tenantId, { branchId: m.branch_id, itemId: m.item_id, batchId: m.batch_id, status: 'sellable', qty: q, cost });
      await recordMovement(cc, { branchId: m.branch_id, itemId: m.item_id, batchId: m.batch_id, serialId: m.serial_id,
        qty: q, unitCost: cost, type: 'return_in', reverses: m.id, reason: p.reason, sourceType: 'order_line', sourceId: p.lineId });
      if (m.serial_id) await cc.client.query(`UPDATE serials SET status='returned' WHERE id=$1`, [m.serial_id]);
    } else {
      await addBalance(cc.client, cc.tenantId, { branchId: m.branch_id, itemId: m.item_id, batchId: m.batch_id, status: 'damaged', qty: q, cost });
      await recordMovement(cc, { branchId: m.branch_id, itemId: m.item_id, batchId: m.batch_id, status: 'damaged',
        qty: q, unitCost: cost, type: 'reversal', reverses: m.id, reason: p.reason, sourceType: 'order_line', sourceId: p.lineId });
      await cc.client.query(
        `UPDATE stock_balances SET on_hand = on_hand - $1
          WHERE branch_id=$2 AND item_id=$3 AND COALESCE(batch_id,'${ZERO}')=COALESCE($4::uuid,'${ZERO}') AND stock_status='damaged'`,
        [q, m.branch_id, m.item_id, m.batch_id]);
      await recordMovement(cc, { branchId: m.branch_id, itemId: m.item_id, batchId: m.batch_id, status: 'damaged',
        qty: -q, unitCost: cost, type: 'waste', reason: p.reason, sourceType: 'order_line', sourceId: p.lineId });
    }
  }
  return ms.rowCount ?? 0;
}

/** Invariant check (design 5.5): every balance equals the sum of its ledger movements. */
export async function reconcile(c: pg.PoolClient): Promise<{ key: string; balance: string; ledger: string }[]> {
  const r = await c.query(
    `WITH l AS (
       SELECT tenant_id, branch_id, item_id, COALESCE(batch_id,'${ZERO}') AS b, stock_status, sum(qty_delta) AS q
         FROM stock_movements GROUP BY 1,2,3,4,5),
     s AS (
       SELECT tenant_id, branch_id, item_id, COALESCE(batch_id,'${ZERO}') AS b, stock_status, on_hand AS q FROM stock_balances)
     SELECT item_id::text || ':' || b::text || ':' || stock_status AS key,
            COALESCE(s.q,0) AS balance, COALESCE(l.q,0) AS ledger
       FROM l FULL JOIN s USING (tenant_id, branch_id, item_id, b, stock_status)
      WHERE COALESCE(s.q,0) <> COALESCE(l.q,0)`);
  return r.rows;
}
