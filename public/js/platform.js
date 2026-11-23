import { api, errorBox, field, friendly, h, modal, toast, put } from './lib.js';
import { dateFmt, getLang, t } from './i18n.js';

export async function platformView() {
  const [{ tenants }, { activities }] = await Promise.all([api('GET', '/platform/tenants'), api('GET', '/activities')]);
  const wrap = h('div');
  const rows = tenants.map((x) => h('tr', null,
    h('td', null, x.name), h('td', null, x.slug), h('td', null, x.plan_id),
    h('td', null, (x.activities ?? []).map((a) => h('span', { class: 'badge' }, t(`act_${a}`)))),
    h('td', { class: 'num' }, String(x.users)), h('td', { class: 'num' }, String(x.items)), h('td', null, dateFmt(x.created_at))));
  put(wrap, 
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('shops')), h('button', { class: 'btn primary', type: 'button', onclick: () => openCreate(activities, () => platformView().then((v) => wrap.replaceWith(v))) }, `+ ${t('newShop')}`)),
    h('div', { class: 'card tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, [t('name'), t('slug'), t('plan'), t('activities'), t('usersCount'), t('itemsCount'), t('date')].map((x) => h('th', null, x)))),
      h('tbody', null, rows))));
  return wrap;
}

function openCreate(activities, done) {
  const err = h('div');
  const name = h('input', { id: 'sn', required: true }), slug = h('input', { id: 'ss', required: true, autocapitalize: 'none', pattern: '[a-z0-9]+(-[a-z0-9]+)*' }),
    plan = h('select', { id: 'sp' }, h('option', { value: 'pro' }, 'pro'), h('option', { value: 'basic' }, 'basic')),
    oname = h('input', { id: 'on', required: true }), oemail = h('input', { id: 'oe', type: 'email', required: true }),
    opw = h('input', { id: 'op', type: 'password', autocomplete: 'new-password', minlength: '10' });
  const selfOwner = h('input', { id: 'self-owner', type: 'checkbox', checked: true });
  const ownerFields = h('div', { hidden: true }, ...field(t('ownerName'), oname, 'on'),
    ...field(t('ownerEmail'), oemail, 'oe'), ...field(t('ownerPassword'), opw, 'op'));
  const switchOwnerMode = () => {
    ownerFields.hidden = selfOwner.checked;
    for (const input of [oname, oemail, opw]) input.required = !selfOwner.checked;
  };
  selfOwner.addEventListener('change', switchOwnerMode);
  switchOwnerMode();
  const checks = activities.map((a) => ({ id: a.id, box: h('input', { type: 'checkbox', id: `act-${a.id}`, value: a.id }) }));
  const m = modal(t('newShop'), h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    try {
      const isSelfOwner = selfOwner.checked;
      const created = await api('POST', '/platform/tenants', { name: name.value, slug: slug.value, plan: plan.value, activities: checks.filter((c) => c.box.checked).map((c) => c.id),
        owner: isSelfOwner ? { self: true } : { name: oname.value, email: oemail.value, password: opw.value } });
      toast(t('created')); m.close();
      if (isSelfOwner) {
        try {
          await api('POST', '/auth/switch-tenant', { tenantId: created.tenantId });
          location.hash = '#/dashboard'; location.reload();
        } catch { done(); }
      } else done();
    } catch (ex) { err.replaceChildren(errorBox(friendly(ex))); }
  } },
    ...field(t('name'), name, 'sn'), ...field(t('slug'), slug, 'ss'), ...field(t('plan'), plan, 'sp'),
    h('label', null, t('activities')),
    h('div', { class: 'chips' }, activities.map((a, i) => h('label', { class: 'chip', for: `act-${a.id}` }, checks[i].box, ` ${a.label[getLang()]}`))),
    h('label', { class: 'chip', for: 'self-owner' }, selfOwner, ` ${t('selfOwner')}`), ownerFields, err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, t('create')), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('cancel')))));
}
