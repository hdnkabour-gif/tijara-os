import { api, errorBox, friendly, h, field } from './lib.js';
import { t } from './i18n.js';

export function loginView(onDone) {
  const err = h('div'), email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true, inputmode: 'email' }),
    pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: null }, t('login'));
  const form = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren(); btn.disabled = true;
    try { await api('POST', '/auth/login', { email: email.value.trim(), password: pw.value, cookie: true }); onDone(); }
    catch (ex) { err.replaceChildren(errorBox(ex.status === 401 ? t('invalidCreds') : friendly(ex))); }
    finally { btn.disabled = false; }
  } }, h('h1', null, t('login')), ...field(t('email'), email, 'email'), ...field(t('password'), pw, 'pw'), err,
    h('div', { class: 'row' }, btn, h('a', { href: '#/forgot' }, t('forgot'))));
  return h('div', { class: 'login' }, form, h('p', { class: 'note' }, t('demoNote')));
}

export function forgotView() {
  const out = h('div'), email = h('input', { id: 'fe', type: 'email', required: true, autocomplete: 'username' });
  return h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/forgot', { email: email.value.trim() }); out.replaceChildren(h('p', null, t('forgotInfo')), h('p', { class: 'note' }, t('forgotProdNote'))); }
    catch (ex) { out.replaceChildren(errorBox(friendly(ex))); }
  } }, h('h1', null, t('forgot')), ...field(t('email'), email, 'fe'), out, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('save')), h('a', { href: '#/login' }, t('login')))));
}

export function resetView(token, done) {
  const out = h('div'), pw = h('input', { id: 'rp', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  return h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/reset', { token, newPassword: pw.value }); out.replaceChildren(h('p', { class: 'badge ok' }, t('resetDone'))); setTimeout(done, 1200); }
    catch (ex) { out.replaceChildren(errorBox(friendly(ex))); }
  } }, h('h1', null, t('resetTitle')), ...field(t('newPassword'), pw, 'rp'), h('p', { class: 'muted' }, t('pwHint')), out, h('button', { class: 'btn primary', type: 'submit' }, t('save'))));
}

export function tenantPicker(tenants, onPick) {
  return h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', null, t('chooseShop')),
    tenants.map((x) => h('p', null, h('button', { class: 'btn', type: 'button', onclick: () => onPick(x.tenant_id) }, `${x.name} — ${x.role_name}`)))));
}
