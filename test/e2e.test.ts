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
const hasMoney = (s: string, v: string) => new RegExp(v.replace('.', '[.,]')).test(s.replace(/\s/g, ''));

describe('web UI in a real browser', () => {
  it('E1 (desktop, FR): platform admin creates a shop by activity; owner runs a full weighed sale with grilling; stock, dashboard and cancellation reflect it', async () => {
    const { ctx, page, problems } = await newPage();
    // 1) platform administrator creates the shop through the UI
    await uiLogin(page, admin.email);
    await page.waitForSelector('text=Plateforme');
    const slug = uniq('atayib').toLowerCase();
    await page.getByRole('button', { name: /Nouvel établissement/ }).click();
    await page.fill('#sn', 'Atayib E2E'); await page.fill('#ss', slug);
    await page.getByText('Boucherie').click(); await page.getByText('Grillades').click();
    const ownerEmail = `owner.${slug}@test.local`;
    await page.fill('#on', 'Owner E2E'); await page.fill('#oe', ownerEmail); await page.fill('#op', PW);
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await page.waitForSelector(`td:has-text("${slug}")`);
    await page.getByRole('button', { name: 'Déconnexion' }).click();

    // 2) owner signs in; the shop shows ITS activities' starter catalog
    await uiLogin(page, ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link', { name: 'Produits & services' }).click();
    await page.waitForSelector('td:has-text("BUT-BOEUF")');
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
    const shop = await createShop(api, admin, 'pro', 'PP Securite E2E', ['security_systems']);
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
});
