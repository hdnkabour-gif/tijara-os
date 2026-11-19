import { api, errorBox, field, friendly, h, modal, newKey, num, toast } from './lib.js';
import { dateFmt, money, qtyFmt, t } from './i18n.js';

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
      h('tbody', null, low.map((r) => h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, `${qtyFmt(r.available)} ${r.base_uom}`))))))));
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
export async function itemsView(S) {
  const { items } = await api('GET', '/items');
  const wrap = h('div');
  const hasSample = items.some((i) => i.attributes?.sample);
  const rows = items.map((i) => h('tr', null, h('td', null, i.sku), h('td', null, i.name, i.attributes?.sample && h('span', { class: 'badge sample' }, ` ${t('sample')}`)),
    h('td', null, t(typeOf(i))), h('td', { class: 'num' }, money(i.price))));
  wrap.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_items')),
    can(S, 'catalog.manage') && h('button', { class: 'btn primary', id: 'new-item', type: 'button', onclick: () => openItem(() => itemsView(S).then((v) => wrap.replaceWith(v))) }, `+ ${t('newItem')}`)),
    hasSample && h('p', { class: 'note' }, t('sampleNote')),
    h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [t('sku'), t('name'), t('kind'), t('price')].map((x) => h('th', null, x)))), h('tbody', null, rows))));
  return wrap;
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
        h('td', { class: 'num' }, `${qtyFmt(r.on_hand)} ${r.base_uom}`), h('td', { class: 'num' }, qtyFmt(r.reserved)), h('td', { class: 'num' }, qtyFmt(r.available))))))));
  }
  wrap.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_stock')),
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
    if (it?.batch_tracking !== 'none') extra.append(...field(t('batchNo'), batch, 'r-batch'), ...field(t('expiresAt'), exp, 'r-exp'));
    if (it?.serial_tracking) extra.append(...field(t('serials'), serials, 'r-serials'), ...field(t('warrantyUntil'), warranty, 'r-war'));
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
  wrap.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('nav_customers')),
    can(S, 'customers.manage') && h('button', { class: 'btn primary', type: 'button', onclick: () => openCustomer(() => customersView(S).then((v) => wrap.replaceWith(v))) }, `+ ${t('add')}`)),
    h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [t('name'), t('phone'), t('creditLimit'), t('balance')].map((x) => h('th', null, x)))),
      h('tbody', null, customers.map((c) => h('tr', null, h('td', null, c.name), h('td', null, c.phone ?? ''), h('td', { class: 'num' }, money(c.credit_limit)), h('td', { class: 'num' }, money(c.balance))))))));
  return wrap;
}
function openCustomer(done) {
  const err = h('div'), name = h('input', { id: 'cname', required: true }), phone = h('input', { id: 'cphone', type: 'tel' }), limit = h('input', { id: 'climit', inputmode: 'decimal', value: '0' });
  const m = modal(t('add'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/customers', { name: name.value, phone: phone.value || undefined, creditLimit: num(limit.value) }); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'cname'), ...field(t('phone'), phone, 'cphone'), ...field(t('creditLimit'), limit, 'climit'), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('save')), cancelBtn({ close: () => m.close() }))));
}

// ───────────── invoices ─────────────
export async function invoicesView(S) {
  const { invoices } = await api('GET', '/invoices'); const wrap = h('div');
  const rows = invoices.map((i) => h('tr', null, h('td', null, i.invoice_no), h('td', null, dateFmt(i.created_at)), h('td', { class: 'num' }, money(i.total)), h('td', { class: 'num' }, money(i.paid)),
    h('td', null, h('span', { class: 'badge ' + (i.status === 'issued' ? 'ok' : 'bad') }, t(i.status))),
    h('td', null, can(S, 'sale.void') && i.status === 'issued' && h('button', { class: 'btn', type: 'button', 'data-cancel': i.invoice_no, onclick: () => openCancel(i, () => invoicesView(S).then((v) => wrap.replaceWith(v))) }, t('cancelSale')))));
  wrap.append(h('h1', null, t('invoices')), h('div', { class: 'card tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, [t('invoice'), t('date'), t('total'), t('paid'), t('status'), ''].map((x) => h('th', null, x)))), h('tbody', null, rows))));
  return wrap;
}
function openCancel(inv, done) {
  const err = h('div'), reason = h('input', { id: 'creason', required: true }),
    how = h('select', { id: 'chow' }, h('option', { value: 'waste' }, t('handlingWaste')), h('option', { value: 'return' }, t('handlingReturn'))), key = newKey();
  const m = modal(`${t('cancelSale')} ${inv.invoice_no}`, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', `/sales/${inv.order_id}/cancel`, { reason: reason.value, committed: how.value }, { 'idempotency-key': key }); toast(t('cancelled')); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('reason'), reason, 'creason'), ...field(t('handling'), how, 'chow'), err,
    h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, t('cancelSale')), cancelBtn({ close: () => m.close() }))));
}

// ───────────── team ─────────────
export async function usersView(S) {
  const [{ users }, { roles }] = await Promise.all([api('GET', '/users'), api('GET', '/roles')]); const wrap = h('div');
  wrap.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('users')),
    h('button', { class: 'btn primary', type: 'button', onclick: () => openUser(S, roles, () => usersView(S).then((v) => wrap.replaceWith(v))) }, `+ ${t('newUser')}`)),
    h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [t('name'), t('email'), t('role'), t('branches')].map((x) => h('th', null, x)))),
      h('tbody', null, users.map((u) => h('tr', null, h('td', null, u.name), h('td', null, u.email), h('td', null, u.role),
        h('td', null, u.branch_ids.length ? u.branch_ids.map((id) => S.branches.find((b) => b.id === id)?.name ?? '').join(', ') : t('allBranches'))))))));
  return wrap;
}
function openUser(S, roles, done) {
  const err = h('div'), name = h('input', { id: 'uname', required: true }), email = h('input', { id: 'uemail', type: 'email', required: true }),
    pw = h('input', { id: 'upw', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' }),
    role = h('select', { id: 'urole' }, roles.map((r) => h('option', { value: r }, r)));
  const boxes = S.branches.map((b) => ({ id: b.id, box: h('input', { type: 'checkbox', id: `ub-${b.id}` }) }));
  const m = modal(t('newUser'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/users', { name: name.value, email: email.value, password: pw.value, roleName: role.value, branchIds: boxes.filter((b) => b.box.checked).map((b) => b.id) }); m.close(); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'uname'), ...field(t('email'), email, 'uemail'), ...field(t('password'), pw, 'upw'), h('p', { class: 'muted' }, t('pwHint')),
    ...field(t('role'), role, 'urole'), h('label', null, t('branches')),
    h('div', { class: 'chips' }, S.branches.map((b, i) => h('label', { class: 'chip', for: `ub-${b.id}` }, boxes[i].box, ` ${b.name}`))), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('create')), cancelBtn({ close: () => m.close() }))));
}
