import { api, errorBox, field, friendly, h, modal, put, toast } from './lib.js';
import { getLang, money } from './i18n.js';

/** Phase D2, owner side: publish the menu, take online orders, QR codes, dish cards with photos and videos. */
const L = {
  fr: { title: 'Menu en ligne', intro: 'Votre menu public (QR ou lien), sans compte pour le client. Les commandes arrivent dans « Commandes » et ne deviennent des ventes qu’après votre accord.',
    published: 'Menu publié', accepting: 'Accepter les commandes en ligne (n’arrête jamais la caisse)', pickup: 'À emporter', dineIn: 'Sur place (QR des tables)',
    prep: 'Délai de préparation (min)', slot: 'Créneau (min)', capacity: 'Commandes par créneau', days: 'Jours à l’avance', message: 'Message affiché en haut du menu',
    hours: 'Horaires d’ouverture', closed: 'Fermé', save: 'Enregistrer', saved: 'Enregistré', link: 'Lien du menu', qr: 'QR code', tableQr: 'QR d’une table',
    tableLabel: 'Numéro de table', make: 'Créer le QR', open: 'Ouvrir le menu', notInPlan: 'Le menu en ligne n’est pas inclus dans votre formule.',
    noStorage: 'Le stockage des photos n’est pas encore configuré sur ce serveur : l’envoi de photos et vidéos est désactivé.',
    dishes: 'Fiches des produits', dishIntro: 'Seuls les produits « Commandables » apparaissent sur le menu. Utilisez vos propres photos (jamais d’images générées présentées comme réelles).',
    card: 'Fiche & photos', category: 'Rubrique (ex. Viandes, Grillades, Plats)', description: 'Description', ingredients: 'Ingrédients', allergens: 'Allergènes',
    weight: 'Poids / portion (ex. ≈ 350 g)', serves: 'Nombre de personnes', dishPrep: 'Préparation (min)', soldOut: 'Épuisé aujourd’hui', photos: 'Photos',
    video: 'Vidéo courte (MP4/WebM, 30 s max)', addPhoto: 'Ajouter des photos', addVideo: 'Ajouter une vidéo', up: 'Monter', down: 'Descendre', del: 'Supprimer',
    alt: 'Description de la photo', orderable: 'Commandable', notOrderable: 'Non commandable', uploading: 'Envoi…', close: 'Fermer', days7: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'] },
  ar: { title: 'القائمة عبر الإنترنت', intro: 'قائمتك العمومية (QR أو رابط) بدون حساب للزبون. تصل الطلبات إلى «الطلبات» ولا تصبح بيعاً إلا بعد موافقتك.',
    published: 'القائمة منشورة', accepting: 'استقبال الطلبات عبر الإنترنت (لا يوقف الكاشير أبداً)', pickup: 'للأخذ', dineIn: 'في المحل (QR الطاولات)',
    prep: 'مدة التحضير (دقيقة)', slot: 'المدة بين المواعيد (دقيقة)', capacity: 'عدد الطلبات في كل موعد', days: 'عدد الأيام مسبقاً', message: 'رسالة أعلى القائمة',
    hours: 'أوقات العمل', closed: 'مغلق', save: 'حفظ', saved: 'تم الحفظ', link: 'رابط القائمة', qr: 'رمز QR', tableQr: 'رمز QR لطاولة',
    tableLabel: 'رقم الطاولة', make: 'إنشاء الرمز', open: 'فتح القائمة', notInPlan: 'القائمة عبر الإنترنت غير متضمنة في باقتك.',
    noStorage: 'تخزين الصور غير مُعد بعد على هذا الخادم: رفع الصور والفيديو معطل.',
    dishes: 'بطاقات المنتجات', dishIntro: 'تظهر في القائمة المنتجات «القابلة للطلب» فقط. استعمل صورك الحقيقية (لا صور مولدة تُقدَّم كأنها حقيقية).',
    card: 'البطاقة والصور', category: 'القسم (مثلاً: لحوم، مشويات، أطباق)', description: 'الوصف', ingredients: 'المكونات', allergens: 'مسببات الحساسية',
    weight: 'الوزن / الحصة (مثلاً ≈ 350 غ)', serves: 'عدد الأشخاص', dishPrep: 'التحضير (دقيقة)', soldOut: 'نفد اليوم', photos: 'الصور',
    video: 'فيديو قصير (MP4/WebM، 30 ثانية كحد أقصى)', addPhoto: 'إضافة صور', addVideo: 'إضافة فيديو', up: 'أعلى', down: 'أسفل', del: 'حذف',
    alt: 'وصف الصورة', orderable: 'قابل للطلب', notOrderable: 'غير قابل للطلب', uploading: 'جارٍ الرفع…', close: 'إغلاق', days7: ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] },
};
const m = (k) => L[getLang()][k] ?? L.fr[k] ?? k;
const ALLERGEN_FR = { gluten: 'Gluten', lait: 'Lait', oeufs: 'Œufs', arachides: 'Arachides', fruits_a_coque: 'Fruits à coque', soja: 'Soja', poisson: 'Poisson', crustaces: 'Crustacés', sesame: 'Sésame', moutarde: 'Moutarde', celeri: 'Céleri', sulfites: 'Sulfites' };
const ALLERGEN_AR = { gluten: 'الغلوتين', lait: 'الحليب', oeufs: 'البيض', arachides: 'الفول السوداني', fruits_a_coque: 'المكسرات', soja: 'الصويا', poisson: 'السمك', crustaces: 'القشريات', sesame: 'السمسم', moutarde: 'الخردل', celeri: 'الكرفس', sulfites: 'الكبريتيت' };
const btn = (label, onclick, cls = '', attrs = {}) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...attrs }, label);
const check = (id, checked) => h('input', { type: 'checkbox', id, checked });
const numIn = (id, value, attrs = {}) => h('input', { id, type: 'number', value: value ?? '', inputmode: 'numeric', ...attrs });

