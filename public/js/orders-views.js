import { api, errorBox, field, friendly, h, modal, newKey, num, put, toast } from './lib.js';
import { dateFmt, getLang, money, qtyFmt, uom } from './i18n.js';

/** Phase D1: order inbox (counter, phone, WhatsApp, table) + product options. Accepting creates a normal sale. */
const L = {
  fr: {
    branch: 'Point de vente', title: 'Commandes', intro: 'Commandes reçues au comptoir, par téléphone ou WhatsApp. Une commande devient une vente seulement quand vous l’acceptez (le stock est alors réservé et elle part en cuisine).',
    new: 'Nouvelle commande', pending: 'À traiter', all: 'Toutes', accept: 'Accepter', reject: 'Refuser', reason: 'Motif du refus',
    st_pending: 'En attente', st_accepted: 'Acceptée', st_rejected: 'Refusée', channel: 'Canal', mode: 'Type', table: 'Table',
    ch_counter: 'Comptoir', ch_phone: 'Téléphone', ch_whatsapp: 'WhatsApp', ch_table: 'Table', ch_web: 'En ligne',
    md_pickup: 'À emporter', md_dine_in: 'Sur place', customer: 'Nom du client', phone: 'Téléphone du client', wanted: 'Pour (date et heure)',
    note: 'Remarque', lineNote: 'Remarque pour ce produit', toKitchen: 'Envoyer en cuisine', product: 'Produit', qty: 'Quantité',
    addLine: 'Ajouter un produit', save: 'Enregistrer la commande', close: 'Annuler', quote: 'Montant estimé', total: 'Total de la vente',
    none: 'Aucune commande', noMenu: 'Aucun produit n’est encore proposé à la commande : dans « Produits & services », cochez « Commandable ».',
    accepted: 'Commande acceptée', options: 'Options', orderable: 'Commandable', choose: 'Choisir…', required: 'obligatoire',
    optTitle: 'Options du produit', optIntro: 'Exemple : « Préparation » (Nature, Grillé) et « Épices » (Avec, Sans). Une option peut ajouter un autre produit ou service (ex. Grillé ajoute la cuisson au kg) : son prix vient de ce produit.',
    group: 'Nom de l’option', multiple: 'Plusieurs choix possibles', addGroup: 'Ajouter une option', choice: 'Choix', addChoice: 'Ajouter un choix',
    pay: 'Encaisser', pm_cash: 'espèces', pm_card: 'carte', pm_transfer: 'virement', paid: 'Encaissée : facture émise', inKitchen: 'En cuisine : encaisser quand elle est prête',
    cancelOrder: 'Annuler la commande', os_closed: 'Encaissée', os_cancelled: 'Annulée (stock libéré)',
    saveOptions: 'Enregistrer', adds: 'Ajoute', nothing: 'Rien (simple précision)', perQty: 'même quantité', perOne: '1 unité', remove: 'Retirer', saved: 'Enregistré',
  },
  ar: {
    branch: 'الفرع', title: 'الطلبات', intro: 'الطلبات الواردة من الكونطوار أو الهاتف أو واتساب. لا تصبح الطلبية بيعاً إلا بعد قبولها (يُحجز المخزون وتُرسل إلى المطبخ).',
    new: 'طلبية جديدة', pending: 'في الانتظار', all: 'الكل', accept: 'قبول', reject: 'رفض', reason: 'سبب الرفض',
    st_pending: 'في الانتظار', st_accepted: 'مقبولة', st_rejected: 'مرفوضة', channel: 'المصدر', mode: 'النوع', table: 'الطاولة',
    ch_counter: 'الكونطوار', ch_phone: 'الهاتف', ch_whatsapp: 'واتساب', ch_table: 'الطاولة', ch_web: 'عبر الإنترنت',
    md_pickup: 'للأخذ', md_dine_in: 'في المحل', customer: 'اسم الزبون', phone: 'هاتف الزبون', wanted: 'موعد التسليم',
    note: 'ملاحظة', lineNote: 'ملاحظة لهذا المنتج', toKitchen: 'إرسال إلى المطبخ', product: 'المنتج', qty: 'الكمية',
    addLine: 'إضافة منتج', save: 'تسجيل الطلبية', close: 'إلغاء', quote: 'المبلغ التقديري', total: 'مجموع البيع',
    none: 'لا توجد طلبات', noMenu: 'لا يوجد أي منتج قابل للطلب بعد: في «المنتجات والخدمات» فعّل خيار «قابل للطلب».',
    accepted: 'تم قبول الطلبية', options: 'الخيارات', orderable: 'قابل للطلب', choose: 'اختر…', required: 'إجباري',
    optTitle: 'خيارات المنتج', optIntro: 'مثال: «التحضير» (عادي، مشوي) و«التوابل» (بها، بدونها). يمكن للخيار أن يضيف منتجاً أو خدمة أخرى (مثلاً: مشوي يضيف الشواء بالكيلو) ويُحتسب ثمنه من ذلك المنتج.',
    group: 'اسم الخيار', multiple: 'يمكن اختيار أكثر من واحد', addGroup: 'إضافة خيار', choice: 'الاختيار', addChoice: 'إضافة اختيار',
    pay: 'استخلاص', pm_cash: 'نقداً', pm_card: 'بطاقة', pm_transfer: 'تحويل', paid: 'تم الاستخلاص وإصدار الفاتورة', inKitchen: 'في المطبخ: يُستخلص عندما تكون جاهزة',
    cancelOrder: 'إلغاء الطلبية', os_closed: 'تم الاستخلاص', os_cancelled: 'ملغاة (تم تحرير المخزون)',
    saveOptions: 'حفظ', adds: 'يضيف', nothing: 'لا شيء (توضيح فقط)', perQty: 'نفس الكمية', perOne: 'وحدة واحدة', remove: 'حذف', saved: 'تم الحفظ',
  },
};
const o = (k) => L[getLang()][k] ?? L.fr[k] ?? k;
const btn = (label, onclick, cls = '', attrs = {}) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...attrs }, label);
const sel = (id, rows) => h('select', { id }, rows);
const opt = (value, label, selected = false) => h('option', { value, selected }, label);

