import { editOptions, optionsLabel, orderableLabel } from './orders-views.js';
import { api, confirmBox, errorBox, field, friendly, h, modal, newKey, num, toast, put } from './lib.js';
import { dateFmt, money, qtyFmt, t, uom } from './i18n.js';

const can = (S, p) => S.me.permissions.includes(p);
const typeOf = (i) => (i.kind === 'service' ? 'type_service' : i.serial_tracking ? 'type_serial' : i.batch_tracking === 'required' ? 'type_batch' : i.base_uom === 'kg' ? 'type_weighed' : 'type_unit');
const branchSelect = (S, id, value, onchange) =>
  h('select', { id, onchange: (e) => onchange(e.target.value) }, S.branches.map((b) => h('option', { value: b.id, selected: b.id === value }, b.name)));
const cancelBtn = (m) => h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('cancel'));

// ───────────── dashboard ─────────────
export async function dashboardView(S) {
  const sum = await api('GET', '/reports/summary');
  const wrap = h('div', null, h('h1', null, t('nav_dashboard')),
    h('div', { class: 'grid tiles' },
      h('div', { class: 'tile', id: 'tile-sales' }, h('div', { class: 'v' }, money(sum.salesToday)), h('div', { class: 'l' }, t('salesToday'))),
      h('div', { class: 'tile', id: 'tile-invoices' }, h('div', { class: 'v' }, String(sum.invoicesToday)), h('div', { class: 'l' }, t('invoicesToday'))),
      h('div', { class: 'tile', id: 'tile-receivables' }, h('div', { class: 'v' }, money(sum.receivables)), h('div', { class: 'l' }, t('receivables')))),
    h('div', { class: 'card' }, h('h2', null, t('quickActions')), h('div', { class: 'row' },
      can(S, 'sale.create') && h('a', { class: 'btn primary', href: '#/pos' }, t('nav_pos')),
      can(S, 'stock.receive') && h('a', { class: 'btn', href: '#/stock' }, t('receive')),
      can(S, 'catalog.manage') && h('a', { class: 'btn', href: '#/items' }, t('newItem')))));
  if (can(S, 'stock.view') && S.branches[0]) {
    const { stock } = await api('GET', `/stock?branchId=${S.branches[0].id}`);
    const low = [...stock].sort((a, b) => Number(a.available) - Number(b.available)).slice(0, 5);
    wrap.appendChild(h('div', { class: 'card' }, h('h2', null, t('lowStock')), h('div', { class: 'tablewrap' }, h('table', null,
      h('tbody', null, low.map((r) => h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, `${qtyFmt(r.available)} ${uom(r.base_uom)}`))))))));
  }
  return wrap;
}

// ───────────── products & services ─────────────
const PRESETS = {
  type_unit: { kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'unit' },
  type_weighed: { kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg' },
  type_batch: { kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'unit', batchTracking: 'required' },
  type_serial: { kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'unit', serialTracking: true },
  type_service: { kind: 'service', trackQuantity: false, fulfillment: 'none', baseUom: 'unit' },
};
export async function itemsView(S, query) {
  const { items } = await api('GET', '/items');
  const showArchived = query?.get('archived') === '1';
  const wrap = h('div');
  const reload = () => itemsView(S, query).then((v) => wrap.replaceWith(v));
  const list = items.filter((i) => showArchived || i.active);
  const hasSample = list.some((i) => i.attributes?.sample);
  const manage = can(S, 'catalog.manage');
  const rows = list.map((i) => h('tr', { 'data-sku': i.sku, class: i.active ? '' : 'muted' }, h('td', null, i.sku),
    h('td', null, i.name, i.attributes?.sample && h('span', { class: 'badge sample' }, ` ${t('sample')}`), !i.active && h('span', { class: 'badge bad' }, ` ${t('archived')}`),
      i.orderable && h('span', { class: 'badge ok' }, ` ${orderableLabel()}`)),
    h('td', null, t(typeOf(i))), h('td', { class: 'num' }, money(i.price)),
    h('td', null, manage && h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', 'data-action': 'edit', onclick: () => editItem(i, reload) }, t('edit')),
      i.active && h('button', { class: 'btn', type: 'button', 'data-action': 'options', onclick: () => editOptions(i, items, reload).catch((e) => toast(friendly(e), true)) }, optionsLabel()),
      h('button', { class: 'btn danger', type: 'button', 'data-action': 'delete', onclick: async () => {
        if (!(await confirmBox(`${t('confirmDelete')} ${i.name}`))) return;
        try { await api('DELETE', `/items/${i.id}`); toast(t('deleted')); reload(); } catch (e) { toast(friendly(e), true); }
      } }, t('del'))))));
  put(wrap, h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_items')),
    h('label', { class: 'chip', for: 'show-archived' }, h('input', { type: 'checkbox', id: 'show-archived', checked: showArchived, onchange: (e) => { location.hash = e.target.checked ? '#/items?archived=1' : '#/items'; } }), ` ${t('showArchived')}`),
    manage && h('button', { class: 'btn primary', id: 'new-item', type: 'button', onclick: () => openItem(reload) }, `+ ${t('newItem')}`)),
    hasSample && h('p', { class: 'note' }, t('sampleNote')),
    h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [t('sku'), t('name'), t('kind'), t('price'), manage ? t('actions') : ''].map((x) => h('th', null, x)))), h('tbody', null, rows))));
  return wrap;
}
function editItem(i, done) {
  const err = h('div'), name = h('input', { id: 'ename', value: i.name, required: true }), price = h('input', { id: 'eprice', inputmode: 'decimal', value: String(Number(i.price)) }),
    active = h('input', { type: 'checkbox', id: 'eactive', checked: i.active });
  const m = modal(`${t('edit')} — ${i.sku}`, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const p = num(price.value);
    if (Number.isNaN(p) || p < 0) return void err.replaceChildren(errorBox(t('price')));
    try { await api('PATCH', `/items/${i.id}`, { name: name.value, price: p, active: active.checked }); m.close(); toast(t('saved')); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'ename'), ...field(t('price'), price, 'eprice'),
    h('div', { class: 'perm-row' }, active, h('label', { for: 'eactive' }, t('activeLabel'))), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('save')), cancelBtn({ close: () => m.close() }))));
}
function openItem(done) {
  const err = h('div'), sku = h('input', { id: 'isku', required: true }), name = h('input', { id: 'iname', required: true }),
    price = h('input', { id: 'iprice', inputmode: 'decimal', value: '0' }),
    type = h('select', { id: 'itype' }, Object.keys(PRESETS).map((k) => h('option', { value: k }, t(k))));
  const m = modal(t('newItem'), h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    const p = num(price.value);
    if (Number.isNaN(p) || p < 0) return void err.replaceChildren(errorBox(t('price')));
    try { await api('POST', '/items', { sku: sku.value, name: name.value, price: p, ...PRESETS[type.value] }); toast(t('save')); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('itemType'), type, 'itype'), ...field(t('sku'), sku, 'isku'), ...field(t('name'), name, 'iname'), ...field(t('price'), price, 'iprice'), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('create')), cancelBtn({ close: () => m.close() }))));
}

