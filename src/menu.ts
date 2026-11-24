import crypto from 'node:crypto';
import { audit } from './audit.js';
import { withTenant } from './db.js';
import { HttpError, bad, num, oneOf, str, uuid } from './http.js';
import type { Kit, Rc } from './kit.js';
import { LIMITS, MediaError, checkMedia } from './mediafile.js';
import { newKey } from './mediastore.js';

/**
 * Phase D2, owner side: public menu settings, dish cards, photos and short videos.
 * Files go to the persistent media store (never PostgreSQL); the database keeps metadata, order and ownership.
 */
const MAX_IMAGES = 8, MAX_VIDEOS = 1;
const ALLERGENS = ['gluten', 'lait', 'oeufs', 'arachides', 'fruits_a_coque', 'soja', 'poisson', 'crustaces', 'sesame', 'moutarde', 'celeri', 'sulfites'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const txt = (v: unknown, name: string, max: number) => (v == null || v === '' ? null : str(v, name, max));
const int = (v: unknown, name: string, min: number, max: number) => {
  if (v == null || v === '') return null;
  const n = num(v, name, { min }); if (!Number.isInteger(n) || n > max) throw bad(`${name} must be an integer from ${min} to ${max}`); return n;
};

/** Opening hours: {"0".."6": [["HH:MM","HH:MM"], ...]} (0 = Sunday), up to 3 ranges a day, open < close. */
export function parseHours(v: unknown): Record<string, [string, string][]> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('hours must be an object');
  const out: Record<string, [string, string][]> = {};
  for (const [day, ranges] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(day)) throw bad('hours: days are 0 (Sunday) to 6');
    if (!Array.isArray(ranges) || ranges.length > 3) throw bad('hours: up to 3 ranges a day');
    out[day] = ranges.map((r: any) => {
      if (!Array.isArray(r) || r.length !== 2 || !HHMM.test(r[0]) || !HHMM.test(r[1]) || r[0] >= r[1]) throw bad('hours: each range is ["HH:MM","HH:MM"] with opening before closing');
      return [r[0], r[1]] as [string, string];
    });
  }
  return out;
}

/** Is a module enabled for this shop (plan + platform override)? */
export async function shopHasFeature(c: any, tenantId: string, feature: string) {
  const r = (await c.query(`SELECT p.features, COALESCE(q.feature_overrides,'{}'::jsonb) AS o FROM tenants t JOIN plans p ON p.id=t.plan_id
      LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=$1`, [tenantId])).rows[0];
  if (!r) return false;
  return typeof r.o?.[feature] === 'boolean' ? r.o[feature] : Array.isArray(r.features) && r.features.includes(feature);
}

