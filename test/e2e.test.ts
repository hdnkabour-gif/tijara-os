import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PW, createShop, key, platformAdmin, staff, startApp, uniq } from './api-helpers.js';

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
    // each browser is a different client (the test server trusts the proxy header): the per-IP login limit (30 / 15 min)
    // stays real for each of them instead of counting every browser of the whole file as one address
    extraHTTPHeaders: { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
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
// no horizontal scroll on a phone; on failure, name the elements that stick out (CI fonts differ from local ones)
const fitsPhone = async (pg: P) => {
  const r = await pg.evaluate(() => {
    const w = window.screen.width, sw = document.documentElement.scrollWidth;
    const wide = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > w + 1 || b.left < -1; })
      .slice(-8).map((e) => `${e.tagName}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]} [${Math.round(e.getBoundingClientRect().left)},${Math.round(e.getBoundingClientRect().right)}] "${(e.textContent ?? '').trim().slice(0, 40)}"`);
    return { ok: sw <= w, sw, w, wide };
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
};
// NOTE: on an emulated phone Chrome widens the layout viewport to fit overflowing content, so innerWidth grows with it;
// 'no horizontal scroll' is checked against the real screen width (375 px) instead.
const shot=async(pg:P,name:string)=>{ if(process.env.SHOTS)await pg.screenshot({path:`${process.env.SHOTS}/${name}.png`}); };
// the platform admin lands on the Control Center overview; the shop list is its own page
const toShops = async (page: P, ar = false) => { await page.locator('nav.nav').getByRole('link', { name: ar ? 'المحلات' : 'Commerces', exact: true }).click(); };
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
    await toShops(page);
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
    await toShops(mobile.page, true);
    await mobile.page.waitForSelector('.platform-empty');
    expect(await mobile.page.locator('html').getAttribute('dir')).toBe('rtl');
    // the platform menu is its own: overview, shops, platform journal; no shop page (POS, stock...) appears in it
    expect(await mobile.page.locator('.workspace .nav a').allInnerTexts()).toEqual(['نظرة عامة','المحلات','سجل المنصة']);
    expect(await mobile.page.locator('.workspace.theme-platform').count()).toBe(1);
    await fitsPhone(mobile.page);
    expect([...problems, ...mobile.problems]).toEqual([]);
    await mobile.ctx.close();
  });

  it('E11: kitchen dashboard confirms a real order flow and fits a Moroccan mobile screen in Arabic', async () => {
    const shop=await createShop(api,admin,'pro','Grill Pilot',['butcher','grill']);
    const grillItems=(await api.call('GET','/items',{token:shop.ownerToken})).json.items;
    const grillItem=grillItems.find((x:any)=>x.sku==='GRL-CUISSON'), kefta=grillItems.find((x:any)=>x.sku==='BUT-KEFTA');
    await api.call('POST','/stock/receive',{token:shop.ownerToken,headers:{'idempotency-key':key()},body:{branchId:shop.branchId,itemId:kefta.id,qty:5,unitCost:70}});
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link',{name:'Cuisine & grill'}).click();
    await page.getByRole('button',{name:/Envoyer à la cuisine/}).click();
    await page.fill('#grill-label','Table 7');
    // one table, several items: grilling service + 1.2 kg of kefta
    await page.locator('#grill-item-0').selectOption(grillItem.id);
    await page.fill('#grill-qty-0','1');
    await page.getByRole('button',{name:/Ajouter un article/}).click();
    await page.locator('#grill-item-1').selectOption(kefta.id);
    await page.fill('#grill-qty-1','1.2');
    await page.locator('.modal button[type=submit]').click();
    await page.getByText('Table 7').waitFor();
    await page.getByRole('button',{name:'Démarrer la préparation'}).click();
    await page.getByRole('button',{name:'Marquer prête'}).click();
    await page.getByRole('button',{name:'Encaisser'}).click();
    await page.locator('.modal button[type=submit]').click();
    await page.getByText('Aucune opération à afficher').waitFor();
    const grillInvoices=(await api.call('GET','/invoices',{token:shop.ownerToken})).json.invoices;
    expect(grillInvoices).toHaveLength(1);
    expect(Number(grillInvoices[0].total)).toBe(152);                               // 1 x 20 + 1.2 kg x 110
    const keftaStock=(await api.call('GET',`/stock?branchId=${shop.branchId}`,{token:shop.ownerToken})).json.stock.find((r:any)=>r.sku==='BUT-KEFTA');
    expect(Number(keftaStock.on_hand)).toBeCloseTo(3.8,4);                          // the meat left stock exactly once
    expect(problems).toEqual([]);
    await ctx.close();

    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,shop.ownerEmail);
    await mobile.page.waitForSelector('#tile-sales');
    await mobile.page.locator('nav.nav').getByRole('link',{name:'المطبخ والمشوي'}).click();
    expect(await mobile.page.locator('html').getAttribute('dir')).toBe('rtl');
    await mobile.page.getByText('طلبات التحضير').waitFor();
    expect(await mobile.page.getByText('طلبات التحضير').isVisible()).toBe(true);
    expect(await mobile.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  });

  it('E12: workshop browser creates vehicle and delivers service invoice; mobile Arabic routes fit', async () => {
    const shop=await createShop(api,admin,'pro','Workshop E2E',['mechanic']);
    const allItems=(await api.call('GET','/items',{token:shop.ownerToken})).json.items;
    const service=allItems.find((i:any)=>i.sku==='MEC-VIDANGE'), labour=allItems.find((i:any)=>i.sku==='MEC-MO');
    await api.call('POST','/workshop/vehicles',{token:shop.ownerToken,body:{plate:'77-B-900',make:'Renault',model:'Clio',odometerKm:77000}});
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link',{name:'Véhicules',exact:true}).click();
    await page.getByRole('button',{name:/Ajouter un véhicule/}).click();
    await page.fill('#v-plate','18-A-501');
    await page.fill('#v-make','Dacia');
    await page.fill('#v-model','Logan');
    await page.fill('#v-km','40000');
    await page.locator('.modal button[type=submit]').click();
    await page.getByText(/18-A-501/).waitFor();
    await page.locator('nav.nav').getByRole('link',{name:'Atelier & réparations',exact:true}).click();
    await page.getByRole('button',{name:/Nouveau devis/}).click();
    // the mileage field follows the vehicle that is selected (not the first one of the list)
    await page.selectOption('#wo-vehicle',{label:'77-B-900 · Clio'});
    expect(await page.inputValue('#wo-km')).toBe('77000');
    await page.selectOption('#wo-vehicle',{label:'18-A-501 · Logan'});
    expect(await page.inputValue('#wo-km')).toBe('40000');
    // several lines: the service plus 1.5 hours of labour
    await page.selectOption('#wo-item-0',service.id);
    await page.fill('#wo-qty-0','1');
    await page.getByRole('button',{name:/Ajouter une ligne/}).click();
    await page.selectOption('#wo-item-1',labour.id);
    await page.fill('#wo-qty-1','1.5');
    await page.fill('#wo-warranty','60');
    await page.fill('#wo-next-date',new Date(Date.now()+180*86400000).toISOString().slice(0,10));
    await page.locator('.modal button[type=submit]').click();
    await page.getByText('18-A-501').waitFor();
    await page.getByRole('button',{name:'Approuver le devis'}).click();
    await page.getByRole('button',{name:'Commencer'}).click();
    await page.getByRole('button',{name:'Terminer'}).click();
    await page.getByRole('button',{name:'Livrer et facturer'}).click();
    await page.locator('.modal button[type=submit]').click();
    await page.getByText('Livré').waitFor();
    // nothing is "due" right after delivery when the next service is in the future
    expect((await api.call('GET',`/workshop/reminders?branchId=${shop.branchId}`,{token:shop.ownerToken})).json.reminders).toHaveLength(0);
    const invoices=(await api.call('GET','/invoices',{token:shop.ownerToken})).json.invoices;
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(330);                                 // 150 (service) + 1.5 h x 120
    expect(problems).toEqual([]);
    await ctx.close();

    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,shop.ownerEmail);
    await mobile.page.waitForSelector('#tile-sales');
    await mobile.page.locator('nav.nav').getByRole('link',{name:'الورشة والإصلاح'}).click();
    await mobile.page.getByText('الورشة وأوامر الإصلاح').waitFor();
    expect(await mobile.page.locator('html').getAttribute('dir')).toBe('rtl');
    await fitsPhone(mobile.page);
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  });

  it('E13: platform admin suspends and restores one shop through the responsive UI with no data deletion',async()=>{
    const shop=await createShop(api,admin,'pro','Suspension UI Pilot',['grocery']);
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,admin.email);
    await toShops(page);
    await page.waitForSelector('tr:has-text("Suspension UI Pilot")');
    const row=page.locator('tr:has-text("Suspension UI Pilot")');
    await row.getByRole('button',{name:'Gérer'}).click();
    await page.locator('#tenant-status').selectOption('suspended');
    await page.fill('#tenant-reason','Maintenance temporaire');
    await page.locator('.modal button[type=submit]').click();
    await page.waitForSelector('tr:has-text("Suspension UI Pilot") >> text=Suspendu');
    // the refreshed list is still the Control Center list: search/filters and the 360° link survive the edit
    expect(await page.locator('#shop-search').count()).toBe(1);
    expect(await page.locator('tr:has-text("Suspension UI Pilot")').getByRole('link',{name:'Suspension UI Pilot'}).count()).toBe(1);
    expect((await api.call('GET','/items',{token:shop.ownerToken})).status).toBe(423);
    await page.locator('tr:has-text("Suspension UI Pilot")').getByRole('button',{name:'Gérer'}).click();
    await page.locator('#tenant-status').selectOption('active');
    await page.locator('.modal button[type=submit]').click();
    await page.waitForSelector('tr:has-text("Suspension UI Pilot") >> text=Actif');
    expect((await api.call('GET','/items',{token:shop.ownerToken})).status).toBe(200);
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it('E1 (desktop, FR): platform admin creates a shop by activity; owner runs a full weighed sale with grilling; stock, dashboard and cancellation reflect it', async () => {
    const { ctx, page, problems } = await newPage();
    // 1) platform administrator creates the shop through the UI
    await uiLogin(page, admin.email);
    await toShops(page);
    const slug = uniq('butcher').toLowerCase();
    await page.getByRole('button', { name: /Nouvel établissement/ }).click();
    await page.fill('#sn', 'Butcher E2E'); await page.fill('#ss', slug);
    await page.locator('#act-butcher').check(); await page.locator('#act-grill').check();
    const ownerEmail = `owner.${slug}@test.local`;
    expect(await page.locator('#self-owner').count()).toBe(0);
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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

  it('E1b: commercial provisioning requires a separate owner in the platform shell', async () => {
    const {ctx,page}=await newPage();
    await uiLogin(page,admin.email);
    await toShops(page);
    await page.getByRole('button',{name:/Nouvel établissement/}).click();
    expect(await page.locator('#oe').isVisible()).toBe(true);
    expect(await page.locator('#self-owner').count()).toBe(0);
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
    await fitsPhone(page);
    const h = await page.locator('button.prod[data-sku=EPI-HUILE]').boundingBox();
    expect(h.height).toBeGreaterThanOrEqual(48);
    await page.tap('button.prod[data-sku=EPI-HUILE]'); await page.tap('button.prod[data-sku=EPI-HUILE]');   // 2 x 18
    await page.waitForFunction(() => /36[.,]00/.test(document.querySelector('#cart-total')?.textContent?.replace(/\s/g, '') ?? ''));
    await fitsPhone(page);
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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
    await page.locator('nav.nav').getByRole('link', { name: 'Caisse', exact: true }).click();
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

  it('E15: a delivery receipt whose response is lost and which is submitted again is recorded ONCE (same command)', async () => {
    const shop=await createShop(api,admin,'pro','Lost Response',['butcher']);
    const beef=(await api.call('GET','/items',{token:shop.ownerToken})).json.items.find((i:any)=>i.sku==='BUT-BOEUF');
    await api.call('POST','/suppliers',{token:shop.ownerToken,body:{name:'Abattoir Test'}});
    const {ctx,page,problems}=await newPage();
    let first=true;
    await page.route('**/purchase-receipts', async (route:any)=>{
      if(route.request().method()==='POST'&&first){ first=false; await route.fetch(); await route.abort('failed'); return; }   // server commits, client never sees the answer
      await route.continue();
    });
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link',{name:'Fournisseurs & achats',exact:true}).click();
    await page.getByRole('button',{name:/Réceptionner une livraison/}).click();
    await page.selectOption('#purchase-item-0',beef.id);
    await page.fill('#purchase-qty-0','12.5'); await page.fill('#purchase-cost-0','80');
    await page.locator('.modal button[type=submit]').click();
    await page.waitForSelector('.modal .error');                                  // the cashier sees a network error...
    await page.locator('.modal button[type=submit]').click();                    // ...and simply presses save again
    await page.waitForFunction(()=>!document.querySelector('.modal'));
    const receipts=(await api.call('GET',`/purchase-receipts?branchId=${shop.branchId}`,{token:shop.ownerToken})).json.receipts;
    expect(receipts).toHaveLength(1);                                             // one delivery, not two
    const st=(await api.call('GET',`/stock?branchId=${shop.branchId}`,{token:shop.ownerToken})).json.stock.find((r:any)=>r.sku==='BUT-BOEUF');
    expect(Number(st.on_hand)).toBe(12.5);
    expect(problems.filter((p:string)=>!/Failed to fetch|net::ERR_FAILED/.test(p))).toEqual([]);
    await ctx.close();
  }, 60_000);
  it('E16: a butcher receives two products in one delivery (one with lot + expiry), sees the receipt details and the expiry watch list', async () => {
    const shop=await createShop(api,admin,'pro','Receiving E2E',['butcher']);
    const items=(await api.call('GET','/items',{token:shop.ownerToken})).json.items;
    const beef=items.find((i:any)=>i.sku==='BUT-BOEUF'), chicken=items.find((i:any)=>i.sku==='BUT-POULET');
    await api.call('POST','/suppliers',{token:shop.ownerToken,body:{name:'Abattoir Test'}});
    const in2=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link',{name:'Fournisseurs & achats',exact:true}).click();
    await page.getByRole('button',{name:/Réceptionner une livraison/}).click();
    await page.selectOption('#purchase-item-0',beef.id);
    await page.fill('#purchase-qty-0','20'); await page.fill('#purchase-cost-0','90');
    await page.fill('#purchase-batch-0','L-E2E-1'); await page.fill('#purchase-exp-0',in2);
    await page.getByRole('button',{name:/Ajouter un article/}).click();
    await page.selectOption('#purchase-item-1',chicken.id);
    expect(await page.locator('#purchase-batch-1').count()).toBe(0);               // chicken has no lot tracking: no lot field shown
    await page.fill('#purchase-qty-1','8'); await page.fill('#purchase-cost-1','25');
    await page.locator('.modal button[type=submit]').click();
    await page.waitForFunction(()=>!document.querySelector('.modal'));
    // the lot that expires in 2 days is listed first thing on the page
    await page.locator('#expiring-list').getByText(/L-E2E-1/).waitFor();
    await page.locator('#receipt-list button').first().click();
    const detail=page.locator('#receipt-detail');
    await detail.getByText('L-E2E-1').waitFor();
    await shot(page,'e16-receipt-detail');
    expect(await detail.innerText()).toMatch(/Poulet/);
    expect(await detail.locator('.total').innerText()).toMatch(/2[.\s\u202f]?000,00/);       // 20 x 90 + 8 x 25
    await noLeaks(page);
    expect(problems).toEqual([]);
    await ctx.close();
    // the same page and the receiving dialog on an Arabic phone: right-to-left and no sideways scrolling
    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,shop.ownerEmail);
    await mobile.page.waitForSelector('#tile-sales');
    await mobile.page.locator('nav.nav').getByRole('link',{name:'الموردون والمشتريات'}).click();
    await mobile.page.locator('#expiring-list').waitFor();
    await mobile.page.getByRole('button',{name:/تسجيل تسلم بضاعة/}).click();
    await mobile.page.selectOption('#purchase-item-0',beef.id);
    await mobile.page.locator('#purchase-exp-0').waitFor();
    await shot(mobile.page,'e16-receive-mobile-ar');
    await fitsPhone(mobile.page);
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  }, 60_000);

  it('E17: a mechanic changes the owner and plate of a sold car; history shows both owners and the warranty end of the repair', async () => {
    const shop=await createShop(api,admin,'pro','Vehicle edit E2E',['mechanic']);
    const items=(await api.call('GET','/items',{token:shop.ownerToken})).json.items;
    const seller=(await api.call('POST','/customers',{token:shop.ownerToken,body:{name:'Client Vendeur'}})).json.id;
    await api.call('POST','/customers',{token:shop.ownerToken,body:{name:'Client Acheteur'}});
    const v=(await api.call('POST','/workshop/vehicles',{token:shop.ownerToken,body:{plate:'10-A-100',make:'Peugeot',model:'208',odometerKm:20000,customerId:seller}})).json.id;
    const q=(await api.call('POST','/workshop/orders',{token:shop.ownerToken,headers:{'idempotency-key':key()},body:{branchId:shop.branchId,vehicleId:v,mileageAtVisit:20000,warrantyDays:90,
      lines:[{itemId:items.find((i:any)=>i.sku==='MEC-VIDANGE').id,qty:1}]}})).json.id;
    for(const step of ['approve','start','complete'])await api.call('POST',`/workshop/orders/${q}/${step}`,{token:shop.ownerToken,headers:{'idempotency-key':key()},body:{}});
    await api.call('POST',`/workshop/orders/${q}/deliver`,{token:shop.ownerToken,headers:{'idempotency-key':key()},body:{payments:[{method:'cash',amount:150}]}});
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    await page.locator('nav.nav').getByRole('link',{name:'Véhicules',exact:true}).click();
    await page.getByRole('button',{name:'Modifier'}).click();
    expect(await page.inputValue('#ve-km')).toBe('20000');
    await page.fill('#ve-plate','20-B-200');
    await page.selectOption('#ve-customer',{label:'Client Acheteur'});
    await page.fill('#ve-note','Véhicule vendu');
    await page.locator('.modal button[type=submit]').click();
    await page.getByText(/20-B-200 · Peugeot 208/).waitFor();
    await page.getByText(/Client Acheteur/).waitFor();
    await page.getByRole('button',{name:'Historique'}).click();
    const owners=page.locator('#owner-history li');
    await owners.first().waitFor();
    expect(await owners.count()).toBe(2);
    expect(await owners.nth(0).innerText()).toMatch(/Client Acheteur · 20-B-200 .*Véhicule vendu/);
    expect(await owners.nth(1).innerText()).toMatch(/Client Vendeur · 10-A-100/);
    expect(await page.locator('#repair-history').innerText()).toMatch(/Sous garantie · Garantie jusqu’au/);
    await shot(page,'e17-history');
    await noLeaks(page);
    expect(problems).toEqual([]);
    await ctx.close();
    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,shop.ownerEmail);
    await mobile.page.waitForSelector('#tile-sales');
    await mobile.page.locator('nav.nav').getByRole('link',{name:'السيارات'}).click();
    await mobile.page.getByRole('button',{name:'السجل'}).click();
    await mobile.page.locator('#owner-history li').first().waitFor();
    await shot(mobile.page,'e17-history-mobile-ar');
    expect(await mobile.page.locator('#repair-history').innerText()).toMatch(/داخل الضمان/);
    await fitsPhone(mobile.page);
    await mobile.page.keyboard.press('Escape');
    await mobile.page.getByRole('button',{name:'تعديل'}).click();
    await mobile.page.locator('#ve-customer').waitFor();
    await shot(mobile.page,'e17-edit-mobile-ar');
    await fitsPhone(mobile.page);
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  }, 60_000);
  it('E18: on an Arabic phone, a mechanic limited to branch A sees only branch-A cars (no plate or owner of branch B)', async () => {
    const shop=await createShop(api,admin,'pro','Two branches E2E',['mechanic']);
    const b2=(await api.call('POST','/branches',{token:shop.ownerToken,body:{name:'Branch B'}})).json.id;
    const other=(await api.call('POST','/customers',{token:shop.ownerToken,body:{name:'Client Branche B'}})).json.id;
    await api.call('POST','/workshop/vehicles',{token:shop.ownerToken,body:{plate:'11-A-111',make:'Dacia',model:'Logan',branchId:shop.branchId}});
    await api.call('POST','/workshop/vehicles',{token:shop.ownerToken,body:{plate:'22-B-222',make:'Renault',model:'Kangoo',branchId:b2,customerId:other}});
    await api.call('POST','/roles',{token:shop.ownerToken,body:{name:'mech_a',permissions:['workshop.view','workshop.manage','customers.view']}});
    const m=await staff(api,shop,'mech_a',[shop.branchId]);
    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,m.email);
    await mobile.page.locator('nav.nav').getByRole('link',{name:'السيارات'}).click();
    await mobile.page.getByText(/11-A-111/).waitFor();
    const body=await mobile.page.evaluate(()=>document.body.innerText);
    expect(body).not.toMatch(/22-B-222|Kangoo|Client Branche B/);
    await fitsPhone(mobile.page);
    await shot(mobile.page,'e18-branch-a-mobile-ar');
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  }, 60_000);
  it('E19: the Control Center (navy, metadata only) and the shop workspace (its own colors and logo) are two separate products', async () => {
    // its own platform admin: the shared one already logged in many times in this file (login rate limit)
    const ccAdmin=await platformAdmin(api);
    const A=await createShop(api,admin,'pro','Atelier Bleu E2E',['butcher']);
    await api.call('POST','/customers',{token:A.ownerToken,body:{name:'Client Confidentiel'}});
    await api.call('PATCH',`/platform/tenants/${A.tenantId}/controls`,{token:admin.token,body:{limits:{max_items:4}}});   // 4/4 items: an alert
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,ccAdmin.email);
    await page.locator('#platform-overview').waitFor();
    expect(await page.locator('.workspace.theme-platform').count()).toBe(1);
    await page.locator('#platform-alerts').getByRole('link',{name:'Atelier Bleu E2E'}).first().waitFor();
    expect(await page.locator('#backup-state').innerText()).toMatch(/sauvegarde|Sauvegarde/);   // the state recorded by real backup runs
    await shot(page,'e19-platform-overview');
    await toShops(page);
    await page.fill('#shop-search','Atelier Bleu');
    expect(await page.locator('tbody tr:not([hidden])').count()).toBe(1);
    await page.locator('tbody tr:not([hidden])').getByRole('link',{name:'Atelier Bleu E2E'}).click();
    await page.locator('#shop-360').waitFor();
    await page.locator('#card-usage [data-usage=items]').getByText('4 / 4').waitFor();
    expect(await page.locator('#card-people').innerText()).toContain(A.ownerEmail);
    expect(await page.locator('body').innerText()).not.toContain('Client Confidentiel');
    await shot(page,'e19-shop-360');
    await page.locator('nav.nav').getByRole('link',{name:'Journal plateforme'}).click();
    await page.locator('#platform-audit').getByText('Abonnement / accès modifié').first().waitFor();
    expect(problems).toEqual([]);
    await ctx.close();

    // the shop owner sets red/gold colors and a logo: the shop workspace takes them, the platform never does
    const shopPage=await newPage();
    await uiLogin(shopPage.page,A.ownerEmail);
    await shopPage.page.locator('nav.nav').getByRole('link',{name:'Paramètres'}).click();
    await shopPage.page.locator('#branding-card').waitFor();
    await shopPage.page.fill('#brand-primary','#b91c1c');
    await shopPage.page.locator('#save-colors').click();
    await shopPage.page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()==='#b91c1c');
    await shopPage.page.locator('#branding-card').waitFor();
    await shopPage.page.setInputFiles('#brand-logo',{name:'logo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')});
    await shopPage.page.locator('#upload-logo').click();
    await shopPage.page.locator('.workspace.theme-shop img.brand-logo').waitFor();
    expect(await shopPage.page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())).toBe('#b91c1c');
    await shopPage.page.locator('nav.nav').getByRole('link',{name:'Ma formule'}).click();
    await shopPage.page.locator('#plan-usage [data-usage=items]').getByText('4 / 4').waitFor();
    await shot(shopPage.page,'e19-ma-formule');
    expect(shopPage.problems).toEqual([]);
    await shopPage.ctx.close();

    // Arabic phone: "Ma formule" fits, and the admin's Control Center keeps its own colors
    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,A.ownerEmail);
    await mobile.page.locator('nav.nav').getByRole('link',{name:'باقتي'}).click();
    await mobile.page.locator('#my-plan').waitFor();
    await fitsPhone(mobile.page);
    await shot(mobile.page,'e19-ma-formule-mobile-ar');
    await mobile.ctx.close();
    const adminMobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(adminMobile.page,ccAdmin.email);
    await adminMobile.page.locator('#platform-overview').waitFor();
    expect(await adminMobile.page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())).not.toBe('#b91c1c');
    await adminMobile.page.goto(`${base}/app/#/platform-shop?id=${A.tenantId}`);
    await adminMobile.page.locator('#shop-360').waitFor();
    await fitsPhone(adminMobile.page);
    // a real owner's e-mail can be long and unbreakable: it must wrap, not widen the phone screen (CI caught this)
    await adminMobile.page.evaluate(()=>{const li=document.createElement('li');li.textContent='owner.shopmwtsu3rb1cd3fabcdefghijklmnop@testlocaldomainexample.ma';document.querySelector('#card-people ul')!.append(li);});
    await fitsPhone(adminMobile.page);
    await shot(adminMobile.page,'e19-shop-360-mobile-ar');
    expect(adminMobile.problems).toEqual([]);
    await adminMobile.ctx.close();
  }, 90_000);
  it('E20: support access through the UI: platform asks, the owner approves, support works under a banner, the owner cuts it off', async () => {
    const supAdmin=await platformAdmin(api);
    const A=await createShop(api,admin,'pro','Support UI shop',['butcher']);
    const adm=await newPage();
    await uiLogin(adm.page,supAdmin.email);
    await adm.page.locator('#platform-overview').waitFor();
    await adm.page.goto(`${base}/app/#/platform-shop?id=${A.tenantId}`);
    await adm.page.locator('#support-section').waitFor();
    await adm.page.fill('#sup-reason','Vérifier un prix affiché en caisse');
    await adm.page.selectOption('#sup-minutes','60');
    await adm.page.locator('#send-support').click();
    await adm.page.locator('#support-requests').getByText('En attente du propriétaire').waitFor();
    expect(await adm.page.locator('#enter-support').count()).toBe(0);              // nothing to enter before the owner says yes

    const own=await newPage();
    await uiLogin(own.page,A.ownerEmail);
    await own.page.locator('#support-pending').click();                           // the owner is told in the top bar
    await own.page.locator('#support-card .support-request').getByText('Vérifier un prix affiché en caisse').waitFor();
    await own.page.locator('#support-card .support-request').getByRole('button',{name:'Accepter'}).click();
    await own.page.locator('#revoke-support').waitFor();
    await own.page.locator('#support-pending').waitFor({state:'detached'});         // the top-bar notice goes away once decided
    await shot(own.page,'e20-owner-support');

    await adm.page.reload();
    await adm.page.locator('#enter-support').click();
    await adm.page.locator('#support-banner').waitFor();
    expect(await adm.page.locator('#support-banner').innerText()).toMatch(/Mode support TIJARA OS\s*· Diagnostic technique/);
    expect(await adm.page.locator('nav.nav').getByRole('link',{name:'Caisse',exact:true}).count()).toBe(0);   // view scope: no POS
    expect(await adm.page.locator('nav.nav a[href="#/items"]').count()).toBe(0);
    await adm.page.locator('#support-diagnostics').waitFor();
    await adm.page.locator('#support-banner').waitFor();
    await shot(adm.page,'e20-support-mode');

    await own.page.locator('#revoke-support').click();
    await own.page.locator('#support-card').getByText('Révoquée').waitFor();
    await adm.page.reload();
    await adm.page.locator('#platform-overview').waitFor();                        // back to the Control Center, no shop
    expect(await adm.page.locator('#support-banner').count()).toBe(0);
    await own.page.locator('nav.nav').getByRole('link',{name:'Journal'}).click();
    await own.page.getByText('support.request').first().waitFor();
    expect([...adm.problems.filter((p:string)=>!/40[03]/.test(p)),...own.problems]).toEqual([]);
    await adm.ctx.close(); await own.ctx.close();
  }, 90_000);
  it('E21: options set in the UI, a phone order with choices, accepted from the inbox, choices shown in the kitchen; fits an Arabic phone', async () => {
    const shop=await createShop(api,admin,'pro','Orders UI shop',['butcher','grill']);
    const items=(await api.call('GET','/items',{token:shop.ownerToken})).json.items;
    const beef=items.find((i:any)=>i.sku==='BUT-BOEUF'), grill=items.find((i:any)=>i.sku==='GRL-CUISSON');
    await api.call('POST','/stock/receive',{token:shop.ownerToken,headers:{'idempotency-key':key()},body:{branchId:shop.branchId,itemId:beef.id,qty:10,unitCost:80}});
    const {ctx,page,problems}=await newPage();
    await uiLogin(page,shop.ownerEmail);
    await page.waitForSelector('#tile-sales');
    // 1) the owner makes beef orderable with two options (in the product list)
    await page.locator('nav.nav').getByRole('link',{name:'Produits & services'}).click();
    await page.locator('tr[data-sku="BUT-BOEUF"] [data-action=options]').click();
    await page.locator('#opt-orderable').check();
    await page.getByRole('button',{name:/Ajouter une option/}).click();
    await page.fill('#og-name-0','Préparation'); await page.locator('#og-req-0').check();
    await page.fill('#oc-label-0-0','Nature');
    await page.locator('.option-group-edit').nth(0).getByRole('button',{name:/Ajouter un choix/}).click();
    await page.fill('#oc-label-0-1','Grillé'); await page.selectOption('#oc-add-0-1',grill.id);
    await page.getByRole('button',{name:/Ajouter une option/}).click();
    await page.fill('#og-name-1','Épices'); await page.fill('#oc-label-1-0','Sans épices');
    await page.locator('.modal button[type=submit]').click();
    await page.locator('tr[data-sku="BUT-BOEUF"]').getByText('Commandable').waitFor();
    // 2) a phone order: 1.5 kg grilled, no spices
    await page.locator('nav.nav').getByRole('link',{name:'Commandes',exact:true}).click();
    await page.locator('#new-order').click();
    await page.selectOption('#o-channel','phone');
    await page.fill('#o-name','Client Téléphone');
    await page.selectOption('#o-item-0',beef.id);
    await page.fill('#o-qty-0','1.5');
    await page.locator('.option-group').filter({hasText:'Préparation'}).getByText('Grillé').click();
    await page.locator('.option-group').filter({hasText:'Épices'}).getByText('Sans épices').click();
    await page.locator('.modal button[type=submit]').click();
    const card=page.locator('.order-card.pending').filter({hasText:'Client Téléphone'});
    await card.getByText(/Grillé · Sans épices/).waitFor();
    expect(await card.locator('.total').innerText()).toMatch(/210,00/);             // 1.5 x 120 + 1.5 x 20, computed by the server
    await noLeaks(page);
    await shot(page,'e21-inbox');
    // 3) accept: it becomes a sale in the kitchen queue with the customer's choices
    await card.locator('[data-action=accept]').click();
    await page.locator('.chip').filter({hasText:'Toutes'}).click();
    await page.locator('.order-card.accepted').filter({hasText:'Client Téléphone'}).waitFor();
    await page.locator('nav.nav').getByRole('link',{name:'Cuisine & grill'}).click();
    await page.locator('.kitchen-note').filter({hasText:'Grillé · Sans épices'}).waitFor();
    expect(await page.locator('main').innerText()).not.toMatch(/· phone|\d unit\b/);    // no raw codes on the kitchen screen (label, unit)
    await shot(page,'e21-kitchen');
    // the kitchen marks it ready, then it is paid from the inbox
    await page.getByRole('button',{name:'Démarrer la préparation'}).click();
    await page.getByRole('button',{name:'Marquer prête'}).click();
    await page.locator('nav.nav').getByRole('link',{name:'Commandes',exact:true}).click();
    await page.locator('.chip').filter({hasText:'Toutes'}).click();
    await page.locator('.order-card.accepted [data-action=pay-cash]').click();
    await page.locator('.order-card.accepted').getByText('Encaissée').waitFor();
    expect((await api.call('GET','/invoices',{token:shop.ownerToken})).json.invoices).toHaveLength(1);
    expect(problems).toEqual([]);
    await ctx.close();
    // 4) the order dialog on an Arabic phone
    const mobile=await newPage({mobile:true,locale:'ar-MA'});
    await uiLogin(mobile.page,shop.ownerEmail);
    await mobile.page.locator('nav.nav').getByRole('link',{name:'الطلبات'}).click();
    await mobile.page.locator('#new-order').click();
    await mobile.page.locator('.option-group').first().waitFor();
    await fitsPhone(mobile.page);
    await shot(mobile.page,'e21-new-order-mobile-ar');
    expect(mobile.problems).toEqual([]);
    await mobile.ctx.close();
  }, 90_000);
});