// ───────────── stock ─────────────
export async function stockView(S) {
  const wrap = h('div'); let branchId = S.branches[0]?.id;
  const body = h('div');
  async function load() {
    const { stock } = await api('GET', `/stock?branchId=${branchId}`);
    body.replaceChildren(h('div', { class: 'card tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, [t('sku'), t('name'), t('stockOnHand'), t('reserved'), t('available')].map((x) => h('th', null, x)))),
      h('tbody', null, stock.map((r) => h('tr', null, h('td', null, r.sku), h('td', null, r.name),
        h('td', { class: 'num' }, `${qtyFmt(r.on_hand)} ${uom(r.base_uom)}`), h('td', { class: 'num' }, qtyFmt(r.reserved)), h('td', { class: 'num' }, qtyFmt(r.available))))))));
  }
  put(wrap, h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_stock')),
    S.branches.length > 1 && branchSelect(S, 'stock-branch', branchId, (v) => { branchId = v; load(); }),
    can(S, 'stock.receive') && h('button', { class: 'btn primary', id: 'receive-btn', type: 'button', onclick: () => openReceive(S, () => branchId, load) }, `+ ${t('receive')}`)), body);
  await load();
  return wrap;
}
async function openReceive(S, getBranch, done) {
  const { items } = await api('GET', '/items');
  const tracked = items.filter((i) => i.track_quantity);
  const err = h('div'), sel = h('select', { id: 'r-item' }, tracked.map((i) => h('option', { value: i.id }, `${i.sku} — ${i.name}`))),
    qty = h('input', { id: 'r-qty', inputmode: 'decimal', value: '1' }), cost = h('input', { id: 'r-cost', inputmode: 'decimal', value: '0' }),
    batch = h('input', { id: 'r-batch' }), exp = h('input', { id: 'r-exp', type: 'date' }), warranty = h('input', { id: 'r-war', type: 'date' }),
    serials = h('textarea', { id: 'r-serials', rows: '4' });
  const extra = h('div');
  const key = newKey();
  const refresh = () => {
    const it = tracked.find((i) => i.id === sel.value);
    extra.replaceChildren();
    if (it?.batch_tracking !== 'none') put(extra, ...field(t('batchNo'), batch, 'r-batch'), ...field(t('expiresAt'), exp, 'r-exp'));
    if (it?.serial_tracking) put(extra, ...field(t('serials'), serials, 'r-serials'), ...field(t('warrantyUntil'), warranty, 'r-war'));
  };
  sel.addEventListener('change', refresh); refresh();
  const m = modal(t('receive'), h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    const it = tracked.find((i) => i.id === sel.value);
    const body = { branchId: getBranch(), itemId: it.id, qty: num(qty.value), unitCost: num(cost.value) };
    if (it.batch_tracking !== 'none' && batch.value) { body.batchNo = batch.value; if (exp.value) body.expiresAt = new Date(exp.value).toISOString(); }
    if (it.serial_tracking) {
      const list = serials.value.split('\n').map((s) => s.trim()).filter(Boolean);
      body.serials = list.map((serialNo) => ({ serialNo, ...(warranty.value ? { warrantyUntil: warranty.value } : {}) })); body.qty = list.length;
    }
    try { await api('POST', '/stock/receive', body, { 'idempotency-key': key }); toast(t('save')); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('item'), sel, 'r-item'), ...field(t('qty'), qty, 'r-qty'), ...field(t('unitCost'), cost, 'r-cost'), extra, err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('save')), cancelBtn({ close: () => m.close() }))));
}

