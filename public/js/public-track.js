import { applyLang, call, h, lang, money, qty, setLang, slotLabel } from './public-common.js';

/** Private tracking page: the token stays in the URL fragment (never sent in a URL, never in logs or referrers). */
const T = {
  fr: { title: 'Suivi de commande', received: 'Reçue', accepted: 'Acceptée', preparing: 'En préparation', ready: 'Prête', collected: 'Retirée',
    refused: 'Refusée par le commerce', cancelled: 'Annulée', notFound: 'Commande introuvable. Vérifiez le lien.', total: 'Total', for: 'Pour',
    pickup: 'À emporter', dine_in: 'Sur place', keep: 'Gardez ce lien pour suivre votre commande. Il ne montre ni votre nom ni votre téléphone.', refresh: 'Actualiser' },
  ar: { title: 'تتبع الطلبية', received: 'تم الاستلام', accepted: 'مقبولة', preparing: 'قيد التحضير', ready: 'جاهزة', collected: 'تم التسليم',
    refused: 'رفضها المحل', cancelled: 'ملغاة', notFound: 'الطلبية غير موجودة. تحقق من الرابط.', total: 'المجموع', for: 'موعد',
    pickup: 'للأخذ', dine_in: 'في المحل', keep: 'احتفظ بهذا الرابط لتتبع طلبيتك. لا يظهر فيه اسمك ولا رقم هاتفك.', refresh: 'تحديث' },
};
const t = (k) => T[lang()][k] ?? T.fr[k] ?? k;
const root = document.getElementById('track');
const token = location.hash.slice(1);
const STEPS = ['received', 'accepted', 'preparing', 'ready', 'collected'];

async function draw() {
  applyLang();
  let o;
  try { o = await call('POST', '/public/track', { token }); }
  catch { root.replaceChildren(h('main', { class: 'public-main' }, h('p', { class: 'card' }, t('notFound')))); return; }
  const at = STEPS.indexOf(o.step);
  root.replaceChildren(h('header', { class: 'public-head' }, h('div', { class: 'grow' }, h('h1', null, o.shop), h('p', { class: 'muted' }, t('title'))),
      h('button', { type: 'button', class: 'btn', onclick: () => { setLang(lang() === 'ar' ? 'fr' : 'ar'); draw(); } }, lang() === 'ar' ? 'Français' : 'العربية')),
    h('main', { class: 'public-main' },
      h('section', { class: 'card', id: 'track-status' },
        at >= 0 ? h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'current' : '' , 'aria-current': i === at ? 'step' : null }, t(s))))
          : h('p', { class: 'badge bad', id: 'track-final' }, t(o.step)),
        h('p', null, `${t(o.mode)} · ${t('for')} ${slotLabel(o.wantedAt)}`)),
      h('section', { class: 'card' }, h('ul', { class: 'order-lines' }, o.lines.map((l) => h('li', null, h('strong', null, `${l.name} × ${qty(l.qty)}${l.unit === 'kg' ? ' kg' : ''}`),
          l.choices.length ? ` — ${l.choices.join(' · ')}` : '', ` ${money(l.total)}`))),
        h('p', { class: 'total' }, `${t('total')} : ${money(o.total)}`)),
      h('p', { class: 'muted' }, t('keep')),
      h('button', { type: 'button', class: 'btn', onclick: draw }, t('refresh'))));
}
draw();
setInterval(() => { if (document.visibilityState === 'visible') draw(); }, 30000);
