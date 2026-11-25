import { audit } from './audit.js';
import { withTenant } from './db.js';
import { HttpError, bad, str, uuid } from './http.js';
import type { Kit, Rc } from './kit.js';

/**
 * PR-B: Platform Control Center (platform admins, metadata only) and the shop's own plan + branding pages.
 * The platform side NEVER reads a shop's sales, customers, invoices or stock: only counters already used for quotas,
 * plan/status, owners' contact and the platform audit trail.
 */
const FEATURES = ['kitchen', 'workshop', 'purchases', 'cash', 'production', 'bookings', 'delivery', 'online'] as const;
const LIMITS = [['users', 'max_users'], ['items', 'max_items'], ['branches', 'max_branches'], ['customers', 'max_customers'], ['monthly_orders', 'max_monthly_orders']] as const;
const HEX = /^#[0-9a-f]{6}$/;
const LOGO_MAX = 65536;

const platformOnly = (rc: Rc) => { if (!rc.session!.isPlatformAdmin) throw new HttpError(403, 'FORBIDDEN', 'platform administrators only'); };
const effectiveFeatures = (planFeatures: unknown, overrides: Record<string, unknown> | null) =>
  Object.fromEntries(FEATURES.map((f) => [f, typeof overrides?.[f] === 'boolean' ? overrides[f] as boolean : Array.isArray(planFeatures) && planFeatures.includes(f)]));
const usage = (row: any) => LIMITS.map(([used, max]) => ({ key: used, used: Number(row[used] ?? 0), limit: Number(row[max]),
  pct: row[max] ? Math.round((Number(row[used] ?? 0) / Number(row[max])) * 100) : 0 }));

/** Alerts derived from real data only (no invented numbers). */
function alertsFor(t: any, now = Date.now()) {
  const out: { tenantId: string; shop: string; kind: string; detail: string }[] = [];
  const push = (kind: string, detail: string) => out.push({ tenantId: t.id, shop: t.name, kind, detail });
  if (t.status === 'suspended') push('suspended', t.status_reason ?? '');
  if (t.status === 'trial_expired') push('trial_expired', String(t.trial_expires_at ?? ''));
  else if (t.plan_id === 'trial' && t.trial_expires_at && new Date(t.trial_expires_at).getTime() - now < 7 * 86400000) push('trial_ending', String(t.trial_expires_at));
  for (const u of usage(t)) if (u.limit && u.pct >= 80) push(u.pct >= 100 ? 'quota_full' : 'quota_high', `${u.key} ${u.used}/${u.limit}`);
  return out;
}

