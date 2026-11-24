import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PW, createShop, platformAdmin, startApp } from './api-helpers.js';

let api: Api, prod: Api, admin: { token: string };
beforeAll(async () => { api = await startApp(false); prod = await startApp(true); admin = await platformAdmin(api); });
afterAll(async () => { await api.close(); await prod.close(); });

const WEB = { 'x-requested-with': 'tijara-web' };
const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').split(';')[0];

describe('browser sessions (HttpOnly cookie + CSRF)', () => {
  it('W1: cookie login never exposes the token to scripts; cookie is HttpOnly + SameSite=Strict (+Secure in production)', async () => {
    const shop = await createShop(api, admin);
    const r = await api.call('POST', '/auth/login', { headers: WEB, body: { email: shop.ownerEmail, password: PW, cookie: true } });
    expect(r.status).toBe(200);
    expect(r.json.token).toBeUndefined();
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^tj_session=tj_/); expect(sc).toContain('HttpOnly'); expect(sc).toContain('SameSite=Strict'); expect(sc).toContain('Path=/');
    expect(sc).not.toContain('Secure');
    const p = await prod.call('POST', '/auth/login', { headers: WEB, body: { email: shop.ownerEmail, password: PW, cookie: true } });
    expect(p.headers.get('set-cookie')).toContain('Secure');
    // login in cookie mode without the CSRF header is refused
    expect((await api.call('POST', '/auth/login', { body: { email: shop.ownerEmail, password: PW, cookie: true } })).status).toBe(403);
  });

  it('W2: cookie sessions work for reads; writes need same-origin + the custom header (CSRF)', async () => {
    const shop = await createShop(api, admin);
    const login = await api.call('POST', '/auth/login', { headers: WEB, body: { email: shop.ownerEmail, password: PW, cookie: true } });
    const cookie = cookieOf(login);
    const item = { sku: 'CSRF1', name: 'x', kind: 'goods', trackQuantity: false, fulfillment: 'none' };
    expect((await api.call('GET', '/me', { headers: { cookie } })).status).toBe(200);
    expect((await api.call('POST', '/items', { headers: { cookie }, body: item })).status).toBe(403);                                            // forged cross-site form: no custom header
    expect((await api.call('POST', '/items', { headers: { cookie, ...WEB, origin: 'https://evil.example' }, body: item })).status).toBe(403);    // wrong origin
    expect((await api.call('POST', '/items', { headers: { cookie, ...WEB, origin: 'http://127.0.0.1:1' }, body: item })).status).toBe(403);
    expect((await api.call('POST', '/items', { headers: { cookie, ...WEB }, body: item })).status).toBe(201);                                    // genuine same-origin app request
    expect((await api.call('GET', '/items', { headers: { cookie } })).json.items).toHaveLength(1);
  });

  it('W3: logout clears the cookie and revokes the session server-side', async () => {
    const shop = await createShop(api, admin);
    const cookie = cookieOf(await api.call('POST', '/auth/login', { headers: WEB, body: { email: shop.ownerEmail, password: PW, cookie: true } }));
    const out = await api.call('POST', '/auth/logout', { headers: { cookie, ...WEB } });
    expect(out.status).toBe(200); expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await api.call('GET', '/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('shop setup by activity and platform overview', () => {
  it('W4: choosing activities seeds an editable starter catalog; unknown activities are refused; only platform admins list shops', async () => {
    const shop = await createShop(api, admin, 'pro', 'Multi', ['butcher', 'grill', 'restaurant']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    expect(items.map((i: any) => i.sku).sort()).toEqual(['BUT-AGNEAU', 'BUT-BOEUF', 'BUT-COTELETTE', 'BUT-DINDE', 'BUT-FOIE', 'BUT-KEFTA', 'BUT-KRAIN', 'BUT-POULET', 'BUT-TQALIA', 'GRL-BROCH', 'GRL-CUISSON', 'RES-BOISSON', 'RES-PLAT']);
    expect(items.find((i: any) => i.sku === 'GRL-CUISSON')).toMatchObject({ kind: 'service', track_quantity: false });
    expect((await api.call('GET', '/tenant', { token: shop.ownerToken })).json).toMatchObject({ name: 'Multi', plan: 'pro', activities: ['butcher', 'grill', 'restaurant'] });
    const bad = await api.call('POST', '/platform/tenants', { token: admin.token, body: { name: 'X', slug: 'bad-activity', plan: 'pro', activities: ['nuclear'], owner: { email: 'q@test.local', name: 'q', password: PW } } });
    expect(bad.status).toBe(400);
    const list = await api.call('GET', '/platform/tenants', { token: admin.token });
    expect(list.status).toBe(200);
    const row = list.json.tenants.find((t: any) => t.id === shop.tenantId);
    expect(row).toMatchObject({ name: 'Multi', activities: ['butcher', 'grill', 'restaurant'], items: 13, users: 1 });
    expect(JSON.stringify(list.json)).not.toMatch(/password|email/i);                 // overview exposes no business or personal data
    expect((await api.call('GET', '/platform/tenants', { token: shop.ownerToken })).status).toBe(403);
    // a sample sale works immediately on the starter catalog (receive + sell)
    const beef = items.find((i: any) => i.sku === 'BUT-BOEUF').id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': 'seed-recv-00001' }, body: { branchId: shop.branchId, itemId: beef, qty: 5, unitCost: 80 } });
    const sale = await api.call('POST', '/sales/quick', { token: shop.ownerToken, headers: { 'idempotency-key': 'seed-sale-00001' }, body: { branchId: shop.branchId, lines: [{ itemId: beef, qty: 2 }], payments: [{ method: 'cash', amount: 240 }] } });
    expect(sale.status).toBe(201);
  });
});

describe('static UI delivery', () => {
  it('W5: UI is served with a strict CSP (no inline script/style), traversal is blocked, / redirects to /app/', async () => {
    const root = await fetch((api.server.address() as any) && `http://127.0.0.1:${(api.server.address() as any).port}/`, { redirect: 'manual' });
    expect(root.status).toBe(302); expect(root.headers.get('location')).toBe('/app/');
    const base = `http://127.0.0.1:${(api.server.address() as any).port}`;
    const page = await fetch(`${base}/app/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'"); expect(csp).not.toContain('unsafe-inline'); expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    for (const bad of ['/app/..%2f..%2fpackage.json', '/app/%2e%2e/%2e%2e/etc/passwd', '/app/..%5c..%5cpackage.json']) {
      const r = await fetch(base + bad); expect(r.status, bad).toBe(404);
    }
    expect((await fetch(`${base}/app/`, { method: 'POST' })).status).toBe(405);
  });
});
