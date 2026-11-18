import type pg from 'pg';
import { audit } from './audit.js';
import { forbidden, invalidState, validation } from './errors.js';
import { hasPermission } from './tenancy.js';

export async function setPolicy(c: pg.PoolClient, tenantId: string, p: { action: string; maxValue: number; approverPermission: string }) {
  await c.query(
    `INSERT INTO approval_policies (tenant_id, action, max_value, approver_permission) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, action) DO UPDATE SET max_value=EXCLUDED.max_value, approver_permission=EXCLUDED.approver_permission`,
    [tenantId, p.action, p.maxValue, p.approverPermission]);
}

export async function getPolicy(c: pg.PoolClient, action: string) {
  const r = await c.query(`SELECT max_value, approver_permission FROM approval_policies WHERE action=$1`, [action]);
  return r.rows[0] as { max_value: string; approver_permission: string } | undefined;
}

export async function requestApproval(
  c: pg.PoolClient, ctx: { tenantId: string; userId: string },
  p: { action: string; refType: string; refId: string; value?: number },
) {
  const r = await c.query(
    `INSERT INTO approval_requests (tenant_id, action, ref_type, ref_id, requested_by, value)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, p.action, p.refType, p.refId, ctx.userId, p.value ?? null]);
  await audit(c, ctx.tenantId, ctx.userId, 'approval.requested', { type: p.refType, id: p.refId }, undefined, p);
  return r.rows[0].id as string;
}

/**
 * Decide on an approval. The requester may NOT approve their own request, except for the
 * documented sole-owner policy (design 8.3): only when the tenant has exactly one active member
 * (or owner_self_approval is enabled), with step-up verification and a written reason; the
 * decision is flagged self_approved and audited.
 */
export async function decide(
  c: pg.PoolClient, ctx: { tenantId: string; userId: string },
  p: { requestId: string; decision: 'approved' | 'rejected'; stepUp?: boolean; reason?: string },
) {
  const rq = (await c.query(`SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE`, [p.requestId])).rows[0];
  if (!rq) throw validation('approval request not found');
  if (rq.status !== 'pending') throw invalidState(`approval already ${rq.status}`);
  const pol = await getPolicy(c, rq.action);
  const needed = pol?.approver_permission ?? 'approvals.decide';
  if (!(await hasPermission(c, ctx.tenantId, ctx.userId, needed))) throw forbidden(`missing permission ${needed}`);
  let selfApproved = false;
  if (rq.requested_by === ctx.userId) {
    const cnt = Number((await c.query(`SELECT count(*) AS n FROM memberships WHERE tenant_id=$1 AND active`, [ctx.tenantId])).rows[0].n);
    const setting = (await c.query(`SELECT settings->>'owner_self_approval' AS v FROM tenants WHERE id=$1`, [ctx.tenantId])).rows[0]?.v;
    if (!(cnt === 1 || setting === 'true')) throw forbidden('requester cannot approve their own request');
    if (!p.stepUp || !p.reason?.trim()) throw forbidden('self-approval requires step-up verification and a reason');
    selfApproved = true;
  }
  await c.query(
    `UPDATE approval_requests SET status=$2, decided_by=$3, decided_at=now(), self_approved=$4, reason=$5 WHERE id=$1`,
    [p.requestId, p.decision, ctx.userId, selfApproved, p.reason ?? null]);
  await audit(c, ctx.tenantId, ctx.userId, `approval.${p.decision}`, { type: rq.ref_type, id: rq.ref_id },
    undefined, undefined, { selfApproved, reason: p.reason, action: rq.action });
}

export async function isApproved(c: pg.PoolClient, action: string, refId: string) {
  const r = await c.query(`SELECT 1 FROM approval_requests WHERE action=$1 AND ref_id=$2 AND status='approved'`, [action, refId]);
  return (r.rowCount ?? 0) > 0;
}
