import { audit } from './audit.js';
import { runCommand } from './commands.js';
import { withTenant } from './db.js';
import { HttpError, arr, bad, num, oneOf, optUuid, str, uuid } from './http.js';
import type { Kit, Rc } from './kit.js';
import { cancelOrder, confirmOrder, createOrder, payOrder, type LineIn } from './sales.js';

/**
 * Phase D1: product options + order inbox. A request records what the customer wants (and a quote computed by the
 * server from item prices); ACCEPTING it creates a normal sales order through the sales engine (stock reserved, kitchen
 * queue, invoice at payment). Prices sent by a client are never used.
 */
const CHANNELS = ['counter', 'phone', 'whatsapp', 'table', 'web'] as const;
const MODES = ['pickup', 'dine_in'] as const;             // delivery comes with D4 (zones, fees, couriers)
const MAX_LINES = 30;
const opt = (v: unknown, name: string, max: number) => (v == null || v === '' ? null : str(v, name, max));
const money = (n: number) => Math.round(n * 100) / 100;
/** An optional list that may be EMPTY (no options, no choice picked); arr() requires at least one element. */
const list = (v: unknown, name: string, max: number): any[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw bad(`${name} must be an array (max ${max})`);
  return v;
};
const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;

type Choice = { id: string; group_id: string; label: string; add_item_id: string | null; qty_mode: 'same' | 'one'; add_price: string | null; add_active: boolean | null };
type Group = { id: string; name: string; required: boolean; multiple: boolean; choices: Choice[] };

