import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PW, Shop, createShop, key, platformAdmin, staff, startApp, uniq } from './api-helpers.js';

let api: Api, admin: { token: string };
beforeAll(async () => { api = await startApp(); admin = await platformAdmin(api); });
afterAll(async () => { await api.close(); });

const j = (token: string) => ({ token });
const item = (s: Shop, sku: string, extra: object = {}) => api.call('POST', '/items', { token: s.ownerToken, body: { sku, name: sku, kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 10, ...extra } }).then((r) => r.json.id as string);
const receive = (s: Shop, itemId: string, qty = 5) => api.call('POST', '/stock/receive', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, itemId, qty, unitCost: 4 } });
const users = async (s: Shop) => (await api.call('GET', '/users', j(s.ownerToken))).json.users as any[];

describe('edit / archive / delete (never erase history)', () => {
  it('AD1: items can be edited and archived; items with history cannot be deleted; unused ones can; other shops are untouchable', async () => {
    const A = await createShop(api, admin), B = await createShop(api, admin);
    const used = await item(A, 'USED'), unused = await item(A, 'UNUSED'), foreign = await item(B, 'FOREIGN');
    await receive(A, used);
    const cashier = await staff(api, A, 'cashier');
    expect((await api.call('PATCH', `/items/${used}`, { ...j(cashier.token), body: { price: 99 } })).status).toBe(403);
    expect((await api.call('PATCH', `/items/${used}`, { ...j(A.ownerToken), body: {} })).status).toBe(400);
    expect((await api.call('PATCH', `/items/${used}`, { ...j(A.ownerToken), body: { price: -1 } })).status).toBe(400);
    expect((await api.call('PATCH', `/items/${used}`, { ...j(A.ownerToken), body: { name: 'Renamed', price: 12.5 } })).status).toBe(200);
    const got = (await api.call('GET', '/items', j(A.ownerToken))).json.items.find((i: any) => i.id === used);
    expect(got).toMatchObject({ name: 'Renamed', price: '12.5000' });
    expect((await api.call('PATCH', `/items/${used}`, { ...j(A.ownerToken), body: { active: false } })).status).toBe(200);          // archive
    expect((await api.call('GET', '/items', j(A.ownerToken))).json.items.find((i: any) => i.id === used).active).toBe(false);
    const del = await api.call('DELETE', `/items/${used}`, j(A.ownerToken));
    expect(del.status).toBe(409); expect(del.json.error.code).toBe('IN_USE'); expect(JSON.stringify(del.json)).not.toMatch(/violates|constraint/i);
    expect((await api.call('DELETE', `/items/${unused}`, j(A.ownerToken))).status).toBe(200);
    expect((await api.call('DELETE', `/items/${unused}`, j(A.ownerToken))).status).toBe(404);
    // cross-shop: another shop's item id behaves as if it does not exist, and is not modified
    expect((await api.call('PATCH', `/items/${foreign}`, { ...j(A.ownerToken), body: { price: 1 } })).status).toBe(404);
    expect((await api.call('DELETE', `/items/${foreign}`, j(A.ownerToken))).status).toBe(404);
    expect((await api.call('GET', '/items', j(B.ownerToken))).json.items.find((i: any) => i.id === foreign).price).toBe('10.0000');
    const audit = (await api.call('GET', '/audit', j(A.ownerToken))).json.entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['item.updated', 'item.deleted']));
  });

  it('AD2: customers and branches: edit, archive, protected delete, last-branch rule', async () => {
    const A = await createShop(api, admin, 'pro', 'Shop', ['grocery']);
    const c1 = (await api.call('POST', '/customers', { ...j(A.ownerToken), body: { name: 'Used', creditLimit: 500 } })).json.id;
    const c2 = (await api.call('POST', '/customers', { ...j(A.ownerToken), body: { name: 'Unused' } })).json.id;
    const it = (await api.call('GET', '/items', j(A.ownerToken))).json.items.find((i: any) => i.sku === 'EPI-SUCRE').id;
    await receive(A, it, 20);
    expect((await api.call('POST', '/sales/quick', { ...j(A.ownerToken), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, customerId: c1, lines: [{ itemId: it, qty: 2 }], payments: [] } })).status).toBe(201);
    expect((await api.call('PATCH', `/customers/${c1}`, { ...j(A.ownerToken), body: { phone: '0600000000', address: 'Rue 1', creditLimit: 800, active: false } })).status).toBe(200);
    const list = (await api.call('GET', '/customers', j(A.ownerToken))).json.customers;
    expect(list.find((c: any) => c.id === c1)).toMatchObject({ phone: '0600000000', active: false, credit_limit: '800.00' });
    expect((await api.call('DELETE', `/customers/${c1}`, j(A.ownerToken))).json.error.code).toBe('IN_USE');
    expect((await api.call('DELETE', `/customers/${c2}`, j(A.ownerToken))).status).toBe(200);

    const b2 = (await api.call('POST', '/branches', { ...j(A.ownerToken), body: { name: 'Second' } })).json.id;
    expect((await api.call('PATCH', `/branches/${b2}`, { ...j(A.ownerToken), body: { name: 'Renamed branch' } })).status).toBe(200);
    expect((await api.call('GET', '/branches', j(A.ownerToken))).json.branches.map((b: any) => b.name)).toContain('Renamed branch');
    expect((await api.call('DELETE', `/branches/${A.branchId}`, j(A.ownerToken))).json.error.code).toBe('IN_USE');      // has stock/sales history
    expect((await api.call('DELETE', `/branches/${b2}`, j(A.ownerToken))).status).toBe(200);
    const last = await api.call('DELETE', `/branches/${A.branchId}`, j(A.ownerToken));
    expect(last.status).toBe(409);                                                                                      // last branch is protected (by rule or by history)
  });
});