/** Magic bytes: the declared type must match the file content (no SVG: it can carry scripts). */
function sniff(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function registerControlRoutes(k: Kit, info: { version: string; expectedMigrations?: string[] }) {
  const { add, authorize, runtime, platform } = k;

  // ───────── platform side ─────────
  add('GET', '/platform/overview', 'session', async (rc) => {
    platformOnly(rc);
    const tenants = (await platform.query('SELECT * FROM platform_list_tenant_controls()')).rows;
    const byStatus: Record<string, number> = {}, byPlan: Record<string, number> = {};
    for (const t of tenants) { byStatus[t.status] = (byStatus[t.status] ?? 0) + 1; byPlan[t.plan_id] = (byPlan[t.plan_id] ?? 0) + 1; }
    let pending: number | null = null;
    if (info.expectedMigrations) {
      const applied = new Set((await runtime.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      pending = info.expectedMigrations.filter((n) => !applied.has(n)).length;
    }
    const lastMigration = (await runtime.query('SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0] ?? null;
    // what the backup job and restore drills really recorded (never inferred from configuration)
    const ev = (await platform.query(`SELECT
        (SELECT row_to_json(e) FROM (SELECT ok, at, detail FROM platform_backup_events WHERE kind='backup' ORDER BY at DESC, id DESC LIMIT 1) e) AS last_backup,
        (SELECT row_to_json(e) FROM (SELECT at, detail FROM platform_backup_events WHERE kind='backup' AND ok ORDER BY at DESC, id DESC LIMIT 1) e) AS last_ok,
        (SELECT max(at) FROM platform_backup_events WHERE kind='restore_drill' AND ok) AS last_drill`)).rows[0];
    const lastOk = ev.last_ok, last = ev.last_backup;
    const backup = !last ? 'never' : !last.ok ? 'failed' : Date.now() - new Date(last.at).getTime() > 26 * 3600000 ? 'stale' : 'ok';
    return { body: {
      shops: tenants.length, byStatus, byPlan,
      users: tenants.reduce((a, t) => a + Number(t.users), 0),
      alerts: tenants.flatMap((t) => alertsFor(t)),
      health: {
        version: info.version, pendingMigrations: pending, lastMigration,
        backup,                                                     // never | failed | stale (> 26 h) | ok
        lastBackupAt: last?.at ?? null, lastSuccessfulBackupAt: lastOk?.at ?? null,
        offsite: lastOk ? lastOk.detail?.dest === 's3' : false,   // a file: destination is NOT off-site
        lastRestoreDrill: ev.last_drill ?? null,
      },
    } };
  });

  add('GET', '/platform/tenants/:id', 'session', async (rc) => {
    platformOnly(rc);
    const id = uuid(rc.params.id, 'id');
    const t = (await platform.query('SELECT * FROM platform_list_tenant_controls() WHERE id=$1', [id])).rows[0];
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'shop not found');
    const people = (await platform.query('SELECT platform_tenant_people($1) AS p', [id])).rows[0].p;
    const history = (await platform.query('SELECT at, action, actor_name, meta FROM platform_audit_feed($1, 50)', [id])).rows;
    return { body: {
      id: t.id, name: t.name, slug: t.slug, plan: t.plan_id, status: t.status, statusReason: t.status_reason,
      trialExpiresAt: t.trial_expires_at, createdAt: t.created_at, activities: t.activities ?? [],
      usage: usage(t), limitOverrides: t.overrides ?? {}, features: effectiveFeatures(t.features, t.feature_overrides),
      featureOverrides: t.feature_overrides ?? {}, people, alerts: alertsFor(t), history,
    } };
  });

  add('GET', '/platform/audit', 'session', async (rc) => {
    platformOnly(rc);
    const tenant = rc.query.get('tenantId') ? uuid(rc.query.get('tenantId'), 'tenantId') : null;
    const limit = Math.min(200, Math.max(1, Number(rc.query.get('limit') ?? 100) || 100));
    return { body: { entries: (await platform.query('SELECT * FROM platform_audit_feed($1,$2)', [tenant, limit])).rows } };
  });

  // ───────── shop side ─────────
  /** Any active member: what my shop's plan includes and how much of it is used. Read-only. */
  const member = async (rc: Rc) => {
    const s = rc.session!;
    if (!s.activeTenantId) throw new HttpError(400, 'NO_TENANT', 'select a tenant first');
    const ctx = { tenantId: s.activeTenantId, userId: s.userId };
    // a deactivated employee keeps a session until it expires: membership is checked on every call
    const ok = (await withTenant(runtime, ctx, (c) => c.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active', [ctx.tenantId, ctx.userId]))).rowCount;
    if (!ok) throw new HttpError(403, 'FORBIDDEN', 'no active membership');
    return ctx;
  };
  add('GET', '/tenant/plan', 'session', async (rc) => {
    const ctx = await member(rc);
    const out = await withTenant(runtime, ctx, async (c) => {
      const r = (await c.query(`SELECT t.plan_id, p.name AS plan_name, t.status, t.trial_expires_at, p.features, COALESCE(q.feature_overrides,'{}'::jsonb) AS feature_overrides,
          COALESCE(q.max_users,p.max_users) AS max_users, COALESCE(q.max_items,p.max_items) AS max_items,
          COALESCE(q.max_branches,p.max_branches) AS max_branches, COALESCE(q.max_customers,p.max_customers) AS max_customers,
          COALESCE(q.max_monthly_orders,p.max_monthly_orders) AS max_monthly_orders,
          (SELECT count(*) FROM memberships m WHERE m.tenant_id=t.id AND m.active) AS users,
          (SELECT count(*) FROM items i WHERE i.tenant_id=t.id) AS items,
          (SELECT count(*) FROM branches b WHERE b.tenant_id=t.id) AS branches,
          (SELECT count(*) FROM customers cu WHERE cu.tenant_id=t.id) AS customers,
          (SELECT count(*) FROM sales_orders o WHERE o.tenant_id=t.id AND o.created_at>=date_trunc('month',now())) AS monthly_orders
        FROM tenants t JOIN plans p ON p.id=t.plan_id LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=$1`, [ctx.tenantId])).rows[0];
      const expired = r.plan_id === 'trial' && r.trial_expires_at && new Date(r.trial_expires_at) <= new Date();
      return { plan: r.plan_id, planName: r.plan_name, status: expired ? 'trial_expired' : r.status, trialExpiresAt: r.trial_expires_at,
        usage: usage(r), features: effectiveFeatures(r.features, r.feature_overrides) };
    });
    return { body: out };
  });

  add('GET', '/tenant/branding', 'session', async (rc) => {
    const ctx = await member(rc);
    const r = (await withTenant(runtime, ctx, (c) => c.query(
      'SELECT primary_color, accent_color, logo IS NOT NULL AS has_logo, updated_at FROM tenant_branding WHERE tenant_id=$1', [ctx.tenantId]))).rows[0];
    return { body: { primaryColor: r?.primary_color ?? null, accentColor: r?.accent_color ?? null, hasLogo: Boolean(r?.has_logo), version: r ? new Date(r.updated_at).getTime() : 0 } };
  });
  add('GET', '/tenant/logo', 'session', async (rc) => {
    const ctx = await member(rc);
    const r = (await withTenant(runtime, ctx, (c) => c.query('SELECT logo, logo_type FROM tenant_branding WHERE tenant_id=$1 AND logo IS NOT NULL', [ctx.tenantId]))).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'no logo');
    return { body: r.logo as Buffer, headers: { 'content-type': r.logo_type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } };
  });
  add('PUT', '/tenant/branding', 'session', async (rc) => {
    const a = await authorize(rc, 'settings.manage'), b = rc.body;
    const color = (v: unknown, n: string) => {
      if (v == null || v === '') return null;
      const s = str(v, n, 7).toLowerCase();
      if (!HEX.test(s)) throw bad(`${n} must be a color like #b91c1c`);
      return s;
    };
    const primary = color(b.primaryColor, 'primaryColor'), accent = color(b.accentColor, 'accentColor');
    await withTenant(runtime, a.ctx, async (c) => {
      await c.query(`INSERT INTO tenant_branding (tenant_id,primary_color,accent_color,updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id) DO UPDATE SET primary_color=EXCLUDED.primary_color, accent_color=EXCLUDED.accent_color,
          updated_by=EXCLUDED.updated_by, updated_at=now()`, [a.ctx.tenantId, primary, accent, a.ctx.userId]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branding.colors_updated', { type: 'tenant', id: a.ctx.tenantId }, undefined, { primary, accent });
    });
    return { body: { status: 'ok' } };
  });
  add('PUT', '/tenant/logo', 'session', async (rc) => {
    const a = await authorize(rc, 'settings.manage');
    const raw = str(rc.body.data, 'data', 90000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw bad('data must be base64');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > LOGO_MAX) throw bad('logo is larger than 64 KB');
    const type = sniff(buf);
    if (!type) throw bad('logo must be a PNG, JPEG or WebP image');
    await withTenant(runtime, a.ctx, async (c) => {
      await c.query(`INSERT INTO tenant_branding (tenant_id,logo,logo_type,updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id) DO UPDATE SET logo=EXCLUDED.logo, logo_type=EXCLUDED.logo_type, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [a.ctx.tenantId, buf, type, a.ctx.userId]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branding.logo_updated', { type: 'tenant', id: a.ctx.tenantId }, undefined, { bytes: buf.length, type });
    });
    return { body: { status: 'ok', type, bytes: buf.length } };
  });
  add('DELETE', '/tenant/logo', 'session', async (rc) => {
    const a = await authorize(rc, 'settings.manage');
    await withTenant(runtime, a.ctx, async (c) => {
      await c.query('UPDATE tenant_branding SET logo=NULL, logo_type=NULL, updated_by=$2, updated_at=now() WHERE tenant_id=$1', [a.ctx.tenantId, a.ctx.userId]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branding.logo_removed', { type: 'tenant', id: a.ctx.tenantId });
    });
    return { body: { status: 'ok' } };
  });
}
