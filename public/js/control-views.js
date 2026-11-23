import { api, errorBox, field, friendly, h, put, toast } from './lib.js';
import { dateFmt, dayFmt, getLang, t } from './i18n.js';
import { openControls, platformView } from './platform.js';

/** PR-B: Platform Control Center pages (platform admins, metadata only) + the shop's "Ma formule" and branding. */
const L = {
  fr: {
    overview: 'Vue d’ensemble', shops: 'Commerces', audit: 'Journal plateforme', health: 'Santé du service',
    shopsTotal: 'Commerces', active: 'Actifs', suspended: 'Suspendus', trialExpired: 'Essais expirés', users: 'Utilisateurs',
    alerts: 'Alertes', noAlerts: 'Aucune alerte : tous les commerces sont dans leurs limites.',
    k_suspended: 'Commerce suspendu', k_trial_expired: 'Essai expiré', k_trial_ending: 'Essai bientôt terminé', k_quota_full: 'Limite atteinte', k_quota_high: 'Limite presque atteinte',
    version: 'Version en ligne', pending: 'Migrations en attente', lastMigration: 'Dernière migration', backup: 'Sauvegarde externe',
    backupNo: 'Non configurée — aucune sauvegarde hors Railway', backupYes: 'Configurée', drill: 'Dernier test de restauration', drillNo: 'Jamais vérifié',
    unknown: 'inconnu', open: 'Ouvrir', search: 'Rechercher un commerce (nom, identifiant)', allStatus: 'Tous les états', allPlans: 'Toutes les formules',
    st_active: 'Actif', st_suspended: 'Suspendu', st_trial_expired: 'Essai expiré', plan: 'Formule', status: 'État', created: 'Créé le',
    card: 'Fiche 360°', identity: 'Abonnement', usage: 'Consommation', modules: 'Modules', people: 'Équipe', owners: 'Propriétaires',
    roles: 'Rôles', branches: 'Points de vente', history: 'Décisions de la plateforme', manage: 'Gérer abonnement & accès', back: '← Commerces',
    privacy: 'Les ventes, clients, factures et stocks du commerce ne sont pas visibles ici.', trialEnd: 'Fin d’essai', reason: 'Motif',
    on: 'Activé', off: 'Désactivé', when: 'Date', action: 'Action', actor: 'Par', shop: 'Commerce', none: 'Aucune entrée',
    a_tenant_created: 'Commerce créé', 'a_tenant.controls_changed': 'Abonnement / accès modifié', 'a_tenant.created': 'Commerce créé', 'a_platform_admin.bootstrapped': 'Administrateur initialisé',
    myPlan: 'Ma formule', planIntro: 'Ce que votre formule comprend et ce que vous utilisez. Pour changer de formule, contactez l’administration de la plateforme.',
    m_kitchen: 'Cuisine & grill', m_workshop: 'Atelier mécanique', m_purchases: 'Achats & fournisseurs', m_cash: 'Clôture de caisse', m_production: 'Transformation',
    m_bookings: 'Réservations', m_delivery: 'Livraison',
    u_users: 'Utilisateurs', u_items: 'Produits & services', u_branches: 'Points de vente', u_customers: 'Clients', u_monthly_orders: 'Ventes ce mois',
    brand: 'Identité visuelle', brandIntro: 'Couleurs et logo de votre commerce (visible par votre équipe). Logo PNG, JPEG ou WebP, 64 Ko maximum.',
    primary: 'Couleur principale', accent: 'Couleur secondaire', logo: 'Logo', removeLogo: 'Retirer le logo', saveColors: 'Enregistrer les couleurs', uploadLogo: 'Envoyer le logo',
    tooBig: 'Le fichier dépasse 64 Ko', saved: 'Enregistré',
  },
  ar: {
    overview: 'نظرة عامة', shops: 'المحلات', audit: 'سجل المنصة', health: 'حالة الخدمة',
    shopsTotal: 'المحلات', active: 'نشطة', suspended: 'موقوفة', trialExpired: 'تجارب منتهية', users: 'المستخدمون',
    alerts: 'التنبيهات', noAlerts: 'لا توجد تنبيهات: كل المحلات داخل حدودها.',
    k_suspended: 'محل موقوف', k_trial_expired: 'انتهت التجربة', k_trial_ending: 'التجربة على وشك الانتهاء', k_quota_full: 'تم بلوغ الحد', k_quota_high: 'اقترب من الحد',
    version: 'الإصدار المنشور', pending: 'ترحيلات معلقة', lastMigration: 'آخر ترحيل', backup: 'النسخ الاحتياطي الخارجي',
    backupNo: 'غير مُعد — لا توجد نسخة خارج Railway', backupYes: 'مُعد', drill: 'آخر اختبار استرجاع', drillNo: 'لم يُتحقق منه بعد',
    unknown: 'غير معروف', open: 'فتح', search: 'ابحث عن محل (الاسم أو المعرّف)', allStatus: 'كل الحالات', allPlans: 'كل الباقات',
    st_active: 'نشط', st_suspended: 'موقوف', st_trial_expired: 'تجربة منتهية', plan: 'الباقة', status: 'الحالة', created: 'تاريخ الإنشاء',
    card: 'بطاقة 360°', identity: 'الاشتراك', usage: 'الاستهلاك', modules: 'الوحدات', people: 'الفريق', owners: 'المالكون',
    roles: 'الأدوار', branches: 'الفروع', history: 'قرارات المنصة', manage: 'التحكم في الباقة والدخول', back: '→ المحلات',
    privacy: 'مبيعات المحل وزبناؤه وفواتيره ومخزونه غير معروضة هنا.', trialEnd: 'نهاية التجربة', reason: 'السبب',
    on: 'مفعّل', off: 'معطّل', when: 'التاريخ', action: 'العملية', actor: 'بواسطة', shop: 'المحل', none: 'لا توجد عمليات',
    'a_tenant.controls_changed': 'تعديل الباقة أو الدخول', 'a_tenant.created': 'إنشاء المحل', 'a_platform_admin.bootstrapped': 'تهيئة المدير',
    myPlan: 'باقتي', planIntro: 'ما تتضمنه باقتك وما تستهلكه منها. لتغيير الباقة تواصل مع إدارة المنصة.',
    m_kitchen: 'المطبخ والمشوي', m_workshop: 'ورشة الميكانيك', m_purchases: 'المشتريات والموردون', m_cash: 'إغلاق الصندوق', m_production: 'تحويل اللحوم',
    m_bookings: 'الحجوزات', m_delivery: 'التوصيل',
    u_users: 'المستخدمون', u_items: 'المنتجات والخدمات', u_branches: 'الفروع', u_customers: 'الزبناء', u_monthly_orders: 'مبيعات هذا الشهر',
    brand: 'الهوية البصرية', brandIntro: 'ألوان وشعار محلك (يظهر لفريقك). الشعار PNG أو JPEG أو WebP بحد أقصى 64 كيلوبايت.',
    primary: 'اللون الرئيسي', accent: 'اللون الثانوي', logo: 'الشعار', removeLogo: 'حذف الشعار', saveColors: 'حفظ الألوان', uploadLogo: 'رفع الشعار',
    tooBig: 'حجم الملف يتجاوز 64 كيلوبايت', saved: 'تم الحفظ',
  },
};
const c = (k) => L[getLang()][k] ?? L.fr[k] ?? k;
// "items 4/4" -> "Produits & services 4/4"
const alertDetail = (a) => a.kind.startsWith('trial') ? dayFmt(a.detail) : a.kind.startsWith('quota') ? a.detail.replace(/^(\w+) /, (_, k) => `${c(`u_${k}`)} `) : a.detail;
const tile = (label, value, id) => h('div', { class: 'tile', ...(id ? { id } : {}) }, h('span', { class: 'l' }, label), h('div', { class: 'v' }, String(value)));
const statusBadge = (s) => h('span', { class: s === 'active' ? 'badge ok' : 'badge bad' }, c(`st_${s}`));
const bar = (u) => h('div', { class: 'usage-row', 'data-usage': u.key },
  h('div', { class: 'row' }, h('span', { class: 'grow' }, c(`u_${u.key}`)), h('strong', { dir: 'ltr' }, `${u.used} / ${u.limit}`)),
  h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(u.limit), 'aria-valuenow': String(u.used), 'aria-label': c(`u_${u.key}`) },
    h('span', { class: u.pct >= 100 ? 'full' : u.pct >= 80 ? 'high' : '', 'data-pct': String(Math.min(100, u.pct)) })));
