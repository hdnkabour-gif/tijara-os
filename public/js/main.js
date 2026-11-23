import { getLang, setLang, t } from './i18n.js';
import { api, clear, friendly, h, toast } from './lib.js';
import { forgotView, loginView, resetView, tenantPicker } from './auth-views.js';
import { platformView } from './platform.js';
import { customersView, dashboardView, invoicesView, itemsView, stockView } from './shop-views.js';
import { invoiceView, journalView, rolesView, settingsView, teamView } from './admin-views.js';
import { posView } from './pos.js';
import { vehiclesView, workshopView, workshopRemindersView } from './workshop-views.js';

const root = document.getElementById('app');
const S = { me: null, tenant: null, branches: [], route: '' };
export const state = S;

const can = (p) => S.me?.permissions?.includes(p);
const ROUTES = [
  { path: 'dashboard', label: 'nav_dashboard', show: () => can('report.view'), view: dashboardView },
  { path: 'pos', label: 'nav_pos', show: () => can('sale.create'), view: posView },
  { path: 'items', label: 'nav_items', show: () => can('catalog.view'), view: itemsView },
  { path: 'stock', label: 'nav_stock', show: () => can('stock.view'), view: stockView },
  { path: 'customers', label: 'nav_customers', show: () => can('customers.view'), view: customersView },
  { path: 'invoices', label: 'nav_invoices', show: () => can('sale.view'), view: invoicesView },
  { path: 'vehicles', label: 'nav_vehicles', show: () => can('workshop.view'), view: vehiclesView },
  { path: 'workshop', label: 'nav_workshop', show: () => can('workshop.view'), view: workshopView },
  { path: 'reminders', label: 'nav_reminders', show: () => can('workshop.view'), view: workshopRemindersView },
  { path: 'users', label: 'nav_users', show: () => can('users.manage'), view: teamView },
  { path: 'roles', label: 'nav_roles', show: () => can('users.manage'), view: rolesView },
  { path: 'settings', label: 'nav_settings', show: () => can('settings.manage') || can('branches.manage'), view: settingsView },
  { path: 'journal', label: 'nav_journal', show: () => can('audit.view'), view: journalView },
  { path: 'invoice', label: 'invoiceTitle', show: () => can('sale.view'), view: invoiceView, hidden: true },
  { path: 'platform', label: 'nav_platform', show: () => S.me?.isPlatformAdmin, view: platformView },
];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { path: path || '', query: new URLSearchParams(qs ?? '') };
}
export const go = (path) => { location.hash = `#/${path}`; };

async function boot() {
  try { S.me = await api('GET', '/me'); } catch { S.me = null; }
  if (S.me?.activeTenantId) {
    try { S.tenant = await api('GET', '/tenant'); } catch { S.tenant = null; }
    try { S.branches = (await api('GET', '/branches')).branches; } catch { S.branches = []; }
  } else { S.tenant = null; S.branches = []; }
  render();
}

function langToggle() {
  return h('button', { type: 'button', 'aria-label': t('language'), onclick: () => { setLang(getLang() === 'ar' ? 'fr' : 'ar'); render(); } }, getLang() === 'ar' ? 'Français' : 'العربية');
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* session may already be gone */ }
  S.me = null; S.tenant = null; location.hash = '#/login'; render();
}

function publicShell(content) {
  return h('div', { class: 'shell' }, h('div', { class: 'topbar' }, h('div', { class: 'brand' }, t('app')), langToggle()), content);
}

async function render() {
  clear(root);
  const { path, query } = parseHash();
  S.route = path;
  if (path === 'reset') return void root.appendChild(publicShell(resetView(query.get('token') ?? '', () => go('login'))));
  if (path === 'forgot') return void root.appendChild(publicShell(forgotView()));
  if (!S.me) return void root.appendChild(publicShell(loginView(async () => { go(''); await boot(); })));
  if (!S.me.activeTenantId && S.me.tenants.length > 1) {
    return void root.appendChild(publicShell(tenantPicker(S.me.tenants, async (id) => {
      try { await api('POST', '/auth/switch-tenant', { tenantId: id }); await boot(); } catch (e) { toast(friendly(e), true); }
    })));
  }
  const visible = ROUTES.filter((r) => r.show());
  let current = visible.find((r) => r.path === path);
  if (!current) {
    current = visible.filter((r) => !r.hidden)[0];
    if (!current) {
      return void root.appendChild(publicShell(h('main', null, h('div', { class: 'card' }, h('p', null, S.me.user.name), h('button', { class: 'btn', onclick: logout }, t('logout'))))));
    }
    history.replaceState(null, '', `#/${current.path}`);
    S.route = current.path;
  }
  const main = h('main', { id: 'main' }, h('p', { class: 'muted' }, t('loading')));
  root.appendChild(h('div', { class: 'shell workspace' },
    h('div', { class: 'topbar' },
      h('div', { class: 'brand-lockup' },
        h('span', { class: 'brandmark', 'aria-hidden': 'true' }, 'ت'),
        h('div', { class: 'brand-copy' },
          h('strong', { class: 'brand-title' }, t('app')),
          h('span', { class: 'brand-context' }, S.tenant?.name ?? t('platform')))),
      h('div', { class: 'topbar-actions' },
        h('span', { class: 'environment-badge' }, t('demoBadge')),
        langToggle(),
        h('button', { type: 'button', onclick: logout }, t('logout')))),
    h('nav', { class: 'nav', 'aria-label': 'navigation' },
      h('span', { class: 'nav-section-label' }, t('workspaceNav')),
      visible.filter((r) => !r.hidden).map((r) => h('a', { href: `#/${r.path}`, ...(r.path === current.path ? { 'aria-current': 'page' } : {}) }, t(r.label)))),
    main));
  try {
    const view = await current.view(S, query);
    clear(main); main.appendChild(view);
  } catch (e) {
    if (e?.status === 401) { S.me = null; return render(); }
    clear(main); main.appendChild(h('div', { class: 'error', role: 'alert' }, friendly(e)));
  }
}

window.addEventListener('hashchange', render);
boot();
