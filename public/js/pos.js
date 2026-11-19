import { api, errorBox, field, friendly, h, modal, newKey, num, toast, put } from './lib.js';
import { money, qtyFmt, t, uom } from './i18n.js';

const r2 = (n) => Math.round(n * 100) / 100;
// Exact money maths: integer arithmetic that mirrors PostgreSQL numeric round(qty*price, 2) (half up), so the amount we send always equals the invoice.
const cents = (qty, price) => Number((BigInt(Math.round(qty * 1e4)) * BigInt(Math.round(Number(price) * 1e4)) + 500000n) / 1000000n);
const lineMoney = (l) => cents(l.qty, l.item.price) / 100;
const isWeighed = (i) => i.track_quantity && i.base_uom !== 'unit';

/** Touch POS. One screen for every activity: weighed items ask for a weight, serial items for a serial number,
 *  services behave like quantities, and a customer can be attached for credit sales. The server stays authoritative. */
export async function posView(S) {
  const [{ items }, custRes] = await Promise.all([api('GET', '/items'), S.me.permissions.includes('customers.view') ? api('GET', '/customers') : { customers: [] }]);
  const sellable = items.filter((i) => i.active);
  let branchId = S.branches[0]?.id, filter = 'all', q = '', cart = [], key = newKey(), busy = false, finished = null;
  const customers = custRes.customers;
  let customerId = '';

  const catalogEl = h('div', { class: 'catalog', id: 'catalog' });
  const cartEl = h('div', { class: 'card cart', id: 'cart' });
  const root = h('div', null, h('h1', null, t('nav_pos')));

  const total = () => cart.reduce((a, l) => a + cents(l.qty, l.item.price), 0) / 100;
  const touch = () => { key = newKey(); };                       // any cart change = a new business command

  function drawCatalog() {
    catalogEl.replaceChildren(...sellable
      .filter((i) => (filter === 'all' || (filter === 'service' ? i.kind === 'service' : i.kind !== 'service')) && (!q || `${i.name} ${i.sku}`.toLowerCase().includes(q.toLowerCase())))
      .map((i) => h('button', { type: 'button', class: 'prod' + (i.kind === 'service' ? ' service' : ''), 'data-sku': i.sku, onclick: () => pick(i) },
        h('span', { class: 'n' }, i.name), h('span', { class: 'p', dir: 'auto' }, `${money(i.price)}${isWeighed(i) ? ' / ' + uom(i.base_uom) : ''}`))));
  }

  function pick(item) {
    if (finished) finished = null;                           // touching the catalog after a paid sale always starts a NEW sale
    if (item.serial_tracking) return askSerial(item);
    if (isWeighed(item)) return askWeight(item);
    const ex = cart.find((l) => l.item.id === item.id);
    if (ex) ex.qty = r2(ex.qty + 1); else cart.push({ item, qty: 1 });
    touch(); drawCart();
  }
  function askWeight(item) {
    const w = h('input', { id: 'w', inputmode: 'decimal', value: '1', 'aria-label': t('weight') });
    const err = h('div');
    const m = modal(`${item.name} (${item.base_uom})`, h('form', { onsubmit: (e) => {
      e.preventDefault();
      const v = num(w.value);
      if (!(v > 0)) return void err.replaceChildren(errorBox(t('weight')));
      cart.push({ item, qty: v }); touch(); m.close(); drawCart();
    } }, ...field(t('weight'), w, 'w'), err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('confirm')))));
    w.select();
  }
  function askSerial(item) {
    const s = h('input', { id: 'sn', autocapitalize: 'characters', 'aria-label': t('serialNo') }), err = h('div');
    const m = modal(`${item.name}`, h('form', { onsubmit: (e) => {
      e.preventDefault();
      const v = s.value.trim();
      if (!v) return;
      if (cart.some((l) => l.serialNo === v && l.item.id === item.id)) return void err.replaceChildren(errorBox(t('serialNo')));
      cart.push({ item, qty: 1, serialNo: v }); touch(); m.close(); drawCart();
    } }, ...field(t('serialNo'), s, 'sn'), err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('confirm')))));
  }

  function setQty(l, v) { if (v > 0) l.qty = v; touch(); drawCart(); }
  function drawCart(result) {
    cartEl.replaceChildren(h('h2', null, t('cart')));
    if (finished) result = finished;
    if (result) {
      put(cartEl, h('div', { id: 'receipt' }, h('p', { class: 'badge ok' }, t('saleDone')),
        h('p', null, `${t('invoice')} ${result.invoiceNo}`), h('div', { class: 'total', id: 'receipt-total' }, money(result.total)),
        result.due > 0 && h('p', { class: 'note' }, `${t('due')}: ${money(result.due)}`),
        h('button', { class: 'btn primary', id: 'new-sale', type: 'button', onclick: () => { finished = null; touch(); drawCart(); } }, t('newSale'))));
      return;
    }
    if (cart.length === 0) { put(cartEl, h('p', { class: 'muted' }, t('cartEmpty'))); return; }
    cart.forEach((l, idx) => {
      const input = h('input', { 'aria-label': t('qty'), inputmode: 'decimal', value: String(l.qty), disabled: Boolean(l.serialNo), onchange: (e) => { const v = num(e.target.value); if (v > 0) setQty(l, v); else drawCart(); } });
      put(cartEl, h('div', { class: 'cartline', 'data-line': l.item.sku },
        h('div', null, h('strong', null, l.item.name), l.serialNo && h('div', { class: 'muted' }, `${t('serialNo')}: ${l.serialNo}`), h('div', { class: 'muted' }, `${money(l.item.price)} × ${qtyFmt(l.qty)}`)),
        h('div', { class: 'num' }, h('strong', null, money(lineMoney(l)))),
        h('div', { class: 'qty' },
          !l.serialNo && h('button', { type: 'button', 'aria-label': '−', onclick: () => (l.qty > 1 ? setQty(l, r2(l.qty - 1)) : null) }, '−'), input,
          !l.serialNo && h('button', { type: 'button', 'aria-label': '+', onclick: () => setQty(l, r2(l.qty + 1)) }, '+')),
        h('button', { class: 'btn', type: 'button', 'aria-label': `${t('remove')} ${l.item.name}`, onclick: () => { cart.splice(idx, 1); touch(); drawCart(); } }, t('remove'))));
    });
    const err = h('div', { id: 'pos-error' });
    const sel = h('select', { id: 'pos-customer', 'aria-label': t('customer'), onchange: (e) => { customerId = e.target.value; } },
      h('option', { value: '' }, t('noCustomer')), customers.map((c) => h('option', { value: c.id, selected: c.id === customerId }, c.name)));
    const credit = h('input', { id: 'pos-paid', inputmode: 'decimal', 'aria-label': t('amountPaid'), value: '0' });
    const pay = async (payments) => {
      if (busy) return; busy = true; err.replaceChildren();
      try {
        const body = { branchId, lines: cart.map((l) => ({ itemId: l.item.id, qty: l.qty, ...(l.serialNo ? { serialNo: l.serialNo } : {}) })), payments };
        if (customerId) body.customerId = customerId;
        const r = await api('POST', '/sales/quick', body, { 'idempotency-key': key });   // same key on retry: never double-charges
        finished = r; cart = []; customerId = ''; touch();   // the paid cart is cleared immediately: it can never be charged twice
        drawCart();
      } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); } finally { busy = false; }
    };
    const T = total();
    put(cartEl, h('div', { class: 'total', id: 'cart-total' }, money(T)),
      S.branches.length > 1 && h('select', { id: 'pos-branch', 'aria-label': t('branch'), onchange: (e) => { branchId = e.target.value; touch(); } }, S.branches.map((b) => h('option', { value: b.id, selected: b.id === branchId }, b.name))),
      customers.length > 0 && [h('label', { for: 'pos-customer' }, t('customer')), sel], err,
      h('div', { class: 'paygrid' },
        h('button', { class: 'btn primary', id: 'pay-cash', type: 'button', onclick: () => pay([{ method: 'cash', amount: T }]) }, t('payCash')),
        h('button', { class: 'btn primary', id: 'pay-card', type: 'button', onclick: () => pay([{ method: 'card', amount: T }]) }, t('payCard')),
        h('button', { class: 'btn primary', id: 'pay-transfer', type: 'button', onclick: () => pay([{ method: 'transfer', amount: T }]) }, t('payTransfer'))),
      customers.length > 0 && h('div', null, ...field(t('amountPaid'), credit, 'pos-paid'),
        h('button', { class: 'btn', id: 'pay-credit', type: 'button', onclick: () => { const p = num(credit.value); if (!customerId) return void err.replaceChildren(errorBox(t('customer'))); pay(p > 0 ? [{ method: 'cash', amount: Math.min(p, T) }] : []); } }, t('payCredit'))));
  }

  const search = h('input', { id: 'pos-search', type: 'search', placeholder: t('pos_search'), 'aria-label': t('pos_search'), oninput: (e) => { q = e.target.value; drawCatalog(); } });
  const chip = (id, label) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === id), onclick: (e) => { filter = id; e.target.parentElement.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); drawCatalog(); } }, label);
  put(root, h('div', { class: 'pos' }, h('div', null, search, h('div', { class: 'chips' }, chip('all', t('all')), chip('product', t('onlyProducts')), chip('service', t('onlyServices'))), catalogEl), cartEl));
  drawCatalog(); drawCart();
  return root;
}
