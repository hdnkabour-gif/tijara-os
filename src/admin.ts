import { audit } from './audit.js';
import { withTenant } from './db.js';
import { checkPasswordPolicy, hashPassword } from './auth.js';
import { HttpError, bad, num, optNum, optStr, optUuid, str, uuid } from './http.js';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, isPermission } from './permissions.js';
import type { Kit } from './kit.js';

export const SYSTEM_ROLES = ['owner', 'manager', 'cashier'];
const ROLE_NAME = /^[a-z][a-z0-9_]{1,29}$/;

/** A DELETE that hits a foreign key means the record has history: it must be archived, never erased. */
async function guardedDelete<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.code === '23503') throw new HttpError(409, 'IN_USE', `${what} has history and cannot be deleted; archive it instead`);
    throw e;
  }
}
/** optional free text: empty is allowed (clears the field), too long is not */
const optText = (v: unknown, name: string, max: number): string => {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be text (max ${max} chars)`);
  return v.trim();
};
const optBool = (v: unknown, name: string) => { if (v == null) return undefined; if (typeof v !== 'boolean') throw bad(`${name} must be boolean`); return v; };

export function registerAdminRoutes(k: Kit) {
  const { add, authorize, runtime } = k;

  // ───────────── products & services: edit / archive / delete ─────────────
  add('PATCH', '/items/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id');
    const name = optStr(rc.body.name, 'name'), price = optNum(rc.body.price, 'price', { min: 0 }), active = optBool(rc.body.active, 'active');
    if (name === undefined && price === undefined && active === undefined) throw bad('nothing to update');
    await withTenant(runtime, a.ctx, async (c) => {
      const before = (await c.query('SELECT name, price, active FROM items WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new HttpError(404, 'NOT_FOUND', 'item not found');
      await c.query('UPDATE items SET name=COALESCE($2,name), price=COALESCE($3,price), active=COALESCE($4,active) WHERE id=$1', [id, name ?? null, price ?? null, active ?? null]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'item.updated', { type: 'item', id }, before, { name, price, active });
    });
    return { body: { status: 'ok' } };
  });
  add('DELETE', '/items/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id');
    await guardedDelete('this item', () => withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query('DELETE FROM items WHERE id=$1 RETURNING sku', [id]);
      if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'item not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'item.deleted', { type: 'item', id }, { sku: r.rows[0].sku });
    }));
    return { body: { status: 'deleted' } };
  });

  // ───────────── customers ─────────────
  add('PATCH', '/customers/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'customers.manage'), id = uuid(rc.params.id, 'id'), b = rc.body;
    const f = { name: optStr(b.name, 'name', 150), phone: optStr(b.phone, 'phone', 30), address: optStr(b.address, 'address', 300), notes: optStr(b.notes, 'notes', 500),
      creditLimit: optNum(b.creditLimit, 'creditLimit', { min: 0 }), active: optBool(b.active, 'active') };
    if (Object.values(f).every((v) => v === undefined)) throw bad('nothing to update');
    await withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query(
        `UPDATE customers SET name=COALESCE($2,name), phone=COALESCE($3,phone), address=COALESCE($4,address), notes=COALESCE($5,notes),
                credit_limit=COALESCE($6,credit_limit), active=COALESCE($7,active) WHERE id=$1`,
        [id, f.name ?? null, f.phone ?? null, f.address ?? null, f.notes ?? null, f.creditLimit ?? null, f.active ?? null]);
      if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'customer not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'customer.updated', { type: 'customer', id }, undefined, f);
    });
    return { body: { status: 'ok' } };
  });
  add('DELETE', '/customers/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'customers.manage'), id = uuid(rc.params.id, 'id');
    await guardedDelete('this customer', () => withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query('DELETE FROM customers WHERE id=$1', [id]);
      if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'customer not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'customer.deleted', { type: 'customer', id });
    }));
    return { body: { status: 'deleted' } };
  });

  // ───────────── branches ─────────────
  add('PATCH', '/branches/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'branches.manage'), id = uuid(rc.params.id, 'id'), name = str(rc.body.name, 'name', 100);
    await withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query('UPDATE branches SET name=$2 WHERE id=$1', [id, name]);
      if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'branch not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branch.updated', { type: 'branch', id }, undefined, { name });
    });
    return { body: { status: 'ok' } };
  });
  add('DELETE', '/branches/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'branches.manage'), id = uuid(rc.params.id, 'id');
    await guardedDelete('this branch', () => withTenant(runtime, a.ctx, async (c) => {
      const left = (await c.query('SELECT count(*)::int n FROM branches')).rows[0].n;
      if (left <= 1) throw new HttpError(409, 'LAST_BRANCH', 'a shop needs at least one branch');
      const r = await c.query('DELETE FROM branches WHERE id=$1', [id]);
      if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'branch not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'branch.deleted', { type: 'branch', id });
    }));
    return { body: { status: 'deleted' } };
  });

  // ───────────── team: edit, deactivate, reset password ─────────────
  add('PATCH', '/users/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage'), id = uuid(rc.params.id, 'id'), b = rc.body;
    const name = optStr(b.name, 'name', 100), roleName = optStr(b.roleName, 'roleName', 50), active = optBool(b.active, 'active');
    const branchIds = b.branchIds == null ? undefined : (Array.isArray(b.branchIds) ? b.branchIds.map((x: unknown) => uuid(x, 'branchIds[]')) : bad('branchIds must be an array') as never);
    if ([name, roleName, active, branchIds].every((v) => v === undefined)) throw bad('nothing to update');
    const self = id === a.ctx.userId, isOwnerActor = a.roleName === 'owner';
    await withTenant(runtime, a.ctx, async (c) => {
      const m = (await c.query(`SELECT m.active, m.branch_ids, r.name AS role_name FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id WHERE m.user_id=$1 FOR UPDATE OF m`, [id])).rows[0];
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'user not found');
      // A branch-scoped manager cannot alter global-scope or other-branch staff accounts.
      if (a.branchIds.length && (!m.branch_ids.length || m.branch_ids.some((bid: string) => !a.branchIds.includes(bid)))) {
        throw new HttpError(403, 'FORBIDDEN', 'member is outside your branch scope');
      }
      if (self && (roleName !== undefined || active === false)) throw new HttpError(409, 'SELF_LOCKOUT', 'you cannot change your own role or deactivate yourself');
      if ((m.role_name === 'owner' || roleName === 'owner') && !isOwnerActor) throw new HttpError(403, 'FORBIDDEN', 'only an owner can change or assign the owner role');
      // defence in depth: unreachable today (only owners may change owners, and nobody may change themselves) but kept in case those rules are relaxed
      if (m.role_name === 'owner' && (active === false || (roleName !== undefined && roleName !== 'owner'))) {
        const others = (await c.query(`SELECT count(*)::int n FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id WHERE r.name='owner' AND m.active AND m.user_id<>$1`, [id])).rows[0].n;
        if (others === 0) throw new HttpError(409, 'LAST_OWNER', 'the shop must keep at least one active owner');
      }
      let roleId: string | null = null;
      if (roleName !== undefined) {
        const r = (await c.query('SELECT id FROM roles WHERE name=$1', [roleName])).rows[0];
        if (!r) throw bad('unknown role');
        roleId = r.id;
        if (!isOwnerActor) {                                       // no privilege escalation through role assignment
          const perms = (await c.query('SELECT permission FROM role_permissions WHERE role_id=$1', [roleId])).rows.map((x) => x.permission);
          if (perms.some((p) => !a.permissions.includes(p))) throw new HttpError(403, 'FORBIDDEN', 'you cannot assign a role with permissions you do not have');
        }
      }
      if (branchIds !== undefined) {
        // Branch access is an authorization boundary, not a profile preference. Empty = ALL branches.
        if (self) throw new HttpError(403, 'FORBIDDEN', 'you cannot change your own branch scope');
        if (new Set(branchIds).size !== branchIds.length) throw bad('duplicate branch');
        if (a.branchIds.length && (!branchIds.length || branchIds.some((bid: string) => !a.branchIds.includes(bid)))) {
          throw new HttpError(403, 'FORBIDDEN', 'cannot grant branch access outside your own scope');
        }
        if (branchIds.length) {
          const ok = (await c.query('SELECT count(*)::int n FROM branches WHERE id = ANY($1::uuid[])', [branchIds])).rows[0].n;
          if (ok !== branchIds.length) throw bad('unknown branch');
        }
      }
      await c.query('UPDATE memberships SET role_id=COALESCE($2,role_id), branch_ids=COALESCE($3,branch_ids), active=COALESCE($4,active) WHERE user_id=$1',
        [id, roleId, branchIds ?? null, active ?? null]);
      if (name !== undefined) await c.query('SELECT auth_set_user_name($1,$2)', [id, name]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'user.updated', { type: 'user', id }, { role: m.role_name, active: m.active }, { roleName, active, branchIds, name });
    });
    return { body: { status: 'ok' } };
  });

  add('POST', '/users/:id/password', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage'), id = uuid(rc.params.id, 'id');
    // Password is global to a user, not tenant-scoped. Delegated HR cannot take over more-privileged accounts.
    if (a.roleName !== 'owner' || id === a.ctx.userId) {
      throw new HttpError(403, 'FORBIDDEN', 'only an owner may reset another member password');
    }
    const pwErr = checkPasswordPolicy(rc.body.password);
    if (pwErr) throw bad(pwErr);
    const hash = await hashPassword(rc.body.password);
    await withTenant(runtime, a.ctx, async (c) => {
      const t = (await c.query(`SELECT r.name AS role_name FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id WHERE m.user_id=$1`, [id])).rows[0];
      if (!t) throw new HttpError(404, 'NOT_FOUND', 'user not found');
      if (!(await c.query('SELECT auth_admin_set_password($1,$2) AS ok', [id, hash])).rows[0].ok) throw new HttpError(404, 'NOT_FOUND', 'user not found');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'user.password_reset', { type: 'user', id });     // never records the password
    });
    return { body: { status: 'ok' } };
  });

  // ───────────── roles & permissions ─────────────
  add('GET', '/permissions', 'session', async (rc) => {
    await authorize(rc, 'users.manage');
    return { body: { groups: PERMISSION_GROUPS } };
  });
  add('GET', '/roles', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage');
    const rows = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT r.id, r.name,
              COALESCE((SELECT array_agg(rp.permission ORDER BY rp.permission) FROM role_permissions rp WHERE rp.role_id=r.id), '{}') AS permissions,
              (SELECT count(*)::int FROM memberships m WHERE m.role_id=r.id AND m.active) AS members
         FROM roles r ORDER BY r.name`))).rows;
    return { body: { roles: rows.map((r) => ({ ...r, system: SYSTEM_ROLES.includes(r.name) })) } };
  });
  const checkPerms = (a: { permissions: string[]; roleName: string }, v: unknown) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > ALL_PERMISSIONS.length) throw bad('permissions must be a non-empty list');
    const perms = [...new Set(v.map((p) => str(p, 'permission', 60)))];
    const unknown = perms.filter((p) => !isPermission(p));
    if (unknown.length) throw bad(`unknown permission: ${unknown[0]}`);
    if (a.roleName !== 'owner' && perms.some((p) => !a.permissions.includes(p))) throw new HttpError(403, 'FORBIDDEN', 'you cannot grant permissions you do not have');
    return perms;
  };
  add('POST', '/roles', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage');
    if (a.roleName !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'only an owner may manage role definitions');
    const name = str(rc.body.name, 'name', 30).toLowerCase();
    if (!ROLE_NAME.test(name)) throw bad('role name: lowercase letters, digits, underscore (2-30 chars)');
    const perms = checkPerms(a, rc.body.permissions);
    const id = await withTenant(runtime, a.ctx, async (c) => {
      const id = (await c.query('INSERT INTO roles (tenant_id, name) VALUES ($1,$2) RETURNING id', [a.ctx.tenantId, name])).rows[0].id;
      for (const p of perms) await c.query('INSERT INTO role_permissions (tenant_id, role_id, permission) VALUES ($1,$2,$3)', [a.ctx.tenantId, id, p]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'role.created', { type: 'role', id }, undefined, { name, permissions: perms });
      return id;
    });
    return { status: 201, body: { id } };
  });
  add('PATCH', '/roles/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage'), id = uuid(rc.params.id, 'id');
    if (a.roleName !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'only an owner may manage role definitions');
    const perms = rc.body.permissions === undefined ? undefined : checkPerms(a, rc.body.permissions);
    const newName = rc.body.name === undefined ? undefined : str(rc.body.name, 'name', 30).toLowerCase();
    if (perms === undefined && newName === undefined) throw bad('nothing to update');
    await withTenant(runtime, a.ctx, async (c) => {
      const r = (await c.query('SELECT name FROM roles WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'role not found');
      if (r.name === 'owner') throw new HttpError(409, 'SYSTEM_ROLE', 'the owner role cannot be changed');
      if (newName !== undefined && newName !== r.name) {
        if (SYSTEM_ROLES.includes(r.name)) throw new HttpError(409, 'SYSTEM_ROLE', 'system roles cannot be renamed');
        if (!ROLE_NAME.test(newName)) throw bad('role name: lowercase letters, digits, underscore (2-30 chars)');
        await c.query('UPDATE roles SET name=$2 WHERE id=$1', [id, newName]);
      }
      if (perms) {
        await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
        for (const p of perms) await c.query('INSERT INTO role_permissions (tenant_id, role_id, permission) VALUES ($1,$2,$3)', [a.ctx.tenantId, id, p]);
      }
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'role.updated', { type: 'role', id }, { name: r.name }, { name: newName, permissions: perms });
    });
    return { body: { status: 'ok' } };
  });
  add('DELETE', '/roles/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'users.manage'), id = uuid(rc.params.id, 'id');
    if (a.roleName !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'only an owner may manage role definitions');
    await guardedDelete('this role (it is assigned to team members)', () => withTenant(runtime, a.ctx, async (c) => {
      const r = (await c.query('SELECT name FROM roles WHERE id=$1', [id])).rows[0];
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'role not found');
      if (SYSTEM_ROLES.includes(r.name)) throw new HttpError(409, 'SYSTEM_ROLE', 'system roles cannot be deleted');
      await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
      await c.query('DELETE FROM roles WHERE id=$1', [id]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'role.deleted', { type: 'role', id }, { name: r.name });
    }));
    return { body: { status: 'deleted' } };
  });

  // ───────────── shop identity (printed on invoices) ─────────────
  add('PATCH', '/tenant', 'session', async (rc) => {
    const a = await authorize(rc, 'settings.manage'), rawCompany = rc.body.company;
    if (rawCompany != null && (typeof rawCompany !== 'object' || Array.isArray(rawCompany))) throw bad('company must be an object');
    const limits: Record<string, number> = { legalName: 200, address: 300, phone: 40, ice: 30, if: 30, rc: 30, footer: 300 };
    const company: Record<string, string> = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (rawCompany != null && Object.prototype.hasOwnProperty.call(rawCompany, key)) {
        company[key] = optText(rawCompany[key], key, limit);
      }
    }
    const name = optStr(rc.body.name, 'name', 100);
    if (name === undefined && Object.keys(company).length === 0) throw bad('nothing to update');
    await withTenant(runtime, a.ctx, async (c) => {
      await c.query('SELECT tenant_update_settings($1,$2::jsonb)', [name ?? null, JSON.stringify(company)]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'settings.updated', { type: 'tenant', id: a.ctx.tenantId });
    });
    return { body: { status: 'ok' } };
  });

  // ───────────── invoice detail (printable) & journal ─────────────
  add('GET', '/invoices/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.view'), id = uuid(rc.params.id, 'id');
    const out = await withTenant(runtime, a.ctx, async (c) => {
      const inv = (await c.query(
        `SELECT i.id, i.invoice_no, i.total, i.status, i.created_at, i.order_id, i.display_snapshot, o.discount_pct,
                COALESCE(i.display_snapshot->>'branchName', b.name) AS branch_name,
                COALESCE(i.display_snapshot->>'customerName', cu.name) AS customer_name,
                COALESCE(i.display_snapshot->>'customerPhone', cu.phone) AS customer_phone
           FROM invoices i JOIN sales_orders o ON o.tenant_id=i.tenant_id AND o.id=i.order_id
           JOIN branches b ON b.tenant_id=o.tenant_id AND b.id=o.branch_id LEFT JOIN customers cu ON cu.tenant_id=o.tenant_id AND cu.id=o.customer_id
          WHERE i.id=$1`, [id])).rows[0];
      if (!inv) throw new HttpError(404, 'NOT_FOUND', 'invoice not found');
      const lines = (await c.query(
        `SELECT l.line_no, l.item_sku_at_sale AS sku, l.item_name_at_sale AS name,
                COALESCE(l.actual_qty, l.ordered_qty) AS qty, l.base_uom_at_sale AS base_uom, l.unit_price, l.line_total
           FROM sales_order_lines l WHERE l.order_id=$1 AND l.state<>'void' ORDER BY l.line_no`, [inv.order_id])).rows;
      const pays = (await c.query(
        `SELECT p.method, pa.amount, p.created_at FROM payment_allocations pa JOIN payments p ON p.tenant_id=pa.tenant_id AND p.id=pa.payment_id WHERE pa.invoice_id=$1 ORDER BY p.created_at`, [id])).rows;
      const { display_snapshot: snapshot, ...invoice } = inv;
      const t = (await c.query('SELECT name, settings FROM tenants WHERE id=$1', [a.ctx.tenantId])).rows[0];
      return { invoice, lines, payments: pays, shop: snapshot?.shop ?? { name: t.name, company: t.settings?.company ?? {} } };
    });
    return { body: out };
  });

  add('GET', '/audit', 'session', async (rc) => {
    const a = await authorize(rc, 'audit.view');
    const limit = Math.min(200, Math.max(1, Number(rc.query.get('limit') ?? 100) || 100));
    const refId = rc.query.get('refId') ? uuid(rc.query.get('refId'), 'refId') : null;   // the history of one record (a vehicle, an item...)
    // before/after hold business values only (names, prices, plates, owners): passwords and tokens are never written to the journal
    const rows = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT l.at, l.action, l.ref_type, l.ref_id, u.name AS actor_name, l.before, l.after, l.meta FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id
        WHERE ($2::uuid IS NULL OR l.ref_id=$2) ORDER BY l.at DESC LIMIT $1`, [limit, refId]))).rows;
    return { body: { entries: rows } };
  });
  void num; void optUuid;
}