export async function ordersView(S) {
  let branchId = S.branches[0]?.id, filter = 'pending';
  const root = h('div', { id: 'orders-page' });
  const canManage = S.me.permissions.includes('orders.manage'), canSell = S.me.permissions.includes('sale.create'), canVoid = S.me.permissions.includes('sale.void');
  const render = async () => {
    const { requests } = await api('GET', `/order-requests?branchId=${branchId}${filter === 'pending' ? '&status=pending' : ''}`);
    const card = (r) => h('div', { class: `card order-card ${r.status}`, 'data-request': r.id },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, [r.table_label && `${o('table')} ${r.table_label}`, r.customer_name, o(`ch_${r.channel}`)].filter(Boolean).join(' · ')),
        h('span', { class: r.status === 'pending' ? 'badge sample' : r.status === 'accepted' ? 'badge ok' : 'badge bad' }, o(`st_${r.status}`))),
      h('p', { class: 'muted' }, `${o(`md_${r.mode}`)} · ${dateFmt(r.created_at)}${r.wanted_at ? ` · ${o('wanted')}: ${dateFmt(r.wanted_at)}` : ''}${r.customer_phone ? ' · ' : ''}`,
        r.customer_phone && h('span', { dir: 'ltr' }, r.customer_phone)),
      h('ul', { class: 'order-lines' }, r.lines.map((l) => h('li', null, h('strong', null, `${l.item} × ${qtyFmt(l.qty)} ${uom(l.unit)}`),
        l.choices.length ? ` — ${l.choices.join(' · ')}` : '', l.note ? ` — ${l.note}` : '', h('span', { class: 'num' }, ` ${money(l.total)}`)))),
      r.note && h('p', null, `${o('note')}: ${r.note}`),
      h('p', { class: 'total' }, r.status === 'accepted' ? `${o('total')}: ${money(r.order_total)}` : `${o('quote')}: ${money(r.quote_total)}`),
      r.reason && h('p', { class: 'muted' }, `${o('reason')}: ${r.reason}`),
      r.status === 'pending' && canManage && h('div', { class: 'row' },
        canSell && btn(o('accept'), () => decide(r, 'accept'), 'primary', { 'data-action': 'accept' }),
        btn(o('reject'), () => decide(r, 'reject'), 'danger', { 'data-action': 'reject' })),
      // after acceptance: pay here (at once if it does not go through the kitchen, or once the kitchen marked it ready)
      r.status === 'accepted' && canManage && h('div', { class: 'row' },
        canSell && (r.to_kitchen ? r.order_state === 'ready' : ['confirmed', 'ready'].includes(r.order_state)) && ['cash', 'card', 'transfer'].map((m) =>
          btn(`${o('pay')} · ${o(`pm_${m}`)}`, () => pay(r, m), m === 'cash' ? 'primary' : '', { 'data-action': `pay-${m}` })),
        r.to_kitchen && r.order_state !== 'ready' && ['confirmed', 'in_preparation'].includes(r.order_state) && h('span', { class: 'muted' }, o('inKitchen')),
        canVoid && r.order_state === 'confirmed' && btn(o('cancelOrder'), () => cancel(r), 'danger', { 'data-action': 'cancel' })),
      r.status === 'accepted' && ['closed', 'cancelled'].includes(r.order_state) && h('p', { class: 'muted' }, o(`os_${r.order_state}`)));
    const tabs = h('div', { class: 'chips' }, [['pending', o('pending')], ['all', o('all')]].map(([k, label]) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === k), onclick: () => { filter = k; render().catch(err); } }, label)));
    // put() skips false/null children (replaceChildren would print "false")
    root.replaceChildren();
    put(root, h('div', { class: 'page-heading' }, h('div', null, h('h1', null, o('title')), h('p', { class: 'muted page-intro' }, o('intro'))),
        canManage && btn(`+ ${o('new')}`, () => newOrder().catch(err), 'primary', { id: 'new-order' })),
      S.branches.length > 1 && h('div', { class: 'row' }, h('label', { for: 'orders-branch' }, o('branch')),
        h('select', { id: 'orders-branch', onchange: (e) => { branchId = e.target.value; render().catch(err); } }, S.branches.map((b) => opt(b.id, b.name, b.id === branchId)))),
      tabs, h('div', { id: 'order-list', class: 'grid cols-2' }, requests.length ? requests.map(card) : h('p', { class: 'muted' }, o('none'))));
  };
  const err = (e) => toast(friendly(e), true);
  const pay = async (r, method) => {
    try { await api('POST', `/order-requests/${r.id}/pay`, { payments: Number(r.order_total) > 0 ? [{ method, amount: Number(r.order_total) }] : [] }, { 'idempotency-key': newKey() });
      toast(o('paid')); await render(); } catch (e) { err(e); }
  };
  const cancel = async (r) => {
    const reason = h('input', { id: 'cancel-reason', required: true, maxlength: '300' }), box = h('div'), key = newKey();
    const m = modal(o('cancelOrder'), h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', `/order-requests/${r.id}/cancel`, { reason: reason.value.trim() }, { 'idempotency-key': key }); m.close(); await render(); }
      catch (ex) { box.replaceChildren(errorBox(friendly(ex))); }
    } }, ...field(o('reason'), reason, 'cancel-reason'), box, h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, o('cancelOrder')))));
  };
  const decide = async (r, what) => {
    if (what === 'reject') {
      const reason = h('input', { id: 'reject-reason', required: true, maxlength: '300' }), box = h('div');
      const key = newKey();
      const m = modal(o('reject'), h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', `/order-requests/${r.id}/reject`, { reason: reason.value.trim() }, { 'idempotency-key': key }); m.close(); await render(); }
        catch (ex) { box.replaceChildren(errorBox(friendly(ex))); }
      } }, ...field(o('reason'), reason, 'reject-reason'), box, h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, o('reject')))));
      return;
    }
    try { const res = await api('POST', `/order-requests/${r.id}/accept`, {}, { 'idempotency-key': newKey() }); toast(`${o('accepted')} · ${money(res.total)}`); await render(); }
    catch (e) { err(e); }
  };
  const newOrder = async () => {
    const { items } = await api('GET', '/order-menu');
    if (!items.length) return void toast(o('noMenu'), true);
    const key = newKey();                                   // one command per dialog: a retry never creates a second order
    const channel = sel('o-channel', ['counter', 'phone', 'whatsapp', 'table'].map((c) => opt(c, o(`ch_${c}`))));
    const mode = sel('o-mode', ['pickup', 'dine_in'].map((m) => opt(m, o(`md_${m}`))));
    const table = h('input', { id: 'o-table', maxlength: '30' }), tableBox = h('div', { hidden: true }, ...field(o('table'), table, 'o-table'));
    mode.addEventListener('change', () => { tableBox.hidden = mode.value !== 'dine_in'; table.required = mode.value === 'dine_in'; });
    const name = h('input', { id: 'o-name', maxlength: '100' }), phone = h('input', { id: 'o-phone', type: 'tel', dir: 'ltr', maxlength: '30' });
    const wanted = h('input', { id: 'o-wanted', type: 'datetime-local' }), note = h('input', { id: 'o-note', maxlength: '300' });
    const kitchen = h('input', { id: 'o-kitchen', type: 'checkbox', checked: S.me.permissions.includes('kitchen.view') });
    const linesBox = h('div', { id: 'o-lines' }), lines = []; let n = 0;
    const addLine = () => {
      const i = n++, product = sel(`o-item-${i}`, items.map((it) => opt(it.id, `${it.name} · ${money(it.price)}${it.base_uom === 'kg' ? '/kg' : ''}`)));
      const qty = h('input', { id: `o-qty-${i}`, type: 'number', min: '0', step: '0.001', value: '1', required: true });
      const lnote = h('input', { id: `o-lnote-${i}`, maxlength: '200' }), optsBox = h('div', { class: 'option-groups' }), row = h('div', { class: 'card purchase-line' });
      let inputs = [];
      const drawOptions = () => {
        const it = items.find((x) => x.id === product.value); inputs = [];
        optsBox.replaceChildren(...(it?.options ?? []).map((g, gi) => h('fieldset', { class: 'option-group' }, h('legend', null, g.name, g.required ? ` (${o('required')})` : ''),
          ...g.choices.map((ch, ci) => {
            const id = `o-opt-${i}-${gi}-${ci}`, input = h('input', { type: g.multiple ? 'checkbox' : 'radio', name: `o-g-${i}-${gi}`, id, value: ch.id, required: g.required && !g.multiple });
            inputs.push(input);
            return h('label', { class: 'chip', for: id }, input, ` ${ch.label}`);
          }))));
        qty.step = it?.base_uom === 'unit' ? '1' : '0.001';
      };
      product.addEventListener('change', drawOptions);
      const line = { read: () => ({ itemId: product.value, qty: num(qty.value), choiceIds: inputs.filter((x) => x.checked).map((x) => x.value), note: lnote.value.trim() || undefined }) };
      row.append(...field(o('product'), product, product.id), ...field(o('qty'), qty, qty.id), optsBox, ...field(o('lineNote'), lnote, lnote.id),
        btn(o('remove'), () => { if (lines.length < 2) return; lines.splice(lines.indexOf(line), 1); row.remove(); }));
      lines.push(line); linesBox.append(row); drawOptions();
    };
    addLine();
    const box = h('div'), submit = h('button', { class: 'btn primary', type: 'submit' }, o('save'));
    let busy = false;
    const m = modal(o('new'), h('form', { onsubmit: async (e) => {
      e.preventDefault(); if (busy) return; busy = true; submit.disabled = true;
      try {
        const res = await api('POST', '/order-requests', { branchId, channel: channel.value, mode: mode.value, tableLabel: table.value.trim() || undefined,
          customerName: name.value.trim() || undefined, customerPhone: phone.value.trim() || undefined,
          wantedAt: wanted.value ? new Date(wanted.value).toISOString() : undefined, note: note.value.trim() || undefined,
          toKitchen: kitchen.checked, lines: lines.map((l) => l.read()) }, { 'idempotency-key': key });
        m.close(); toast(`${o('quote')}: ${money(res.total)}`); filter = 'pending'; await render();
      } catch (ex) { box.replaceChildren(errorBox(friendly(ex))); } finally { busy = false; submit.disabled = false; }
    } }, h('div', { class: 'grid tiles' }, h('div', null, ...field(o('channel'), channel, 'o-channel')), h('div', null, ...field(o('mode'), mode, 'o-mode'))),
      tableBox, ...field(o('customer'), name, 'o-name'), ...field(o('phone'), phone, 'o-phone'), ...field(o('wanted'), wanted, 'o-wanted'),
      linesBox, btn(`+ ${o('addLine')}`, addLine), ...field(o('note'), note, 'o-note'),
      h('div', { class: 'perm-row' }, kitchen, h('label', { for: 'o-kitchen' }, o('toKitchen'))), box,
      h('div', { class: 'row' }, submit, btn(o('close'), () => m.close()))));
  };
  await render();
  return root;
}

