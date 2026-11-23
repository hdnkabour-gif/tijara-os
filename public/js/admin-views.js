import { api, confirmBox, errorBox, field, friendly, h, modal, put, toast } from './lib.js';
import { dateFmt, money, qtyFmt, roleLabel, t, uom } from './i18n.js';

const can = (S, p) => S.me.permissions.includes(p);
const member = (S) => S.me.tenants?.find((t) => t.tenant_id === S.me.activeTenantId);
const isOwner = (S) => member(S)?.role_name === 'owner';
const ownScope = (S) => member(S)?.branch_ids ?? [];
const manageable = (S, u) => isOwner(S) || (!u.branch_ids.length ? !ownScope(S).length : (!ownScope(S).length || u.branch_ids.every((id) => ownScope(S).includes(id))));
const btn = (label, onclick, cls = '', attrs = {}) => h('button', { class: 'btn ' + cls, type: 'button', onclick, ...attrs }, label);
const formRow = (...kids) => h('div', { class: 'row' }, ...kids);
const branchName = (S, id) => S.branches.find((b) => b.id === id)?.name ?? '';

// ───────────── team ─────────────
export async function teamView(S) {
  const [{ users }, { roles }] = await Promise.all([api('GET', '/users'), api('GET', '/roles')]);
  const wrap = h('div');
  const reload = () => teamView(S).then((v) => wrap.replaceWith(v));
  const rows = users.map((u) => {
    const self = u.id === S.me.user.id;
    const editAllowed = manageable(S, u) && (u.role !== 'owner' || isOwner(S));
    return h('tr', { 'data-user': u.email },
      h('td', null, u.name, self && h('span', { class: 'badge' }, ' ★')), h('td', null, u.email),
      h('td', null, roleLabel(u.role)),
      h('td', null, u.branch_ids.length ? u.branch_ids.map((id) => branchName(S, id)).join(', ') : t('allBranches')),
      h('td', null, h('span', { class: 'badge ' + (u.active ? 'ok' : 'bad') }, u.active ? t('userActive') : t('inactive'))),
      h('td', null, h('div', { class: 'row-actions' },
        editAllowed && btn(t('edit'), () => editUser(S, u, roles, reload), '', { 'data-action': 'edit' }),
        isOwner(S) && !self && btn(t('resetPassword'), () => resetPw(u), '', { 'data-action': 'password' }),
        editAllowed && !self && btn(u.active ? t('deactivate') : t('reactivate'), async () => {
          try { await api('PATCH', `/users/${u.id}`, { active: !u.active }); toast(t('saved')); reload(); } catch (e) { toast(friendly(e), true); }
        }, u.active ? 'danger' : '', { 'data-action': 'toggle' }))));
  });
  put(wrap,
    formRow(h('h1', { class: 'grow' }, t('users')), btn(`+ ${t('newUser')}`, () => newUser(S, roles, reload), 'primary', { id: 'new-user' })),
    h('div', { class: 'card tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, [t('name'), t('email'), t('role'), t('branches'), t('status'), t('actions')].map((x) => h('th', null, x)))), h('tbody', null, rows))));
  return wrap;
}
function branchBoxes(S, selected = []) {
  const boxes = S.branches.map((b) => ({ id: b.id, box: h('input', { type: 'checkbox', id: `ub-${b.id}`, checked: selected.includes(b.id) }) }));
  const el = h('div', { class: 'chips' }, S.branches.map((b, i) => h('label', { class: 'chip', for: `ub-${b.id}` }, boxes[i].box, ` ${b.name}`)));
  return { el, value: () => boxes.filter((b) => b.box.checked).map((b) => b.id) };
}
const roleSelect = (roles, value, disabled = false) => h('select', { id: 'urole', disabled }, roles.map((r) => h('option', { value: r.name, selected: r.name === value }, roleLabel(r.name))));
const grantableRoles = (S, roles) => isOwner(S) ? roles : roles.filter((r) => r.name !== 'owner' && r.permissions.every((p) => can(S, p)));
function newUser(S, roles, done) {
  const err = h('div'), name = h('input', { id: 'uname', required: true }), email = h('input', { id: 'uemail', type: 'email', required: true }),
    pw = h('input', { id: 'upw', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' }),
    allowedRoles = grantableRoles(S, roles), role = roleSelect(allowedRoles, allowedRoles[0]?.name ?? 'cashier'),
    br = branchBoxes(S, ownScope(S));
  const m = modal(t('newUser'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/users', { name: name.value, email: email.value, password: pw.value, roleName: role.value, branchIds: br.value() }); m.close(); toast(t('saved')); done(); }
    catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'uname'), ...field(t('email'), email, 'uemail'), ...field(t('password'), pw, 'upw'), h('p', { class: 'muted' }, t('pwHint')),
    ...field(t('role'), role, 'urole'), h('label', null, t('branches')), br.el, err,
    formRow(h('button', { class: 'btn primary', type: 'submit' }, t('create')), btn(t('cancel'), () => m.close()))));
}
function editUser(S, u, roles, done) {
  const self = u.id === S.me.user.id;
  const err = h('div'), name = h('input', { id: 'ename', value: u.name, required: true }),
    allowedRoles = grantableRoles(S, roles), role = roleSelect(allowedRoles.some((r) => r.name === u.role) ? allowedRoles : roles.filter((r) => r.name === u.role), u.role, self),
    br = branchBoxes(S, u.branch_ids);
  const m = modal(t('editUser'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const body = { name: name.value, ...(!self ? { branchIds: br.value() } : {}) };
    if (!self && role.value !== u.role) body.roleName = role.value;
    try { await api('PATCH', `/users/${u.id}`, body); m.close(); toast(t('saved')); done(); } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('name'), name, 'ename'), ...field(t('role'), role, 'urole'), self && h('p', { class: 'note' }, t('selfNote')),
    h('label', null, t('branches')), br.el, h('p', { class: 'muted' }, t('allBranches') + ' = ∅'), err,
    formRow(h('button', { class: 'btn primary', type: 'submit' }, t('save')), btn(t('cancel'), () => m.close()))));
}
function resetPw(u) {
  const err = h('div'), pw = h('input', { id: 'rpw', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const m = modal(`${t('resetPassword')} — ${u.name}`, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', `/users/${u.id}/password`, { password: pw.value }); m.close(); toast(t('saved')); } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('newPassword'), pw, 'rpw'), h('p', { class: 'muted' }, t('pwHint')), h('p', { class: 'note' }, t('resetNote')), err,
    formRow(h('button', { class: 'btn primary', type: 'submit' }, t('save')), btn(t('cancel'), () => m.close()))));
}

// ───────────── roles & permissions ─────────────
export async function rolesView(S) {
  const [{ roles }, { groups }] = await Promise.all([api('GET', '/roles'), api('GET', '/permissions')]);
  const wrap = h('div');
  const reload = () => rolesView(S).then((v) => wrap.replaceWith(v));
  put(wrap, formRow(h('h1', { class: 'grow' }, t('nav_roles')), isOwner(S) && btn(`+ ${t('newRole')}`, () => editRole(null, groups, reload), 'primary', { id: 'new-role' })),
    roles.map((r) => h('div', { class: 'role-card', 'data-role': r.name },
      formRow(h('strong', { class: 'grow' }, roleLabel(r.name)), r.system && h('span', { class: 'badge' }, t('systemRole')), h('span', { class: 'muted' }, `${t('members')}: ${r.members}`),
        isOwner(S) && r.name !== 'owner' && btn(t('edit'), () => editRole(r, groups, reload), '', { 'data-action': 'edit' }),
        isOwner(S) && !r.system && btn(t('del'), async () => {
          if (!(await confirmBox(t('confirmDelete')))) return;
          try { await api('DELETE', `/roles/${r.id}`); toast(t('deleted')); reload(); } catch (e) { toast(friendly(e), true); }
        }, 'danger', { 'data-action': 'delete' })),
      h('div', { class: 'chips' }, r.permissions.map((p) => h('span', { class: 'chip static' }, t('p_' + p)))))));
  return wrap;
}
function editRole(r, groups, done) {
  const err = h('div'), name = h('input', { id: 'rname', value: r?.name ?? '', required: true, disabled: Boolean(r?.system), pattern: '[a-z][a-z0-9_]{1,29}', autocapitalize: 'none' });
  const boxes = [];
  const permsEl = h('div', { class: 'perm-groups' }, groups.map((g) => h('div', { class: 'perm-group' }, h('h3', null, t('g_' + g.id)),
    g.permissions.map((p) => {
      const box = h('input', { type: 'checkbox', id: `perm-${p}`, checked: Boolean(r?.permissions.includes(p)) }); boxes.push({ p, box });
      return h('div', { class: 'perm-row' }, box, h('label', { for: `perm-${p}` }, t('p_' + p)));
    }))));
  const m = modal(r ? `${t('edit')} — ${roleLabel(r.name)}` : t('newRole'), h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const permissions = boxes.filter((b) => b.box.checked).map((b) => b.p);
    try {
      if (r) await api('PATCH', `/roles/${r.id}`, { permissions, ...(!r.system && name.value !== r.name ? { name: name.value } : {}) });
      else await api('POST', '/roles', { name: name.value, permissions });
      m.close(); toast(t('saved')); done();
    } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } }, ...field(t('roleCode'), name, 'rname'), h('label', null, t('permissions')), permsEl, err,
    formRow(h('button', { class: 'btn primary', type: 'submit' }, t('save')), btn(t('cancel'), () => m.close()))));
}

// ───────────── settings: shop identity + branches ─────────────
export async function settingsView(S) {
  const tenant = await api('GET', '/tenant'); const { branches } = await api('GET', '/branches');
  const wrap = h('div'); const reload = () => settingsView(S).then((v) => wrap.replaceWith(v));
  const c = tenant.company ?? {};
  const inp = (id, v, attrs = {}) => h('input', { id, value: v ?? '', ...attrs });
  const f = { name: inp('s-name', tenant.name), legalName: inp('s-legal', c.legalName), address: inp('s-address', c.address), phone: inp('s-phone', c.phone, { type: 'tel' }),
    ice: inp('s-ice', c.ice, { inputmode: 'numeric' }), if: inp('s-if', c.if), rc: inp('s-rc', c.rc), footer: inp('s-footer', c.footer) };
  const err = h('div'), editable = can(S, 'settings.manage');
  if (!editable) Object.values(f).forEach((x) => { x.disabled = true; });
  put(wrap, h('h1', null, t('nav_settings')),
    h('form', { class: 'card', id: 'company-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', '/tenant', { name: f.name.value, company: { legalName: f.legalName.value, address: f.address.value, phone: f.phone.value, ice: f.ice.value, if: f.if.value, rc: f.rc.value, footer: f.footer.value } });
        toast(t('saved')); S.tenant = await api('GET', '/tenant');
      } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
    } }, h('h2', null, t('company')), ...field(t('shopName'), f.name, 's-name'), ...field(t('legalName'), f.legalName, 's-legal'), ...field(t('address'), f.address, 's-address'),
      ...field(t('phoneShop'), f.phone, 's-phone'), h('div', { class: 'grid tiles' }, h('div', null, ...field(t('ice'), f.ice, 's-ice')), h('div', null, ...field(t('ifNo'), f.if, 's-if')), h('div', null, ...field(t('rcNo'), f.rc, 's-rc'))),
      ...field(t('footer'), f.footer, 's-footer'), err, editable && h('button', { class: 'btn primary', type: 'submit' }, t('save'))),
    h('div', { class: 'card' }, formRow(h('h2', { class: 'grow' }, t('branchesTitle')), can(S, 'branches.manage') && btn(`+ ${t('addBranch')}`, () => nameDialog(t('addBranch'), '', async (n) => { await api('POST', '/branches', { name: n }); reload(); }), '', { id: 'add-branch' })),
      h('table', null, h('tbody', null, branches.map((b) => h('tr', { 'data-branch': b.name }, h('td', null, b.name),
        h('td', null, can(S, 'branches.manage') && h('div', { class: 'row-actions' },
          btn(t('rename'), () => nameDialog(t('rename'), b.name, async (n) => { await api('PATCH', `/branches/${b.id}`, { name: n }); reload(); })),
          btn(t('del'), async () => {
            if (!(await confirmBox(t('confirmDelete')))) return;
            try { await api('DELETE', `/branches/${b.id}`); toast(t('deleted')); reload(); } catch (e) { toast(friendly(e), true); }
          }, 'danger')))))))));
  return wrap;
}
function nameDialog(title, value, save) {
  const err = h('div'), n = h('input', { id: 'dlg-name', value, required: true });
  const m = modal(title, h('form', { onsubmit: async (e) => { e.preventDefault(); try { await save(n.value); m.close(); toast(t('saved')); } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); } } },
    ...field(t('name'), n, 'dlg-name'), err, formRow(h('button', { class: 'btn primary', type: 'submit' }, t('save')), btn(t('cancel'), () => m.close()))));
}

