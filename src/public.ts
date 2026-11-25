import crypto from 'node:crypto';
import { SHOP_TZ } from './clock.js';
import { runCommand } from './commands.js';
import { withTenant } from './db.js';
import { HttpError, RateLimiter, bad, oneOf, str, uuid } from './http.js';
import type { Kit, Rc } from './kit.js';
import { serveFile } from './menu.js';
import { shopModules } from './entitlements.js';
import { type RequestIn, loadOptions, parseLines, quoteLines, insertRequest } from './orders.js';

/**
 * Phase D2, public side (no customer account): the menu of a shop that PUBLISHED it, its photos/videos, a server-side
 * quote, time slots with capacity, an order sent to the D1 inbox (never a sale until staff accept it), and a private
 * tracking link. Every endpoint is rate-limited; suspended / expired shops answer as if they had no menu.
 */
const TOKEN_TTL_MS = 2 * 3600_000, MIN_FILL_MS = 3_000;
const configuredSecret = process.env.PUBLIC_FORM_SECRET && process.env.PUBLIC_FORM_SECRET.length >= 32 ? process.env.PUBLIC_FORM_SECRET : null;
// without a configured secret (development/tests) a per-process one is used; production refuses online orders instead
const formSecret = configuredSecret ?? crypto.randomBytes(32).toString('hex');
const sign = (s: string) => crypto.createHmac('sha256', formSecret).update(s).digest('base64url');
/** A form token proves the order comes from a menu page opened a few seconds ago (bots post instantly or replay forever). */
export const formToken = (tenantId: string, now = Date.now()) => `${now}.${sign(`${tenantId}.${now}`)}`;
function checkFormToken(tenantId: string, token: unknown, now = Date.now()) {
  const [ts, mac] = String(token ?? '').split('.');
  const t = Number(ts);
  if (!t || !mac || mac.length !== 43 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(`${tenantId}.${t}`))))
    throw new HttpError(400, 'FORM_EXPIRED', 'please reload the menu and try again');
  if (now - t < MIN_FILL_MS) throw new HttpError(429, 'TOO_FAST', 'please take a moment to check your order');
  if (now - t > TOKEN_TTL_MS) throw new HttpError(400, 'FORM_EXPIRED', 'the menu page is too old: reload it');
}
/** Tracking token = <shop id 16 bytes><24 random bytes>, base64url (54 chars). Only its SHA-256 is stored. */
/** Derived from the order's idempotency key with the server secret: a retry gets the same link, and the token itself is
 *  never stored anywhere (neither in order_requests, which keeps its SHA-256, nor in the stored command result). */