describe('team management', () => {
  it('AD3: edit role/branches/name, deactivate (instant effect), reset password (sessions revoked), and the safety rails', async () => {
    const A = await createShop(api, admin);
    const worker = await staff(api, A, 'cashier');
    const b2 = (await api.call('POST', '/branches', { ...j(A.ownerToken), body: { name: 'Second' } })).json.id;
    const ownerId = (await users(A)).find((u) => u.role === 'owner').id;
    const newItem = { sku: 'N1', name: 'N', kind: 'goods', trackQuantity: false, fulfillment: 'none' };

    expect((await api.call('POST', '/items', { ...j(worker.token), body: newItem })).status).toBe(403);                  // cashier cannot
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(A.ownerToken), body: { roleName: 'manager', name: 'Renamed Worker', branchIds: [b2] } })).status).toBe(200);
    expect((await api.call('POST', '/items', { ...j(worker.token), body: newItem })).status).toBe(201);                  // role change is live immediately
    expect((await users(A)).find((u) => u.id === worker.userId)).toMatchObject({ name: 'Renamed Worker', role: 'manager', branch_ids: [b2] });
    expect((await api.call('GET', `/stock?branchId=${A.branchId}`, j(worker.token))).status).toBe(403);                  // branch scope applies

    // safety rails
    expect((await api.call('PATCH', `/users/${ownerId}`, { ...j(A.ownerToken), body: { active: false } })).json.error.code).toBe('SELF_LOCKOUT');
    expect((await api.call('PATCH', `/users/${ownerId}`, { ...j(A.ownerToken), body: { roleName: 'cashier' } })).json.error.code).toBe('SELF_LOCKOUT');
    expect((await api.call('PATCH', `/users/${key()}`, { ...j(A.ownerToken), body: { active: false } })).status).toBe(404);
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(A.ownerToken), body: { roleName: 'ghost' } })).status).toBe(400);

    // reset password: old sessions die, old password dies, new one works
    expect((await api.call('POST', `/users/${worker.userId}/password`, { ...j(A.ownerToken), body: { password: 'short' } })).status).toBe(400);
    expect((await api.call('POST', `/users/${worker.userId}/password`, { ...j(A.ownerToken), body: { password: 'Brand-New-Passw0rd' } })).status).toBe(200);
    expect((await api.call('GET', '/me', j(worker.token))).status).toBe(401);
    expect((await api.call('POST', '/auth/login', { body: { email: worker.email, password: PW } })).status).toBe(401);
    const relog = await api.call('POST', '/auth/login', { body: { email: worker.email, password: 'Brand-New-Passw0rd' } });
    expect(relog.status).toBe(200);

    // deactivate: effective on the very next request, and the user can no longer enter the shop
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(A.ownerToken), body: { active: false } })).status).toBe(200);
    expect((await api.call('GET', '/items', j(relog.json.token))).status).toBeGreaterThanOrEqual(400);
    const again = await api.call('POST', '/auth/login', { body: { email: worker.email, password: 'Brand-New-Passw0rd' } });
    expect(again.json.activeTenantId).toBeNull();
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(A.ownerToken), body: { active: true } })).status).toBe(200);
    expect((await api.call('GET', '/audit', j(A.ownerToken))).json.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['user.updated', 'user.password_reset']));
    expect(JSON.stringify((await api.call('GET', '/audit', j(A.ownerToken))).json)).not.toContain('Brand-New-Passw0rd');   // passwords never reach the journal
  });

  it('AD4: only owners can change owners, nobody can lock themselves out, a delegate cannot escalate, other shops are untouchable', async () => {
    const A = await createShop(api, admin), B = await createShop(api, admin);
    // delegate role: may manage users but holds few permissions
    const role = await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'hr', permissions: ['users.manage', 'stock.view'] } });
    expect(role.status).toBe(201);
    const hr = await staff(api, A, 'hr');
    const ownerId = (await users(A)).find((u) => u.role === 'owner').id;
    const cashier = await staff(api, A, 'cashier');
    expect((await api.call('PATCH', `/users/${cashier.userId}`, { ...j(hr.token), body: { roleName: 'manager' } })).status).toBe(403);   // manager has permissions hr lacks
    expect((await api.call('PATCH', `/users/${cashier.userId}`, { ...j(hr.token), body: { roleName: 'owner' } })).status).toBe(403);
    expect((await api.call('PATCH', `/users/${ownerId}`, { ...j(hr.token), body: { active: false } })).status).toBe(403);
    expect((await api.call('POST', `/users/${ownerId}/password`, { ...j(hr.token), body: { password: 'Hostile-Takeover-1' } })).status).toBe(403);
    expect((await api.call('POST', '/roles', { ...j(hr.token), body: { name: 'sneaky', permissions: ['users.manage', 'settings.manage'] } })).status).toBe(403);   // cannot grant what it lacks
    expect((await api.call('POST', `/users/${cashier.userId}/password`, { ...j(hr.token), body: { password: 'Delegated-Reset-1' } })).status).toBe(403);          // reset requires shop owner, not delegated HR
    expect((await api.call('POST', '/users', { ...j(hr.token), body: { email: `owner.${uniq('attack')}@test.local`, name: 'Fake owner', password: PW, roleName: 'owner', branchIds: [] } })).status).toBe(403);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: { email: `manager.${uniq('attack')}@test.local`, name: 'Fake manager', password: PW, roleName: 'manager', branchIds: [] } })).status).toBe(403);
    expect((await api.call('PATCH', `/users/${cashier.userId}`, { ...j(hr.token), body: { branchIds: [A.branchId] } })).status).toBe(200);
    expect((await api.call('POST', '/roles', { ...j(hr.token), body: { name: 'junior', permissions: ['stock.view'] } })).status).toBe(403);
    // owner promotes a second owner, then the first can be demoted, but never the last
    const second = await staff(api, A, 'cashier');
    expect((await api.call('PATCH', `/users/${second.userId}`, { ...j(A.ownerToken), body: { roleName: 'owner' } })).status).toBe(200);
    expect((await api.call('PATCH', `/users/${ownerId}`, { ...j(second.token), body: { roleName: 'manager' } })).status).toBe(200);
    expect((await api.call('PATCH', `/users/${second.userId}`, { ...j(second.token), body: { roleName: 'manager' } })).json.error.code).toBe('SELF_LOCKOUT');
    // cross-shop
    const bUser = (await users(B)).find((u) => u.role === 'owner').id;
    expect((await api.call('PATCH', `/users/${bUser}`, { ...j(second.token), body: { active: false } })).status).toBe(404);
    expect((await api.call('POST', `/users/${bUser}/password`, { ...j(second.token), body: { password: 'Cross-Shop-Attack-1' } })).status).toBe(404);
    expect((await api.call('POST', '/auth/login', { body: { email: `owner.${B.slug}@test.local`, password: 'Cross-Shop-Attack-1' } })).status).toBe(401);
  });

  it('AD5: roles — catalogue, custom roles, live permission changes, protected system roles, in-use deletion', async () => {
    const A = await createShop(api, admin), B = await createShop(api, admin);
    const perms = (await api.call('GET', '/permissions', j(A.ownerToken))).json.groups.flatMap((g: any) => g.permissions);
    expect(perms).toEqual(expect.arrayContaining(['sale.create', 'users.manage', 'settings.manage']));
    const roles = (await api.call('GET', '/roles', j(A.ownerToken))).json.roles;
    expect(roles.find((r: any) => r.name === 'owner')).toMatchObject({ system: true, members: 1 });
    expect(roles.find((r: any) => r.name === 'cashier').permissions).toContain('sale.create');

    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'Bad Name', permissions: ['stock.view'] } })).status).toBe(400);
    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'ghosty', permissions: ['stock.view', 'rocket.launch'] } })).status).toBe(400);
    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'empty', permissions: [] } })).status).toBe(400);
    const made = await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'stockist', permissions: ['catalog.view', 'stock.view', 'stock.receive'] } });
    expect(made.status).toBe(201);
    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'stockist', permissions: ['stock.view'] } })).status).toBe(409);
    const u = await staff(api, A, 'stockist');
    const it = await item(A, 'S1');
    expect((await api.call('POST', '/stock/receive', { ...j(u.token), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, itemId: it, qty: 1, unitCost: 1 } })).status).toBe(201);
    expect((await api.call('POST', '/sales/quick', { ...j(u.token), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, lines: [{ itemId: it, qty: 1 }], payments: [{ method: 'cash', amount: 10 }] } })).status).toBe(403);
    // edit permissions: takes effect on the next request
    expect((await api.call('PATCH', `/roles/${made.json.id}`, { ...j(A.ownerToken), body: { permissions: ['catalog.view', 'stock.view', 'sale.create'] } })).status).toBe(200);
    expect((await api.call('POST', '/stock/receive', { ...j(u.token), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, itemId: it, qty: 1, unitCost: 1 } })).status).toBe(403);
    expect((await api.call('POST', '/sales/quick', { ...j(u.token), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, lines: [{ itemId: it, qty: 1 }], payments: [{ method: 'cash', amount: 10 }] } })).status).toBe(201);
    // in use -> cannot delete; unused -> can; system roles protected
    expect((await api.call('DELETE', `/roles/${made.json.id}`, j(A.ownerToken))).json.error.code).toBe('IN_USE');
    const ownerRole = roles.find((r: any) => r.name === 'owner').id, cashierRole = roles.find((r: any) => r.name === 'cashier').id;
    expect((await api.call('PATCH', `/roles/${ownerRole}`, { ...j(A.ownerToken), body: { permissions: ['stock.view'] } })).json.error.code).toBe('SYSTEM_ROLE');
    expect((await api.call('PATCH', `/roles/${cashierRole}`, { ...j(A.ownerToken), body: { name: 'renamed' } })).json.error.code).toBe('SYSTEM_ROLE');
    expect((await api.call('DELETE', `/roles/${cashierRole}`, j(A.ownerToken))).json.error.code).toBe('SYSTEM_ROLE');
    const tmp = await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'temp_role', permissions: ['stock.view'] } });
    expect((await api.call('DELETE', `/roles/${tmp.json.id}`, j(A.ownerToken))).status).toBe(200);
    // cross-shop role ids and non-admins
    const bRole = (await api.call('GET', '/roles', j(B.ownerToken))).json.roles[0].id;
    expect((await api.call('PATCH', `/roles/${bRole}`, { ...j(A.ownerToken), body: { permissions: ['stock.view'] } })).status).toBe(404);
    expect((await api.call('GET', '/roles', j(u.token))).status).toBe(403);
  });
  it('AD8: scoped HR cannot expand its own or a subordinate branch access or create unrestricted users', async () => {
    const A = await createShop(api, admin);
    const b2 = (await api.call('POST', '/branches', { ...j(A.ownerToken), body: { name: 'Other branch' } })).json.id;
    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'scoped_hr', permissions: ['users.manage', 'stock.view'] } })).status).toBe(201);
    expect((await api.call('POST', '/roles', { ...j(A.ownerToken), body: { name: 'junior', permissions: ['stock.view'] } })).status).toBe(201);
    const hr = await staff(api, A, 'scoped_hr', [A.branchId]);
    const worker = await staff(api, A, 'junior', [A.branchId]);
    const payload = (branchIds: string[]) => ({ name: 'Junior', email: `junior.${uniq('x')}@test.local`, password: PW, roleName: 'junior', branchIds });
    expect((await api.call('PATCH', `/users/${hr.userId}`, { ...j(hr.token), body: { branchIds: [] } })).status).toBe(403);
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(hr.token), body: { branchIds: [] } })).status).toBe(403);
    expect((await api.call('PATCH', `/users/${worker.userId}`, { ...j(hr.token), body: { branchIds: [b2] } })).status).toBe(403);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: payload([]) })).status).toBe(403);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: payload([b2]) })).status).toBe(403);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: payload([A.branchId]) })).status).toBe(201);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: payload([A.branchId, A.branchId]) })).status).toBe(400);
    expect((await api.call('POST', '/users', { ...j(hr.token), body: { ...payload([A.branchId]), branchIds: 'not-array' } })).status).toBe(400);
    const allScoped = (await users(A)).filter((x: any) => x.role === 'junior');
    expect(allScoped.every((x: any) => x.branch_ids.includes(A.branchId) && !x.branch_ids.includes(b2))).toBe(true);
  });

  it('AD9: owner in one shop cannot take over a platform-admin or multi-tenant global login', async () => {
    const master = await platformAdmin(api);
    const ten = await api.call('POST', '/platform/tenants', { ...j(master.token),
      body: { name: 'Shared account security', slug: uniq('shared').toLowerCase(), plan: 'pro', owner: { self: true } } });
    expect(ten.status).toBe(201);
    expect((await api.call('POST', '/auth/switch-tenant', { ...j(master.token), body: { tenantId: ten.json.tenantId } })).status).toBe(200);
    const otherOwnerEmail = `owner.${uniq('delegate')}@test.local`;
    const created = await api.call('POST', '/users', { ...j(master.token),
      body: { email: otherOwnerEmail, name: 'Other Owner', password: PW, roleName: 'owner', branchIds: [] } });
    expect(created.status).toBe(201);
    const otherLogin = await api.call('POST', '/auth/login', { body: { email: otherOwnerEmail, password: PW } });
    expect(otherLogin.status).toBe(200);
    const blocked = await api.call('POST', `/users/${master.id}/password`, { ...j(otherLogin.json.token), body: { password: 'Hostile-Takeover-1' } });
    expect(blocked.status).toBe(403);
    expect((await api.call('PATCH', `/users/${master.id}`, { ...j(otherLogin.json.token), body: { name: 'Global Name Hijack' } })).status).toBe(403);
    expect((await api.call('POST', '/auth/login', { body: { email: master.email, password: PW } })).status).toBe(200);
  });
});

