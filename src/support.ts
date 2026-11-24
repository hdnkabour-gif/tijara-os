import { audit } from './audit.js';
import * as authm from './auth.js';
import { withTenant } from './db.js';
import { HttpError, bad, num, oneOf, str, uuid } from './http.js';
import type { Kit, Rc } from './kit.js';

/**
 * PR-C: support access only with the shop OWNER's explicit, time-limited, revocable approval.
 * Platform side: ask (reason, duration, scope), see the answer, enter/leave. Shop side (owner only): approve - possibly
 * shorter or narrower - refuse, revoke at once. The dispatcher journals requests and limits the support session to diagnostic metadata.
 */
const platformOnly = (rc: Rc) => { if (!rc.session!.isPlatformAdmin) throw new HttpError(403, 'FORBIDDEN', 'platform administrators only'); };

export function registerSupportRoutes(k: Kit) {
  const { add, authorize, runtime, platform } = k;

  // ───────── platform side ─────────
  add('POST', '/platform/tenants/:id/support-requests', 'session', async (rc) => {
    platformOnly(rc);
    const tenantId = uuid(rc.params.id, 'id');
    const reason = str(rc.body.reason, 'reason', 500);
    if (reason.length < 10) throw bad('reason: explain in at least 10 characters why access is needed');
    const minutes = num(rc.body.minutes, 'minutes', { min: 15 });
    if (!Number.isInteger(minutes) || minutes > 1440) throw bad('minutes must be an integer from 15 to 1440 (24 h)');
    const scope = oneOf(rc.body.scope ?? 'view', 'scope', ['view', 'assist'] as const);
    const id = (await platform.query('SELECT platform_request_support($1,$2,$3,$4,$5) AS id', [rc.session!.userId, tenantId, reason, minutes, scope])).rows[0].id;
    if (!id) throw new HttpError(404, 'NOT_FOUND', 'shop not found');
    return { status: 201, body: { id, status: 'requested' } };
  });
  add('GET', '/platform/tenants/:id/support-requests', 'session', async (rc) => {
    platformOnly(rc);
    const tenantId = uuid(rc.params.id, 'id');
    return { body: { requests: (await platform.query('SELECT * FROM platform_my_support($1,$2)', [rc.session!.userId, tenantId])).rows } };
  });
  add('POST', '/platform/support/enter', 'session', async (rc) => {
    platformOnly(rc);
    const ok = await authm.enterSupport(runtime, rc.token!, uuid(rc.body.tenantId, 'tenantId'), uuid(rc.body.grantId, 'grantId'));
    if (!ok) throw new HttpError(403, 'FORBIDDEN', 'no approved, unexpired access for you on this shop');
    return { body: { status: 'ok' } };
  });
  add('GET', '/support/diagnostics', 'session', async (rc) => {
    const s = rc.session!;
    if (!s.isPlatformAdmin || !s.activeTenantId || !s.supportGrantId)
      throw new HttpError(403, 'FORBIDDEN', 'an active support grant is required');
    const result = await platform.query('SELECT * FROM platform_support_diagnostics($1,$2,$3)', [s.userId,s.activeTenantId,s.supportGrantId]);
    if (!result.rowCount) throw new HttpError(403, 'FORBIDDEN', 'support grant ended');
    return { body: result.rows[0] };
  });
  add('POST', '/support/leave', 'session', async (rc) => {
    await authm.leaveSupport(runtime, rc.token!);
    return { body: { status: 'ok' } };
  });

  // ───────── shop side: the OWNER decides ─────────
  const ownerOnly = async (rc: Rc) => {
    const a = await authorize(rc, 'users.manage');
    if (a.roleName !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'only the shop owner decides on support access');
    return a;
  };
  add('GET', '/support/grants', 'session', async (rc) => {
    const a = await ownerOnly(rc);
    const grants = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT g.id, g.status, g.scope, g.minutes, g.reason, g.created_at, g.decided_at, g.expires_at, g.revoked_at,
              u.name AS requested_by, (g.status='approved' AND g.revoked_at IS NULL AND g.expires_at>now()) AS active
         FROM support_grants g LEFT JOIN users u ON u.id=g.requested_by ORDER BY g.created_at DESC LIMIT 50`))).rows;
    return { body: { grants } };
  });
  add('POST', '/support/grants/:id/approve', 'session', async (rc) => {
    const a = await ownerOnly(rc), id = uuid(rc.params.id, 'id');
    await withTenant(runtime, a.ctx, async (c) => {
      const g = (await c.query('SELECT status, minutes, scope FROM support_grants WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!g) throw new HttpError(404, 'NOT_FOUND', 'request not found');
      if (g.status !== 'requested') throw new HttpError(409, 'INVALID_STATE', 'this request was already decided');
      // the owner can only give LESS than asked: a shorter time, or view instead of assist
      const minutes = rc.body.minutes == null ? g.minutes : num(rc.body.minutes, 'minutes', { min: 15 });
      if (!Number.isInteger(minutes) || minutes > g.minutes) throw bad(`minutes must be an integer from 15 to ${g.minutes}`);
      const scope = rc.body.scope == null ? g.scope : oneOf(rc.body.scope, 'scope', ['view', 'assist'] as const);
      if (g.scope === 'view' && scope === 'assist') throw bad('the approval cannot be wider than the request');
      await c.query(`UPDATE support_grants SET status='approved', scope=$2, minutes=$3, decided_by=$4, decided_at=now(),
          expires_at=now() + make_interval(mins => $3) WHERE id=$1`, [id, scope, minutes, a.ctx.userId]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'support.approved', { type: 'support_grant', id }, undefined, { scope, minutes });
    });
    return { body: { status: 'approved' } };
  });
  for (const [verb, from, to] of [['refuse', 'requested', 'refused'], ['revoke', 'approved', 'revoked']] as const) {
    add('POST', `/support/grants/:id/${verb}`, 'session', async (rc) => {
      const a = await ownerOnly(rc), id = uuid(rc.params.id, 'id');
      await withTenant(runtime, a.ctx, async (c) => {
        const r = await c.query(`UPDATE support_grants SET status=$2, decided_by=COALESCE(decided_by,$3), decided_at=COALESCE(decided_at,now()),
            revoked_at=CASE WHEN $2='revoked' THEN now() ELSE revoked_at END WHERE id=$1 AND status=$4`, [id, to, a.ctx.userId, from]);
        if (!r.rowCount) throw new HttpError(409, 'INVALID_STATE', `only a ${from} request can be ${to}`);
        await audit(c, a.ctx.tenantId, a.ctx.userId, `support.${to}`, { type: 'support_grant', id });
      });
      return { body: { status: to } };
    });
  }
}
