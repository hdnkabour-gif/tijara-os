import { api, errorBox, field, friendly, h, modal, toast, put } from './lib.js';
import { dateFmt, getLang, t } from './i18n.js';

export async function platformView() {
  const [{ tenants }, { activities }, { plans }] = await Promise.all([api('GET', '/platform/tenants'), api('GET', '/activities'), api('GET','/platform/plans')]);
  const wrap = h('div', { class: 'platform-page' });
  const reload = () => platformView().then(v => wrap.replaceWith(v));
  const openNewShop = () => openCreate(activities, plans, reload);
  const editShop = (shop) => openControls(shop,plans,reload);
  const rows = tenants.map((x) => h('tr', null,
    h('td', null, x.name), h('td', null, x.slug), h('td', null, x.plan_id),
    h('td', null, (x.activities ?? []).map((a) => h('span', { class: 'badge' }, t(`act_${a}`)))),
    h('td', { class: 'num' }, `${x.users}/${x.max_users}`), h('td', { class: 'num' }, `${x.items}/${x.max_items}`),
    h('td', null, h('span',{class:x.status==='active'?'badge':'badge bad'},x.status==='active'?(getLang()==='ar'?'نشط':'Actif'):(getLang()==='ar'?'موقوف':'Suspendu'))),
    h('td',null,h('button',{class:'btn',type:'button',onclick:()=>editShop(x)},getLang()==='ar'?'الإدارة':'Gérer')),
    h('td', null, dateFmt(x.created_at))));
  put(wrap,
    h('div', { class: 'page-heading' },
      h('div', null,
        h('span', { class: 'eyebrow' }, t('platformWorkspace')),
        h('h1', null, t('shops')),
        h('p', { class: 'muted page-intro' }, t('platformIntro'))),
      h('button', { class: 'btn primary', type: 'button', onclick: openNewShop }, `+ ${t('newShop')}`)),
    h('div', { class: 'grid overview-strip' },
      h('div', { class: 'tile' },
        h('span', { class: 'l' }, t('shopsCount')),
        h('div', { class: 'v' }, String(tenants.length))),
      h('div', { class: 'tile' },
        h('span', { class: 'l' }, t('platformScope')),
        h('div', { class: 'v overview-caption' }, t('platformScopeValue')))),
    tenants.length === 0
      ? h('section', { class: 'platform-empty card' },
          h('div', { class: 'empty-illustration', 'aria-hidden': 'true' }, '◈'),
          h('div', { class: 'empty-content' },
            h('span', { class: 'eyebrow' }, t('getStarted')),
            h('h2', null, t('platformEmptyTitle')),
            h('p', { class: 'muted' }, t('platformEmptyDetail')),
            h('div', { class: 'setup-steps' },
              h('div', null, h('b', null, '01'), h('span', null, t('setupCreate'))),
              h('div', null, h('b', null, '02'), h('span', null, t('setupActivities'))),
              h('div', null, h('b', null, '03'), h('span', null, t('setupDemo')))),
            h('button', { class: 'btn primary', type: 'button', onclick: openNewShop }, t('startFirstShop'))))
      : h('div', { class: 'card tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, [t('name'), t('slug'), t('plan'), t('activities'), t('usersCount'), t('itemsCount'), getLang()==='ar'?'الحالة':'Statut',getLang()==='ar'?'التحكم':'Gestion',t('date')].map((x) => h('th', null, x)))),
          h('tbody', null, rows))));
  return wrap;
}

