import { api, errorBox, friendly, h, toast } from './lib.js';
import { getLang } from './i18n.js';

/** Issue #19: "Modules et affichage" — the owner switches modules on/off within what the plan/platform allows.
 *  A module switched off disappears from every menu and its API is refused; its data is kept. */
const L = {
  fr: { title: 'Modules et affichage', intro: 'Choisissez ce que votre commerce utilise. Un module désactivé disparaît des menus de toute l’équipe ; ses données sont conservées.',
    notIncluded: 'Non inclus dans votre abonnement', planned: 'Bientôt disponible', on: 'Activé', off: 'Désactivé', ownerOnly: 'Seul le propriétaire peut modifier les modules.',
    kitchen: ['Cuisine / grill', 'Commandes en préparation, cuisson, écran cuisine'], production: ['Transformation', 'Découpe et transformation des viandes'],
    workshop: ['Atelier mécanique', 'Véhicules, réparations, rappels d’entretien'], orders: ['Prise de commandes', 'Commandes comptoir, téléphone, WhatsApp, table'],
    online: ['Menu en ligne', 'Menu public et commandes des clients'], purchases: ['Achats / fournisseurs', 'Fournisseurs et réceptions'],
    cash: ['Clôture de caisse', 'Ouverture et fermeture de caisse'], bookings: ['Réservations', 'Rendez-vous et réservations'], delivery: ['Livraison', 'Suivi des livraisons'] },
  ar: { title: 'الوحدات والعرض', intro: 'اختر ما يستعمله محلك. الوحدة المعطلة تختفي من قوائم كل الفريق، وبياناتها محفوظة.',
    notIncluded: 'غير مشمولة في اشتراكك', planned: 'قريباً', on: 'مفعّلة', off: 'معطّلة', ownerOnly: 'المالك وحده يستطيع تغيير الوحدات.',
    kitchen: ['المطبخ والمشوي', 'الطلبات قيد التحضير والشواء وشاشة المطبخ'], production: ['التحويل', 'تقطيع وتحويل اللحوم'],
    workshop: ['ورشة الميكانيك', 'السيارات والإصلاحات وتذكيرات الصيانة'], orders: ['استقبال الطلبات', 'طلبات الكونتوار والهاتف وواتساب والطاولة'],
    online: ['القائمة على الإنترنت', 'القائمة العمومية وطلبات الزبناء'], purchases: ['المشتريات والموردون', 'الموردون والاستلامات'],
    cash: ['إغلاق الصندوق', 'فتح وإغلاق الصندوق'], bookings: ['الحجوزات', 'المواعيد والحجوزات'], delivery: ['التوصيل', 'تتبع التوصيل'] },
};
const m = (k) => (L[getLang()] ?? L.fr)[k] ?? L.fr[k];

export async function modulesCard(S, isOwner, changed) {
  const { modules } = await api('GET', '/tenant/modules');
  const err = h('div');
  const rows = modules.map((x) => {
    const [name, desc] = m(x.id);
    let state;
    if (x.status !== 'available') state = h('span', { class: 'badge' }, m('planned'));
    else if (!x.platformAllowed) state = h('span', { class: 'badge' }, m('notIncluded'));
    else if (!isOwner) state = h('span', { class: `badge ${x.shopEnabled ? 'ok' : ''}` }, x.shopEnabled ? m('on') : m('off'));
    else {
      const word = h('span', null, x.shopEnabled ? m('on') : m('off'));
      const box = h('input', { type: 'checkbox', id: `mod-${x.id}`, checked: x.shopEnabled, onchange: async () => {
        err.replaceChildren(); box.disabled = true;
        try { await api('PATCH', `/tenant/modules/${x.id}`, { enabled: box.checked }); toast(box.checked ? m('on') : m('off')); await changed(); }
        catch (e) { box.checked = !box.checked; err.replaceChildren(errorBox(friendly(e))); }
        finally { box.disabled = false; word.textContent = box.checked ? m('on') : m('off'); }
      } });
      state = h('label', { class: 'switch', for: `mod-${x.id}` }, box, word);
    }
    return h('li', { class: 'module-row', 'data-module': x.id }, h('div', { class: 'grow' }, h('strong', null, name), h('div', { class: 'muted' }, desc)), state);
  });
  return h('section', { class: 'card', id: 'modules-card' }, h('h2', null, m('title')), h('p', { class: 'note' }, isOwner ? m('intro') : m('ownerOnly')),
    h('ul', { class: 'module-list' }, rows), err);
}