export function registerOrderRoutes(k: Kit) {
  const { add, authorize, runtime, idemKey } = k;

  /** Options of a set of items, grouped (one query). */
  const loadOptions = async (c: any, itemIds: string[]): Promise<Map<string, Group[]>> => {
    const rows = (await c.query(
      `SELECT g.item_id, g.id AS gid, g.name, g.required, g.multiple, g.position AS gp,
              ch.id, ch.label, ch.add_item_id, ch.qty_mode, ch.position AS cp, ai.price AS add_price, ai.active AS add_active
         FROM item_option_groups g LEFT JOIN item_option_choices ch ON ch.tenant_id=g.tenant_id AND ch.group_id=g.id
         LEFT JOIN items ai ON ai.tenant_id=ch.tenant_id AND ai.id=ch.add_item_id
        WHERE g.item_id = ANY($1::uuid[]) ORDER BY g.position, g.name, ch.position, ch.label`, [itemIds])).rows;
    const out = new Map<string, Group[]>();
    for (const r of rows) {
      const groups = out.get(r.item_id) ?? []; out.set(r.item_id, groups);
      let g = groups.find((x) => x.id === r.gid);
      if (!g) { g = { id: r.gid, name: r.name, required: r.required, multiple: r.multiple, choices: [] }; groups.push(g); }
      if (r.id) g.choices.push({ id: r.id, group_id: r.gid, label: r.label, add_item_id: r.add_item_id, qty_mode: r.qty_mode, add_price: r.add_price, add_active: r.add_active });
    }
    return out;
  };

  // ───────── product options (owner / catalog.manage) ─────────
  add('GET', '/items/:id/options', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.view'), id = uuid(rc.params.id, 'id');
    const groups = await withTenant(runtime, a.ctx, async (c) => (await loadOptions(c, [id])).get(id) ?? []);
    return { body: { groups } };
  });
  /** Replace the whole option set of a product (simple to edit, nothing half-saved). Past requests keep their labels. */
  add('PUT', '/items/:id/options', 'session', async (rc) => {
    const a = await authorize(rc, 'catalog.manage'), id = uuid(rc.params.id, 'id');
    // groups/choices sent back with their id keep it: pending orders that chose them stay valid
    const groups = list(rc.body.groups, 'groups', 10).map((g: any, i: number) => ({
      id: optUuid(g.id, `groups[${i}].id`) ?? null,
      name: str(g.name, `groups[${i}].name`, 60), required: g.required === true, multiple: g.multiple === true,
      choices: list(g.choices, `groups[${i}].choices`, 20).map((ch: any, j: number) => ({
        id: optUuid(ch.id, `groups[${i}].choices[${j}].id`) ?? null,
        label: str(ch.label, `groups[${i}].choices[${j}].label`, 60),
        addItemId: optUuid(ch.addItemId, `groups[${i}].choices[${j}].addItemId`) ?? null,
        qtyMode: oneOf(ch.qtyMode ?? 'same', 'qtyMode', ['same', 'one'] as const),
      })),
    }));
    for (const g of groups) if (g.choices.length === 0) throw bad(`option "${g.name}" needs at least one choice`);
    await withTenant(runtime, a.ctx, async (c) => {
      const item = (await c.query('SELECT id FROM items WHERE id=$1', [id])).rows[0];
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'item not found');
      for (const g of groups) for (const ch of g.choices) if (ch.addItemId) {
        if (ch.addItemId === id) throw bad('a choice cannot add the product itself');
        const x = (await c.query('SELECT active FROM items WHERE id=$1', [ch.addItemId])).rows[0];
        if (!x || !x.active) throw bad(`choice "${ch.label}": the added product is missing or archived`);
      }
      // upsert: an id that already belongs to THIS product is updated in place; anything not sent back is removed
      const existing = (await c.query(`SELECT g.id AS gid, ch.id AS cid FROM item_option_groups g
          LEFT JOIN item_option_choices ch ON ch.tenant_id=g.tenant_id AND ch.group_id=g.id WHERE g.item_id=$1`, [id])).rows;
      const ownGroups = new Set(existing.map((r: any) => r.gid));
      const keptGroups: string[] = [], keptChoices: string[] = [];
      let gp = 0;
      for (const g of groups) {
        let gid: string | null = g.id && ownGroups.has(g.id) ? g.id : null;
        if (gid) await c.query('UPDATE item_option_groups SET name=$2,required=$3,multiple=$4,position=$5 WHERE id=$1', [gid, g.name, g.required, g.multiple, gp++]);
        else gid = (await c.query('INSERT INTO item_option_groups (tenant_id,item_id,name,required,multiple,position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [a.ctx.tenantId, id, g.name, g.required, g.multiple, gp++])).rows[0].id;
        keptGroups.push(gid as string);
        const ownChoices = new Set(existing.filter((r: any) => r.gid === gid && r.cid).map((r: any) => r.cid));
        let cp = 0;
        for (const ch of g.choices) {
          if (ch.id && ownChoices.has(ch.id)) {
            await c.query('UPDATE item_option_choices SET label=$2,add_item_id=$3,qty_mode=$4,position=$5 WHERE id=$1', [ch.id, ch.label, ch.addItemId, ch.qtyMode, cp++]);
            keptChoices.push(ch.id);
          } else keptChoices.push((await c.query('INSERT INTO item_option_choices (tenant_id,group_id,label,add_item_id,qty_mode,position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [a.ctx.tenantId, gid, ch.label, ch.addItemId, ch.qtyMode, cp++])).rows[0].id);
        }
      }
      await c.query(`DELETE FROM item_option_choices ch USING item_option_groups g
          WHERE ch.tenant_id=g.tenant_id AND ch.group_id=g.id AND g.item_id=$1 AND NOT (ch.id = ANY($2::uuid[]))`, [id, keptChoices]);
      await c.query('DELETE FROM item_option_groups WHERE item_id=$1 AND NOT (id = ANY($2::uuid[]))', [id, keptGroups]);
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'item.options_updated', { type: 'item', id }, undefined, { groups: groups.map((g) => ({ name: g.name, choices: g.choices.map((x) => x.label) })) });
    });
    return { body: { status: 'ok' } };
  });

  /** What staff can take an order for: orderable, active products with their options. */
  add('GET', '/order-menu', 'session', async (rc) => {
    const a = await authorize(rc, 'orders.view');
    const out = await withTenant(runtime, a.ctx, async (c) => {
      const items = (await c.query(`SELECT id, sku, name, price, base_uom, kind FROM items WHERE orderable AND active ORDER BY name`)).rows;
      const opts = await loadOptions(c, items.map((i: any) => i.id));
      return items.map((i: any) => ({ ...i, options: (opts.get(i.id) ?? []).map((g) => ({ ...g, choices: g.choices.filter((ch) => ch.add_item_id === null || ch.add_active) })) }));
    });
    return { body: { items: out } };
  });

  /** Validate one request line against the product's options and compute its server-side quote. */
  const priceLine = (item: any, groups: Group[], choiceIds: string[], qty: number, i: number) => {
    const all = groups.flatMap((g) => g.choices);
    const picked = choiceIds.map((cid) => { const ch = all.find((x) => x.id === cid); if (!ch) throw bad(`lines[${i}]: this choice does not belong to ${item.name}`); return ch; });
    if (new Set(choiceIds).size !== choiceIds.length) throw bad(`lines[${i}]: the same choice twice`);
    for (const g of groups) {
      const n = picked.filter((ch) => ch.group_id === g.id).length;
      if (g.required && n === 0) throw bad(`lines[${i}]: choose "${g.name}" for ${item.name}`);
      if (!g.multiple && n > 1) throw bad(`lines[${i}]: only one choice for "${g.name}"`);
    }
    for (const ch of picked) if (ch.add_item_id && !ch.add_active) throw bad(`lines[${i}]: "${ch.label}" is not available any more`);
    const extra = picked.filter((ch) => ch.add_item_id).map((ch) => ({ itemId: ch.add_item_id!, qty: ch.qty_mode === 'same' ? qty : 1, price: Number(ch.add_price) }));
    const total = money(qty * Number(item.price) + extra.reduce((s, x) => s + money(x.qty * x.price), 0));
    return { picked, extra, total };
  };

  // ───────── intake + inbox ─────────
  add('POST', '/order-requests', 'session', async (rc) => {
    const a = await authorize(rc, 'orders.manage'), b = rc.body;
    const branchId = uuid(b.branchId, 'branchId');
    a.assertBranch(branchId);
    const p = {
      branchId, channel: oneOf(b.channel ?? 'counter', 'channel', CHANNELS), mode: oneOf(b.mode ?? 'pickup', 'mode', MODES),
      customerId: optUuid(b.customerId, 'customerId') ?? null, customerName: opt(b.customerName, 'customerName', 100),
      customerPhone: opt(b.customerPhone, 'customerPhone', 30), tableLabel: opt(b.tableLabel, 'tableLabel', 30),
      wantedAt: b.wantedAt == null || b.wantedAt === '' ? null : str(b.wantedAt, 'wantedAt', 40), note: opt(b.note, 'note', 300),
      toKitchen: b.toKitchen !== false,
      lines: arr(b.lines, 'lines', MAX_LINES).map((l: any, i: number) => ({
        itemId: uuid(l.itemId, `lines[${i}].itemId`), qty: num(l.qty, `lines[${i}].qty`, { positive: true }),
        choiceIds: list(l.choiceIds, `lines[${i}].choiceIds`, 20).map((x: unknown, j: number) => uuid(x, `lines[${i}].choiceIds[${j}]`)),
        note: opt(l.note, `lines[${i}].note`, 200),
      })),
    };
    if (p.wantedAt && Number.isNaN(Date.parse(p.wantedAt))) throw bad('wantedAt must be a date and time');
    if (p.customerPhone && !/^[+0-9 ().-]{6,30}$/.test(p.customerPhone)) throw bad('customerPhone is not a phone number');
    if (p.mode === 'dine_in' && !p.tableLabel) throw bad('a table is required for dine-in');
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'order_request', payload: p }, async (cc) => {
      const ids = [...new Set(p.lines.map((l) => l.itemId))];
      const items = new Map((await cc.client.query('SELECT id, name, price, active, orderable, base_uom FROM items WHERE id = ANY($1::uuid[])', [ids])).rows.map((r: any) => [r.id, r]));
      const opts = await loadOptions(cc.client, ids);
      const priced = p.lines.map((l, i) => {
        const item = items.get(l.itemId);
        if (!item || !item.active || !item.orderable) throw bad(`lines[${i}]: this product cannot be ordered`);
        if (item.base_uom === 'unit' && !Number.isInteger(l.qty)) throw bad(`lines[${i}]: ${item.name} is sold by the unit`);
        return { ...l, ...priceLine(item, opts.get(l.itemId) ?? [], l.choiceIds, l.qty, i) };
      });
      const total = money(priced.reduce((s, l) => s + l.total, 0));
      const id = (await cc.client.query(`INSERT INTO order_requests (tenant_id,branch_id,channel,mode,customer_id,customer_name,customer_phone,table_label,
          wanted_at,note,to_kitchen,quote_total,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [cc.tenantId, p.branchId, p.channel, p.mode, p.customerId, p.customerName, p.customerPhone, p.tableLabel, p.wantedAt, p.note, p.toKitchen, total, cc.userId ?? null])).rows[0].id;
      let n = 0;
      for (const l of priced) await cc.client.query(`INSERT INTO order_request_lines (tenant_id,request_id,line_no,item_id,qty,choice_ids,choice_labels,note,quote_total)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [cc.tenantId, id, ++n, l.itemId, l.qty, l.choiceIds, l.picked.map((ch) => ch.label), l.note, l.total]);
      await audit(cc.client, cc.tenantId, cc.userId, 'order_request.created', { type: 'order_request', id }, undefined, { channel: p.channel, total });
      return { id, total };
    });
    return { status: 201, body: result };
  });

  add('GET', '/order-requests', 'session', async (rc) => {
    const a = await authorize(rc, 'orders.view'), branchId = uuid(rc.query.get('branchId'), 'branchId');
    a.assertBranch(branchId);
    const status = rc.query.get('status') ? oneOf(rc.query.get('status'), 'status', ['pending', 'accepted', 'rejected'] as const) : null;
    const requests = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT r.id, r.channel, r.mode, r.customer_name, r.customer_phone, r.table_label, r.wanted_at, r.note, r.to_kitchen, r.status,
              r.quote_total, r.sales_order_id, r.reason, r.created_at, r.decided_at, o.total AS order_total, o.state AS order_state,
              COALESCE(jsonb_agg(jsonb_build_object('item',i.name,'unit',i.base_uom,'qty',l.qty,'choices',l.choice_labels,'note',l.note,'total',l.quote_total)
                ORDER BY l.line_no) FILTER (WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines
         FROM order_requests r
         LEFT JOIN order_request_lines l ON l.tenant_id=r.tenant_id AND l.request_id=r.id
         LEFT JOIN items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id
         LEFT JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.sales_order_id
        WHERE r.branch_id=$1 AND ($2::text IS NULL OR r.status=$2)
        GROUP BY r.tenant_id, r.id, o.total, o.state
        ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 100`, [branchId, status]))).rows;
    return { body: { requests } };
  });

  const loadRequest = async (rc: Rc, perm: string) => {
    const a = await authorize(rc, perm), id = uuid(rc.params.id, 'id');
    const r = (await withTenant(runtime, a.ctx, (c) => c.query('SELECT branch_id FROM order_requests WHERE id=$1', [id]))).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'order request not found');
    a.assertBranch(r.branch_id);
    return { a, id };
  };

  /** Accept = one atomic command: the request becomes a confirmed sales order (stock reserved, sent to the kitchen). */
  add('POST', '/order-requests/:id/accept', 'session', async (rc) => {
    const { a, id } = await loadRequest(rc, 'orders.manage');
    if (!a.permissions.includes('sale.create')) throw new HttpError(403, 'FORBIDDEN', 'sale.create required to accept an order');
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'order_request_accept', payload: { id } }, async (cc) => {
      const r = (await cc.client.query('SELECT * FROM order_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (r.status !== 'pending') throw new HttpError(409, 'INVALID_STATE', `this order was already ${r.status}`);
      const lines = (await cc.client.query('SELECT * FROM order_request_lines WHERE request_id=$1 ORDER BY line_no', [id])).rows;
      const opts = await loadOptions(cc.client, [...new Set(lines.map((l: any) => l.item_id as string))]);
      const salesLines: LineIn[] = [];
      for (const l of lines) {
        // re-validate against the CURRENT options: a choice removed since intake cannot be sold silently
        const item = (await cc.client.query('SELECT id, name, price, active FROM items WHERE id=$1', [l.item_id])).rows[0];
        if (!item?.active) throw new HttpError(409, 'INVALID_STATE', 'a product of this order was archived');
        const { extra } = priceLine(item, opts.get(l.item_id) ?? [], l.choice_ids, Number(l.qty), l.line_no - 1);
        const note = [...l.choice_labels, l.note].filter(Boolean).join(' · ') || undefined;
        salesLines.push({ itemId: l.item_id, qty: Number(l.qty), prepRequired: r.to_kitchen, note });
        for (const x of extra) salesLines.push({ itemId: x.itemId, qty: x.qty, prepRequired: r.to_kitchen, note: `↳ ${item.name}` });
      }
      const { orderId } = await createOrder(cc, { branchId: r.branch_id, customerId: r.customer_id ?? undefined, lines: salesLines });
      // what the kitchen reads: the table and/or the customer's name (the channel code only when nothing else is known)
      const label = ([r.table_label ? `T${r.table_label}` : null, r.customer_name].filter(Boolean).join(' · ') || r.channel).slice(0, 60);
      await cc.client.query('UPDATE sales_orders SET service_label=$2 WHERE id=$1', [orderId, label]);
      await confirmOrder(cc, orderId);                                     // reserves stock: refused as a whole if short
      await cc.client.query(`UPDATE order_requests SET status='accepted', sales_order_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, orderId, cc.userId ?? null]);
      const total = (await cc.client.query('SELECT total FROM sales_orders WHERE id=$1', [orderId])).rows[0].total;
      await audit(cc.client, cc.tenantId, cc.userId, 'order_request.accepted', { type: 'order_request', id }, undefined, { orderId, total });
      return { orderId, total };
    });
    return { body: result };
  });
  /** Checkout of an accepted order from the inbox: at once when it does not go through the kitchen, else once it is ready.
   *  Same payment engine as everywhere (invoice issued once, stock committed once); retries replay the stored result. */
  add('POST', '/order-requests/:id/pay', 'session', async (rc) => {
    const { a, id } = await loadRequest(rc, 'orders.manage');
    if (!a.permissions.includes('sale.create')) throw new HttpError(403, 'FORBIDDEN', 'sale.create required to take a payment');
    const payments = list(rc.body.payments, 'payments', 5).map((p: any, i: number) => ({
      method: oneOf(p.method, `payments[${i}].method`, PAYMENT_METHODS), amount: num(p.amount, `payments[${i}].amount`, { positive: true }) }));
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'order_request_pay', payload: { id, payments } }, async (cc) => {
      const r = (await cc.client.query(`SELECT r.status, r.to_kitchen, r.sales_order_id, o.state FROM order_requests r
          LEFT JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.sales_order_id WHERE r.id=$1 FOR UPDATE OF r`, [id])).rows[0];
      if (r.status !== 'accepted') throw new HttpError(409, 'INVALID_STATE', 'accept the order before taking the payment');
      const payable = r.to_kitchen ? r.state === 'ready' : ['confirmed', 'ready'].includes(r.state);
      if (!payable) throw new HttpError(409, 'INVALID_STATE', r.to_kitchen ? 'the kitchen must mark the order ready before payment' : `cannot pay an order that is ${r.state}`);
      const invoice = await payOrder(cc, { orderId: r.sales_order_id, payments });
      await audit(cc.client, cc.tenantId, cc.userId, 'order_request.paid', { type: 'order_request', id }, undefined, { invoiceId: invoice.invoiceId });
      return invoice;
    });
    return { status: 201, body: result };
  });
  /** An accepted order that will not be collected: the sale is cancelled and its reserved stock released (before any preparation). */
  add('POST', '/order-requests/:id/cancel', 'session', async (rc) => {
    const { a, id } = await loadRequest(rc, 'orders.manage');
    if (!a.permissions.includes('sale.void')) throw new HttpError(403, 'FORBIDDEN', 'sale.void required to cancel an accepted order');
    const reason = str(rc.body.reason, 'reason', 300);
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'order_request_cancel', payload: { id, reason } }, async (cc) => {
      const r = (await cc.client.query(`SELECT r.status, r.sales_order_id, o.state FROM order_requests r
          LEFT JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.sales_order_id WHERE r.id=$1 FOR UPDATE OF r`, [id])).rows[0];
      if (r.status !== 'accepted' || r.state !== 'confirmed') throw new HttpError(409, 'INVALID_STATE', 'only an accepted order not yet prepared or paid can be cancelled here');
      await cancelOrder(cc, { orderId: r.sales_order_id, reason });
      await audit(cc.client, cc.tenantId, cc.userId, 'order_request.cancelled', { type: 'order_request', id }, undefined, { reason });
      return { state: 'cancelled' };
    });
    return { body: result };
  });
  add('POST', '/order-requests/:id/reject', 'session', async (rc) => {
    const { a, id } = await loadRequest(rc, 'orders.manage');
    const reason = str(rc.body.reason, 'reason', 300);
    await withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query(`UPDATE order_requests SET status='rejected', reason=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='pending'`, [id, reason, a.ctx.userId]);
      if (!r.rowCount) throw new HttpError(409, 'INVALID_STATE', 'only a pending order can be rejected');
      await audit(c, a.ctx.tenantId, a.ctx.userId, 'order_request.rejected', { type: 'order_request', id }, undefined, { reason });
    });
    return { body: { status: 'rejected' } };
  });
}
