import { PublicError, applyBrand, applyLang, call, h, lang, money, prefs, qty, setLang, slotLabel } from './public-common.js';

/** Public menu (QR or link): browse, configure dishes, see the full server price, send an order, get a private tracking link. */
const T = {
  fr: { closed: 'Les commandes en ligne sont fermées pour le moment. Le menu reste consultable.', add: 'Ajouter', unavailable: 'Indisponible', cart: 'Panier',
    empty: 'Votre panier est vide', order: 'Commander', checkout: 'Votre commande', pickup: 'À emporter', dine_in: 'Sur place', table: 'Table',
    slot: 'Heure souhaitée', noSlot: 'Aucun créneau disponible', name: 'Votre nom', phone: 'Votre téléphone', note: 'Remarque (facultatif)',
    consent: 'J’accepte d’être appelé(e) au sujet de cette commande', send: 'Envoyer la commande', total: 'Total', remove: 'Retirer',
    qtyKg: 'Quantité (kg)', qtyUnit: 'Quantité', required: 'obligatoire', cancel: 'Annuler', serves: 'personnes', prep: 'min de préparation',
    ingredients: 'Ingrédients', allergens: 'Allergènes', notFound: 'Ce menu n’est pas disponible.', priceNote: 'Prix calculé par le commerce. Le paiement se fait au retrait.',
    notice: 'Votre commande sera confirmée par le commerce. Elle n’est pas encore acceptée ni payée.', sent: 'Commande envoyée', follow: 'Suivre ma commande',
    pending: 'Calcul du prix…', perKg: '/ kg', mode: 'Mode', soldOut: 'Épuisé', closedShort: 'Commandes fermées',
    al_gluten: 'Gluten', al_lait: 'Lait', al_oeufs: 'Œufs', al_arachides: 'Arachides', al_fruits_a_coque: 'Fruits à coque', al_soja: 'Soja', al_poisson: 'Poisson',
    al_crustaces: 'Crustacés', al_sesame: 'Sésame', al_moutarde: 'Moutarde', al_celeri: 'Céleri', al_sulfites: 'Sulfites' },
  ar: { closed: 'الطلب عبر الإنترنت مغلق حالياً. يمكنك تصفح القائمة.', add: 'إضافة', unavailable: 'غير متوفر', cart: 'السلة',
    empty: 'السلة فارغة', order: 'اطلب', checkout: 'طلبيتك', pickup: 'للأخذ', dine_in: 'في المحل', table: 'الطاولة',
    slot: 'الوقت المرغوب', noSlot: 'لا يوجد وقت متاح', name: 'اسمك', phone: 'رقم هاتفك', note: 'ملاحظة (اختياري)',
    consent: 'أوافق على أن يتصل بي المحل بخصوص هذه الطلبية', send: 'إرسال الطلبية', total: 'المجموع', remove: 'حذف',
    qtyKg: 'الكمية (كلغ)', qtyUnit: 'الكمية', required: 'إجباري', cancel: 'إلغاء', serves: 'أشخاص', prep: 'دقيقة تحضير',
    ingredients: 'المكونات', allergens: 'مسببات الحساسية', notFound: 'هذه القائمة غير متاحة.', priceNote: 'الثمن يحسبه المحل. الأداء عند الاستلام.',
    notice: 'سيؤكد المحل طلبيتك. لم تُقبل ولم تُؤدَّ بعد.', sent: 'تم إرسال الطلبية', follow: 'تتبع طلبيتي',
    pending: 'جارٍ حساب الثمن…', perKg: '/ كلغ', mode: 'الطريقة', soldOut: 'نفد', closedShort: 'الطلب مغلق',
    al_gluten: 'الغلوتين', al_lait: 'الحليب', al_oeufs: 'البيض', al_arachides: 'الفول السوداني', al_fruits_a_coque: 'المكسرات', al_soja: 'الصويا', al_poisson: 'السمك',
    al_crustaces: 'القشريات', al_sesame: 'السمسم', al_moutarde: 'الخردل', al_celeri: 'الكرفس', al_sulfites: 'الكبريتيت' },
};
const t = (k) => T[lang()][k] ?? T.fr[k] ?? k;
const root = document.getElementById('menu');
const params = new URLSearchParams(location.search);
const slug = (params.get('s') ?? '').toLowerCase(), table = params.get('t');
let M = null; const cart = [];
const api = (path) => `/public/shops/${encodeURIComponent(slug)}${path}`;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, '');