// CSP forbids inline styles in markup, but the CSSOM is allowed: set the meter width after creation
const sizeMeters = (root) => root.querySelectorAll('.meter > span[data-pct]').forEach((s) => { s.style.width = `${s.dataset.pct}%`; });
const moduleList = (features) => h('ul', { class: 'module-list' }, Object.entries(features).map(([k, v]) =>
  h('li', { 'data-module': k }, h('span', { class: v ? 'badge ok' : 'badge' }, v ? c('on') : c('off')), ` ${c(`m_${k}`)}`)));
const heading = (eyebrow, title, intro, action) => h('div', { class: 'page-heading' },
  h('div', null, h('span', { class: 'eyebrow' }, eyebrow), h('h1', null, title), intro && h('p', { class: 'muted page-intro' }, intro)), action);

export async function overviewView() {
  const o = await api('GET', '/platform/overview');
  const wrap = h('div', { id: 'platform-overview' });
  put(wrap, heading('TIJARA OS', c('overview'), null),
    h('div', { class: 'grid tiles' }, tile(c('shopsTotal'), o.shops, 'kpi-shops'), tile(c('active'), o.byStatus.active ?? 0, 'kpi-active'),
      tile(c('suspended'), o.byStatus.suspended ?? 0, 'kpi-suspended'), tile(c('trialExpired'), o.byStatus.trial_expired ?? 0), tile(c('users'), o.users)),
    h('section', { class: 'card', id: 'platform-alerts' }, h('h2', null, `${c('alerts')} (${o.alerts.length})`),
      o.alerts.length ? h('ul', { class: 'alert-list' }, o.alerts.map((a) => h('li', null,
        h('span', { class: a.kind.startsWith('quota_high') || a.kind === 'trial_ending' ? 'badge sample' : 'badge bad' }, c(`k_${a.kind}`)), ' ',
        h('a', { href: `#/platform-shop?id=${a.tenantId}` }, a.shop), a.detail ? ` · ${alertDetail(a)}` : '')))
        : h('p', { class: 'muted' }, c('noAlerts'))),
    h('section', { class: 'card', id: 'platform-health' }, h('h2', null, c('health')),
      h('dl', { class: 'facts' },
        h('dt', null, c('version')), h('dd', { dir: 'ltr' }, o.health.version),
        h('dt', null, c('pending')), h('dd', null, o.health.pendingMigrations == null ? c('unknown') : String(o.health.pendingMigrations)),
        h('dt', null, c('lastMigration')), h('dd', { dir: 'ltr' }, o.health.lastMigration ? `${o.health.lastMigration.name} · ${dateFmt(o.health.lastMigration.applied_at)}` : c('unknown')),
        h('dt', null, c('backup')), h('dd', null, h('span', { class: o.health.offsiteBackup === 'configured' ? 'badge ok' : 'badge bad' }, o.health.offsiteBackup === 'configured' ? c('backupYes') : c('backupNo'))),
        h('dt', null, c('drill')), h('dd', null, o.health.lastRestoreDrill ? dayFmt(o.health.lastRestoreDrill) : c('drillNo')))));
  return wrap;
}

