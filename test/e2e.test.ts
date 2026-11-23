import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PW, createShop, key, platformAdmin, startApp, uniq } from './api-helpers.js';

// Real browser tests (Chromium via Playwright): desktop + phone viewport, French + Arabic, security properties of the web UI.
const { chromium } = createRequire(import.meta.url)('playwright');
let api: Api, base: string, browser: any, admin: { email: string; token: string };

beforeAll(async () => {
  api = await startApp(false);
  base = `http://127.0.0.1:${(api.server.address() as any).port}`;
  admin = await platformAdmin(api);
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); await api?.close(); });

async function newPage(opts: { mobile?: boolean; locale?: string } = {}) {
  const ctx = await browser.newContext({
    locale: opts.locale ?? 'fr-FR',
    viewport: opts.mobile ? { width: 375, height: 812 } : { width: 1280, height: 800 },
    hasTouch: Boolean(opts.mobile), isMobile: Boolean(opts.mobile), deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const problems: string[] = [];
  page.on('pageerror', (e: Error) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m: any) => {
    const txt = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(txt)) problems.push(`console: ${txt}`);   // expected 401 on /me before login
  });
  return { ctx, page, problems };
}
type P = Awaited<ReturnType<typeof newPage>>['page'];

async function uiLogin(page: P, email: string, password = PW) {
  await page.goto(`${base}/app/`);
  await page.fill('#email', email);
  await page.fill('#pw', password);
  await page.click('button[type=submit]');
}
const text = (page: P, sel: string) => page.locator(sel).first().innerText();
// the word "false"/"undefined"/"null" printed in the page means a rendering bug leaked a JS value
const noLeaks = async (page: P) => expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\b(false|undefined|null|NaN|\[object)\b/);
const hasMoney = (s: string, v: string) => new RegExp(v.replace('.', '[.,]')).test(s.replace(/\s/g, ''));