function modal(title, ...content) {
  const close = () => back.remove();
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === back) close(); }, onkeydown: (e) => { if (e.key === 'Escape') close(); } },
    h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { type: 'button', class: 'modal-x', 'aria-label': t('cancel'), onclick: close }, '×')), ...content));
  document.body.append(back);
  back.querySelector('input,select,textarea,button')?.focus();
  return { close, back };
}
const unitLabel = (u) => (u === 'kg' ? t('perKg') : '');

function dishCard(it) {
  const photos = it.media.filter((m) => m.kind === 'image'), video = it.media.find((m) => m.kind === 'video');
  const main = photos[0] ? h('img', { class: 'dish-photo', src: photos[0].thumbUrl ?? photos[0].url, alt: photos[0].alt ?? it.name, loading: 'lazy', width: photos[0].width, height: photos[0].height }) : null;
  const gallery = photos.length > 1 ? h('div', { class: 'dish-thumbs' }, photos.map((p) => h('button', { type: 'button', class: 'thumb-btn', 'aria-label': p.alt ?? it.name,
    onclick: () => { if (main) { main.src = p.url; main.alt = p.alt ?? it.name; } } }, h('img', { src: p.thumbUrl ?? p.url, alt: '', loading: 'lazy' })))) : null;
  return h('article', { class: `dish-card${it.available ? '' : ' unavailable'}`, 'data-item': it.id },
    main, gallery,
    video && h('video', { class: 'dish-video', src: video.url, controls: true, preload: 'none', playsinline: true, muted: true }),
    h('div', { class: 'dish-body' },
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, it.name), h('strong', { class: 'dish-price', dir: 'auto' }, `${money(it.price)} ${unitLabel(it.unit)}`)),
      it.description && h('p', null, it.description),
      h('p', { class: 'muted dish-facts' }, [it.weightLabel, it.serves && `${it.serves} ${t('serves')}`, it.prepMinutes != null && `${it.prepMinutes} ${t('prep')}`].filter(Boolean).join(' · ')),
      it.ingredients && h('p', { class: 'muted' }, `${t('ingredients')} : ${it.ingredients}`),
      it.allergens.length > 0 && h('p', { class: 'allergens' }, `${t('allergens')} : `, it.allergens.map((a) => h('span', { class: 'badge sample' }, t(`al_${a}`)))),
      it.available && M.ordering.accepting
        ? h('button', { type: 'button', class: 'btn primary', 'data-action': 'add', onclick: () => configure(it) }, `+ ${t('add')}`)
        : h('span', { class: 'badge bad' }, it.available ? t('closedShort') : t('soldOut'))));
}