export async function shopsView() {
  const [{ tenants }, { plans }] = await Promise.all([api('GET', '/platform/tenants'), api('GET', '/platform/plans')]);
  const base = await platformView();          // creation wizard + table come from the existing page
  const q = h('input', { id: 'shop-search', type: 'search', placeholder: c('search'), 'aria-label': c('search') });
  const st = h('select', { id: 'shop-status', 'aria-label': c('status') }, h('option', { value: '' }, c('allStatus')),
    ['active', 'suspended', 'trial_expired'].map((s) => h('option', { value: s }, c(`st_${s}`))));
  const pl = h('select', { id: 'shop-plan', 'aria-label': c('plan') }, h('option', { value: '' }, c('allPlans')), plans.map((p) => h('option', { value: p.id }, p.name)));
  // match each table row to its shop by slug (2nd column), never by position
  const rows = [...base.querySelectorAll('tbody tr')].map((tr) => ({ tr, x: tenants.find((t) => t.slug === tr.children[1]?.textContent) })).filter((r) => r.x);
  const apply = () => {
    const text = q.value.trim().toLowerCase();
    rows.forEach(({ tr, x }) => {
      tr.hidden = !((!text || `${x.name} ${x.slug}`.toLowerCase().includes(text)) && (!st.value || x.status === st.value) && (!pl.value || x.plan_id === pl.value));
    });
  };
  [q, st, pl].forEach((el) => el.addEventListener(el === q ? 'input' : 'change', apply));
  // each row links to its 360° card
  rows.forEach(({ tr, x }) => tr.querySelector('td')?.replaceChildren(h('a', { href: `#/platform-shop?id=${x.id}` }, x.name)));
  const heading = base.querySelector('.page-heading');
  if (rows.length) heading?.after(h('div', { class: 'card filters row', id: 'shop-filters' }, h('div', { class: 'grow' }, q), st, pl));
  return base;
}