describe('web UI in a real browser', () => {
  it('E0b: empty platform shows actionable onboarding and responsive AR/FR navigation without fake metrics', async () => {
    const { ctx, page, problems } = await newPage();
    // The empty-state UI is a deterministic fixture: parallel suites create real tenants in the shared CI database.
    await page.route('**/platform/tenants', (route: any) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tenants: [] }) }));
    await uiLogin(page, admin.email);
    await page.waitForSelector('.platform-empty');
    expect(await page.getByRole('heading', { name: /premier établissement/i }).isVisible()).toBe(true);
    expect((await page.locator('.overview-strip .v').first().innerText()).trim()).toBe('0');
    expect(await page.getByRole('button', { name: /créer le premier établissement/i }).isVisible()).toBe(true);
    await page.getByRole('button', { name: /créer le premier établissement/i }).click();
    await page.waitForSelector('#sn');
    expect(await page.locator('#ss').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await ctx.close();

    const mobile = await newPage({ mobile: true, locale: 'ar-MA' });
    await mobile.page.route('**/platform/tenants', (route: any) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tenants: [] }) }));
    await uiLogin(mobile.page, admin.email);
    await mobile.page.waitForSelector('.platform-empty');
    expect(await mobile.page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(await mobile.page.locator('.workspace .nav a').count()).toBe(1);
    const fits = await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits).toBe(true);
    expect([...problems, ...mobile.problems]).toEqual([]);
    await mobile.ctx.close();
  });

  it('E1 (desktop, FR): platform admin creates a shop by activity; owner runs a full weighed sale with grilling; stock, dashboard and cancellation reflect it', async () => {
    const { ctx, page, problems } = await newPage();
    // 1) platform administrator creates the shop through the UI
    await uiLogin(page, admin.email);
    await page.waitForSelector('text=Plateforme');
    const slug = uniq('butcher').toLowerCase();
    await page.getByRole('button', { name: /Nouvel établissement/ }).click();
    await page.fill('#sn', 'Butcher E2E'); await page.fill('#ss', slug);
    await page.locator('#act-butcher').check(); await page.locator('#act-grill').check();
    const ownerEmail = `owner.${slug}@test.local`;
    await page.locator('#self-owner').uncheck();
    await page.fill('#on', 'Owner E2E'); await page.fill('#oe', ownerEmail); await page.fill('#op', PW);
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await page.waitForSelector(`td:has-text("${slug}")`);
    await page.getByRole('button', { name: 'Déconnexion' }).click();

    // 2) owner signs in; the shop shows ITS activities' starter catalog
    await uiLogin(page, ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link', { name: 'Produits & services' }).click();
    await page.waitForSelector('td:has-text("BUT-BOEUF")');
    await noLeaks(page);
    expect(await page.locator('.badge.sample').count()).toBeGreaterThan(0);
    expect(await page.locator('td:has-text("EQP-POMPE")').count()).toBe(0);              // other activities' items are not there

    // 3) receive 10 kg
    await page.locator('nav.nav').getByRole('link', { name: 'Stock' }).click();
    await page.click('#receive-btn');
    await page.selectOption('#r-item', { label: 'BUT-BOEUF — Viande de bœuf' });
    await page.fill('#r-qty', '10'); await page.fill('#r-cost', '80');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForSelector('tr:has-text("BUT-BOEUF") >> text=/10/');

    // 4) POS: weighed meat + grilling service
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    await page.click('button.prod[data-sku=BUT-BOEUF]');
    await page.fill('#w', '1.47'); await page.getByRole('button', { name: 'Valider' }).click();
    await page.click('button.prod[data-sku=GRL-CUISSON]');
    await page.locator('[data-line=GRL-CUISSON] input').fill('1.47'); await page.locator('[data-line=GRL-CUISSON] input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#cart-total')?.textContent?.replace(/\s/g, '').match(/205[.,]80/));
    expect(hasMoney(await text(page, '#cart-total'), '205.80')).toBe(true);             // 1.47*120 + 1.47*20
    await noLeaks(page);
    await page.click('#pay-cash');
    await page.waitForSelector('#receipt');
    expect(hasMoney(await text(page, '#receipt-total'), '205.80')).toBe(true);

    // 5) effects: stock 8.53, dashboard, invoice list
    await page.locator('nav.nav').getByRole('link', { name: 'Stock' }).click();
    await page.waitForSelector('tr:has-text("BUT-BOEUF")');
    expect(await text(page, 'tr:has-text("BUT-BOEUF")')).toMatch(/8[.,]53/);
    await page.locator('nav.nav').getByRole('link', { name: 'Tableau de bord' }).click();
    await page.waitForSelector('#tile-sales');
    expect(hasMoney(await text(page, '#tile-sales'), '205.80')).toBe(true);
    expect(await text(page, '#tile-invoices')).toMatch(/1/);

    // 6) cancel the sale (meat is already committed -> write-off, not restocked)
    await page.locator('nav.nav').getByRole('link', { name: 'Factures' }).click();
    await page.getByRole('button', { name: 'Annuler la vente' }).click();
    expect(await page.locator('#chow').count()).toBe(0);                                  // no "return to stock" choice without an approval workflow
    await page.fill('#creason', 'client parti'); await page.getByRole('button', { name: 'Annuler la vente' }).last().click();
    await page.waitForSelector('.badge.bad');
    await page.locator('nav.nav').getByRole('link', { name: 'Tableau de bord' }).click();
    await page.waitForSelector('#tile-sales');
    await page.waitForFunction(() => /^0[.,]00/.test(document.querySelector('#tile-sales .v')?.textContent?.replace(/\s/g, '') ?? ''));

    // security properties of the browser session
    const cookies = await ctx.cookies();
    const sess = cookies.find((c: any) => c.name === 'tj_session');
    expect(sess).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('tj_session');
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(stored).not.toMatch(/tj_|token|session/i);                                    // nothing sensitive in web storage
    expect(problems).toEqual([]);                                                        // no CSP violations, no script errors
    await ctx.close();
  }, 120_000);

  it('E1b: platform admin creates pilot shop with their own account and opens its dashboard without another password', async () => {
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, admin.email);
    await page.waitForSelector('text=Plateforme');
    const slug = uniq('pilotui').toLowerCase();
    await page.getByRole('button', { name: /Nouvel établissement/ }).click();
    await page.fill('#sn', 'Pilot Butcher');
    await page.fill('#ss', slug);
    await page.locator('#act-butcher').check();
    await page.locator('#act-grill').check();
    await page.locator('#act-restaurant').check();
    expect(await page.locator('#self-owner').isChecked()).toBe(true);
    expect(await page.locator('#oe').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link', { name: 'Produits & services' }).click();
    await page.waitForSelector('td:has-text("BUT-BOEUF")');
    expect(await page.locator('td:has-text("EQP-POMPE")').count()).toBe(0);
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it('E2 (phone, AR/RTL): grocery owner sells on a 375px screen; layout does not overflow; targets are touch-sized', async () => {
    const adm = admin;
    const shop = await createShop(api, adm, 'pro', 'Epicerie Mobile', ['grocery']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    const oil = items.find((i: any) => i.sku === 'EPI-HUILE').id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: oil, qty: 30, unitCost: 12 } });

    const { ctx, page, problems } = await newPage({ mobile: true, locale: 'ar-MA' });
    await uiLogin(page, shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(page, 'nav.nav')).toContain('نقطة البيع');
    await page.locator('nav.nav').getByRole('link', { name: 'نقطة البيع' }).click();
    await page.waitForSelector('button.prod[data-sku=EPI-HUILE]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const h = await page.locator('button.prod[data-sku=EPI-HUILE]').boundingBox();
    expect(h.height).toBeGreaterThanOrEqual(48);
    await page.tap('button.prod[data-sku=EPI-HUILE]'); await page.tap('button.prod[data-sku=EPI-HUILE]');   // 2 x 18
    await page.waitForFunction(() => /36[.,]00/.test(document.querySelector('#cart-total')?.textContent?.replace(/\s/g, '') ?? ''));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await noLeaks(page);
    const pay = await page.locator('#pay-cash').boundingBox();
    expect(pay.height).toBeGreaterThanOrEqual(44);
    await page.tap('#pay-cash');
    await page.waitForSelector('#receipt');
    const stock = (await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: shop.ownerToken })).json.stock.find((r: any) => r.sku === 'EPI-HUILE');
    expect(Number(stock.on_hand)).toBe(28);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('E3 (desktop): equipment/security shop — serial-numbered product + installation service through the same POS', async () => {
    const shop = await createShop(api, admin, 'pro', 'Security E2E', ['security_systems']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    const det = items.find((i: any) => i.sku === 'SEC-DETECT').id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: det, qty: 2, unitCost: 300, serials: [{ serialNo: 'D-100' }, { serialNo: 'D-101' }] } });
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, shop.ownerEmail);
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    await page.click('button.prod[data-sku=SEC-DETECT]');
    await page.fill('#sn', 'D-100'); await page.getByRole('button', { name: 'Valider' }).click();
    await page.click('button.prod[data-sku=SEC-INSTALL]');
    await page.waitForFunction(() => /750[.,]00/.test(document.querySelector('#cart-total')?.textContent?.replace(/\s/g, '') ?? ''));   // 450 + 300
    await page.click('#pay-card');
    await page.waitForSelector('#receipt');
    // the same serial cannot be sold twice: the UI shows the server's refusal
    await page.click('#new-sale');
    await page.click('button.prod[data-sku=SEC-DETECT]');
    await page.fill('#sn', 'D-100'); await page.getByRole('button', { name: 'Valider' }).click();
    await page.click('#pay-cash');
    await page.waitForSelector('#pos-error');
    expect(await text(page, '#pos-error')).toMatch(/D-100/);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('E4: hostile data is rendered as text (no XSS) and cross-shop access is impossible from the UI session', async () => {
    const A = await createShop(api, admin, 'pro', 'Shop A', ['grocery']), B = await createShop(api, admin, 'pro', 'Shop B', ['grocery']);
    const evil = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    const mk = await api.call('POST', '/items', { token: A.ownerToken, body: { sku: 'EVIL-1', name: evil, kind: 'goods', trackQuantity: false, fulfillment: 'none', price: 5 } });
    expect(mk.status).toBe(201);
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, A.ownerEmail);
    await page.locator('nav.nav').getByRole('link', { name: 'Produits & services' }).click();
    await page.waitForSelector('td:has-text("EVIL-1")');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(await text(page, 'tr:has-text("EVIL-1")')).toContain('<img src=x');             // shown literally
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    await page.waitForSelector('button.prod[data-sku=EVIL-1]');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    // the browser session of A cannot read B through the API either (tenant comes from the session only)
    const leak = await page.evaluate(async (tenantId: string) => (await fetch(`/items?tenantId=${tenantId}`, { headers: { 'x-tenant-id': tenantId } })).json(), B.tenantId);
    expect(leak.items.map((i: any) => i.sku)).not.toContain('SEC-DETECT');
    expect(leak.items.every((i: any) => ['EVIL-1', 'EPI-LAIT', 'EPI-HUILE', 'EPI-SUCRE'].includes(i.sku))).toBe(true);
    // a forged cross-site style write (no custom header) is refused even though the cookie is attached
    const forged = await page.evaluate(async () => (await fetch('/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    expect(forged).toBe(403);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('E5: password reset page and wrong-credential handling in the UI', async () => {
    const shop = await createShop(api, admin);
    const { ctx, page } = await newPage();
    await uiLogin(page, shop.ownerEmail, 'Totally-Wrong-1');
    await page.waitForSelector('.error');
    expect(await text(page, '.error')).toContain('Identifiants invalides');
    const f = await api.call('POST', '/auth/forgot', { body: { email: shop.ownerEmail } });
    await page.goto(`${base}/app/#/reset?token=${f.json.devResetToken}`);
    await page.fill('#rp', 'Brand-New-Passw0rd'); await page.click('button[type=submit]');
    await page.waitForSelector('.badge.ok');
    await uiLogin(page, shop.ownerEmail, 'Brand-New-Passw0rd');
    await page.waitForSelector('#tile-sales');
    await ctx.close();
  }, 60_000);

  it('E6: regressions from review — a paid cart can never be charged twice, and weighed totals match the server to the cent', async () => {
    const shop = await createShop(api, admin, 'pro', 'Epicerie E6', ['grocery']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    const sugar = items.find((i: any) => i.sku === 'EPI-SUCRE').id, oil = items.find((i: any) => i.sku === 'EPI-HUILE').id;
    for (const [id, qty] of [[sugar, 20], [oil, 20]] as const) await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: id, qty, unitCost: 5 } });
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, shop.ownerEmail);
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    // 1.005 kg x 7 = 7.035 -> PostgreSQL numeric rounds to 7.04 (binary floats would give 7.03)
    await page.click('button.prod[data-sku=EPI-SUCRE]');
    await page.fill('#w', '1.005'); await page.getByRole('button', { name: 'Valider' }).click();
    expect(hasMoney(await text(page, '#cart-total'), '7.04')).toBe(true);
    // the +/- step buttons must keep the weighed precision: 1.005 -> 2.005 -> 1.005 (never 1.01)
    await page.locator('[data-line=EPI-SUCRE] .qty button').last().click();
    expect(await page.locator('[data-line=EPI-SUCRE] input').inputValue()).toBe('2.005');
    await page.locator('[data-line=EPI-SUCRE] .qty button').first().click();
    expect(await page.locator('[data-line=EPI-SUCRE] input').inputValue()).toBe('1.005');
    await page.click('#pay-cash');
    await page.waitForSelector('#receipt');                                          // accepted: amount equals the invoice exactly
    expect(await page.locator('#pos-error').count()).toBe(0);
    // touching the catalog after payment must NOT resurrect the paid lines
    await page.click('button.prod[data-sku=EPI-HUILE]');
    expect(await page.locator('[data-line]').count()).toBe(1);
    expect(await page.locator('[data-line=EPI-SUCRE]').count()).toBe(0);
    expect(hasMoney(await text(page, '#cart-total'), '18.00')).toBe(true);
    await page.click('#pay-cash'); await page.waitForSelector('#receipt');
    const inv = (await api.call('GET', '/invoices', { token: shop.ownerToken })).json.invoices;
    expect(inv.map((i: any) => i.total).sort()).toEqual(['18.00', '7.04']);
    const st = (await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: shop.ownerToken })).json.stock;
    expect(Number(st.find((r: any) => r.sku === 'EPI-SUCRE').on_hand)).toBeCloseTo(18.995, 3);   // sold once
    expect(Number(st.find((r: any) => r.sku === 'EPI-HUILE').on_hand)).toBe(19);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('E7: while a payment request is in flight the cart is frozen, so an extra tap can never be lost or double-charged', async () => {
    const shop = await createShop(api, admin, 'pro', 'Epicerie E7', ['grocery']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    const oil = items.find((i: any) => i.sku === 'EPI-HUILE').id, sugar = items.find((i: any) => i.sku === 'EPI-SUCRE').id;
    for (const id of [oil, sugar]) await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: id, qty: 20, unitCost: 5 } });
    const { ctx, page, problems } = await newPage();
    await page.route('**/sales/quick', async (route: any) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });   // slow network
    await uiLogin(page, shop.ownerEmail);
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    await page.click('button.prod[data-sku=EPI-HUILE]');
    await page.click('#pay-cash');
    await page.waitForSelector('[aria-busy=true]');
    await page.click('button.prod[data-sku=EPI-SUCRE]', { force: true }).catch(() => {});      // user taps another product during the request
    await page.locator('[data-line=EPI-HUILE] button').first().click({ force: true }).catch(() => {});
    await page.waitForSelector('#receipt');
    expect(hasMoney(await text(page, '#receipt-total'), '18.00')).toBe(true);
    await page.click('#new-sale');
    expect(await page.locator('[data-line]').count()).toBe(0);                                  // the extra tap was ignored, nothing half-added
    const st = (await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: shop.ownerToken })).json.stock;
    expect(Number(st.find((r: any) => r.sku === 'EPI-HUILE').on_hand)).toBe(19);
    expect(Number(st.find((r: any) => r.sku === 'EPI-SUCRE').on_hand)).toBe(20);
    expect((await api.call('GET', '/invoices', { token: shop.ownerToken })).json.invoices).toHaveLength(1);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('E8: a sale whose total is zero (free items) completes without sending a 0-amount payment', async () => {
    const shop = await createShop(api, admin, 'pro', 'Epicerie E8', ['grocery']);
    const free = (await api.call('POST', '/items', { token: shop.ownerToken, body: { sku: 'FREE-1', name: 'Echantillon gratuit', kind: 'goods', trackQuantity: true, fulfillment: 'stock', price: 0 } })).json.id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: free, qty: 5, unitCost: 1 } });
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, shop.ownerEmail);
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse' }).click();
    await page.click('button.prod[data-sku=FREE-1]');
    expect(hasMoney(await text(page, '#cart-total'), '0.00')).toBe(true);
    await page.click('#pay-cash');
    await page.waitForSelector('#receipt');
    expect(await page.locator('#pos-error').count()).toBe(0);
    const inv = (await api.call('GET', '/invoices', { token: shop.ownerToken })).json.invoices;
    expect(inv).toHaveLength(1); expect(inv[0].total).toBe('0.00');
    const st = (await api.call('GET', `/stock?branchId=${shop.branchId}`, { token: shop.ownerToken })).json.stock.find((r: any) => r.sku === 'FREE-1');
    expect(Number(st.on_hand)).toBe(4);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('E9 (UI): edit price, archive and protected delete of products; customers edit; invoice detail with company identity and print', async () => {
    const shop = await createShop(api, admin, 'pro', 'Admin UI', ['grocery']);
    const items = (await api.call('GET', '/items', { token: shop.ownerToken })).json.items;
    const oil = items.find((i: any) => i.sku === 'EPI-HUILE').id;
    await api.call('POST', '/stock/receive', { token: shop.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: shop.branchId, itemId: oil, qty: 10, unitCost: 5 } });
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, shop.ownerEmail);
    const nav = (name: string) => page.locator('nav.nav').getByRole('link', { name, exact: true }).click();
    // settings: company identity
    await nav('Paramètres');
    await page.fill('#s-legal', 'SARL Démo'); await page.fill('#s-ice', '001234567000089'); await page.fill('#s-footer', 'Merci et à bientôt');
    await page.locator('#company-form button[type=submit]').click();
    await page.waitForSelector('.toast');
    // products: edit price, protected delete (has stock history), archive, delete unused
    await nav('Produits & services');
    await page.locator('tr[data-sku=EPI-HUILE] [data-action=edit]').click();
    await page.fill('#eprice', '21'); await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForSelector('tr[data-sku=EPI-HUILE] >> text=/21,00/');
    await page.locator('tr[data-sku=EPI-HUILE] [data-action=delete]').click(); await page.click('#confirm-ok');
    await page.waitForSelector('.toast.err');
    expect(await text(page, '.toast.err')).toContain('archivez-le');
    await page.locator('tr[data-sku=EPI-SUCRE] [data-action=delete]').click(); await page.click('#confirm-ok');     // never used -> really deleted
    await page.waitForFunction(() => !document.querySelector('tr[data-sku=EPI-SUCRE]'));
    await page.locator('tr[data-sku=EPI-LAIT] [data-action=edit]').click();
    await page.uncheck('#eactive'); await page.getByRole('button', { name: 'Enregistrer' }).click();               // archive
    await page.waitForFunction(() => !document.querySelector('tr[data-sku=EPI-LAIT]'));
    await page.check('#show-archived');
    await page.waitForSelector('tr[data-sku=EPI-LAIT] .badge.bad');
    // POS: new price, archived product gone
    await nav('Caisse');
    await page.waitForSelector('button.prod[data-sku=EPI-HUILE]');
    expect(await page.locator('button.prod[data-sku=EPI-LAIT]').count()).toBe(0);
    await page.click('button.prod[data-sku=EPI-HUILE]');
    expect(hasMoney(await text(page, '#cart-total'), '21.00')).toBe(true);
    await page.click('#pay-cash'); await page.waitForSelector('#receipt');
    // invoice detail: lines, total, company identity, print button
    await nav('Factures');
    await page.locator('a[data-invoice]').first().click();
    await page.waitForSelector('#invoice-sheet');
    const sheet = await text(page, '#invoice-sheet');
    expect(sheet).toContain('SARL Démo'); expect(sheet).toContain('ICE 001234567000089'); expect(sheet).toContain('Huile 1L'); expect(sheet).toContain('Merci et à bientôt');
    expect(hasMoney(await text(page, '#invoice-total'), '21.00')).toBe(true);
    expect(await page.locator('#print-btn').isVisible()).toBe(true);
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('nav.nav').isVisible()).toBe(false);                                         // print layout hides the app chrome
    expect(await page.locator('#print-btn').isVisible()).toBe(false);
    await page.emulateMedia({ media: 'screen' });
    // customers: edit and archive
    await api.call('POST', '/customers', { token: shop.ownerToken, body: { name: 'Client Test' } });
    await nav('Clients');
    await page.locator('tr[data-customer="Client Test"] [data-action=edit]').click();
    await page.fill('#cphone', '0600000001'); await page.uncheck('#cactive'); await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForSelector('tr[data-customer="Client Test"] .badge.bad');
    await noLeaks(page);
    expect(problems).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('E10 (UI): team and roles — a custom role with limited permissions, a new staff member, deactivate, reset password, journal', async () => {
    const shop = await createShop(api, admin, 'pro', 'Team UI', ['butcher']);
    const { ctx, page, problems } = await newPage();
    await uiLogin(page, shop.ownerEmail);
    const nav = (name: string) => page.locator('nav.nav').getByRole('link', { name, exact: true }).click();
    // custom role: stock only
    await nav('Rôles & permissions');
    await page.click('#new-role');
    await page.fill('#rname', 'magasinier');
    for (const p of ['catalog.view', 'stock.view', 'stock.receive']) await page.check(`#perm-${p.replace('.', '\\.')}`);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForSelector('[data-role=magasinier]');
    // new staff member with that role
    await nav('Équipe');
    await page.click('#new-user');
    const email = `mag.${uniq('m')}@test.local`;
    await page.fill('#uname', 'Magasinier Test'); await page.fill('#uemail', email); await page.fill('#upw', 'Magasin-Pass-2026');
    await page.selectOption('#urole', 'magasinier');
    await page.getByRole('button', { name: 'Créer' }).click();
    await page.waitForSelector(`tr[data-user="${email}"]`);
    // reset their password from the team page
    await page.locator(`tr[data-user="${email}"] [data-action=password]`).click();
    await page.fill('#rpw', 'Reset-By-Owner-77'); await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForSelector('.toast');
    // the staff member sees ONLY what the role allows
    const staffPage = await newPage();
    await uiLogin(staffPage.page, email, 'Reset-By-Owner-77');
    await staffPage.page.waitForSelector('nav.nav a');
    const links = await staffPage.page.locator('nav.nav a').allInnerTexts();
    expect(links).toEqual(expect.arrayContaining(['Produits & services', 'Stock']));
    for (const forbidden of ['Caisse', 'Équipe', 'Paramètres', 'Factures', 'Rôles & permissions', 'Journal']) expect(links).not.toContain(forbidden);
    await staffPage.page.goto(`${base}/app/#/users`);                                                       // typing a forbidden URL does not open it
    await staffPage.page.waitForSelector('nav.nav a[aria-current=page]');
    expect(await staffPage.page.locator('nav.nav a[aria-current=page]').innerText()).not.toBe('Équipe');
    // owner deactivates them: their next action is refused
    await page.locator(`tr[data-user="${email}"] [data-action=toggle]`).click();
    await page.waitForSelector(`tr[data-user="${email}"] .badge.bad`);
    const r = await staffPage.page.evaluate(async () => (await fetch('/items', { headers: { 'x-requested-with': 'tijara-web' } })).status);
    expect(r).toBeGreaterThanOrEqual(400);
    // journal shows what happened, with the actor, and no password
    await nav('Journal');
    await page.waitForSelector('code');
    const journal = await page.locator('main').innerText();
    expect(journal).toContain('role.created'); expect(journal).toContain('user.password_reset'); expect(journal).toContain('user.updated');
    expect(journal).not.toContain('Reset-By-Owner-77');
    await noLeaks(page);
    expect(problems).toEqual([]); expect(staffPage.problems).toEqual([]);
    await staffPage.ctx.close(); await ctx.close();
  }, 120_000);
});