const trackingFor = (tenantId: string, key: string) => Buffer.concat([Buffer.from(tenantId.replace(/-/g, ''), 'hex'),
  crypto.createHmac('sha256', formSecret).update(`track:${tenantId}:${key}`).digest().subarray(0, 24)]).toString('base64url');
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
function tenantOfToken(t: string): string | null {
  if (!/^[A-Za-z0-9_-]{54}$/.test(t)) return null;
  const hex = Buffer.from(t, 'base64url').subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pickup / dine-in time slots of the next days, in the shop's local time, with remaining capacity. */
async function slots(c: any, tenantId: string, s: any) {
  return (await c.query(`
    WITH days AS (SELECT ((now() AT TIME ZONE $1)::date + d) AS day FROM generate_series(0, $2::int) d),
    ranges AS (SELECT day, (r->>0)::time AS o, (r->>1)::time AS cl FROM days,
               jsonb_array_elements(COALESCE($3::jsonb -> extract(dow FROM day)::int::text, '[]'::jsonb)) r),
    raw AS (SELECT (gs AT TIME ZONE $1) AS at FROM ranges,
            generate_series(day + o, day + cl - make_interval(mins => $4::int), make_interval(mins => $4::int)) gs)
    SELECT raw.at, $5::int - COALESCE((SELECT count(*) FROM order_requests r WHERE r.tenant_id=$7 AND r.wanted_at=raw.at
               AND r.status IN ('pending','accepted')),0)::int AS left
      FROM raw WHERE raw.at >= now() + make_interval(mins => $6::int) ORDER BY raw.at LIMIT 300`,
    [SHOP_TZ, s.days_ahead, JSON.stringify(s.hours ?? {}), s.slot_minutes, s.slot_capacity, s.prep_minutes, tenantId])).rows
    .map((r: any) => ({ at: new Date(r.at).toISOString(), left: Math.max(0, r.left) }));
}

export function registerPublicRoutes(k: Kit) {
  const { add, runtime } = k;
  const byIp = new RateLimiter(240, 15 * 60_000), quotesByIp = new RateLimiter(120, 15 * 60_000);
  const ordersByIp = new RateLimiter(8, 15 * 60_000), ordersByShop = new RateLimiter(200, 60 * 60_000), trackByIp = new RateLimiter(120, 15 * 60_000);
  const limit = (rl: RateLimiter, key: string) => { if (!rl.allow(key)) throw new HttpError(429, 'RATE_LIMITED', 'too many requests, try again later'); };

  /** The shop behind a public slug (published menu, active shop, online module enabled) or a plain 404. */
  const shop = async (rc: Rc) => {
    limit(byIp, rc.ip);
    const slug = String(rc.params.slug ?? '');
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw new HttpError(404, 'NOT_FOUND', 'menu not found');
    const tenantId = (await runtime.query('SELECT public_shop_by_slug($1) AS id', [slug])).rows[0].id as string | null;
    if (!tenantId) throw new HttpError(404, 'NOT_FOUND', 'menu not found');
    const ctx = { tenantId };
    const found = await withTenant(runtime, ctx, async (c) => {
      const mods = await shopModules(c, tenantId);                    // plan ∩ platform override ∩ owner choice (Issue #19)
      if (!mods.has('online')) return null;
      const row = (await c.query('SELECT * FROM shop_menu_settings WHERE tenant_id=$1 AND published', [tenantId])).rows[0];
      return row ? { row, mods } : null;
    });
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'menu not found');
    // ONE effective answer for the menu and for checkout: taking orders also needs the 'orders' module. Orders already
    // received stay in the shop (and their tracking keeps working); they come back in the inbox when it is switched on.
    const s = { ...found.row, accepting_orders: found.row.accepting_orders && found.mods.has('orders') };
    return { tenantId, ctx, s, slug, kitchen: found.mods.has('kitchen') };
  };

  add('GET', '/public/shops/:slug/menu', 'public', async (rc) => {
    const { tenantId, ctx, s, slug } = await shop(rc);
    const out = await withTenant(runtime, ctx, async (c) => {
      const t = (await c.query('SELECT name FROM tenants WHERE id=$1', [tenantId])).rows[0];
      const brand = (await c.query('SELECT primary_color, accent_color, logo IS NOT NULL AS has_logo, updated_at FROM tenant_branding WHERE tenant_id=$1', [tenantId])).rows[0];
      const items = (await c.query(
        `SELECT i.id, i.name, i.price, i.base_uom, i.kind, i.track_quantity, m.category, m.description, m.ingredients, COALESCE(m.allergens,'{}') AS allergens,
                m.weight_label, m.serves, m.prep_minutes, COALESCE(m.sold_out,false) AS sold_out,
                COALESCE((SELECT sum(sb.on_hand - sb.reserved) FROM stock_balances sb WHERE sb.item_id=i.id AND sb.branch_id=$1 AND sb.stock_status='sellable'),0) AS free_qty,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'type',x.content_type,'alt',x.alt,'thumb',x.thumb_key IS NOT NULL,
                    'width',x.width,'height',x.height) ORDER BY x.position, x.created_at) FROM item_media x WHERE x.item_id=i.id),'[]'::jsonb) AS media
           FROM items i LEFT JOIN item_menu m ON m.tenant_id=i.tenant_id AND m.item_id=i.id
          WHERE i.active AND i.orderable ORDER BY COALESCE(m.position,0), m.category NULLS LAST, i.name`, [s.branch_id])).rows;
      const opts = await loadOptions(c, items.map((i: any) => i.id));
      return {
        shop: { name: t.name, slug, primaryColor: brand?.primary_color ?? null, accentColor: brand?.accent_color ?? null,
          logo: brand?.has_logo ? `/public/shops/${slug}/logo?v=${new Date(brand.updated_at).getTime()}` : null, message: s.message },
        ordering: { accepting: s.accepting_orders, pickup: s.pickup_enabled, dineIn: s.dine_in_enabled, prepMinutes: s.prep_minutes, hours: s.hours,
          slots: s.accepting_orders ? await slots(c, tenantId, s) : [] },
        items: items.map((i: any) => ({
          id: i.id, name: i.name, price: i.price, unit: i.base_uom, category: i.category, description: i.description, ingredients: i.ingredients,
          allergens: i.allergens, weightLabel: i.weight_label, serves: i.serves, prepMinutes: i.prep_minutes,
          // availability: the owner's "sold out" switch, and for stocked products the free quantity at the ordering branch
          available: !i.sold_out && (!i.track_quantity || Number(i.free_qty) > 0),
          media: i.media.map((m: any) => ({ ...m, url: `/public/shops/${slug}/media/${m.id}`, thumbUrl: m.thumb ? `/public/shops/${slug}/media/${m.id}?thumb=1` : null })),
          options: (opts.get(i.id) ?? []).map((g) => ({ id: g.id, name: g.name, required: g.required, multiple: g.multiple,
            choices: g.choices.filter((ch) => ch.add_item_id === null || ch.add_active).map((ch) => ({ id: ch.id, label: ch.label,
              extra: ch.add_item_id ? { price: ch.add_price, qtyMode: ch.qty_mode, qty: ch.add_qty } : null })) })),
        })),
        formToken: formToken(tenantId),
      };
    });
    return { body: out, headers: { 'cache-control': 'no-store' } };
  });

  add('GET', '/public/shops/:slug/media/:id', 'public', async (rc) => {
    const { ctx } = await shop(rc);
    const id = uuid(rc.params.id, 'id');
    const m = (await withTenant(runtime, ctx, (c) => c.query(
      `SELECT x.* FROM item_media x JOIN items i ON i.tenant_id=x.tenant_id AND i.id=x.item_id WHERE x.id=$1 AND i.active AND i.orderable`, [id]))).rows[0];
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'not found');           // unpublished products' media are never public
    return serveFile(k, rc, m, rc.query.get('thumb') === '1', 'public, max-age=3600');
  });
  add('GET', '/public/shops/:slug/logo', 'public', async (rc) => {
    const { tenantId, ctx } = await shop(rc);
    const r = (await withTenant(runtime, ctx, (c) => c.query('SELECT logo, logo_type FROM tenant_branding WHERE tenant_id=$1 AND logo IS NOT NULL', [tenantId]))).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'no logo');
    return { body: r.logo as Buffer, headers: { 'content-type': r.logo_type, 'cache-control': 'public, max-age=3600' } };
  });

  /** The full price BEFORE sending: computed by the server from the shop's prices and options. */
  add('POST', '/public/shops/:slug/quote', 'public', async (rc) => {
    const { ctx } = await shop(rc);
    limit(quotesByIp, rc.ip);
    const lines = parseLines(rc.body.lines).map((l) => ({ ...l, note: null }));
    const q = await withTenant(runtime, ctx, (c) => quoteLines(c, lines, { publicMenu: true }));
    return { body: { total: q.total, lines: q.priced.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, unit: l.unit, choices: l.picked.map((p: any) => p.label), total: l.total })) } };
  });

  add('POST', '/public/shops/:slug/orders', 'public', async (rc) => {
    const { tenantId, ctx, s, kitchen } = await shop(rc);
    if (k.production && !configuredSecret) throw new HttpError(503, 'NOT_CONFIGURED', 'online ordering is not configured on this server');
    limit(ordersByIp, rc.ip); limit(ordersByShop, tenantId);
    const b = rc.body;
    if (b.website) throw new HttpError(400, 'VALIDATION', 'invalid form');                   // honeypot: hidden field only bots fill
    checkFormToken(tenantId, b.formToken);
    if (!s.accepting_orders) throw new HttpError(409, 'CLOSED', 'this shop is not taking online orders right now');
    const mode = oneOf(b.mode ?? 'pickup', 'mode', ['pickup', 'dine_in'] as const);
    if (mode === 'pickup' && !s.pickup_enabled) throw bad('pickup is not offered');
    if (mode === 'dine_in' && !s.dine_in_enabled) throw bad('dine-in is not offered');
    const name = str(b.customerName, 'customerName', 100), phone = str(b.customerPhone, 'customerPhone', 30);
    if (!/^[+0-9 ().-]{6,30}$/.test(phone) || phone.replace(/\D/g, '').length < 8) throw bad('customerPhone is not a phone number');
    const wantedAt = str(b.wantedAt, 'wantedAt', 40);
    if (Number.isNaN(Date.parse(wantedAt))) throw bad('choose a time slot');
    const table = mode === 'dine_in' ? str(b.tableLabel, 'tableLabel', 30) : null;
    const key = String(rc.req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9_.:-]{16,100}$/.test(key)) throw bad('Idempotency-Key header (16-100 chars) is required');
    const p: RequestIn = {
      branchId: s.branch_id, channel: 'web', mode, customerId: null, customerName: name, customerPhone: phone, tableLabel: table,
      wantedAt: new Date(wantedAt).toISOString(), note: b.note == null || b.note === '' ? null : str(b.note, 'note', 300), toKitchen: true,   // replaced below by the shop's kitchen module
      lines: parseLines(b.lines),
    };
    const consent = b.contactConsent === true;
    // a shop without the kitchen module pays at once from the inbox; with it, the kitchen marks the order ready first
    p.toKitchen = kitchen;
    const tracking = trackingFor(tenantId, key);
    const result = await runCommand(runtime, ctx, { key: `web:${key}`, type: 'public_order', payload: { ...p, consent } }, async (cc) => {
      // one order at a time per shop for the slot check: two customers cannot both take the last place of a slot
      await cc.client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slots:${tenantId}`]);
      const slot = (await slots(cc.client, tenantId, s)).find((x: { at: string; left: number }) => x.at === p.wantedAt);
      if (!slot) throw bad('this time slot is not available: choose another one');
      if (slot.left <= 0) throw new HttpError(409, 'SLOT_FULL', 'this time slot is full: choose another one');
      const q = await quoteLines(cc.client, p.lines, { publicMenu: true });
      await insertRequest(cc, p, q, { trackingHash: hashToken(tracking), contactConsent: consent });
      return { total: q.total, wantedAt: p.wantedAt };                // stored for retries: no token in it
    });
    return { status: 201, body: { ...result, tracking } };
  });

  /** Private tracking: the token in the body (not the URL: no logs, no referrer). Status and the order only - no name, no phone. */
  add('POST', '/public/track', 'public', async (rc) => {
    limit(trackByIp, rc.ip);
    const token = String(rc.body.token ?? '');
    const tenantId = tenantOfToken(token);
    if (!tenantId) throw new HttpError(404, 'NOT_FOUND', 'order not found');
    const out = await withTenant(runtime, { tenantId }, async (c) => {
      const r = (await c.query(`SELECT r.id, r.status, r.mode, r.wanted_at, r.created_at, r.quote_total, o.state AS order_state, o.total AS order_total, t.name AS shop
          FROM order_requests r JOIN tenants t ON t.id=r.tenant_id LEFT JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.sales_order_id
         WHERE r.tracking_hash=$1`, [hashToken(token)])).rows[0];
      if (!r) return null;
      const lines = (await c.query(`SELECT i.name, l.qty, i.base_uom AS unit, l.choice_labels AS choices, l.quote_total AS total
          FROM order_request_lines l JOIN items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id WHERE l.request_id=$1 ORDER BY l.line_no`, [r.id])).rows;
      const step = r.status === 'pending' ? 'received' : r.status === 'rejected' ? 'refused'
        : ({ confirmed: 'accepted', in_preparation: 'preparing', ready: 'ready', closed: 'collected', cancelled: 'cancelled' } as Record<string, string>)[r.order_state] ?? 'accepted';
      return { shop: r.shop, step, mode: r.mode, wantedAt: r.wanted_at, createdAt: r.created_at, total: r.order_total ?? r.quote_total, lines };
    });
    if (!out) throw new HttpError(404, 'NOT_FOUND', 'order not found');
    return { body: out, headers: { 'cache-control': 'no-store' } };
  });
}