// ───────────── customers ─────────────
export async function customersView(S) {
  const { customers } = await api('GET', '/customers'); const wrap = h('div');
  const reload = () => customersView(S).then((v) => wrap.replaceWith(v));
  const manage = can(S, 'customers.manage');
  put(wrap, h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_customers')),
    manage && h('button', { class: 'btn primary', id: 'new-customer', type: 'button', onclick: () => openCustomer(reload) }, `+ ${t('add')}`)),
    h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [t('name'), t('phone'), t('creditLimit'), t('balance'), manage ? t('actions') : ''].map((x) => h('th', null, x)))),
      h('tbody', null, customers.map((c) => h('tr', { 'data-customer': c.name, class: c.active ? '' : 'muted' },
        h('td', null, c.name, !c.active && h('span', { class: 'badge bad' }, ` ${t('archived')}`)), h('td', null, c.phone ?? ''), h('td', { class: 'num' }, money(c.credit_limit)), h('td', { class: 'num' }, money(c.balance)),
        h('td', null, manage && h('div', { class: 'row-actions' },
          h('button', { class: 'btn', type: 'button', 'data-action': 'edit', onclick: () => openCustomer(reload, c) }, t('edit')),
          h('button', { class: 'btn danger', type: 'button', 'data-action': 'delete', onclick: async () => {
            if (!(await confirmBox(`${t('confirmDelete')} ${c.name}`))) return;
            try { await api('DELETE', `/customers/${c.id}`); toast(t('deleted')); reload(); } catch (e) { toast(friendly(e), true); }
          } }, t('del'))))))))));
  return wrap;
}
function openCustomer(done, c = null) {
  const err = h('div'), name = h('input', { id: 'cname', required: true, value: c?.name ?? '' }), phone = h('input', { id: 'cphone', type: 'tel', value: c?.phone ?? '' }),
    address = h('input', { id: 'caddr', value: c?.address ?? '' }), limit = h('input', { id: 'climit', inputmode: 'decimal', value: String(Number(c?.credit_limit ?? 0)) }),
    active = h('input', { type: 'checkbox', id: 'cactive', checked: c ? c.active : true });
  const m = modal(c ? `${t('edit')} — ${c.name}` : t('add'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const body = { name: name.value, phone: phone.value || undefined, address: address.value || undefined, creditLimit: num(limit.value) };
    try { if (c) await api('PATCH', `/customers/${c.id}`, { ...body, active: active.checked }); else await api('POST', '/customers', body); m.close(); toast(t('saved')); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'cname'), ...field(t('phone'), phone, 'cphone'), ...field(t('address'), address, 'caddr'), ...field(t('creditLimit'), limit, 'climit'),
    c && h('div', { class: 'perm-row' }, active, h('label', { for: 'cactive' }, t('activeLabel'))), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('save')), cancelBtn({ close: () => m.close() }))));
}

// ───────────── invoices ─────────────
export async function invoicesView(S) {
  const { invoices } = await api('GET', '/invoices'); const wrap = h('div');
  const rows = invoices.map((i) => h('tr', null, h('td', null, h('a', { href: `#/invoice?id=${i.id}`, 'data-invoice': i.invoice_no }, i.invoice_no)), h('td', null, dateFmt(i.created_at)), h('td', { class: 'num' }, money(i.total)), h('td', { class: 'num' }, money(i.paid)),
    h('td', null, h('span', { class: 'badge ' + (i.status === 'issued' ? 'ok' : 'bad') }, t(i.status))),
    h('td', null, can(S, 'sale.void') && i.status === 'issued' && h('button', { class: 'btn', type: 'button', 'data-cancel': i.invoice_no, onclick: () => openCancel(i, () => invoicesView(S).then((v) => wrap.replaceWith(v))) }, t('cancelSale')))));
  put(wrap, h('h1', null, t('invoices')), h('div', { class: 'card tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, [t('invoice'), t('date'), t('total'), t('paid'), t('status'), ''].map((x) => h('th', null, x)))), h('tbody', null, rows))));
  return wrap;
}
function openCancel(inv, done) {
  // "Return to stock" needs a manager approval workflow that has no UI/API yet, so the UI only offers write-off (never silently restocks).
  const err = h('div'), reason = h('input', { id: 'creason', required: true }), key = newKey();
  const m = modal(`${t('cancelSale')} ${inv.invoice_no}`, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', `/sales/${inv.order_id}/cancel`, { reason: reason.value, committed: 'waste' }, { 'idempotency-key': key }); toast(t('cancelled')); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('reason'), reason, 'creason'), h('p', { class: 'note' }, t('handlingWaste')), err,
    h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, t('cancelSale')), cancelBtn({ close: () => m.close() }))));
}