/** The QR library is a classic script (MIT, vendored): loaded on demand. */
let qrReady;
function qrLib() {
  qrReady ??= new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = '/app/js/vendor/qrcode.js'; s.onload = () => resolve(window.qrcode); s.onerror = reject; document.head.append(s); });
  return qrReady;
}
async function qrImage(text, label) {
  const qrcode = await qrLib(); const q = qrcode(0, 'M'); q.addData(text); q.make();
  return h('figure', { class: 'qr' }, h('img', { src: q.createDataURL(6, 8), alt: `QR ${label}`, width: 240, height: 240 }), h('figcaption', null, label));
}

/** Re-encode a photo in the browser (drops EXIF/GPS, bounds the size) and make a JPEG thumbnail. The server checks again. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const enc = async (max, quality) => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  };
  return { main: await enc(1600, 0.85), thumb: await enc(480, 0.8) };
}
async function upload(path, blob) {
  const r = await fetch(path, { method: path.includes('/thumb') ? 'PUT' : 'POST', body: blob, credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'tijara-web' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
  return j;
}

export async function menuView(S) {
  const root = h('div', { id: 'menu-page' });
  const canSettings = S.me.permissions.includes('settings.manage'), canCatalog = S.me.permissions.includes('catalog.manage');
  const render = async () => {
    const [{ settings, slug, online, orders, mediaStorage }, { items, allergens }] = await Promise.all([api('GET', '/menu/settings'), api('GET', '/menu/items')]);
    const s = settings ?? { published: false, accepting_orders: false, pickup_enabled: true, dine_in_enabled: false, prep_minutes: 30, slot_minutes: 15, slot_capacity: 5, days_ahead: 2, hours: {}, message: '' };
    const url = `${location.origin}/app/menu.html?s=${encodeURIComponent(slug)}`;
    const f = { published: check('mn-pub', s.published), accepting: check('mn-acc', s.accepting_orders), pickup: check('mn-pick', s.pickup_enabled), dineIn: check('mn-dine', s.dine_in_enabled),
      prep: numIn('mn-prep', s.prep_minutes, { min: '0', max: '1440' }), slot: h('select', { id: 'mn-slot' }, [10, 15, 20, 30, 60].map((n) => h('option', { value: n, selected: n === s.slot_minutes }, String(n)))),
      capacity: numIn('mn-cap', s.slot_capacity, { min: '1', max: '200' }), days: numIn('mn-days', s.days_ahead, { min: '0', max: '14' }), message: h('input', { id: 'mn-msg', value: s.message ?? '', maxlength: '300' }) };
    // taking orders is its own module: when the owner (or the platform) switched it off, the menu is display-only
    if (orders === false) { f.accepting.checked = false; f.accepting.disabled = true; }
    // opening hours: up to two ranges a day (e.g. lunch and dinner)
    const hoursRows = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const ranges = s.hours?.[d] ?? [];
      const ins = [0, 1].map((r) => [h('input', { type: 'time', id: `mn-h-${d}-${r}-o`, value: ranges[r]?.[0] ?? '', 'aria-label': `${m('days7')[d]} ${r + 1}` }),
        h('input', { type: 'time', id: `mn-h-${d}-${r}-c`, value: ranges[r]?.[1] ?? '', 'aria-label': `${m('days7')[d]} ${r + 1}` })]);
      return { d, ins, row: h('div', { class: 'hours-row' }, h('strong', null, m('days7')[d]), ins.map(([o, c]) => h('span', { class: 'hours-range' }, o, '–', c))) };
    });
    const readHours = () => Object.fromEntries(hoursRows.map(({ d, ins }) => [String(d), ins.filter(([o, c]) => o.value && c.value).map(([o, c]) => [o.value, c.value])]));
    const err = h('div');
    const settingsCard = h('form', { class: 'card', id: 'menu-settings', onsubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        await api('PUT', '/menu/settings', { published: f.published.checked, acceptingOrders: f.accepting.checked, pickupEnabled: f.pickup.checked, dineInEnabled: f.dineIn.checked,
          prepMinutes: Number(f.prep.value), slotMinutes: Number(f.slot.value), slotCapacity: Number(f.capacity.value), daysAhead: Number(f.days.value), hours: readHours(), message: f.message.value });
        toast(m('saved')); await render();
      } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
    } }, h('h2', null, m('title')), !online && h('p', { class: 'note' }, m('notInPlan')),
      [['published', 'mn-pub'], ['accepting', 'mn-acc'], ['pickup', 'mn-pick'], ['dineIn', 'mn-dine']].map(([k, id]) => h('div', { class: 'perm-row' }, f[k], h('label', { for: id }, m(k)))),
      h('div', { class: 'grid tiles' }, h('div', null, ...field(m('prep'), f.prep, 'mn-prep')), h('div', null, ...field(m('slot'), f.slot, 'mn-slot')),
        h('div', null, ...field(m('capacity'), f.capacity, 'mn-cap')), h('div', null, ...field(m('days'), f.days, 'mn-days'))),
      ...field(m('message'), f.message, 'mn-msg'), h('h3', null, m('hours')), hoursRows.map((r) => r.row), err,
      canSettings && h('button', { class: 'btn primary', type: 'submit' }, m('save')));
    if (!canSettings) settingsCard.querySelectorAll('input,select').forEach((x) => { x.disabled = true; });
    // link + QR codes (the general one and one per table)
    const qrBox = h('div', { class: 'qr-grid', id: 'qr-box' }), tableIn = h('input', { id: 'qr-table', maxlength: '30' });
    const share = h('section', { class: 'card', id: 'menu-share' }, h('h2', null, m('link')),
      h('p', null, h('a', { href: url, target: '_blank', rel: 'noopener', dir: 'ltr', id: 'menu-link' }, url)), qrBox,
      s.dine_in_enabled && h('div', { class: 'row' }, h('div', { class: 'grow' }, ...field(m('tableLabel'), tableIn, 'qr-table')),
        btn(m('make'), async () => { if (tableIn.value.trim()) qrBox.append(await qrImage(`${url}&t=${encodeURIComponent(tableIn.value.trim())}`, `${m('tableQr')} ${tableIn.value.trim()}`)); })));
    if (s.published) qrBox.append(await qrImage(url, m('qr')));
    // dish cards
    const dishes = h('section', { class: 'card', id: 'menu-dishes' }, h('h2', null, m('dishes')), h('p', { class: 'muted' }, m('dishIntro')),
      !mediaStorage && h('p', { class: 'note', id: 'no-storage' }, m('noStorage')),
      h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, items.map((it) => h('tr', { 'data-item': it.id },
        h('td', null, it.media.find((x) => x.kind === 'image') ? h('img', { class: 'mini-thumb', alt: '', src: `/media/${it.media.find((x) => x.kind === 'image').id}?thumb=1` }) : ''),
        h('td', null, h('strong', null, it.name), h('div', { class: 'muted' }, [it.category, money(it.price)].filter(Boolean).join(' · '))),
        h('td', null, h('span', { class: it.orderable ? 'badge ok' : 'badge' }, it.orderable ? m('orderable') : m('notOrderable')), it.sold_out && h('span', { class: 'badge bad' }, ` ${m('soldOut')}`)),
        h('td', null, canCatalog && btn(m('card'), () => editCard(it, allergens, mediaStorage, render), '', { 'data-action': 'card' }))))))));
    root.replaceChildren(); put(root, h('p', { class: 'muted page-intro' }, m('intro')), settingsCard, share, dishes);
  };
  await render();
  return root;
}

function editCard(it, allergens, mediaStorage, done) {
  const v = (id, value, attrs = {}) => h('input', { id, value: value ?? '', ...attrs });
  const f = { category: v('dc-cat', it.category, { maxlength: '60' }), description: h('textarea', { id: 'dc-desc', rows: '3', maxlength: '600' }, it.description ?? ''),
    ingredients: v('dc-ing', it.ingredients, { maxlength: '400' }), weight: v('dc-weight', it.weight_label, { maxlength: '40' }),
    serves: numIn('dc-serves', it.serves, { min: '1', max: '50' }), prep: numIn('dc-prep', it.prep_minutes, { min: '0', max: '600' }), soldOut: check('dc-sold', it.sold_out) };
  const names = getLang() === 'ar' ? ALLERGEN_AR : ALLERGEN_FR;
  const al = allergens.map((a) => ({ a, box: h('input', { type: 'checkbox', id: `dc-al-${a}`, checked: it.allergens.includes(a) }) }));
  const err = h('div'), mediaBox = h('div', { id: 'dc-media' });
  let media = [...it.media];
  const drawMedia = () => mediaBox.replaceChildren(...media.map((x, i) => h('div', { class: 'media-tile', 'data-media': x.id },
    x.kind === 'image' ? h('img', { src: `/media/${x.id}?thumb=1`, alt: x.alt ?? '' }) : h('video', { src: `/media/${x.id}`, controls: true, preload: 'metadata', playsinline: true }),
    h('div', { class: 'row' }, btn(m('up'), () => move(i, -1), '', { disabled: i === 0 }), btn(m('down'), () => move(i, 1), '', { disabled: i === media.length - 1 }),
      btn(m('del'), async () => { try { await api('DELETE', `/media/${x.id}`); media.splice(i, 1); drawMedia(); } catch (e) { err.replaceChildren(errorBox(friendly(e))); } }, 'danger', { 'data-action': 'del-media' })))));
  const move = async (i, d) => {
    const next = [...media]; [next[i], next[i + d]] = [next[i + d], next[i]];
    try { await api('PUT', `/items/${it.id}/media-order`, { ids: next.map((x) => x.id) }); media = next; drawMedia(); } catch (e) { err.replaceChildren(errorBox(friendly(e))); }
  };
  const photoIn = h('input', { type: 'file', id: 'dc-photo', accept: 'image/jpeg,image/png,image/webp', multiple: true, disabled: !mediaStorage });
  const videoIn = h('input', { type: 'file', id: 'dc-video', accept: 'video/mp4,video/webm', disabled: !mediaStorage });
  const status = h('p', { class: 'muted', role: 'status' });
  photoIn.addEventListener('change', async () => {
    for (const file of photoIn.files) {
      status.textContent = m('uploading'); err.replaceChildren();
      try {
        const { main, thumb } = await prepareImage(file);
        const r = await upload(`/items/${it.id}/media?kind=image`, main);
        await upload(`/media/${r.id}/thumb`, thumb);
        media.push({ id: r.id, kind: 'image', thumb: true }); drawMedia();
      } catch (e) { err.replaceChildren(errorBox(e.message)); }
    }
    status.textContent = ''; photoIn.value = '';
  });
  videoIn.addEventListener('change', async () => {
    const file = videoIn.files?.[0]; if (!file) return;
    status.textContent = m('uploading'); err.replaceChildren();
    try { const r = await upload(`/items/${it.id}/media?kind=video`, file); media.push({ id: r.id, kind: 'video' }); drawMedia(); }
    catch (e) { err.replaceChildren(errorBox(e.message)); }
    status.textContent = ''; videoIn.value = '';
  });
  drawMedia();
  const dlg = modal(`${m('card')} — ${it.name}`, h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    try {
      await api('PUT', `/items/${it.id}/menu`, { category: f.category.value, description: f.description.value, ingredients: f.ingredients.value,
        allergens: al.filter((x) => x.box.checked).map((x) => x.a), weightLabel: f.weight.value, serves: f.serves.value ? Number(f.serves.value) : null,
        prepMinutes: f.prep.value ? Number(f.prep.value) : null, soldOut: f.soldOut.checked });
      dlg.close(); toast(m('saved')); done();
    } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(m('category'), f.category, 'dc-cat'), ...field(m('description'), f.description, 'dc-desc'), ...field(m('ingredients'), f.ingredients, 'dc-ing'),
    h('fieldset', { class: 'option-group' }, h('legend', null, m('allergens')), al.map(({ a, box }) => h('label', { class: 'chip', for: box.id }, box, ` ${names[a] ?? a}`))),
    h('div', { class: 'grid tiles' }, h('div', null, ...field(m('weight'), f.weight, 'dc-weight')), h('div', null, ...field(m('serves'), f.serves, 'dc-serves')), h('div', null, ...field(m('dishPrep'), f.prep, 'dc-prep'))),
    h('div', { class: 'perm-row' }, f.soldOut, h('label', { for: 'dc-sold' }, m('soldOut'))),
    h('h3', null, m('photos')), mediaBox, ...field(m('addPhoto'), photoIn, 'dc-photo'), ...field(m('video'), videoIn, 'dc-video'), status, err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, m('save')), btn(m('close'), () => { dlg.close(); done(); }))));
}
