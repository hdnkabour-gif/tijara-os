import type pg from 'pg';
import { withTenant } from './db.js';
import { createItem } from './catalog.js';
import { ACTIVITIES } from './templates.js';

const CAT = ['catalog.view', 'catalog.manage', 'stock.view', 'stock.receive', 'stock.adjust', 'sale.view', 'sale.create', 'sale.discount',
  'sale.price_override', 'sale.void', 'customers.view', 'customers.manage', 'branches.view', 'report.view'];
export const DEFAULT_ROLES: Record<string, string[]> = {
  owner: [...CAT, 'approvals.decide', 'report.view_profit', 'users.manage', 'branches.manage', 'audit.view', 'settings.manage', 'kitchen.view','kitchen.manage','purchases.view','purchases.manage','cash.view','cash.manage','production.manage','workshop.view','workshop.manage','orders.view','orders.manage'],
  manager: [...CAT, 'approvals.decide', 'audit.view','kitchen.view','kitchen.manage','purchases.view','cash.view','cash.manage','workshop.view','workshop.manage','orders.view','orders.manage'],
  cashier: ['catalog.view', 'stock.view', 'sale.view', 'sale.create', 'customers.view', 'branches.view', 'orders.view', 'orders.manage'],
};

export async function createUser(platform: pg.Pool, email: string, name: string, passwordHash: string | null = null): Promise<string> {
  const r = await platform.query(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [email, name, passwordHash]);
  return r.rows[0].id;
}

/** Platform action: create tenant (via SECURITY DEFINER fn), then default branch + roles under tenant context. */
export async function provisionTenant(
  platform: pg.Pool, runtime: pg.Pool, o: { name: string; slug: string; plan: string; settings?: object },
) {
  const t = o.settings
    ? await platform.query(`SELECT create_tenant($1,$2,$3,$4::jsonb) AS id`, [o.name, o.slug, o.plan, JSON.stringify(o.settings)])
    : await platform.query(`SELECT create_tenant($1,$2,$3) AS id`, [o.name, o.slug, o.plan]);
  const tenantId: string = t.rows[0].id;
  const out = await withTenant(runtime, { tenantId }, async (c) => {
    const b = await c.query(`INSERT INTO branches (tenant_id, name) VALUES ($1,'Main') RETURNING id`, [tenantId]);
    const roles: Record<string, string> = {};
    for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
      const r = await c.query(`INSERT INTO roles (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tenantId, name]);
      roles[name] = r.rows[0].id;
      for (const p of perms) {
        await c.query(`INSERT INTO role_permissions (tenant_id, role_id, permission) VALUES ($1,$2,$3)`,
          [tenantId, r.rows[0].id, p]);
      }
    }
    return { branchId: b.rows[0].id as string, roles };
  });
  return { tenantId, ...out };
}

export async function addMember(runtime: pg.Pool, tenantId: string, userId: string, roleId: string) {
  await withTenant(runtime, { tenantId }, (c) => c.query(
    `INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenantId, userId, roleId]));
}

export async function hasPermission(c: pg.PoolClient, tenantId: string, userId: string, perm: string) {
  const r = await c.query(
    `SELECT 1 FROM memberships m JOIN role_permissions rp
       ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active AND rp.permission=$3`, [tenantId, userId, perm]);
  return (r.rowCount ?? 0) > 0;
}

/** Platform action: a new shop with its first owner, audited in platform_audit. */
export async function platformCreateShop(
  platform: pg.Pool, runtime: pg.Pool, actorUserId: string,
  o: { name: string; slug: string; plan: string; activities?: string[]; owner: { existingUserId: string } | { email: string; name: string; passwordHash: string } },
) {
  // Self-ownership is only allowed for the authenticated platform administrator performing the action.
  if ('existingUserId' in o.owner && o.owner.existingUserId !== actorUserId) throw new Error('self owner must be the acting administrator');
  const activities = o.activities ?? [];
  const t = await provisionTenant(platform, runtime, { name: o.name, slug: o.slug, plan: o.plan, settings: { activities } });
  await withTenant(runtime, { tenantId: t.tenantId }, async (c) => {            // starter catalog (examples the owner will edit)
    const seen = new Set<string>();
    for (const a of ACTIVITIES.filter((x) => activities.includes(x.id))) {
      for (const it of a.items) {
        if (seen.has(it.sku)) continue;
        seen.add(it.sku);
        await createItem(c, t.tenantId, { ...it, attributes: { sample: true, activity: a.id } });
      }
    }
  });
  const ownerId = 'existingUserId' in o.owner
    ? o.owner.existingUserId
    : await createUser(platform, o.owner.email, o.owner.name, o.owner.passwordHash);
  await addMember(runtime, t.tenantId, ownerId, t.roles.owner);
  await platform.query(`INSERT INTO platform_audit (actor_user_id, action, meta) VALUES ($1,'tenant.created',$2)`,
    [actorUserId, JSON.stringify({ tenantId: t.tenantId, slug: o.slug, plan: o.plan })]);
  return { ...t, ownerId };
}