/** One dish with its options; the price shown is the SERVER's quote for exactly this choice. */
function configure(it) {
  const isKg = it.unit === 'kg';
  const q = h('input', { id: 'cfg-qty', type: 'number', min: isKg ? '0.25' : '1', step: isKg ? '0.25' : '1', value: '1', inputmode: 'decimal' });
  const inputs = [], price = h('p', { class: 'total', id: 'cfg-price' }, t('pending')), err = h('div');
  const groups = it.options.map((g, gi) => h('fieldset', { class: 'option-group' }, h('legend', null, g.name, g.required ? ` (${t('required')})` : ''),
    g.choices.map((c, ci) => {
      const id = `cfg-${gi}-${ci}`, input = h('input', { type: g.multiple ? 'checkbox' : 'radio', name: `cfg-g-${gi}`, id, value: c.id, onchange: () => refresh() });
      inputs.push(input);
      return h('label', { class: 'chip', for: id }, input, ` ${c.label}`, c.extra ? h('span', { class: 'muted' }, ` +${money(c.extra.price)}${c.extra.qtyMode === 'fixed' ? ` × ${qty(c.extra.qty)}` : ''}`) : '');
    })));
  const line = () => ({ itemId: it.id, qty: Number(q.value), choiceIds: inputs.filter((x) => x.checked).map((x) => x.value) });
  let seq = 0;
  async function refresh() {
    const n = ++seq; err.replaceChildren();
    try { const r = await call('POST', api('/quote'), { lines: [line()] }); if (n === seq) price.textContent = `${t('total')} : ${money(r.total)}`; }
    catch (e) { if (n === seq) { price.textContent = ''; err.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); } }
  }
  q.addEventListener('input', refresh);
  const m = modal(it.name, ...groups, h('label', { for: 'cfg-qty' }, isKg ? t('qtyKg') : t('qtyUnit')), q, price, err,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'cfg-add', onclick: async () => {
      try { const r = await call('POST', api('/quote'), { lines: [line()] });
        cart.push({ ...line(), name: it.name, unit: it.unit, choices: r.lines[0].choices, total: r.total }); m.close(); drawCart(); }
      catch (e) { err.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
    } }, t('add')), h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, t('cancel'))));
  refresh();
}

function drawCart() {
  document.getElementById('cart-bar')?.remove();
  if (!cart.length) return;
  const total = cart.reduce((s, l) => s + Number(l.total), 0);
  document.body.append(h('div', { class: 'cart-bar', id: 'cart-bar' }, h('button', { type: 'button', class: 'btn primary', id: 'open-cart', onclick: checkout },
    `${t('cart')} (${cart.length}) · ${money(total)} — ${t('order')}`)));
}