// ───────────── journal ─────────────
export async function journalView() {
  const { entries } = await api('GET', '/audit?limit=200');
  return h('div', null, h('h1', null, t('journalTitle')), h('div', { class: 'card tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, [t('date'), t('who'), t('what'), t('onWhat')].map((x) => h('th', null, x)))),
    h('tbody', null, entries.map((e) => h('tr', null, h('td', null, dateFmt(e.at)), h('td', null, e.actor_name ?? '—'), h('td', null, h('code', null, e.action)), h('td', null, e.ref_type ?? '')))))));
}

// ───────────── printable invoice ─────────────
const METHOD = { cash: 'methodCash', card: 'methodCard', transfer: 'methodTransfer' };
export async function invoiceView(_S, query) {
  const d = await api('GET', `/invoices/${encodeURIComponent(query.get('id') ?? '')}`);
  const c = d.shop.company ?? {}, inv = d.invoice;
  const legal = [c.ice && `ICE ${c.ice}`, c.if && `IF ${c.if}`, c.rc && `RC ${c.rc}`].filter(Boolean).join(' · ');
  return h('div', null,
    formRow(h('a', { class: 'btn no-print', href: '#/invoices' }, `← ${t('back')}`), h('button', { class: 'btn primary no-print', id: 'print-btn', type: 'button', onclick: () => window.print() }, t('print'))),
    h('article', { class: 'invoice-sheet', id: 'invoice-sheet' },
      h('div', { class: 'meta' },
        h('div', null, h('h1', null, c.legalName || d.shop.name), c.address && h('div', null, c.address), c.phone && h('div', null, c.phone), legal && h('div', { class: 'muted' }, legal)),
        h('div', null, h('h2', null, `${t('invoiceTitle')} ${inv.invoice_no}`), h('div', null, dateFmt(inv.created_at)), h('div', null, `${t('branchLbl')}: ${inv.branch_name}`),
          inv.customer_name && h('div', null, `${t('customerLbl')}: ${inv.customer_name}`), inv.status === 'void' && h('span', { class: 'badge bad' }, t('void')))),
      h('table', null, h('thead', null, h('tr', null, [t('item'), t('qtyShort'), t('puHt'), t('totalLine')].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', null, d.lines.map((l) => h('tr', null, h('td', null, l.name), h('td', { class: 'num' }, `${qtyFmt(l.qty)} ${l.base_uom === 'unit' ? '' : uom(l.base_uom)}`),
          h('td', { class: 'num' }, money(l.unit_price)), h('td', { class: 'num' }, money(l.line_total)))))),
      Number(inv.discount_pct) > 0 && h('p', { class: 'num' }, `-${inv.discount_pct}%`),
      h('p', { class: 'total num', id: 'invoice-total' }, `${t('total')}: ${money(inv.total)}`),
      d.payments.length > 0 && h('div', null, h('h3', null, t('paymentsLbl')), d.payments.map((p) => h('div', { class: 'num' }, `${t(METHOD[p.method] ?? p.method)}: ${money(p.amount)}`))),
      h('p', { class: 'muted' }, c.footer || t('thanks'))));
}
