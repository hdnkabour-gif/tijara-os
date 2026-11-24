import { api, errorBox, field, friendly, h, toast } from './lib.js';
import { dateFmt, getLang } from './i18n.js';

/** PR-C: support access only with the owner's explicit, time-limited, revocable approval. */
const L = {
  fr: {
    title: 'Accès support', ask: 'Demander un accès au commerce', reason: 'Motif (visible par le propriétaire)', duration: 'Durée',
    scope: 'Étendue', s_view: 'Consultation seulement', s_assist: 'Consultation + réglages et catalogue', send: 'Envoyer la demande',
    enter: 'Entrer (mode support)', none: 'Aucune demande', st_requested: 'En attente du propriétaire', st_approved: 'Approuvée',
    st_refused: 'Refusée', st_revoked: 'Révoquée', st_cancelled: 'Annulée', until: 'jusqu’au', expired: 'expirée',
    platformNote: 'Le propriétaire décide. Sans son accord, aucune donnée du commerce n’est accessible. Chaque action est inscrite dans son journal.',
    ownerIntro: 'L’équipe TIJARA OS ne voit rien de votre commerce sans votre accord. Vous choisissez la durée et l’étendue, et vous pouvez couper l’accès à tout moment. Tout ce qui est fait apparaît dans le Journal.',
    approve: 'Accepter', refuse: 'Refuser', revoke: 'Couper l’accès maintenant', active: 'Accès en cours', pending: 'Demandes en attente',
    history: 'Historique', by: 'Demandé par', supportTeam: 'Support TIJARA OS', banner: 'Mode support TIJARA OS', leave: 'Quitter le mode support',
    logged: 'chaque action est inscrite dans le journal du commerce', m: 'min', h: 'h', newRequest: 'Demande d’accès support',
  },
  ar: {
    title: 'دخول فريق الدعم', ask: 'طلب الدخول إلى المحل', reason: 'السبب (يراه صاحب المحل)', duration: 'المدة',
    scope: 'النطاق', s_view: 'اطلاع فقط', s_assist: 'اطلاع + الإعدادات والمنتجات', send: 'إرسال الطلب',
    enter: 'الدخول (وضع الدعم)', none: 'لا توجد طلبات', st_requested: 'في انتظار صاحب المحل', st_approved: 'مقبول',
    st_refused: 'مرفوض', st_revoked: 'تم إلغاؤه', st_cancelled: 'ملغى', until: 'حتى', expired: 'انتهت مدته',
    platformNote: 'صاحب المحل هو من يقرر. بدون موافقته لا يمكن الاطلاع على أي معلومة. كل عملية تُسجَّل في سجله.',
    ownerIntro: 'فريق TIJARA OS لا يرى أي شيء من محلك بدون موافقتك. أنت تختار المدة والنطاق ويمكنك قطع الدخول في أي وقت. كل ما يتم يظهر في سجل العمليات.',
    approve: 'قبول', refuse: 'رفض', revoke: 'قطع الدخول الآن', active: 'دخول جارٍ', pending: 'طلبات في الانتظار',
    history: 'السجل', by: 'طلبه', supportTeam: 'دعم TIJARA OS', banner: 'وضع دعم TIJARA OS', leave: 'الخروج من وضع الدعم',
    logged: 'كل عملية تُسجَّل في سجل المحل', m: 'د', h: 'س', newRequest: 'طلب دخول فريق الدعم',
  },
};
const s = (k) => L[getLang()][k] ?? L.fr[k] ?? k;
const dur = (m) => (m % 60 === 0 ? `${m / 60} ${s('h')}` : `${m} ${s('m')}`);
const btn = (label, onclick, cls = '', id) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...(id ? { id } : {}) }, label);
const statusLine = (g) => `${s(`st_${g.status}`)}${g.status === 'approved' ? ` · ${g.active === false || g.usable === false ? s('expired') : `${s('until')} ${dateFmt(g.expires_at)}`}` : ''}`;