export async function shop360View(S, query) {
  const id = query.get('id');
  const [s, { plans }] = await Promise.all([api('GET', `/platform/tenants/${encodeURIComponent(id ?? '')}`), api('GET', '/platform/plans')]);
  const reload = () => shop360View(S, query).then((v) => wrap.replaceWith(v));
  const wrap = h('div', { id: 'shop-360' });
  const list = (await api('GET', '/platform/tenants')).tenants.find((x) => x.id === s.id);
  put(wrap, h('a', { href: '#/platform-shops', class: 'muted' }, c('back')),
    heading(c('card'), s.name, c('privacy'), h('button', { class: 'btn primary', type: 'button', onclick: () => openControls(list, plans, reload) }, c('manage'))),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card', id: 'card-identity' }, h('h2', null, c('identity')),
        h('dl', { class: 'facts' },
          h('dt', null, c('status')), h('dd', null, statusBadge(s.status), s.statusReason ? ` · ${s.statusReason}` : ''),
          h('dt', null, c('plan')), h('dd', null, s.plan),
          s.trialExpiresAt && [h('dt', null, c('trialEnd')), h('dd', null, dayFmt(s.trialExpiresAt))],
          h('dt', null, c('created')), h('dd', null, dayFmt(s.createdAt)),
          h('dt', null, 'Slug'), h('dd', { dir: 'ltr' }, s.slug)),
        s.activities.length > 0 && h('div', { class: 'chips' }, s.activities.map((a) => h('span', { class: 'badge' }, t(`act_${a}`))))),
      h('section', { class: 'card', id: 'card-usage' }, h('h2', null, c('usage')), s.usage.map(bar)),
      h('section', { class: 'card', id: 'card-modules' }, h('h2', null, c('modules')), moduleList(s.features)),
      h('section', { class: 'card', id: 'card-people' }, h('h2', null, c('people')),
        h('h3', null, c('owners')), h('ul', null, s.people.owners.map((o) => h('li', null, `${o.name} · `, h('span', { dir: 'ltr' }, o.email)))),
        h('h3', null, c('roles')), h('ul', null, s.people.roles.map((r) => h('li', null, `${r.role}: ${r.active}`))),
        h('h3', null, c('branches')), h('ul', null, s.people.branches.map((b) => h('li', null, b))))),
    s.alerts.length > 0 && h('section', { class: 'card', id: 'card-alerts' }, h('h2', null, c('alerts')),
      h('ul', null, s.alerts.map((a) => h('li', null, h('span', { class: 'badge bad' }, c(`k_${a.kind}`)), ` ${alertDetail(a)}`)))),
    h('section', { class: 'card', id: 'card-history' }, h('h2', null, c('history')), auditTable(s.history, false)));
  sizeMeters(wrap);
  return wrap;
}