export function registerMenuRoutes(k: Kit) {
  const { add, authorize, runtime, media } = k;
  const needStore = () => { if (!media.enabled) throw new HttpError(503, 'MEDIA_UNAVAILABLE', media.reason ?? 'media storage unavailable'); };

  // ───────── settings ─────────
  add('GET', '/menu/settings', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.view');
    const out = await withTenant(runtime, a.ctx, async (c) => ({
      settings: (await c.query('SELECT * FROM shop_menu_settings WHERE tenant_id=$1', [a.ctx.tenantId])).rows[0] ?? null,
      slug: (await c.query('SELECT slug FROM tenants WHERE id=$1', [a.ctx.tenantId])).rows[0].slug,
      online: await shopHasFeature(c, a.ctx.tenantId, 'online'),
      mediaStorage: media.enabled,
    }));
    return { body: out };
  });
  add('PUT', '/menu/settings', 'session', async (rc) => {
    const a = await authorize(rc, 'settings.manage'), b = rc.body;
    const s = {
      published: b.published === true, acceptingOrders: b.acceptingOrders === true,
      pickupEnabled: b.pickupEnabled !== false, dineInEnabled: b.dineInEnabled === true,
      branchId: b.branchId ? uuid(b.branchId, 'branchId') : null,
      prepMinutes: int(b.prepMinutes, 'prepMinutes', 0, 1440) ?? 30, slotMinutes: [10, 15, 20, 30, 60].includes(Number(b.slotMinutes ?? 15)) ? Number(b.slotMinutes ?? 15) : bad('slotMinutes must be 10, 15, 20, 30 or 60'),
      slotCapacity: int(b.slotCapacity, 'slotCapacity', 1, 200) ?? 5, daysAhead: int(b.daysAhead, 'daysAhead', 0, 14) ?? 2,
      hours: parseHours(b.hours), message: txt(b.message, 'message', 300),
    };
    if (s.acceptingOrders && !s.published) throw bad('publish the menu before accepting online orders');
    if (s.acceptingOrders && !s.pickupEnabled && !s.dineInEnabled) throw bad('choose pickup and/or dine-in');
    if (s.acceptingOrders && !Object.values(s.hours).some((r) => r.length)) throw bad('set opening hours before accepting online orders');
    await withTenant(runtime, a.ctx, async (c) => {
      if ((s.published || s.acceptingOrders) && !(await shopHasFeature(c, a.ctx.tenantId, 'online'))) throw new HttpError(403, 'FEATURE_NOT_IN_PLAN', 'online menu is not included in this plan');
      let branch = s.branchId;
      if (!branch) branch = (await c.query('SELECT id FROM branches ORDER BY name LIMIT 1')).rows[0]?.id ?? null;
      else if (!(await c.query('SELECT 1 FROM branches WHERE id=$1', [branch])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'branch not found');
      if (!branch) throw bad('create a branch first');
      a.assertBranch(branch);
      await c.query(`INSERT INTO shop_menu_settings (tenant_id,published,accepting_orders,pickup_enabled,dine_in_enabled,branch_id,prep_minutes,slot_minutes,slot_capacity,days_ahead,hours,message,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
          ON CONFLICT (tenant_id) DO UPDATE SET published=EXCLUDED.published, accepting_orders=EXCLUDED.accepting_orders, pickup_enabled=EXCLUDED.pickup_enabled,
            dine_in_enabled=EXCLUDED.dine_in_enabled, branch_id=EXCLUDED.branch_id, prep_minutes=EXCLUDED.prep_minutes, slot_minutes=EXCLUDED.slot_minutes,
            slot_capacity=EXCLUDED.slot_capacity, days_ahead=EXCLUDED.days_ahead, hours=EXCLUDED.hours, message=EXCLUDED.message, updated_at=now()`,
        [a.ctx.tenantId, s.published, s.acceptingOrders, s.pickupEnabled, s.dineInEnabled, branch, s.prepMinutes, s.slotMinutes, s.slotCapacity, s.daysAhead, JSON.stringify(s.hours), s.message]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'menu.settings_updated', { type: 'tenant', id: a.ctx.tenantId }, undefined, { published: s.published, acceptingOrders: s.acceptingOrders });
    });
    return { body: { status: 'ok' } };
  });

  // ───────── dish cards ─────────
  add('GET', '/menu/items', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.view');
    const items = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT i.id, i.sku, i.name, i.price, i.base_uom, i.kind, i.active, i.orderable,
              m.category, m.description, m.ingredients, COALESCE(m.allergens,'{}') AS allergens, m.weight_label, m.serves, m.prep_minutes,
              COALESCE(m.sold_out,false) AS sold_out, COALESCE(m.position,0) AS position,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'type',x.content_type,'alt',x.alt,'bytes',x.bytes,'width',x.width,'height',x.height,
                  'durationMs',x.duration_ms,'thumb',x.thumb_key IS NOT NULL) ORDER BY x.position, x.created_at) FROM item_media x WHERE x.item_id=i.id),'[]'::jsonb) AS media
         FROM items i LEFT JOIN item_menu m ON m.tenant_id=i.tenant_id AND m.item_id=i.id
        WHERE i.active ORDER BY COALESCE(m.position,0), i.name`))).rows;
    return { body: { items, allergens: ALLERGENS, limits: { images: MAX_IMAGES, videos: MAX_VIDEOS, ...LIMITS } } };
  });
  add('PUT', '/items/:id/menu', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id'), b = rc.body;
    const allergens = b.allergens == null ? [] : Array.isArray(b.allergens) ? b.allergens.map((x: unknown) => oneOf(x, 'allergens[]', ALLERGENS)) : bad('allergens must be a list');
    const card = {
      category: txt(b.category, 'category', 60), description: txt(b.description, 'description', 600), ingredients: txt(b.ingredients, 'ingredients', 400),
      allergens: [...new Set(allergens as string[])], weightLabel: txt(b.weightLabel, 'weightLabel', 40), serves: int(b.serves, 'serves', 1, 50),
      prepMinutes: int(b.prepMinutes, 'prepMinutes', 0, 600), soldOut: b.soldOut === true, position: int(b.position, 'position', 0, 10000) ?? 0,
    };
    await withTenant(runtime, a.ctx, async (c) => {
      if (!(await c.query('SELECT 1 FROM items WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'item not found');
      await c.query(`INSERT INTO item_menu (tenant_id,item_id,category,description,ingredients,allergens,weight_label,serves,prep_minutes,sold_out,position)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id,item_id) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description,
          ingredients=EXCLUDED.ingredients, allergens=EXCLUDED.allergens, weight_label=EXCLUDED.weight_label, serves=EXCLUDED.serves,
          prep_minutes=EXCLUDED.prep_minutes, sold_out=EXCLUDED.sold_out, position=EXCLUDED.position`,
        [a.ctx.tenantId, id, card.category, card.description, card.ingredients, card.allergens, card.weightLabel, card.serves, card.prepMinutes, card.soldOut, card.position]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'item.card_updated', { type: 'item', id }, undefined, { soldOut: card.soldOut });
    });
    return { body: { status: 'ok' } };
  });

  // ───────── media: upload (raw body), thumbnail, order, alt text, delete, staff preview ─────────
  const store = async (data: Buffer) => { const key = newKey(); await media.put(key, data); return key; };
  add('POST', '/items/:id/media', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id');
    needStore();
    const kind = oneOf(rc.query.get('kind') ?? 'image', 'kind', ['image', 'video'] as const);
    let f;
    try { f = checkMedia(rc.body as Buffer, kind); } catch (e) { if (e instanceof MediaError) throw bad(e.message); throw e; }
    const sha = crypto.createHash('sha256').update(f.data).digest('hex');
    // count limits and position BEFORE writing the file; the row is inserted right after
    const pre = await withTenant(runtime, a.ctx, async (c) => {
      if (!(await c.query('SELECT 1 FROM items WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'item not found');
      const n = (await c.query('SELECT count(*) FILTER (WHERE kind=$2)::int AS n, COALESCE(max(position),-1)+1 AS pos FROM item_media WHERE item_id=$1', [id, f.kind])).rows[0];
      if (n.n >= (f.kind === 'image' ? MAX_IMAGES : MAX_VIDEOS)) throw new HttpError(409, 'LIMIT', f.kind === 'image' ? `at most ${MAX_IMAGES} photos per product` : 'one video per product');
      return n.pos as number;
    });
    const key = await store(f.data);
    try {
      const mediaId = await withTenant(runtime, a.ctx, async (c) => {
        const r = (await c.query(`INSERT INTO item_media (tenant_id,item_id,kind,content_type,storage_key,bytes,width,height,duration_ms,sha256,alt,position,created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [a.ctx.tenantId, id, f.kind, f.type, key, f.data.length, f.width ?? null, f.height ?? null, f.durationMs ?? null, sha,
            txt(rc.query.get('alt'), 'alt', 120), pre, a.ctx.userId])).rows[0].id;
        await audit(c, a.ctx.tenantId, a.ctx.userId, 'media.uploaded', { type: 'item', id }, undefined, { mediaId: r, kind: f.kind, bytes: f.data.length });
        return r;
      });
      return { status: 201, body: { id: mediaId, type: f.type, bytes: f.data.length, width: f.width, height: f.height, durationMs: f.durationMs } };
    } catch (e) { await media.remove(key); throw e; }                // no orphan file when the row fails
  }, { raw: LIMITS.videoBytes + 1024 });

  const ownMedia = async (rc: Rc, perm: string) => {
    const a = await authorize(rc, perm), id = uuid(rc.params.id, 'id');
    const m = (await withTenant(runtime, a.ctx, (c) => c.query('SELECT * FROM item_media WHERE id=$1', [id]))).rows[0];
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'media not found');
    return { a, m };
  };
  add('PUT', '/media/:id/thumb', 'session', async (rc) => {
    const { a, m } = await ownMedia(rc, 'catalog.manage');
    needStore();
    if (m.kind !== 'image') throw bad('thumbnails are for photos');
    let f;
    try { f = checkMedia(rc.body as Buffer, 'thumb'); } catch (e) { if (e instanceof MediaError) throw bad(e.message); throw e; }
    if (f.type !== 'image/jpeg') throw bad('a thumbnail is a JPEG image');            // every browser can produce it
    if ((f.width ?? 0) > 800 || (f.height ?? 0) > 800) throw bad('a thumbnail is at most 800 pixels');
    const key = await store(f.data);
    await withTenant(runtime, a.ctx, (c) => c.query('UPDATE item_media SET thumb_key=$2 WHERE id=$1', [m.id, key]));
    if (m.thumb_key) await media.remove(m.thumb_key);
    return { body: { status: 'ok' } };
  }, { raw: LIMITS.thumbBytes + 1024 });
  add('PATCH', '/media/:id', 'session', async (rc) => {
    const { a, m } = await ownMedia(rc, 'catalog.manage');
    await withTenant(runtime, a.ctx, (c) => c.query('UPDATE item_media SET alt=$2 WHERE id=$1', [m.id, txt(rc.body.alt, 'alt', 120)]));
    return { body: { status: 'ok' } };
  });
  add('PUT', '/items/:id/media-order', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id');
    const ids = (Array.isArray(rc.body.ids) ? rc.body.ids : bad('ids must be a list')).map((x: unknown) => uuid(x, 'ids[]'));
    await withTenant(runtime, a.ctx, async (c) => {
      const own = (await c.query('SELECT id FROM item_media WHERE item_id=$1', [id])).rows.map((r: any) => r.id).sort();
      if (JSON.stringify([...ids].sort()) !== JSON.stringify(own)) throw bad('send every media id of this product exactly once');
      for (const [i, mid] of ids.entries()) await c.query('UPDATE item_media SET position=$2 WHERE id=$1', [mid, i]);
    });
    return { body: { status: 'ok' } };
  });
  add('DELETE', '/media/:id', 'session', async (rc) => {
    const { a, m } = await ownMedia(rc, 'catalog.manage');
    await withTenant(runtime, a.ctx, async (c) => {
      await c.query('DELETE FROM item_media WHERE id=$1', [m.id]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'media.deleted', { type: 'item', id: m.item_id }, undefined, { mediaId: m.id });
    });
    await media.remove(m.storage_key);                               // the row is gone first: the file is never served again
    if (m.thumb_key) await media.remove(m.thumb_key);
    return { body: { status: 'ok' } };
  });
  /** Staff preview (also unpublished products); public serving is in public.ts. */
  add('GET', '/media/:id', 'session', async (rc) => {
    const { m } = await ownMedia(rc, 'catalog.view');
    return serveFile(k, rc, m, rc.query.get('thumb') === '1', 'private, max-age=300');
  });
}

/** Stream a stored file with its verified type; supports byte ranges (video seeking on phones). */
export function serveFile(k: Kit, rc: Rc, m: any, thumb: boolean, cache: string): { status: number; body: unknown; headers: Record<string, string> } {
  const key = thumb && m.thumb_key ? m.thumb_key : m.storage_key;
  const type = thumb && m.thumb_key ? 'image/jpeg' : m.content_type;
  const f = k.media.open(key);
  if (!f) throw new HttpError(404, 'NOT_FOUND', 'file not found');
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(rc.req.headers.range ?? ''));
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': cache, 'accept-ranges': 'bytes' };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : f.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
    if (start < 0) start = 0;
    end = Math.min(end, f.size - 1);
    if (start > end || start >= f.size) return { status: 416, body: { error: { code: 'RANGE', message: 'range not satisfiable' } }, headers: { 'content-range': `bytes */${f.size}` } };
    return { status: 206, body: f.stream(start, end), headers: { ...headers, 'content-range': `bytes ${start}-${end}/${f.size}`, 'content-length': String(end - start + 1) } };
  }
  return { status: 200, body: f.stream(), headers: { ...headers, 'content-length': String(f.size) } };
}
