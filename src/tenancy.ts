import type pg from 'pg';
import { withTenant } from './db.js';

export const DEFAULT_ROLES: Record<string, string[]> = {
  owner: ['sale.create', 'sale.discount', 'sale.void', 'stock.adjust', 'approvals.decide', 'report.view_profit', 'users.manage'],
  manager: ['sale.create', 'sale.discount', 'sale.void', 'stock.adjust', 'approvals.decide'],
  cashier: ['sale.create'],
};

export async function createUser(platform: pg.Pool, email: string, name: string): Promise<string> {
  const r = await platform.query(`INSERT INTO users (email, name) VALUES ($1,$2) RETURNING id`, [email, name]);
  return r.rows[0].id;
}

/** Platform action: create tenant (via SECURITY DEFINER fn), then default branch + roles under tenant context. */
export async function provisionTenant(
  platform: pg.Pool, runtime: pg.Pool, o: { name: string; slug: string; plan: string },
) {
  const t = await platform.query(`SELECT create_tenant($1,$2,$3) AS id`, [o.name, o.slug, o.plan]);
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