describe('shop identity, printable invoice, journal', () => {
  it('AD6: company details are saved per shop and appear on the invoice detail; invoices of other shops are invisible', async () => {
    const A = await createShop(api, admin, 'pro', 'Shop Name', ['grocery']), B = await createShop(api, admin, 'pro', 'Other', ['grocery']);
    const manager = await staff(api, A, 'manager'), cashier = await staff(api, A, 'cashier');
    expect((await api.call('PATCH', '/tenant', { ...j(manager.token), body: { company: { legalName: 'X' } } })).status).toBe(403);
    expect((await api.call('PATCH', '/tenant', { ...j(A.ownerToken), body: { name: 'Renamed Shop', company: { legalName: 'SARL Demo', address: '1 Rue Test', phone: '0500000000', ice: '001234567000089', if: '12345', rc: '999', footer: 'Merci !' } } })).status).toBe(200);
    expect((await api.call('PATCH', '/tenant', { ...j(A.ownerToken), body: { name: 'Renamed Shop', company: { legalName: 'SARL Demo', address: '', phone: '', ice: '001234567000089', if: '', rc: '', footer: 'Merci !' } } })).status).toBe(200);   // empty optional fields are fine
    // PATCH of just one company field must not erase other legal or invoice data.
    expect((await api.call('PATCH', '/tenant', { ...j(A.ownerToken), body: { company: { footer: 'Only footer updated' } } })).status).toBe(200);
    const afterPatch = (await api.call('GET', '/tenant', j(A.ownerToken))).json;
    expect(afterPatch.company).toMatchObject({ legalName: 'SARL Demo', ice: '001234567000089', address: '', footer: 'Only footer updated' });
    expect((await api.call('PATCH', '/tenant', { ...j(A.ownerToken), body: { company: { legalName: 'x'.repeat(201) } } })).status).toBe(400);
    const t = (await api.call('GET', '/tenant', j(cashier.token))).json;
    expect(t.name).toBe('Renamed Shop'); expect(t.company).toMatchObject({ legalName: 'SARL Demo', ice: '001234567000089', footer: 'Only footer updated' });
    const sugar = (await api.call('GET', '/items', j(A.ownerToken))).json.items.find((i: any) => i.sku === 'EPI-SUCRE').id;
    await receive(A, sugar, 10);
    const customerId = (await api.call('POST', '/customers', { ...j(A.ownerToken), body: { name: 'Original Customer', phone: '0500000001' } })).json.id;
    const sale = await api.call('POST', '/sales/quick', { ...j(cashier.token), headers: { 'idempotency-key': key() }, body: { branchId: A.branchId, customerId, lines: [{ itemId: sugar, qty: 1.5 }], payments: [{ method: 'cash', amount: 10.5 }] } });
    expect(sale.status).toBe(201);
    const inv = (await api.call('GET', '/invoices', j(cashier.token))).json.invoices[0];
    const d = await api.call('GET', `/invoices/${inv.id}`, j(cashier.token));
    expect(d.status).toBe(200);
    expect(d.json.shop).toMatchObject({ name: 'Renamed Shop', company: { ice: '001234567000089' } });
    expect(d.json.lines).toHaveLength(1); expect(d.json.lines[0]).toMatchObject({ sku: 'EPI-SUCRE', qty: '1.5000', unit_price: '7.0000', line_total: '10.50' });
    expect(d.json.payments).toEqual([expect.objectContaining({ method: 'cash', amount: '10.50' })]);
    expect(d.json.invoice).toMatchObject({ invoice_no: expect.stringMatching(/^A-/), total: '10.50', branch_name: 'Main', customer_name: 'Original Customer' });
    // Commercial identity is immutable after issuance even when seller, catalog, customer and branch are edited.
    expect((await api.call('PATCH', `/items/${sugar}`, { ...j(A.ownerToken), body: { name: 'New Catalog Name', price: 123 } })).status).toBe(200);
    expect((await api.call('PATCH', `/customers/${customerId}`, { ...j(A.ownerToken), body: { name: 'Updated Customer' } })).status).toBe(200);
    expect((await api.call('PATCH', `/branches/${A.branchId}`, { ...j(A.ownerToken), body: { name: 'Renamed Location' } })).status).toBe(200);
    expect((await api.call('PATCH', '/tenant', { ...j(A.ownerToken), body: { name: 'New Branding', company: { legalName: 'Updated Legal Name' } } })).status).toBe(200);
    const originalAgain = await api.call('GET', `/invoices/${inv.id}`, j(cashier.token));
    expect(originalAgain.status).toBe(200);
    expect(originalAgain.json.lines[0]).toMatchObject({ name: 'Sucre 1kg', sku: 'EPI-SUCRE', unit_price: '7.0000' });
    expect(originalAgain.json.invoice).toMatchObject({ branch_name: 'Main', customer_name: 'Original Customer', total: '10.50' });
    expect(originalAgain.json.shop).toMatchObject({ name: 'Renamed Shop', company: { legalName: 'SARL Demo' } });
    expect((await api.call('GET', `/invoices/${inv.id}`, j(B.ownerToken))).status).toBe(404);        // another shop cannot read it
    expect((await api.call('GET', `/invoices/${key()}`, j(A.ownerToken))).status).toBe(404);
    expect((await api.call('GET', '/invoices/not-a-uuid', j(A.ownerToken))).status).toBe(400);
  });

  it('AD7: the journal is restricted, tenant-scoped, ordered and carries the actor', async () => {
    const A = await createShop(api, admin), B = await createShop(api, admin);
    await item(A, 'J1'); await item(B, 'JB1');
    const cashier = await staff(api, A, 'cashier');
    expect((await api.call('GET', '/audit', j(cashier.token))).status).toBe(403);
    const entries = (await api.call('GET', '/audit?limit=5', j(A.ownerToken))).json.entries;
    expect(entries.length).toBeGreaterThan(0); expect(entries.length).toBeLessThanOrEqual(5);
    expect(entries.every((e: any) => typeof e.actor_name === 'string' || e.actor_name === null)).toBe(true);
    expect(entries.map((e: any) => e.at)).toEqual([...entries.map((e: any) => e.at)].sort().reverse());
    expect(JSON.stringify(entries)).not.toContain('JB1');                                            // never another shop's events
    void uniq;
  });
});