/** Checkout: the full price is re-computed by the server for the whole cart BEFORE the customer sends anything. */
async function checkout() {
  const key = newKey();                                              // one key per checkout: a retry never creates a 2nd order
  const modeSel = h('select', { id: 'co-mode' }, M.ordering.pickup && h('option', { value: 'pickup' }, t('pickup')), M.ordering.dineIn && h('option', { value: 'dine_in', selected: Boolean(table) }, t('dine_in')));
  const tableIn = h('input', { id: 'co-table', value: table ?? '', maxlength: '30' }), tableBox = h('div', null, h('label', { for: 'co-table' }, t('table')), tableIn);
  const sync = () => { tableBox.hidden = modeSel.value !== 'dine_in'; }; modeSel.addEventListener('change', sync);
  const slots = M.ordering.slots.filter((s) => s.left > 0);
  const slot = h('select', { id: 'co-slot', required: true }, slots.length ? slots.map((s) => h('option', { value: s.at }, slotLabel(s.at))) : h('option', { value: '' }, t('noSlot')));
  const name = h('input', { id: 'co-name', required: true, maxlength: '100', autocomplete: 'name' });
  const phone = h('input', { id: 'co-phone', required: true, type: 'tel', dir: 'ltr', maxlength: '30', autocomplete: 'tel' });
  const note = h('input', { id: 'co-note', maxlength: '300' }), consent = h('input', { id: 'co-consent', type: 'checkbox' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', class: 'hp' });   // bots fill it, people never see it
  const totalEl = h('p', { class: 'total', id: 'co-total' }, t('pending')), err = h('div'), lines = h('ul', { class: 'order-lines', id: 'co-lines' });
  const submit = h('button', { type: 'submit', class: 'btn primary', id: 'co-send' }, t('send'));
  const draw = async () => {
    lines.replaceChildren(...cart.map((l, i) => h('li', null, h('strong', null, `${l.name} × ${qty(l.qty)}${l.unit === 'kg' ? ' kg' : ''}`), l.choices.length ? ` — ${l.choices.join(' · ')}` : '', ' ',
      h('button', { type: 'button', class: 'linklike', onclick: async () => { cart.splice(i, 1); drawCart(); if (!cart.length) m.close(); else await draw(); } }, t('remove')))));
    try { const r = await call('POST', api('/quote'), { lines: cart.map(({ itemId, qty: q, choiceIds }) => ({ itemId, qty: q, choiceIds })) }); totalEl.textContent = `${t('total')} : ${money(r.total)}`; submit.disabled = false; }
    catch (e) { totalEl.textContent = ''; submit.disabled = true; err.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
  };
  let busy = false;
  const m = modal(t('checkout'), h('form', { id: 'checkout', onsubmit: async (e) => {
    e.preventDefault(); if (busy) return; busy = true; submit.disabled = true; err.replaceChildren();
    try {
      const r = await call('POST', api('/orders'), { formToken: M.formToken, mode: modeSel.value, tableLabel: modeSel.value === 'dine_in' ? tableIn.value.trim() : undefined,
        wantedAt: slot.value, customerName: name.value.trim(), customerPhone: phone.value.trim(), note: note.value.trim() || undefined, contactConsent: consent.checked,
        website: trap.value, lines: cart.map(({ itemId, qty: q, choiceIds }) => ({ itemId, qty: q, choiceIds })) }, { 'idempotency-key': key });
      prefs.set('tj_last_tracking', r.tracking);
      location.assign(`/app/track.html#${r.tracking}`);
    } catch (ex) {
      err.replaceChildren(h('div', { class: 'error', role: 'alert' }, ex instanceof PublicError && ex.code === 'FORM_EXPIRED' ? `${ex.message}` : ex.message));
    } finally { busy = false; submit.disabled = false; }
  } }, lines, totalEl, h('p', { class: 'muted' }, t('priceNote')),
    h('label', { for: 'co-mode' }, t('mode')), modeSel, tableBox, h('label', { for: 'co-slot' }, t('slot')), slot,
    h('label', { for: 'co-name' }, t('name')), name, h('label', { for: 'co-phone' }, t('phone')), phone, h('label', { for: 'co-note' }, t('note')), note,
    h('div', { class: 'perm-row' }, consent, h('label', { for: 'co-consent' }, t('consent'))), trap,
    h('p', { class: 'note' }, t('notice')), err, h('div', { class: 'row' }, submit)));
  sync(); await draw();
}

async function main() {
  applyLang();
  if (!slug) { root.replaceChildren(h('main', { class: 'public-main' }, h('p', null, t('notFound')))); return; }
  try { M = await call('GET', api('/menu')); }
  catch { root.replaceChildren(h('main', { class: 'public-main' }, h('p', { class: 'card' }, t('notFound')))); return; }
  applyBrand(M.shop.primaryColor, M.shop.accentColor);
  document.title = M.shop.name;
  const cats = [...new Set(M.items.map((i) => i.category ?? ''))];
  root.replaceChildren(
    h('header', { class: 'public-head' },
      M.shop.logo ? h('img', { class: 'public-logo', src: M.shop.logo, alt: '' }) : h('span', { class: 'brandmark' }, M.shop.name.charAt(0).toUpperCase()),
      h('div', { class: 'grow' }, h('h1', null, M.shop.name), M.shop.message && h('p', { class: 'muted' }, M.shop.message)),
      h('button', { type: 'button', class: 'btn', id: 'pub-lang', onclick: () => { setLang(lang() === 'ar' ? 'fr' : 'ar'); main(); } }, lang() === 'ar' ? 'Français' : 'العربية')),
    h('main', { class: 'public-main' },
      !M.ordering.accepting && h('p', { class: 'note', id: 'closed-note' }, t('closed')),
      table && h('p', { class: 'badge' }, `${t('table')} ${table}`),
      cats.map((c) => h('section', { class: 'menu-section' }, c && h('h2', null, c), h('div', { class: 'dish-grid' }, M.items.filter((i) => (i.category ?? '') === c).map(dishCard))))));
  drawCart();
}
main();