function openCreate(activities, plans, done) {
  const err = h('div');
  const name = h('input', { id: 'sn', required: true }), slug = h('input', { id: 'ss', required: true, autocapitalize: 'none', pattern: '[a-z0-9]+(-[a-z0-9]+)*' }),
    plan = h('select', { id: 'sp' }, plans.map(p=>h('option',{value:p.id,selected:p.id==='pro'},p.name))),
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

/** Platform super-admin only. Shop owners cannot invoke this UI or its API. */
export function openControls(shop,plans,done){
  const ar=getLang()==='ar';
  const txt=(fr,arText)=>ar?arText:fr;
  const header=txt('Gérer abonnement & accès','التحكم في الباقة والدخول');
  const plan=h('select',{id:'tenant-plan'},plans.map(p=>h('option',{value:p.id,selected:p.id===shop.plan_id},p.name)));
  const status=h('select',{id:'tenant-status'},
    h('option',{value:'active',selected:shop.status==='active'},txt('Actif','نشط')),
    h('option',{value:'suspended',selected:shop.status==='suspended'},txt('Suspendu','موقوف')));
  const reason=h('input',{id:'tenant-reason',maxlength:'300',value:shop.status_reason??'',placeholder:txt('Motif obligatoire en cas de suspension','سبب الإيقاف إجباري')});
  const fields=[
    ['max_users',txt('Utilisateurs','المستخدمون')],['max_items',txt('Articles','المنتجات')],
    ['max_branches',txt('Points de vente','الفروع')],['max_customers',txt('Clients','الزبناء')],
    ['max_monthly_orders',txt('Commandes par mois','الطلبات شهرياً')],
  ].map(([key,label])=>{
    const override=shop.overrides?.[key];
    const input=h('input',{id:'limit-'+key,type:'number',min:'1',max:'10000000',step:'1',
      placeholder:String(shop[key]??''),value:override==null?'':String(override)});
    return {key,label,input};
  });
  const modules=[
    ['kitchen',txt('Cuisine / grill','المطبخ والمشوي')],['workshop',txt('Atelier mécanique','ورشة الميكانيك')],
    ['purchases',txt('Achats / fournisseurs','المشتريات والموردون')],['cash',txt('Clôture de caisse','إغلاق الصندوق')],
    ['production',txt('Transformation','تحويل اللحوم')],['bookings',txt('Commandes / réservations','الطلبات والحجوزات')],
    ['delivery',txt('Livraison','التوصيل')]
  ].map(([key,label])=>{
    const v=shop.feature_overrides?.[key];
    const input=h('select',{id:'feature-'+key},
      h('option',{value:'inherit',selected:typeof v!=='boolean'},txt('Selon le forfait','حسب الباقة')),
      h('option',{value:'on',selected:v===true},txt('Activé','مفعّل')),
      h('option',{value:'off',selected:v===false},txt('Désactivé','معطّل')));
    return {key,label,input};
  });
  const error=h('div');
  const submit=h('button',{class:'btn primary',type:'submit'},txt('Enregistrer','حفظ'));
  const form=h('form',{onsubmit:async(e)=>{
    e.preventDefault();submit.disabled=true;error.replaceChildren();
    try{
      const limits={};
      for(const f of fields){
        const v=f.input.value.trim();
        if(v&&(!Number.isSafeInteger(Number(v))||Number(v)<1||Number(v)>10000000))
          throw new Error(txt('Limite invalide','الحد غير صالح')+' '+f.label);
        limits[f.key]=v===''?null:Number(v);
      }
      if(status.value==='suspended'&&!reason.value.trim())
        throw new Error(txt('Précisez le motif de suspension','أدخل سبب إيقاف المحل'));
      const features={};
      for(const f of modules){
        if(f.input.value!=='inherit')features[f.key]=f.input.value==='on';
      }
      await api('PATCH',`/platform/tenants/${shop.id}/controls`,{
        plan:plan.value,status:status.value,reason:status.value==='suspended'?reason.value.trim():undefined,limits,features
      });
      toast(txt('Modifications enregistrées','تم حفظ التغييرات'));m.close();done();
    }catch(ex){
      error.replaceChildren(errorBox(ex?.message??friendly(ex)));
    }finally{submit.disabled=false;}
  }},
    h('p',{class:'muted'},shop.name+' — '+shop.slug),
    ...field(txt('Abonnement','الباقة'),plan,'tenant-plan'),
    ...field(txt('Accès au commerce','حالة المحل'),status,'tenant-status'),
    ...field(txt('Motif d’arrêt','سبب الإيقاف'),reason,'tenant-reason'),
    h('h3',null,txt('Limites personnalisées','الحدود الخاصة بالمحل')),
    h('p',{class:'muted'},txt('Laisser vide pour appliquer la limite du forfait. Réduire une limite ne supprime aucune donnée.','اتركه فارغاً لتطبيق حد الباقة. تقليل الحد لا يحذف البيانات.')),
    fields.map(f=>h('div',null,...field(f.label,f.input,'limit-'+f.key))),
    h('h3',null,txt('Modules et autorisations','الوحدات والصلاحيات')),
    h('p',{class:'muted'},txt('Les droits des employés restent gérés dans chaque commerce. Ici, vous activez ou bloquez les modules.','صلاحيات الموظفين يديرها صاحب المحل؛ هنا تفعل أو تعطل الوحدات.')),
    modules.map(f=>h('div',null,...field(f.label,f.input,'feature-'+f.key))),
    error,h('div',{class:'row'},submit,h('button',{type:'button',class:'btn',onclick:()=>m.close()},t('cancel'))));
  const m=modal(header,form);
}
