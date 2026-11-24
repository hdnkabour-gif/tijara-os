import http from 'node:http';
import type pg from 'pg';
import * as authm from './auth.js';
import { audit } from './audit.js';
import { runCommand } from './commands.js';
import { createItem } from './catalog.js';
import { withTenant } from './db.js';
import { DomainError } from './errors.js';
import { receiveStock } from './inventory.js';
import { platformCreateShop } from './tenancy.js';
import { ACTIVITIES, activityIds } from './templates.js';
import { serveUi } from './static.js';
import { registerAdminRoutes } from './admin.js';
import { registerGrillRoutes } from './grill.js';
import { registerWorkshopRoutes } from './workshop.js';
import { registerControlRoutes } from './control.js';
import { registerSupportRoutes } from './support.js';
import { registerOrderRoutes } from './orders.js';
import type { Handler, Rc } from './kit.js';
import { cancelOrder, quickSale } from './sales.js';
import { HttpError, RateLimiter, arr, bad, email, num, oneOf, optNum, optStr, optUuid, readJson, send, str, uuid } from './http.js';

export interface AppDeps { runtime: pg.Pool; platform: pg.Pool; production: boolean; trustProxy?: boolean; version?: string; expectedMigrations?: string[]; uiRoot?: string }

const COOKIE = 'tj_session', COOKIE_MAX_AGE = 12 * 60 * 60;
interface Route { method: string; path: string; re: RegExp; keys: string[]; handler: Handler; auth: 'public' | 'session' }

// The dispatcher applies these lists before any tenant handler, including routes without a permission check.
const PLATFORM_ACCOUNT_ACTIONS = new Set(['GET /me', 'GET /activities', 'POST /auth/logout', 'POST /auth/change-password']);
const SUPPORT_ACTIONS = new Set(['GET /me', 'GET /support/diagnostics', 'POST /support/leave', 'POST /auth/logout']);

const KINDS = ['goods', 'service', 'composite'] as const;
const FULFILL = ['stock', 'backflush', 'none'] as const;
const BATCH = ['none', 'optional', 'required'] as const;
const METHODS = ['cash', 'card', 'transfer'] as const;