/** Platform 360° card section: ask, follow the answer, enter when approved. */
export async function platformSupportSection(tenantId) {
  const { requests } = await api('GET', `/platform/tenants/${tenantId}/support-requests`);
  const sec = h('section', { class: 'card', id: 'support-section' });
  const reason = h('textarea', { id: 'sup-reason', rows: '2', minlength: '10', maxlength: '500' });
  const minutes = h('select', { id: 'sup-minutes' }, [30, 60, 120, 240, 480].map((m) => h('option', { value: String(m), selected: m === 60 }, dur(m))));
  const scope = h('select', { id: 'sup-scope' }, h('option', { value: 'view' }, s('s_view')), h('option', { value: 'assist' }, s('s_assist')));
  const err = h('div');
  const redraw = async () => sec.replaceWith(await platformSupportSection(tenantId));
  sec.append(h('h2', null, s('title')), h('p', { class: 'muted' }, s('platformNote')),
    requests.length ? h('ul', { id: 'support-requests' }, requests.map((g) => h('li', null, `${dateFmt(g.created_at)} · ${s(`s_${g.scope}`)} · ${dur(g.minutes)} · ${statusLine(g)} `,
      g.usable && btn(s('enter'), async () => {
        try { await api('POST', '/platform/support/enter', { tenantId, grantId: g.id }); location.hash = '#/dashboard'; location.reload(); }
        catch (e) { toast(friendly(e), true); }
      }, 'primary', 'enter-support')))) : h('p', { class: 'muted' }, s('none')),
    h('h3', null, s('ask')), ...field(s('reason'), reason, 'sup-reason'),
    h('div', { class: 'grid tiles' }, h('div', null, ...field(s('duration'), minutes, 'sup-minutes')), h('div', null, ...field(s('scope'), scope, 'sup-scope'))),
    err, btn(s('send'), async () => {
      err.replaceChildren();
      try { await api('POST', `/platform/tenants/${tenantId}/support-requests`, { reason: reason.value.trim(), minutes: Number(minutes.value), scope: scope.value }); await redraw(); }
      catch (e) { err.replaceChildren(errorBox(friendly(e))); }
    }, 'primary', 'send-support'));
  return sec;
}

/** Shop Settings, owner only: decide, revoke, see the history. */
export async function ownerSupportCard() {
  const { grants } = await api('GET', '/support/grants');
  const card = h('section', { class: 'card', id: 'support-card' });
  const redraw = async () => card.replaceWith(await ownerSupportCard());
  // after a decision the shell recounts waiting requests (top-bar notice)
  const act = (fn) => async () => { try { await fn(); await redraw(); window.dispatchEvent(new Event('support-changed')); } catch (e) { toast(friendly(e), true); } };
  const pending = grants.filter((g) => g.status === 'requested'), active = grants.filter((g) => g.active), past = grants.filter((g) => g.status !== 'requested' && !g.active);
  card.append(h('h2', null, s('title')), h('p', { class: 'muted' }, s('ownerIntro')));
  if (pending.length) card.append(h('h3', null, s('pending')), ...pending.map((g) => {
    const minutes = h('select', { 'aria-label': s('duration') }, [15, 30, 60, 120, 240, 480, 1440].filter((m) => m <= g.minutes).map((m) => h('option', { value: String(m), selected: m === g.minutes }, dur(m))));
    const scope = h('select', { 'aria-label': s('scope') }, h('option', { value: 'view' }, s('s_view')), g.scope === 'assist' && h('option', { value: 'assist', selected: true }, s('s_assist')));
    return h('div', { class: 'support-request', 'data-grant': g.id },
      h('p', null, h('strong', null, g.requested_by ?? s('supportTeam')), ` · ${dateFmt(g.created_at)}`), h('p', null, `${s('reason')}: ${g.reason}`),
      h('div', { class: 'row' }, minutes, scope,
        btn(s('approve'), act(() => api('POST', `/support/grants/${g.id}/approve`, { minutes: Number(minutes.value), scope: scope.value })), 'primary'),
        btn(s('refuse'), act(() => api('POST', `/support/grants/${g.id}/refuse`, {})), 'danger')));
  }));
  if (active.length) card.append(h('h3', null, s('active')), ...active.map((g) => h('div', { class: 'support-request active', 'data-grant': g.id },
    h('p', null, `${s(`s_${g.scope}`)} · ${s('until')} ${dateFmt(g.expires_at)}`),
    btn(s('revoke'), act(() => api('POST', `/support/grants/${g.id}/revoke`, {})), 'danger', 'revoke-support'))));
  card.append(h('h3', null, s('history')), past.length ? h('ul', null, past.map((g) => h('li', null, `${dateFmt(g.created_at)} · ${s(`s_${g.scope}`)} · ${dur(g.minutes)} · ${statusLine(g)}`))) : h('p', { class: 'muted' }, s('none')));
  return card;
}

/** Banner shown on every shop page while a platform admin works under a grant. */
export function supportBanner(support, onLeave) {
  return h('div', { class: 'support-banner', role: 'status', id: 'support-banner' },
    h('strong', null, s('banner')), ` · ${s(`s_${support.scope}`)} · ${s('until')} ${dateFmt(support.expiresAt)} · ${s('logged')} `,
    btn(s('leave'), onLeave, '', 'leave-support'));
}
export const supportRequestLabel = () => s('newRequest');
