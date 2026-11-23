import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha } from '../src/auth.js';
import { owner } from './helpers.js';
import { Api, PW, Shop, createShop, key, platformAdmin, staff, startApp, uniq } from './api-helpers.js';

let api: Api, prodApi: Api, admin: { id: string; email: string; token: string };
beforeAll(async () => { api = await startApp(false); prodApi = await startApp(true); admin = await platformAdmin(api); });
afterAll(async () => { await api.close(); await prodApi.close(); });

const login = (email: string, password = PW, extra: object = {}) => api.call('POST', '/auth/login', { body: { email, password, ...extra } });

describe('authentication', () => {
  it('A1: wrong password, unknown user and locked account are indistinguishable; token is stored only as a hash', async () => {
    const shop = await createShop(api, admin);
    const wrong = await login(shop.ownerEmail, 'Wrong-Password-1');
    const unknown = await login(`nobody.${uniq('x')}@test.local`, 'Wrong-Password-1');
    expect(wrong.status).toBe(401); expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
    const ok = await login(shop.ownerEmail);
    expect(ok.status).toBe(200);
    expect(ok.json.token).toMatch(/^tj_/);
    expect(ok.json.activeTenantId).toBe(shop.tenantId);
    const plain = await owner.query('SELECT 1 FROM sessions WHERE token_hash = $1', [ok.json.token]);
    const hashed = await owner.query('SELECT 1 FROM sessions WHERE token_hash = $1', [sha(ok.json.token)]);
    expect(plain.rowCount).toBe(0); expect(hashed.rowCount).toBe(1);
    expect(JSON.stringify(ok.json)).not.toMatch(/password|scrypt/i);
  });

  it('A2: 5 failures lock the account (even for the right password) until the lock expires', async () => {
    const shop = await createShop(api, admin);
    for (let i = 0; i < 5; i++) expect((await login(shop.ownerEmail, 'Wrong-Password-1')).status).toBe(401);
    expect((await login(shop.ownerEmail)).status).toBe(401);                                // correct password, but locked
    await owner.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE lower(email)=lower($1)`, [shop.ownerEmail]);
    expect((await login(shop.ownerEmail)).status).toBe(200);
    expect((await owner.query('SELECT failed_attempts FROM users WHERE lower(email)=lower($1)', [shop.ownerEmail])).rows[0].failed_attempts).toBe(0);
  });

  it('A3: logout, expiry and disabled accounts all revoke access; garbage tokens are rejected', async () => {
    const shop = await createShop(api, admin);
    const t1 = (await login(shop.ownerEmail)).json.token;
    expect((await api.call('GET', '/me', { token: t1 })).status).toBe(200);
    await api.call('POST', '/auth/logout', { token: t1 });
    expect((await api.call('GET', '/me', { token: t1 })).status).toBe(401);

    const t2 = (await login(shop.ownerEmail)).json.token;
    await owner.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha(t2)]);
    expect((await api.call('GET', '/me', { token: t2 })).status).toBe(401);

    const t3 = (await login(shop.ownerEmail)).json.token;
    await owner.query(`UPDATE users SET disabled = true WHERE lower(email)=lower($1)`, [shop.ownerEmail]);
    expect((await api.call('GET', '/me', { token: t3 })).status).toBe(401);
    expect((await login(shop.ownerEmail)).status).toBe(401);

    for (const bad of ['', 'tj_short', 'Bearer', 'x'.repeat(60), 'tj_' + 'A'.repeat(43)]) {
      expect((await api.call('GET', '/me', { token: bad || undefined })).status).toBe(401);
    }
  });

  it('A4: changing the password revokes the other sessions, keeps the current one, enforces the policy', async () => {
    const shop = await createShop(api, admin);
    const a = (await login(shop.ownerEmail)).json.token, b = (await login(shop.ownerEmail)).json.token;
    expect((await api.call('POST', '/auth/change-password', { token: a, body: { currentPassword: 'nope-nope-nope', newPassword: 'New-Password-77' } })).status).toBe(403);
    expect((await api.call('POST', '/auth/change-password', { token: a, body: { currentPassword: PW, newPassword: 'short' } })).status).toBe(400);
    expect((await api.call('POST', '/auth/change-password', { token: a, body: { currentPassword: PW, newPassword: 'aaaaaaaaaaaa' } })).status).toBe(400);
    expect((await api.call('POST', '/auth/change-password', { token: a, body: { currentPassword: PW, newPassword: 'New-Password-77' } })).status).toBe(200);
    expect((await api.call('GET', '/me', { token: a })).status).toBe(200);
    expect((await api.call('GET', '/me', { token: b })).status).toBe(401);
    expect((await login(shop.ownerEmail)).status).toBe(401);
    expect((await login(shop.ownerEmail, 'New-Password-77')).status).toBe(200);
  });

  it('A5: password reset — single use, expires, revokes all sessions, and does not reveal whether the account exists', async () => {
    const shop = await createShop(api, admin);
    const session = (await login(shop.ownerEmail)).json.token;
    const f = await api.call('POST', '/auth/forgot', { body: { email: shop.ownerEmail } });
    expect(f.status).toBe(202);
    const token = f.json.devResetToken as string;
    expect(token).toMatch(/^tj_/);
    expect((await owner.query('SELECT 1 FROM password_resets WHERE token_hash = $1', [token])).rowCount).toBe(0);   // stored hashed

    expect((await api.call('POST', '/auth/reset', { body: { token, newPassword: 'weak' } })).status).toBe(400);
    expect((await api.call('POST', '/auth/reset', { body: { token, newPassword: 'Reset-Pass-4242' } })).status).toBe(200);
    expect((await api.call('POST', '/auth/reset', { body: { token, newPassword: 'Another-Pass-4242' } })).status).toBe(400);   // single use
    expect((await api.call('GET', '/me', { token: session })).status).toBe(401);
    expect((await login(shop.ownerEmail, 'Reset-Pass-4242')).status).toBe(200);

    const f2 = await api.call('POST', '/auth/forgot', { body: { email: shop.ownerEmail } });
    await owner.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha(f2.json.devResetToken)]);
    expect((await api.call('POST', '/auth/reset', { body: { token: f2.json.devResetToken, newPassword: 'Expired-Pass-4242' } })).status).toBe(400);

    // production mode: identical response for existing and unknown accounts, never contains a token
    const real = await prodApi.call('POST', '/auth/forgot', { body: { email: shop.ownerEmail } });
    const none = await prodApi.call('POST', '/auth/forgot', { body: { email: `ghost.${uniq('g')}@test.local` } });
    expect(real.json).toEqual({ status: 'ok' }); expect(none.json).toEqual(real.json); expect(none.status).toBe(real.status);
  });

  it('A6: login attempts are rate limited per client address', async () => {
    const ip = '203.0.113.77';
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await api.call('POST', '/auth/login', { ip, body: { email: `x${i}@test.local`, password: 'Wrong-Password-1' } })).status;
    expect(last).toBe(429);
  });
});

describe('authorization and isolation over HTTP', () => {
  it('A7: permissions are enforced by role; only platform admins create shops', async () => {
    const shop = await createShop(api, admin);
    const cashier = await staff(api, shop, 'cashier'), manager = await staff(api, shop, 'manager');
    const item = { sku: 'X1', name: 'X', kind: 'goods', trackQuantity: true, fulfillment: 'stock' };
    expect((await api.call('POST', '/items', { token: cashier.token, body: item })).status).toBe(403);
    expect((await api.call('POST', '/items', { token: manager.token, body: item })).status).toBe(201);
    expect((await api.call('GET', '/items', { token: cashier.token })).status).toBe(200);
    expect((await api.call('POST', '/users', { token: manager.token, body: { email: 'z@test.local', name: 'z', password: PW, roleName: 'cashier' } })).status).toBe(403);
    expect((await api.call('POST', '/users', { token: cashier.token, body: {} })).status).toBe(403);
    expect((await api.call('GET', '/reports/summary', { token: cashier.token })).status).toBe(403);
    expect((await api.call('GET', '/reports/summary', { token: manager.token })).status).toBe(200);
    const body = { name: 'Evil', slug: uniq('evil').toLowerCase(), plan: 'pro', owner: { email: `e.${uniq('e')}@test.local`, name: 'e', password: PW } };
    expect((await api.call('POST', '/platform/tenants', { token: shop.ownerToken, body })).status).toBe(403);
    expect((await api.call('POST', '/platform/tenants', { token: admin.token, body })).status).toBe(201);
    expect((await api.call('GET', '/items')).status).toBe(401);
  });

  it('A7b: platform admin may own pilot shop using their current account; no duplicate user or password is required', async () => {
    const slug = uniq('pilot').toLowerCase();
    const countBefore = (await owner.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [admin.id])).rows[0].n;
    const created = await api.call('POST', '/platform/tenants', { token: admin.token,
      body: { name: 'Pilot grill', slug, plan: 'pro', activities: ['butcher', 'grill', 'restaurant'], owner: { self: true } } });
    expect(created.status).toBe(201);
    expect(created.json.ownerUserId).toBe(admin.id);
    expect((await owner.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [admin.id])).rows[0].n).toBe(countBefore);
    const switched = await api.call('POST', '/auth/switch-tenant', { token: admin.token, body: { tenantId: created.json.tenantId } });
    expect(switched.status).toBe(200);
    const me = await api.call('GET', '/me', { token: admin.token });
    expect(me.json.isPlatformAdmin).toBe(true);
    expect(me.json.activeTenantId).toBe(created.json.tenantId);
    expect(me.json.permissions).toContain('sale.create');
    const items = await api.call('GET', '/items', { token: admin.token });
    expect(items.status).toBe(200);
    expect(items.json.items.map((x: any) => x.sku)).toContain('BUT-BOEUF');
    expect(items.json.items.map((x: any) => x.sku)).not.toContain('EQP-POMPE');

    const invalid = await api.call('POST', '/platform/tenants', { token: admin.token,
      body: { name: 'Bad pilot', slug: uniq('bad').toLowerCase(), plan: 'pro', owner: { self: true, password: PW } } });
    expect(invalid.status).toBe(400);
    const nonAdmin = await createShop(api, admin);
    const denied = await api.call('POST', '/platform/tenants', { token: nonAdmin.ownerToken,
      body: { name: 'Denied pilot', slug: uniq('denied').toLowerCase(), plan: 'pro', owner: { self: true } } });
    expect(denied.status).toBe(403);
  });

  it('A8: a user of shop A can never read or touch shop B (ids, tenant switching, login, stock)', async () => {
    const A = await createShop(api, admin, 'pro', 'A'), B = await createShop(api, admin, 'pro', 'B');
    const mk = async (s: Shop, sku: string) => (await api.call('POST', '/items', { token: s.ownerToken, body: { sku, name: sku, kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 10 } })).json.id as string;
    const ia = await mk(A, 'SECRET-A'), ib = await mk(B, 'SECRET-B');
    await api.call('POST', '/stock/receive', { token: B.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: B.branchId, itemId: ib, qty: 5, unitCost: 3 } });

    const itemsA = (await api.call('GET', '/items', { token: A.ownerToken })).json.items;
    expect(itemsA.map((i: any) => i.sku)).toEqual(['SECRET-A']);
    // tenant ids supplied by the client are ignored/refused
    expect((await api.call('GET', `/items?tenantId=${B.tenantId}`, { token: A.ownerToken, headers: { 'x-tenant-id': B.tenantId } })).json.items.map((i: any) => i.sku)).toEqual(['SECRET-A']);
    expect((await api.call('POST', '/auth/switch-tenant', { token: A.ownerToken, body: { tenantId: B.tenantId } })).status).toBe(403);
    expect((await login(A.ownerEmail, PW, { tenantId: B.tenantId })).status).toBe(401);
    // B's branch / item in A's requests
    expect((await api.call('GET', `/stock?branchId=${B.branchId}`, { token: A.ownerToken })).status).toBe(404);
    expect((await api.call('POST', '/stock/receive', { token: A.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: B.branchId, itemId: ia, qty: 1, unitCost: 1 } })).status).toBe(400);
    const sale = await api.call('POST', '/sales/quick', { token: A.ownerToken, headers: { 'idempotency-key': key() },
      body: { branchId: A.branchId, lines: [{ itemId: ib, qty: 1 }], payments: [{ method: 'cash', amount: 10 }] } });
    expect(sale.status).toBe(400);
    expect((await api.call('GET', `/stock?branchId=${B.branchId}`, { token: B.ownerToken })).json.stock[0].on_hand).toBe('5.0000');
    // users of B are invisible to A
    expect((await api.call('GET', '/users', { token: A.ownerToken })).json.users.map((u: any) => u.email)).toEqual([A.ownerEmail]);
  });

  it('A9: a user restricted to one branch cannot read or write another branch', async () => {
    const shop = await createShop(api, admin);
    const b2 = (await api.call('POST', '/branches', { token: shop.ownerToken, body: { name: 'Second' } })).json.id as string;
    const cashier = await staff(api, shop, 'cashier', [b2]);
    expect((await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: cashier.token })).status).toBe(403);
    expect((await api.call('GET', `/stock?branchId=${b2}`, { token: cashier.token })).status).toBe(200);
    const sale = await api.call('POST', '/sales/quick', { token: cashier.token, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, lines: [{ itemId: key(), qty: 1 }], payments: [] } });
    expect(sale.status).toBe(403);
    expect((await api.call('GET', '/branches', { token: cashier.token })).json.branches.map((b: any) => b.id)).toEqual([b2]);
  });

  it('A10: staff creation — duplicates, weak passwords, unknown roles and plan quotas', async () => {
    const shop = await createShop(api, admin, 'basic');                     // basic plan: 3 users
    const base = { name: 'n', password: PW, roleName: 'cashier' };
    expect((await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email: 'a1@test.local', password: 'short' } })).status).toBe(400);
    expect((await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email: 'a1@test.local', roleName: 'god' } })).status).toBe(400);
    const email = `dup.${uniq('d')}@test.local`;
    expect((await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email } })).status).toBe(201);
    expect((await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email: email.toUpperCase() } })).status).toBe(409);
    expect((await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email: `b.${uniq('b')}@test.local` } })).status).toBe(201);
    const over = await api.call('POST', '/users', { token: shop.ownerToken, body: { ...base, email: `c.${uniq('c')}@test.local` } });
    expect(over.status).toBe(403); expect(over.json.error.code).toBe('QUOTA');
    expect((await api.call('GET', '/users', { token: shop.ownerToken })).json.users).toHaveLength(3);
  });
});

describe('request hygiene', () => {
  it('A11: idempotency keys are required and honoured; price override needs permission', async () => {
    const shop = await createShop(api, admin);
    const it = (await api.call('POST', '/items', { token: shop.ownerToken, body: { sku: 'K', name: 'K', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 100 } })).json.id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: it, qty: 10, unitCost: 60 } });
    const cashier = await staff(api, shop, 'cashier');
    const body = { branchId: shop.branchId, lines: [{ itemId: it, qty: 2 }], payments: [{ method: 'cash', amount: 200 }] };
    expect((await api.call('POST', '/sales/quick', { token: cashier.token, body })).status).toBe(400);              // no key
    const k = key();
    const r1 = await api.call('POST', '/sales/quick', { token: cashier.token, headers: { 'idempotency-key': k }, body });
    const r2 = await api.call('POST', '/sales/quick', { token: cashier.token, headers: { 'idempotency-key': k }, body });
    expect(r1.status).toBe(201); expect(r2.json).toEqual(r1.json);
    expect((await api.call('GET', '/invoices', { token: cashier.token })).json.invoices).toHaveLength(1);
    expect((await api.call('POST', '/sales/quick', { token: cashier.token, headers: { 'idempotency-key': k }, body: { ...body, lines: [{ itemId: it, qty: 3 }], payments: [{ method: 'cash', amount: 300 }] } })).status).toBe(409);
    const cheap = { ...body, lines: [{ itemId: it, qty: 1, unitPrice: 1 }], payments: [{ method: 'cash', amount: 1 }] };
    expect((await api.call('POST', '/sales/quick', { token: cashier.token, headers: { 'idempotency-key': key() }, body: cheap })).status).toBe(403);
    expect((await api.call('POST', '/sales/quick', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: cheap })).status).toBe(201);
    expect((await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: shop.ownerToken })).json.stock[0].on_hand).toBe('7.0000');
  });

  it('A12: input validation, size limits, content types, unknown routes and methods', async () => {
    const shop = await createShop(api, admin);
    const t = shop.ownerToken, h = { 'idempotency-key': key() };
    const post = (path: string, body: unknown, headers: Record<string, string> = h) => api.call('POST', path, { token: t, body, headers });
    expect((await post('/stock/receive', { branchId: 'not-a-uuid', itemId: key(), qty: 1, unitCost: 1 })).status).toBe(400);
    expect((await post('/stock/receive', { branchId: shop.branchId, itemId: key(), qty: -1, unitCost: 1 })).status).toBe(400);
    expect((await post('/stock/receive', { branchId: shop.branchId, itemId: key(), qty: '5', unitCost: 1 })).status).toBe(400);
    expect((await post('/stock/receive', { branchId: shop.branchId, itemId: key(), qty: 1e12, unitCost: 1 })).status).toBe(400);
    expect((await post('/items', { sku: 'S', name: 'S', kind: 'weapon', trackQuantity: true, fulfillment: 'stock' })).status).toBe(400);
    expect((await post('/items', { sku: 'S', name: 'S', kind: 'service', trackQuantity: true, fulfillment: 'stock' })).status).toBe(400);   // data rule
    expect((await api.call('POST', '/items', { token: t, raw: '{"sku": ', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await api.call('POST', '/items', { token: t, raw: 'x'.repeat(200_000), headers: { 'content-type': 'application/json' } })).status).toBe(413);
    expect((await api.call('POST', '/items', { token: t, raw: 'sku=1', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await api.call('GET', '/nope', { token: t })).status).toBe(404);
    expect((await api.call('DELETE', '/items', { token: t })).status).toBe(405);
  });

  it('A13: errors never leak SQL or internals; security headers are set; /ready reports the Postgres version', async () => {
    const shop = await createShop(api, admin);
    const item = { sku: 'DUP', name: 'D', kind: 'goods', trackQuantity: false, fulfillment: 'none' };
    expect((await api.call('POST', '/items', { token: shop.ownerToken, body: item })).status).toBe(201);
    const dup = await api.call('POST', '/items', { token: shop.ownerToken, body: item });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.json)).not.toMatch(/violates|constraint|items_|duplicate key|relation/i);
    expect(dup.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dup.headers.get('cache-control')).toBe('no-store');
    expect(dup.headers.get('content-security-policy')).toContain("default-src 'none'");
    const ready = await api.call('GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ status: 'ready', rlsBypassPossible: false, unprotectedTables: 0, migrated: true });
    expect(ready.json.postgres).toMatch(/^\d+/);
  });
});

describe('end-to-end journeys for the three pilot business types', () => {
  const mkItem = (s: Shop, body: object) => api.call('POST', '/items', { token: s.ownerToken, body }).then((r) => { if (r.status !== 201) throw new Error(JSON.stringify(r.json)); return r.json.id as string; });
  const receive = (s: Shop, body: object) => api.call('POST', '/stock/receive', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, ...body } });
  const sell = (s: Shop, body: object, token = s.ownerToken) => api.call('POST', '/sales/quick', { token, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, ...body } });
  const stock = async (s: Shop) => Object.fromEntries((await api.call('GET', `/stock?branchId=${s.branchId}`, { token: s.ownerToken })).json.stock.map((r: any) => [r.sku, Number(r.on_hand)]));

  it('J1: butcher + grill — receive 10kg, sell 1.47kg with grilling = 220.50, report, then cancel the sale', async () => {
    const s = await createShop(api, admin, 'pro', 'Shop Butcher');
    const kafta = await mkItem(s, { sku: 'KAFTA', name: 'Kafta', kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price: 130 });
    const grill = await mkItem(s, { sku: 'GRILL', name: 'Grilling', kind: 'service', trackQuantity: false, fulfillment: 'none', price: 20 });
    expect((await receive(s, { itemId: kafta, qty: 10, unitCost: 100 })).status).toBe(201);
    const sale = await sell(s, { lines: [{ itemId: kafta, qty: 1.5, actualQty: 1.47 }, { itemId: grill, qty: 1.5, actualQty: 1.47 }], payments: [{ method: 'cash', amount: 220.5 }] });
    expect(sale.status).toBe(201); expect(sale.json.total).toBe(220.5);
    expect(await stock(s)).toMatchObject({ KAFTA: 8.53 });
    const sum = (await api.call('GET', '/reports/summary', { token: s.ownerToken })).json;
    expect(Number(sum.salesToday)).toBe(220.5); expect(sum.invoicesToday).toBe(1);
    const cancel = await api.call('POST', `/sales/${sale.json.orderId}/cancel`, { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { reason: 'customer refused' } });
    expect(cancel.status).toBe(200);
    expect(await stock(s)).toMatchObject({ KAFTA: 8.53 });                          // committed meat is written off, not silently restocked
    expect(Number((await api.call('GET', '/reports/summary', { token: s.ownerToken })).json.salesToday)).toBe(0);
    expect((await api.call('GET', '/invoices', { token: s.ownerToken })).json.invoices[0].status).toBe('void');
  });

  it('J2: grocery — batch with expiry, credit sale for a business customer, receivable shown', async () => {
    const s = await createShop(api, admin, 'pro', 'Epicerie');
    const yog = await mkItem(s, { sku: 'YOG', name: 'Yogurt', kind: 'goods', trackQuantity: true, fulfillment: 'stock', batchTracking: 'required', price: 3 });
    expect((await receive(s, { itemId: yog, qty: 50, unitCost: 2 })).status).toBe(400);                // batch is required
    const exp = new Date(Date.now() + 10 * 86400_000).toISOString();
    expect((await receive(s, { itemId: yog, qty: 50, unitCost: 2, batchNo: 'L1', expiresAt: exp })).status).toBe(201);
    const cust = (await api.call('POST', '/customers', { token: s.ownerToken, body: { name: 'Restaurant Atlas', creditLimit: 500 } })).json.id;
    const credit = await sell(s, { customerId: cust, lines: [{ itemId: yog, qty: 100 }], payments: [] });
    expect(credit.status).toBe(409);                                                                  // only 50 in stock
    const ok = await sell(s, { customerId: cust, lines: [{ itemId: yog, qty: 40 }], payments: [{ method: 'cash', amount: 20 }] });
    expect(ok.status).toBe(201); expect(ok.json).toMatchObject({ total: 120, paid: 20, due: 100 });
    expect((await api.call('GET', '/customers', { token: s.ownerToken })).json.customers[0]).toMatchObject({ name: 'Restaurant Atlas', balance: '100.00' });
    const nocust = await sell(s, { lines: [{ itemId: yog, qty: 1 }], payments: [] });
    expect(nocust.status).toBe(400);                                                                  // unpaid without a customer
    expect(await stock(s)).toMatchObject({ YOG: 10 });
  });

  it('J3: equipment + installation — serial numbers sell once; the service touches no stock', async () => {
    const s = await createShop(api, admin, 'pro', 'Shop Security');
    const det = await mkItem(s, { sku: 'DET-01', name: 'Smoke detector', kind: 'goods', trackQuantity: true, serialTracking: true, fulfillment: 'stock', price: 450 });
    const inst = await mkItem(s, { sku: 'INST', name: 'Installation', kind: 'service', trackQuantity: false, fulfillment: 'none', price: 200 });
    expect((await receive(s, { itemId: det, qty: 2, unitCost: 300, serials: [{ serialNo: 'D1', warrantyUntil: '2028-01-01' }] })).status).toBe(400);
    expect((await receive(s, { itemId: det, qty: 2, unitCost: 300, serials: [{ serialNo: 'D1', warrantyUntil: '2028-01-01' }, { serialNo: 'D2', warrantyUntil: '2028-01-01' }] })).status).toBe(201);
    const first = await sell(s, { lines: [{ itemId: det, qty: 1, serialNo: 'D1' }, { itemId: inst, qty: 1 }], payments: [{ method: 'card', amount: 650 }] });
    expect(first.status).toBe(201);
    expect((await sell(s, { lines: [{ itemId: det, qty: 1, serialNo: 'D1' }], payments: [{ method: 'cash', amount: 450 }] })).status).toBe(409);
    expect(await stock(s)).toMatchObject({ 'DET-01': 1 });
  });

  it('J4: the three shops are fully isolated from each other and each owner sees only their own data', async () => {
    const [a, b] = [await createShop(api, admin, 'pro', 'One'), await createShop(api, admin, 'pro', 'Two')];
    for (const [s, sku] of [[a, 'ONLY-A'], [b, 'ONLY-B']] as const) {
      await mkItem(s, { sku, name: sku, kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 5 });
    }
    expect((await api.call('GET', '/items', { token: a.ownerToken })).json.items.map((i: any) => i.sku)).toEqual(['ONLY-A']);
    expect((await api.call('GET', '/items', { token: b.ownerToken })).json.items.map((i: any) => i.sku)).toEqual(['ONLY-B']);
    expect((await api.call('GET', '/invoices', { token: a.ownerToken })).json.invoices).toEqual([]);
    const me = (await api.call('GET', '/me', { token: a.ownerToken })).json;
    expect(me.tenants).toHaveLength(1); expect(me.permissions).toContain('users.manage');
  });
});