const auditTable = (entries, withShop) => entries.length === 0 ? h('p', { class: 'muted' }, c('none')) : h('div', { class: 'tablewrap' }, h('table', null,
  h('thead', null, h('tr', null, [c('when'), c('action'), c('actor'), withShop && c('shop')].filter(Boolean).map((x) => h('th', null, x)))),
  h('tbody', null, entries.map((e) => h('tr', null, h('td', null, dateFmt(e.at)), h('td', null, c(`a_${e.action}`)),
    h('td', null, e.actor_name ?? '—'), withShop && h('td', null, e.tenant_id ? h('a', { href: `#/platform-shop?id=${e.tenant_id}` }, e.meta?.slug ?? c('open')) : '—'))))));

export async function platformAuditView() {
  const { entries } = await api('GET', '/platform/audit?limit=200');
  return h('div', { id: 'platform-audit' }, heading('TIJARA OS', c('audit'), null), h('section', { class: 'card' }, auditTable(entries, true)));
}

// ───────── shop side ─────────
export async function planView() {
  const p = await api('GET', '/tenant/plan');
  const wrap = h('div', { id: 'my-plan' });
  put(wrap, heading(c('myPlan'), p.planName, c('planIntro')),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('h2', null, c('identity')),
        h('dl', { class: 'facts' }, h('dt', null, c('status')), h('dd', null, statusBadge(p.status)),
          p.trialExpiresAt && [h('dt', null, c('trialEnd')), h('dd', null, dayFmt(p.trialExpiresAt))])),
      h('section', { class: 'card', id: 'plan-usage' }, h('h2', null, c('usage')), p.usage.map(bar)),
      h('section', { class: 'card', id: 'plan-modules' }, h('h2', null, c('modules')), moduleList(p.features))));
  sizeMeters(wrap);
  return wrap;
}

/** Apply the shop's colors to the SHOP shell only (the platform shell never calls this). */
export function applyBranding(b) {
  const root = document.documentElement.style;
  for (const [name, value] of [['--brand', b?.primaryColor], ['--accent', b?.accentColor]]) {
    if (value) root.setProperty(name, value); else root.removeProperty(name);
  }
}

export function brandingCard(S, branding, onChange) {
  const err = h('div');
  const primary = h('input', { id: 'brand-primary', type: 'color', value: branding.primaryColor ?? '#08795e' });
  const accent = h('input', { id: 'brand-accent', type: 'color', value: branding.accentColor ?? '#d4a017' });
  const file = h('input', { id: 'brand-logo', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  const preview = branding.hasLogo ? h('img', { class: 'logo-preview', alt: c('logo'), src: `/tenant/logo?v=${branding.version}` }) : null;
  const run = async (fn) => { err.replaceChildren(); try { await fn(); toast(c('saved')); await onChange(); } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); } };
  const upload = () => {
    const f = file.files?.[0];
    if (f && f.size > 65536) return void err.replaceChildren(errorBox(c('tooBig')));   // checked again on the server
    return run(async () => {
    if (!f) return;
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = reject; r.readAsDataURL(f); });
    await api('PUT', '/tenant/logo', { data });
  }); };
  return h('section', { class: 'card', id: 'branding-card' }, h('h2', null, c('brand')), h('p', { class: 'muted' }, c('brandIntro')),
    h('div', { class: 'grid tiles' }, h('div', null, ...field(c('primary'), primary, 'brand-primary')), h('div', null, ...field(c('accent'), accent, 'brand-accent'))),
    h('button', { class: 'btn primary', type: 'button', id: 'save-colors', onclick: () => run(() => api('PUT', '/tenant/branding', { primaryColor: primary.value, accentColor: accent.value })) }, c('saveColors')),
    ...field(c('logo'), file, 'brand-logo'), preview,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', id: 'upload-logo', onclick: upload }, c('uploadLogo')),
      branding.hasLogo && h('button', { class: 'btn danger', type: 'button', onclick: () => run(() => api('DELETE', '/tenant/logo')) }, c('removeLogo'))), err);
}