export function createApp(d: AppDeps): http.RequestListener {
  const routes: Route[] = [];
  const add = (method: string, path: string, auth: 'public' | 'session', handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, path, re, keys, handler, auth });
  };
  const cookieHeader = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${d.production ? '; Secure' : ''}`;
  const loginByIp = new RateLimiter(30, 15 * 60_000), loginByEmail = new RateLimiter(10, 15 * 60_000), forgotByIp = new RateLimiter(10, 15 * 60_000);

  /** Resolve tenant context from the SESSION only (never from the request), check membership, permission and branch scope. */
  async function authorize(rc: Rc, perm: string) {
    const s = rc.session!;
    if (!s.activeTenantId) throw new HttpError(400, 'NO_TENANT', 'select a tenant first (POST /auth/switch-tenant)');
    const ctx = { tenantId: s.activeTenantId, userId: s.userId };
    const row = (await withTenant(d.runtime, ctx, (c) => c.query(
      `SELECT m.branch_ids, r.name AS role_name, t.status AS shop_status, t.plan_id AS shop_plan,
              t.trial_expires_at AS trial_expires_at, p.features AS plan_features,
              COALESCE(q.feature_overrides,'{}'::jsonb) AS feature_overrides,
              COALESCE((SELECT array_agg(rp.permission) FROM role_permissions rp WHERE rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id), '{}') AS perms
         FROM memberships m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
         JOIN tenants t ON t.id=m.tenant_id JOIN plans p ON p.id=t.plan_id
         LEFT JOIN tenant_quotas q ON q.tenant_id=t.id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.active`, [ctx.tenantId, ctx.userId]))).rows[0];
    if (!row) throw new HttpError(403,'FORBIDDEN','no active membership');
    if (row.shop_status !== 'active') throw new HttpError(423,'SHOP_SUSPENDED','shop access has been temporarily suspended; all data is retained');
    if (row.shop_plan === 'trial' && row.trial_expires_at && new Date(row.trial_expires_at) <= new Date())
      throw new HttpError(423,'TRIAL_EXPIRED','trial expired; all shop records are retained');
    const feature = perm.startsWith('kitchen.') ? 'kitchen'
      : perm.startsWith('workshop.') ? 'workshop'
      : perm.startsWith('purchases.') ? 'purchases'
      : perm.startsWith('cash.') ? 'cash'
      : perm.startsWith('production.') ? 'production'
      : perm.startsWith('bookings.') ? 'bookings'
      : perm.startsWith('delivery.') ? 'delivery' : 'core';
    const overridden = row.feature_overrides?.[feature];
    if (!(feature==='core' || (typeof overridden==='boolean' ? overridden
      : Array.isArray(row.plan_features) && row.plan_features.includes(feature))))
      throw new HttpError(403,'FEATURE_NOT_IN_PLAN',`feature ${feature} unavailable for this shop`);
    if (!row.perms.includes(perm)) throw new HttpError(403, 'FORBIDDEN', `missing permission ${perm}`);
    const branchIds: string[] = row.branch_ids;
    return {
      ctx: ctx as { tenantId: string; userId: string }, branchIds, permissions: row.perms as string[], roleName: row.role_name as string,
      assertBranch(branchId: string) {
        if (branchIds.length > 0 && !branchIds.includes(branchId)) throw new HttpError(403, 'FORBIDDEN', 'branch not in your scope');
      },
    };
  }
  const idemKey = (rc: Rc) => {
    const k = rc.req.headers['idempotency-key'];
    if (typeof k !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(k)) throw bad('Idempotency-Key header (8-100 chars) is required');
    return k;
  };

  // ───────────── auth ─────────────
  add('POST', '/auth/login', 'public', async (rc) => {
    const emailV = email(rc.body.email), pw = str(rc.body.password, 'password', 200);
    if (!loginByIp.allow(rc.ip) || !loginByEmail.allow(emailV)) throw new HttpError(429, 'RATE_LIMITED', 'too many attempts, try later');
    const r = await authm.login(d.runtime, { email: emailV, password: pw, tenantId: optUuid(rc.body.tenantId, 'tenantId'), ip: rc.ip, ua: String(rc.req.headers['user-agent'] ?? '') });
    const base = { user: { id: r.userId, name: r.name }, activeTenantId: r.activeTenantId, tenants: r.tenants };
    // Browser mode: the session token lives ONLY in an HttpOnly cookie and is never exposed to page scripts.
    if (rc.body.cookie === true) return { body: base, headers: { 'set-cookie': cookieHeader(r.token, COOKIE_MAX_AGE) } };
    return { body: { token: r.token, ...base } };
  });
  add('POST', '/auth/logout', 'session', async (rc) => {
    await authm.logout(d.runtime, rc.token!);
    return { body: { status: 'ok' }, headers: { 'set-cookie': cookieHeader('', 0) } };
  });
  add('POST', '/auth/switch-tenant', 'session', async (rc) => {
    const ok = await authm.switchTenant(d.runtime, rc.token!, uuid(rc.body.tenantId, 'tenantId'));
    if (!ok) throw new HttpError(403, 'FORBIDDEN', 'not a member of this tenant');
    return { body: { activeTenantId: rc.body.tenantId } };
  });
  add('POST', '/auth/change-password', 'session', async (rc) => {
    await authm.changePassword(d.runtime, rc.session!, rc.token!, str(rc.body.currentPassword, 'currentPassword'), str(rc.body.newPassword, 'newPassword'));
    return { body: { status: 'ok' } };
  });
  add('POST', '/auth/forgot', 'public', async (rc) => {
    if (!forgotByIp.allow(rc.ip)) throw new HttpError(429, 'RATE_LIMITED', 'too many attempts, try later');
    const token = await authm.requestReset(d.runtime, email(rc.body.email));
    // production: the token must be e-mailed (provider not wired yet); the response is identical whether or not the account exists
    return { status: 202, body: d.production ? { status: 'ok' } : { status: 'ok', devResetToken: token } };
  });
  add('POST', '/auth/reset', 'public', async (rc) => {
    await authm.consumeReset(d.runtime, str(rc.body.token, 'token', 200), str(rc.body.newPassword, 'newPassword'));
    return { body: { status: 'ok' } };
  });
  add('GET', '/me', 'session', async (rc) => {
    const s = rc.session!;
    if (s.isPlatformAdmin) {
      let support = null;
      if (s.supportGrantId && s.activeTenantId) {
        support = (await withTenant(d.runtime, {tenantId:s.activeTenantId, userId:s.userId}, c => c.query(
          `SELECT id, scope, expires_at AS "expiresAt" FROM support_grants
            WHERE id=$1 AND requested_by=$2 AND status='approved' AND revoked_at IS NULL AND expires_at>now()`,
          [s.supportGrantId, s.userId]))).rows[0] ?? null;
      }
      return {body:{user:{id:s.userId,name:s.name,email:s.email},isPlatformAdmin:true,
        activeTenantId:support ? s.activeTenantId : null,tenants:[],permissions:[],support}};
    }
    const tenants = await authm.listTenants(d.runtime, s.userId);
    let permissions: string[] = [];
    if (s.activeTenantId) {
      const result = await withTenant(d.runtime, { tenantId:s.activeTenantId,userId:s.userId }, async(c) => {
        const ps = (await c.query(`SELECT t.status,t.plan_id,t.trial_expires_at,p.features,COALESCE(q.feature_overrides,'{}'::jsonb) AS overrides
          FROM tenants t JOIN plans p ON p.id=t.plan_id LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=$1`,
          [s.activeTenantId])).rows[0];
        if (!ps || ps.status!=='active' || (ps.plan_id==='trial' && ps.trial_expires_at && new Date(ps.trial_expires_at)<=new Date())) return [];
        const list = (await c.query(`SELECT rp.permission FROM memberships m JOIN role_permissions rp
          ON rp.tenant_id=m.tenant_id AND rp.role_id=m.role_id
          WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active ORDER BY 1`,[s.activeTenantId,s.userId])).rows;
        const entitled=(perm:string)=>{
          const feature=perm.startsWith('kitchen.')?'kitchen':perm.startsWith('workshop.')?'workshop'
            :perm.startsWith('purchases.')?'purchases':perm.startsWith('cash.')?'cash'
            :perm.startsWith('production.')?'production':perm.startsWith('bookings.')?'bookings'
            :perm.startsWith('delivery.')?'delivery':'core';
          return feature==='core'||(typeof ps.overrides?.[feature]==='boolean'?ps.overrides[feature]:ps.features.includes(feature));
        };
        return list.map(x=>x.permission as string).filter(entitled);
      });
      permissions = result;
    }
    return { body: { user: { id: s.userId, name: s.name, email: s.email }, isPlatformAdmin: false, activeTenantId: s.activeTenantId, tenants, permissions, support: null } };
  });

  add('GET', '/activities', 'session', async () => ({ body: { activities: ACTIVITIES.map((a) => ({ id: a.id, label: a.label, sampleItems: a.items.length })) } }));
  add('GET', '/tenant', 'session', async (rc) => {
    const s = rc.session!;
    if (!s.activeTenantId) throw new HttpError(400, 'NO_TENANT', 'select a tenant first');
    const row = (await withTenant(d.runtime, { tenantId: s.activeTenantId, userId: s.userId }, (c) => c.query(
      'SELECT id, name, slug, plan_id, status, status_reason, trial_expires_at, settings FROM tenants WHERE id = $1', [s.activeTenantId]))).rows[0];
    if (!row) throw new HttpError(403, 'FORBIDDEN', 'not a member of this tenant');
    return { body: { id: row.id, name: row.name, slug: row.slug, plan: row.plan_id, status:row.plan_id==='trial' && row.trial_expires_at && new Date(row.trial_expires_at)<=new Date()?'trial_expired':row.status,
      statusReason: row.status_reason,trialExpiresAt:row.trial_expires_at, activities: row.settings?.activities ?? [], company: row.settings?.company ?? {} } };
  });

  // ───────────── platform (super admin) ─────────────
  add('GET', '/platform/tenants', 'session', async (rc) => {
    if (!rc.session!.isPlatformAdmin) throw new HttpError(403, 'FORBIDDEN', 'platform administrators only');
    return { body: { tenants: (await d.platform.query('SELECT * FROM platform_list_tenant_controls()')).rows } };
  });
  add('GET', '/platform/plans', 'session', async (rc) => {
    if (!rc.session!.isPlatformAdmin) throw new HttpError(403,'FORBIDDEN','platform administrators only');
    const plans = (await d.platform.query("SELECT id,name,max_users,max_items,max_branches,max_customers,max_monthly_orders,features FROM plans WHERE id <> 'tiny' ORDER BY CASE id WHEN 'trial' THEN 1 WHEN 'basic' THEN 2 WHEN 'pro' THEN 3 ELSE 4 END")).rows;
    return { body: { plans } };
  });
  add('PATCH', '/platform/tenants/:id/controls', 'session', async (rc) => {
    if (!rc.session!.isPlatformAdmin) throw new HttpError(403,'FORBIDDEN','platform administrators only');
    const id = uuid(rc.params.id,'id'), b = rc.body;
    const plan = b.plan === undefined ? null : oneOf(b.plan,'plan',['trial','basic','pro','complete'] as const);
    const status = b.status === undefined ? null : oneOf(b.status,'status',['active','suspended'] as const);
    const reason = b.reason === undefined ? null : str(b.reason,'reason',300);
    const limits: Record<string,number|null> = {};
    let features: Record<string,boolean>|null = null;
    if (b.features !== undefined) {
      if (!b.features || typeof b.features!=='object' || Array.isArray(b.features)) throw bad('features must be an object');
      const allowed = ['kitchen','workshop','purchases','cash','production','bookings','delivery'];
      features={};
      for (const [key,value] of Object.entries(b.features)) {
        if (!allowed.includes(key)||typeof value!=='boolean') throw bad('invalid feature override');
        features[key]=value;
      }
    }
    if (b.limits !== undefined) {
      if (!b.limits || typeof b.limits !== 'object' || Array.isArray(b.limits)) throw bad('limits must be an object');
      const keys = ['max_users','max_items','max_branches','max_customers','max_monthly_orders'];
      for (const [key,value] of Object.entries(b.limits)) {
        if (!keys.includes(key)) throw bad(`unsupported limit ${key}`);
        if (value !== null && (!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>10000000))
          throw bad(`invalid ${key}`);
        limits[key] = value as number|null;
      }
    }
    if (status==='suspended' && !reason) throw bad('suspension reason required');
    if (plan===null && status===null && Object.keys(limits).length===0 && features===null) throw bad('no changes requested');
    const changed=(await d.platform.query('SELECT platform_set_tenant_controls($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) AS ok',
      [rc.session!.userId,id,plan,status,reason,b.limits===undefined?null:JSON.stringify(limits),
        features===null?null:JSON.stringify(features)])).rows[0]?.ok;
    if (!changed) throw new HttpError(404,'NOT_FOUND','shop not found');
    return { body: { status:'ok' } };
  });

  add('POST', '/platform/tenants', 'session', async (rc) => {
    if (!rc.session!.isPlatformAdmin) throw new HttpError(403, 'FORBIDDEN', 'platform administrators only');
    const o = rc.body;
    if (o.owner?.self === true) throw new HttpError(403, 'FORBIDDEN', 'a separate shop owner is required');
    const pwErr = authm.checkPasswordPolicy(o.owner?.password);
    if (pwErr) throw bad(pwErr);
    const slug = str(o.slug, 'slug', 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw bad('slug must be lowercase letters, digits, dashes');
    const t = await platformCreateShop(d.platform, d.runtime, rc.session!.userId, {
      name: str(o.name, 'name'), slug, plan: oneOf(o.plan, 'plan', ['trial', 'basic', 'pro', 'complete']),
      activities: (o.activities == null ? [] : arr(o.activities, 'activities', 10)).map((a: unknown) => oneOf(a, 'activities[]', activityIds as readonly string[])),
      owner: { email: email(o.owner?.email), name: str(o.owner?.name, 'owner.name'), passwordHash: await authm.hashPassword(o.owner.password) },
    });
    return { status: 201, body: { tenantId: t.tenantId, branchId: t.branchId, ownerUserId: t.ownerId } };
  });

  // ───────────── tenant administration ─────────────
  add('GET', '/branches', 'session', async (rc) => {
    const a = await authorize(rc, 'branches.view');
    const rows = (await withTenant(d.runtime, a.ctx, (c) => c.query('SELECT id, name FROM branches ORDER BY name'))).rows;
    return { body: { branches: a.branchIds.length ? rows.filter((r) => a.branchIds.includes(r.id)) : rows } };
  });
  add('POST', '/branches', 'session', async (rc) => {
    const a = await authorize(rc, 'branches.manage');
    const r = await withTenant(d.runtime, a.ctx, async (c) => {
      const id = (await c.query('INSERT INTO branches (tenant_id, name) VALUES ($1,$2) RETURNING id', [a.ctx.tenantId, str(rc.body.name, 'name', 100)])).rows[0].id;
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branch.created', { type: 'branch', id });
      return id;
    });
    return { status: 201, body: { id: r } };
  });
  add('GET', '/users', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage');
    const rows = (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT u.id, u.name, u.email, r.name AS role, m.branch_ids, m.active FROM memberships m
         JOIN users u ON u.id = m.user_id JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id ORDER BY u.name`))).rows;
    return { body: { users: rows } };
  });
  add('POST', '/users', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage');
    const pwErr = authm.checkPasswordPolicy(rc.body.password);
    if (pwErr) throw bad(pwErr);
    const hash = await authm.hashPassword(rc.body.password);
    if (rc.body.branchIds !== undefined && !Array.isArray(rc.body.branchIds)) throw bad('branchIds must be an array');
    const branchIds = (rc.body.branchIds ?? []).map((b: unknown) => uuid(b, 'branchIds[]'));
    if (new Set(branchIds).size !== branchIds.length) throw bad('duplicate branch');
    // An empty branch_ids array means ALL branches. A scoped staff manager must never grant that scope.
    if (a.branchIds.length && (!branchIds.length || branchIds.some((bid: string) => !a.branchIds.includes(bid)))) {
      throw new HttpError(403, 'FORBIDDEN', 'cannot grant branch access outside your own scope');
    }
    const roleName = str(rc.body.roleName, 'roleName', 50);
    if (roleName === 'owner' && a.roleName !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'only an owner can create an owner');
    const id = await withTenant(d.runtime, a.ctx, async (c) => {
      const role = (await c.query('SELECT id FROM roles WHERE name=$1', [roleName])).rows[0];
      if (!role) throw bad('unknown role');
      // users.manage alone does not grant the ability to create a higher-privilege login.
      if (a.roleName !== 'owner') {
        const granted = (await c.query('SELECT permission FROM role_permissions WHERE role_id=$1', [role.id])).rows.map((r) => r.permission as string);
        if (granted.some((p: string) => !a.permissions.includes(p))) {
          throw new HttpError(403, 'FORBIDDEN', 'cannot assign more permissions than you hold');
        }
      }
      if (branchIds.length) {
        const ok = (await c.query('SELECT count(*)::int n FROM branches WHERE id = ANY($1::uuid[])', [branchIds])).rows[0].n;
        if (ok !== branchIds.length) throw bad('unknown branch');
      }
      const uid = (await c.query('SELECT auth_create_user($1,$2,$3) AS id', [email(rc.body.email), str(rc.body.name, 'name', 100), hash])).rows[0].id;
      await c.query('INSERT INTO memberships (tenant_id, user_id, role_id, branch_ids) VALUES ($1,$2,$3,$4)', [a.ctx.tenantId, uid, role.id, branchIds]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'user.created', { type: 'user', id: uid }, undefined, { role: rc.body.roleName, branchIds });
      return uid;
    });
    return { status: 201, body: { id } };
  });

  // ───────────── catalog ─────────────
  add('GET', '/items', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.view');
    return { body: { items: (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT id, sku, name, kind, track_quantity, batch_tracking, serial_tracking, fulfillment, base_uom, price, active, orderable, attributes FROM items ORDER BY sku`))).rows } };
  });
  add('POST', '/items', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), b = rc.body;
    const kind = oneOf(b.kind, 'kind', KINDS), fulfillment = oneOf(b.fulfillment, 'fulfillment', FULFILL);
    const id = await withTenant(d.runtime, a.ctx, async (c) => {
      const id = await createItem(c, a.ctx.tenantId, {
        sku: str(b.sku, 'sku', 60), name: str(b.name, 'name', 200), kind, fulfillment,
        trackQuantity: typeof b.trackQuantity === 'boolean' ? b.trackQuantity : bad('trackQuantity must be boolean') as never,
        batchTracking: b.batchTracking == null ? 'none' : oneOf(b.batchTracking, 'batchTracking', BATCH),
        serialTracking: b.serialTracking === true, baseUom: optStr(b.baseUom, 'baseUom', 20) ?? 'unit', price: optNum(b.price, 'price', { min: 0 }) ?? 0,
      });
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'item.created', { type: 'item', id });
      return id;
    });
    return { status: 201, body: { id } };
  });
  add('GET', '/customers', 'session', async (rc) => {
    const a = await authorize(rc, 'customers.view');
    return { body: { customers: (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT c.id, c.name, c.phone, c.address, c.notes, c.active, c.credit_limit, COALESCE((SELECT sum(amount) FROM receivable_entries r WHERE r.customer_id=c.id),0) AS balance FROM customers c ORDER BY c.name`))).rows } };
  });
  add('POST', '/customers', 'session', async (rc) => {
    const a = await authorize(rc, 'customers.manage');
    const id = (await withTenant(d.runtime, a.ctx, (c) => c.query(
      'INSERT INTO customers (tenant_id, name, phone, credit_limit) VALUES ($1,$2,$3,$4) RETURNING id',
      [a.ctx.tenantId, str(rc.body.name, 'name', 150), optStr(rc.body.phone, 'phone', 30) ?? null, optNum(rc.body.creditLimit, 'creditLimit', { min: 0 }) ?? 0]))).rows[0].id;
    return { status: 201, body: { id } };
  });

  // ───────────── stock ─────────────
  add('GET', '/stock', 'session', async (rc) => {
    const a = await authorize(rc, 'stock.view');
    const branchId = uuid(rc.query.get('branchId'), 'branchId');
    a.assertBranch(branchId);
    const known = (await withTenant(d.runtime, a.ctx, (c) => c.query('SELECT 1 FROM branches WHERE id=$1', [branchId]))).rowCount;
    if (!known) throw new HttpError(404, 'NOT_FOUND', 'branch not found');
    const rows = (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT i.id AS item_id, i.sku, i.name, i.base_uom, COALESCE(sum(sb.on_hand),0) AS on_hand, COALESCE(sum(sb.reserved),0) AS reserved,
              COALESCE(sum(sb.on_hand - sb.reserved),0) AS available
         FROM items i LEFT JOIN stock_balances sb ON sb.item_id=i.id AND sb.branch_id=$1 AND sb.stock_status='sellable'
        WHERE i.track_quantity GROUP BY i.id, i.sku, i.name, i.base_uom ORDER BY i.sku`, [branchId]))).rows;
    return { body: { stock: rows } };
  });
  add('POST', '/stock/receive', 'session', async (rc) => {
    const a = await authorize(rc, 'stock.receive'), b = rc.body;
    const branchId = uuid(b.branchId, 'branchId');
    a.assertBranch(branchId);
    const p = {
      branchId, itemId: uuid(b.itemId, 'itemId'), qty: num(b.qty, 'qty', { positive: true }), unitCost: num(b.unitCost, 'unitCost', { min: 0 }),
      batchNo: optStr(b.batchNo, 'batchNo', 60), expiresAt: optStr(b.expiresAt, 'expiresAt', 40),
      serials: b.serials == null ? undefined : arr(b.serials, 'serials', 500).map((s) => ({ serialNo: str(s.serialNo, 'serialNo', 80), warrantyUntil: optStr(s.warrantyUntil, 'warrantyUntil', 10) })),
    };
    const r = await runCommand(d.runtime, a.ctx, { key: idemKey(rc), type: 'stock_receive', payload: p }, async (cc) => {
      const out = await receiveStock(cc, p);
      await audit(cc.client, a.ctx.tenantId, a.ctx.userId, 'stock.received', { type: 'item', id: p.itemId }, undefined, { qty: p.qty, unitCost: p.unitCost });
      return out;
    });
    return { status: 201, body: r };
  });

  // ───────────── sales ─────────────
  add('POST', '/sales/quick', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.create'), b = rc.body;
    const branchId = uuid(b.branchId, 'branchId');
    a.assertBranch(branchId);
    const canOverride = (await authorize(rc, 'sale.price_override').then(() => true, () => false));
    const lines = arr(b.lines, 'lines', 50).map((l, i) => {
      if (l.unitPrice != null && !canOverride) throw new HttpError(403, 'FORBIDDEN', 'price override requires permission sale.price_override');
      return { itemId: uuid(l.itemId, `lines[${i}].itemId`), qty: num(l.qty, `lines[${i}].qty`, { positive: true }), unitPrice: optNum(l.unitPrice, 'unitPrice', { min: 0 }),
        serialNo: optStr(l.serialNo, 'serialNo', 80), actualQty: optNum(l.actualQty, 'actualQty', { positive: true }), prepRequired: l.prepRequired === true };
    });
    const payments = (b.payments == null ? [] : Array.isArray(b.payments) ? b.payments : bad('payments must be an array')).map((p: any, i: number) => ({
      method: oneOf(p.method, `payments[${i}].method`, METHODS), amount: num(p.amount, `payments[${i}].amount`, { positive: true }) }));
    const p = { branchId, customerId: optUuid(b.customerId, 'customerId'), lines, payments };
    const r = await runCommand(d.runtime, a.ctx, { key: idemKey(rc), type: 'quick_sale', payload: p }, (cc) => quickSale(cc, p));
    return { status: 201, body: r };
  });
  add('POST', '/sales/:orderId/cancel', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.void');
    const p = { orderId: uuid(rc.params.orderId, 'orderId'), reason: str(rc.body.reason, 'reason', 300), committed: rc.body.committed == null ? undefined : oneOf(rc.body.committed, 'committed', ['return', 'waste'] as const) };
    await runCommand(d.runtime, a.ctx, { key: idemKey(rc), type: 'cancel_order', payload: p }, (cc) => cancelOrder(cc, p));
    return { body: { status: 'cancelled' } };
  });
  add('GET', '/invoices', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.view');
    const rows = (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT i.id, i.invoice_no, i.order_id, i.total, i.status, i.created_at,
              COALESCE((SELECT sum(amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0) AS paid
         FROM invoices i ORDER BY i.created_at DESC LIMIT 100`))).rows;
    return { body: { invoices: rows } };
  });
  add('GET', '/reports/summary', 'session', async (rc) => {
    const a = await authorize(rc, 'report.view');
    const r = (await withTenant(d.runtime, a.ctx, (c) => c.query(
      `SELECT (SELECT COALESCE(sum(total),0) FROM invoices WHERE status='issued' AND created_at >= date_trunc('day', now())) AS sales_today,
              (SELECT count(*)::int FROM invoices WHERE status='issued' AND created_at >= date_trunc('day', now())) AS invoices_today,
              (SELECT COALESCE(sum(amount),0) FROM receivable_entries) AS receivables`))).rows[0];
    return { body: { salesToday: r.sales_today, invoicesToday: r.invoices_today, receivables: r.receivables } };
  });

  registerAdminRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform });
  registerGrillRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform });
  registerWorkshopRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform });
  registerControlRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform }, { version: d.version ?? 'dev', expectedMigrations: d.expectedMigrations });
  registerSupportRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform });
  registerOrderRoutes({ add, authorize, idemKey, runtime: d.runtime, platform: d.platform });

  // ───────────── dispatcher ─────────────
  const clientIp = (req: http.IncomingMessage) =>
    (d.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  function mapError(e: any): { status: number; code: string; message: string } {
    if (e instanceof HttpError || e instanceof authm.AuthError) return { status: e.status, code: e.code, message: e.message };
    if (e instanceof DomainError) {
      const s = ({ VALIDATION: 400, FORBIDDEN: 403, INSUFFICIENT_STOCK: 409, CONFLICT: 409, INVALID_STATE: 409 } as Record<string, number>)[e.code] ?? 400;
      return { status: s, code: e.code, message: e.message };
    }
    switch (e?.code) {
      case '23503': return { status: 400, code: 'INVALID_REFERENCE', message: 'a referenced record does not exist' };
      case '23505': return { status: 409, code: 'ALREADY_EXISTS', message: 'record already exists' };
      case '23514': return { status: 400, code: 'VALIDATION', message: 'value violates a data rule' };
      case '22P02': case '22003': return { status: 400, code: 'VALIDATION', message: 'invalid value' };
      case '42501': return { status: 403, code: 'FORBIDDEN', message: 'not allowed' };
      case 'P0001': return { status: 403, code: 'QUOTA', message: String(e.message).replace(/^.*?(plan .*)$/s, '$1') };
    }
    console.error('internal error', typeof e?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : 'UNCLASSIFIED');
    return { status: 500, code: 'INTERNAL', message: 'internal error' };
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (d.uiRoot && serveUi(d.uiRoot, req, res, url.pathname, d.production)) return;
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', version: d.version ?? 'dev' });
      if (req.method === 'GET' && url.pathname === '/ready') {
        const role = (await d.runtime.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
        const unprotected = (await d.runtime.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r'
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
              AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows[0].n;
        const migrations = (await d.runtime.query(`SELECT current_setting('server_version') AS v, (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations') AS m`)).rows[0];
        let pending: number | null = null;
        if (migrations.m === 1 && d.expectedMigrations) {
          const applied = new Set((await d.runtime.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
          pending = d.expectedMigrations.filter((n) => !applied.has(n)).length;
        }
        const ok = !(role.rolsuper || role.rolbypassrls) && unprotected === 0 && migrations.m === 1 && (pending ?? 0) === 0;
        return send(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', rlsBypassPossible: Boolean(role.rolsuper || role.rolbypassrls), unprotectedTables: unprotected, migrated: migrations.m === 1, pendingMigrations: pending, postgres: migrations.v, version: d.version ?? 'dev' });
      }
      let matched: { r: Route; params: Record<string, string> } | null = null;
      let pathExists = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathExists = true;
        if (r.method !== req.method) continue;
        matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        break;
      }
      if (!matched) return send(res, pathExists ? 405 : 404, { error: { code: pathExists ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', message: 'not found' } });
      const body = await readJson(req);
      const auth = String(req.headers.authorization ?? '');
      let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      let viaCookie = false;
      if (!token) {
        const m = /(?:^|;\s*)tj_session=([^;]+)/.exec(String(req.headers.cookie ?? ''));
        if (m) { token = m[1]; viaCookie = true; }
      }
      // CSRF defence for cookie sessions (in addition to SameSite=Strict): same-origin only + a custom header browsers
      // cannot send cross-site without a CORS preflight (which this server never grants).
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && (viaCookie || (matched.r.path === '/auth/login' && body?.cookie === true))) {
        const origin = req.headers.origin;
        if (origin && new URL(String(origin)).host !== req.headers.host) throw new HttpError(403, 'CSRF', 'cross-origin request refused');
        if (req.headers['x-requested-with'] !== 'tijara-web') throw new HttpError(403, 'CSRF', 'missing x-requested-with header');
      }
      let session: authm.SessionInfo | null = null;
      if (matched.r.auth === 'session') {
        session = token ? await authm.getSession(d.runtime, token) : null;
        if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
        // every request made under a support grant, whatever handler serves it, goes to the shop's own journal first
        if (session.supportGrantId && session.activeTenantId) {
          const grantId = session.supportGrantId;
          await withTenant(d.runtime, { tenantId: session.activeTenantId, userId: session.userId }, (c) =>
            audit(c, session!.activeTenantId!, session!.userId, 'support.request', { type: 'support_grant', id: grantId }, undefined, undefined,
              { method: req.method, path: matched!.r.path }));
        }
        if (session.isPlatformAdmin) {
          const action = matched.r.method + ' ' + matched.r.path;
          const allowed = session.supportGrantId ? SUPPORT_ACTIONS.has(action)
            : matched.r.path.startsWith('/platform/') || PLATFORM_ACCOUNT_ACTIONS.has(action);
          if (!allowed) throw new HttpError(403, 'FORBIDDEN', 'outside platform access');
        }
      }
      const out = await matched.r.handler({ req, body, query: url.searchParams, params: matched.params, token, session, ip: clientIp(req), viaCookie });
      return send(res, out.status ?? 200, out.body, out.headers);
    } catch (e) {
      const m = mapError(e);
      return send(res, m.status, { error: { code: m.code, message: m.message } });
    }
  };
}