/** Product options editor (catalog.manage). */
export async function editOptions(item, allItems, done) {
  const { groups } = await api('GET', `/items/${item.id}/options`);
  const others = allItems.filter((x) => x.active && x.id !== item.id);
  const box = h('div', { id: 'opt-groups' }), err = h('div'), state = [];
  const addGroup = (g = { name: '', required: false, multiple: false, choices: [{ label: '' }] }) => {
    const gi = state.length, name = h('input', { id: `og-name-${gi}`, value: g.name, maxlength: '60', required: true });
    const required = h('input', { type: 'checkbox', id: `og-req-${gi}`, checked: g.required }), multiple = h('input', { type: 'checkbox', id: `og-multi-${gi}`, checked: g.multiple });
    const choicesBox = h('div'), choices = [];
    const addChoice = (ch = { label: '', add_item_id: null, qty_mode: 'same' }) => {
      const ci = choices.length, label = h('input', { id: `oc-label-${gi}-${ci}`, value: ch.label, maxlength: '60', required: true, 'aria-label': o('choice') });
      const addItem = sel(`oc-add-${gi}-${ci}`, [opt('', o('nothing'), !ch.add_item_id), ...others.map((x) => opt(x.id, `${o('adds')}: ${x.name} (${money(x.price)})`, x.id === ch.add_item_id))]);
      const mode = sel(`oc-mode-${gi}-${ci}`, [opt('same', o('perQty'), ch.qty_mode !== 'one'), opt('one', o('perOne'), ch.qty_mode === 'one')]);
      const row = h('div', { class: 'row option-choice' }, h('div', { class: 'grow' }, label), addItem, mode);
      const c = { read: () => ({ id: ch.id, label: label.value.trim(), addItemId: addItem.value || undefined, qtyMode: mode.value }), row };
      row.append(btn(o('remove'), () => { choices.splice(choices.indexOf(c), 1); row.remove(); }));
      choices.push(c); choicesBox.append(row);
    };
    (g.choices?.length ? g.choices : [{ label: '' }]).forEach(addChoice);
    const card = h('div', { class: 'card option-group-edit' }, ...field(o('group'), name, name.id),
      h('div', { class: 'perm-row' }, required, h('label', { for: required.id }, o('required'))),
      h('div', { class: 'perm-row' }, multiple, h('label', { for: multiple.id }, o('multiple'))),
      h('h3', null, o('choice')), choicesBox, btn(`+ ${o('addChoice')}`, () => addChoice()));
    const gs = { read: () => ({ id: g.id, name: name.value.trim(), required: required.checked, multiple: multiple.checked, choices: choices.map((c) => c.read()) }), card };
    card.append(btn(o('remove'), () => { state.splice(state.indexOf(gs), 1); card.remove(); }, 'danger'));
    state.push(gs); box.append(card);
  };
  groups.forEach(addGroup);
  const orderable = h('input', { type: 'checkbox', id: 'opt-orderable', checked: item.orderable });
  const m = modal(`${o('optTitle')} — ${item.name}`, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/items/${item.id}/options`, { groups: state.map((g) => g.read()) });
      if (orderable.checked !== Boolean(item.orderable)) await api('PATCH', `/items/${item.id}`, { orderable: orderable.checked });
      m.close(); toast(o('saved')); done();
    } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, h('p', { class: 'muted' }, o('optIntro')), h('div', { class: 'perm-row' }, orderable, h('label', { for: 'opt-orderable' }, o('orderable'))),
    box, btn(`+ ${o('addGroup')}`, () => addGroup()), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, o('saveOptions')), btn(o('close'), () => m.close()))));
}
export const optionsLabel = () => o('options');
export const orderableLabel = () => o('orderable');
