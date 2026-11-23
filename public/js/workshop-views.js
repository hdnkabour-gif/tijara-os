import { api, field, friendly, h, modal, newKey, toast } from './lib.js';
import { dateFmt, dayFmt, getLang, money, qtyFmt } from './i18n.js';

const lang = {
  fr:{
    vehicles:'Véhicules',register:'Ajouter un véhicule',plate:'Immatriculation',make:'Marque',model:'Modèle',vin:'N° châssis',
    mileage:'Kilométrage',customer:'Client',noCustomer:'Client de passage',repair:'Atelier & réparations',newQuote:'Nouveau devis',
    issue:'Travaux à effectuer',item:'Pièce ou prestation',service:'Main-d’œuvre (facultatif)',qty:'Quantité',branch:'Point de vente',
    warranty:'Garantie (jours)',nextDate:'Prochain entretien (date)',nextKm:'Prochain entretien (km)',state:'État',
    quoted:'Devis',approved:'Validé',in_progress:'En réparation',completed:'Terminé',delivered:'Livré',cancelled:'Annulé',
    approve:'Approuver le devis',start:'Commencer',complete:'Terminer',deliver:'Livrer et facturer',
    cancel:'Annuler le devis',reason:'Motif',choose:'Choisir…',cash:'Espèces',card:'Carte',transfer:'Virement',credit:'Crédit client',
    reminders:'Entretiens à prévoir',due:'À rappeler',noData:'Aucun enregistrement',save:'Enregistrer',
    close:'Annuler',invalid:'Veuillez renseigner les champs requis',sent:'Enregistré',noAccess:'Droits insuffisants',addLine:'Ajouter une ligne',
    edit:'Modifier',history:'Historique',changeNote:'Motif du changement (ex. véhicule vendu)',owners:'Propriétaires successifs',
    repairs:'Réparations',warrantyUntil:'Garantie jusqu’au',inWarranty:'Sous garantie',warrantyOver:'Garantie terminée',noWarranty:'Sans garantie',
    since:'depuis',by:'par',
  },
  ar:{
    vehicles:'السيارات',register:'إضافة سيارة',plate:'رقم التسجيل',make:'الماركة',model:'الموديل',vin:'رقم الهيكل',
    mileage:'عدد الكيلومترات',customer:'الزبون',noCustomer:'زبون عابر',repair:'الورشة وأوامر الإصلاح',newQuote:'عرض سعر جديد',
    issue:'الأشغال المطلوبة',item:'قطعة أو خدمة',service:'اليد العاملة (اختياري)',qty:'الكمية',branch:'الفرع',
    warranty:'الضمان بالأيام',nextDate:'تاريخ الصيانة القادمة',nextKm:'كيلومترات الصيانة القادمة',state:'الحالة',
    quoted:'عرض سعر',approved:'موافق عليه',in_progress:'قيد الإصلاح',completed:'مكتمل',delivered:'تم التسليم',cancelled:'ملغى',
    approve:'الموافقة على عرض السعر',start:'بدء الإصلاح',complete:'إنهاء الإصلاح',deliver:'تسليم وفوترة',
    cancel:'إلغاء الطلب',reason:'السبب',choose:'اختر…',cash:'نقداً',card:'بطاقة',transfer:'تحويل',credit:'دين الزبون',
    reminders:'الصيانة المستحقة',due:'يجب التذكير',noData:'لا توجد بيانات',save:'حفظ',
    close:'إلغاء',invalid:'المرجو ملء الحقول',sent:'تم الحفظ',noAccess:'لا توجد صلاحيات',addLine:'إضافة سطر',
    edit:'تعديل',history:'السجل',changeNote:'سبب التغيير (مثلاً: بيعت السيارة)',owners:'المالكون المتعاقبون',
    repairs:'الإصلاحات',warrantyUntil:'الضمان حتى',inWarranty:'داخل الضمان',warrantyOver:'انتهى الضمان',noWarranty:'بدون ضمان',
    since:'منذ',by:'بواسطة',
  },
};
const w=(s)=>lang[getLang()][s]??s;
// a plate such as 20-B-200 is left-to-right text: isolate it so Arabic (RTL) screens do not display it as B-200-20
const plateTxt=(p)=>getLang()==='ar'?`\u2066${p}\u2069`:p;
const btn=(label,onclick,cls='')=>h('button',{type:'button',class:'btn '+cls,onclick},label);
const panel=(...kids)=>h('div',{class:'card'},...kids);
const select=(id,rows)=>h('select',{id},rows);
const opt=(value,label,selected=false)=>h('option',{value,selected},label);
const val=(id,value='',type='text',extra={})=>h('input',{id,value,type,...extra});
const number=(id,initial='0',step='1')=>val(id,initial,'number',{min:'0',step,required:true});
const title=(text,action)=>h('div',{class:'row'},h('h1',{class:'grow'},text),action);
const error=(ex)=>toast(friendly(ex),true);
const formModal=(heading,fields,onSave)=>{
  const key=newKey();   // one business command per dialog, reused on retry
  const err=h('div'),submit=h('button',{type:'submit',class:'btn primary'},w('save'));
  let busy=false;
  const m=modal(heading,h('form',{onsubmit:async(e)=>{
    e.preventDefault();
    if(busy)return;
    busy=true;submit.disabled=true;
    try{await onSave(key);m.close();}catch(ex){err.replaceChildren(h('div',{class:'error',role:'alert'},friendly(ex)));}
    finally{busy=false;submit.disabled=false;}
  }},...fields,err,h('div',{class:'row'},submit,btn(w('close'),()=>m.close()))));
  return m;
};
const branchChoose=(S,current,cb)=>h('div',{class:'row'},h('label',{for:'workshop-branch'},w('branch')),
  select('workshop-branch',S.branches.map(b=>opt(b.id,b.name,b.id===current))));
const refreshBranch=(root,cb)=>root.querySelector('#workshop-branch')?.addEventListener('change',(e)=>cb(e.target.value));

export async function vehiclesView(S){
  const wrap=h('div');
  const render=async()=>{
    const {vehicles}=await api('GET','/workshop/vehicles');
    const add=async()=>{
      const plate=val('v-plate','','text',{dir:'ltr'}),make=val('v-make',''),model=val('v-model',''),vin=val('v-vin','','text',{dir:'ltr'}),mileage=number('v-km');
      const customers=S.me.permissions.includes('customers.view')?(await api('GET','/customers')).customers.filter(c=>c.active):[];
      const customer=select('v-customer',[opt('',w('noCustomer')),...customers.map(c=>opt(c.id,c.name))]);
      formModal(w('register'),[...field(w('plate'),plate,'v-plate'),...field(w('make'),make,'v-make'),...field(w('model'),model,'v-model'),
        ...field(w('vin'),vin,'v-vin'),...field(w('mileage'),mileage,'v-km'),...field(w('customer'),customer,'v-customer')],async()=>{
          await api('POST','/workshop/vehicles',{plate:plate.value,make:make.value,model:model.value,vin:vin.value||null,
            odometerKm:Number(mileage.value),customerId:customer.value||null});
          toast(w('sent'));await render();
        });
    };
    const canManage=S.me.permissions.includes('workshop.manage'),canCustomers=S.me.permissions.includes('customers.view');
    const edit=async(v)=>{
      const plate=val('ve-plate',v.plate,'text',{dir:'ltr'}),make=val('ve-make',v.make),model=val('ve-model',v.model),vin=val('ve-vin',v.vin??'','text',{dir:'ltr'});
      const km=number('ve-km',String(v.odometer_km));km.min=String(v.odometer_km);   // the odometer never goes back
      const note=val('ve-note','');
      const fields=[...field(w('plate'),plate,'ve-plate'),...field(w('make'),make,'ve-make'),...field(w('model'),model,'ve-model'),
        ...field(w('vin'),vin,'ve-vin'),...field(w('mileage'),km,'ve-km')];
      let owner=null;
      if(canCustomers){   // handing the car to another customer needs customer access
        const customers=(await api('GET','/customers')).customers.filter(c=>c.active||c.id===v.customer_id);
        owner=select('ve-customer',[opt('',w('noCustomer'),!v.customer_id),...customers.map(c=>opt(c.id,c.name,c.id===v.customer_id))]);
        fields.push(...field(w('customer'),owner,'ve-customer'),...field(w('changeNote'),note,'ve-note'));
      }
      formModal(`${w('edit')} · ${plateTxt(v.plate)}`,fields,async()=>{
        const body={};
        if(plate.value.trim()!==v.plate)body.plate=plate.value;
        if(make.value.trim()!==v.make)body.make=make.value;
        if(model.value.trim()!==v.model)body.model=model.value;
        if(vin.value.trim()!==(v.vin??''))body.vin=vin.value.trim()||null;
        if(Number(km.value)!==Number(v.odometer_km))body.odometerKm=Number(km.value);
        if(owner&&(owner.value||null)!==(v.customer_id??null))body.customerId=owner.value||null;
        if(!Object.keys(body).length)return;
        if(note.value.trim())body.note=note.value.trim();
        await api('PATCH',`/workshop/vehicles/${v.id}`,body);
        toast(w('sent'));await render();
      });
    };
    const history=async(v)=>{
      const {vehicle,owners,repairs}=await api('GET',`/workshop/vehicles/${v.id}`);
      const warrantyBadge=(r)=>!r.warranty_until?h('span',{class:'badge'},w('noWarranty'))
        :h('span',{class:r.in_warranty?'badge ok':'badge bad'},`${r.in_warranty?w('inWarranty'):w('warrantyOver')} · ${w('warrantyUntil')} ${dayFmt(r.warranty_until)}`);
      modal(`${w('history')} · ${plateTxt(vehicle.plate)}`,h('div',{id:'vehicle-history'},
        h('p',{class:'muted'},`${vehicle.make} ${vehicle.model} · ${w('mileage')}: ${qtyFmt(vehicle.odometer_km)} · ${vehicle.customer_name??w('noCustomer')}`),
        h('h3',null,w('owners')),
        h('ul',{id:'owner-history'},owners.map(o=>h('li',null,`${o.customer_name??w('noCustomer')} · ${plateTxt(o.plate)} · ${w('since')} ${dateFmt(o.changed_at)}`
          +(o.changed_by?` · ${w('by')} ${o.changed_by}`:'')+(o.note&&o.note!=='initial'?` · ${o.note}`:'')))),
        h('h3',null,w('repairs')),
        repairs.length?h('ul',{id:'repair-history'},repairs.map(r=>h('li',null,
          `${dateFmt(r.delivered_at??r.created_at)} · ${w(r.state)} · ${money(r.quote_total)} · ${qtyFmt(r.mileage_at_visit)} km `,
          r.state==='delivered'&&warrantyBadge(r)))):h('p',{class:'muted'},w('noData'))));
    };
    const listing=vehicles.map(v=>panel(h('strong',null,`${plateTxt(v.plate)} · ${v.make} ${v.model}`),
      h('p',{class:'muted'},`${w('mileage')}: ${qtyFmt(v.odometer_km)} · ${v.customer_name??w('noCustomer')}`),
      h('div',{class:'row'},btn(w('history'),()=>history(v).catch(error)),canManage&&btn(w('edit'),()=>edit(v).catch(error)))));
    wrap.replaceChildren(title(w('vehicles'),S.me.permissions.includes('workshop.manage')&&btn('+ '+w('register'),add,'primary')),
      h('div',{class:'grid tiles'},listing.length?listing:panel(w('noData'))));
  };
  await render();return wrap;
}

export async function workshopView(S){
  let branchId=S.branches[0]?.id;
  if(!branchId)return panel(w('noData'));
  const wrap=h('div');
  const render=async()=>{
    const [{orders},{vehicles}]=await Promise.all([
      api('GET',`/workshop/orders?branchId=${branchId}`),api('GET','/workshop/vehicles')
    ]);
    const products=S.me.permissions.includes('catalog.view')?(await api('GET','/items')).items.filter(x=>x.active&&!x.serial_tracking):[];
    const permitted=S.me.permissions.includes('workshop.manage');
    const canSale=S.me.permissions.includes('sale.create');
    const quote=()=>{
      const vehicle=select('wo-vehicle',vehicles.map(v=>opt(v.id,`${plateTxt(v.plate)} · ${v.model}`)));
      const km=number('wo-km',String(vehicles[0]?.odometer_km??0));
      vehicle.addEventListener('change',()=>{ const v=vehicles.find(x=>x.id===vehicle.value); km.value=String(v?.odometer_km??0); });
      const linesBox=h('div',{id:'wo-lines'});
      const addLine=()=>{
        const n=linesBox.children.length;
        const part=select(`wo-item-${n}`,products.map(i=>opt(i.id,`${i.name} · ${money(i.price)}`)));
        const qty=number(`wo-qty-${n}`,'1','0.0001');
        const row=h('div',{class:'row wo-line','data-line':String(n)},h('div',{class:'grow'},part),h('div',null,qty),
          btn('✕',()=>{ if(linesBox.children.length>1) row.remove(); },''));
        linesBox.appendChild(row);
      };
      addLine();
      const warranty=number('wo-warranty','30'),nextDate=val('wo-next-date','','date'),
        nextKm=val('wo-next-km','','number',{min:'0',step:'1'}),notes=h('textarea',{id:'wo-notes',rows:3});
      formModal(w('newQuote'),[...field(w('plate'),vehicle,'wo-vehicle'),
        h('label',null,w('item')),linesBox,btn('+ '+w('addLine'),addLine,'',),
        ...field(w('mileage'),km,'wo-km'),...field(w('issue'),notes,'wo-notes'),
        ...field(w('warranty'),warranty,'wo-warranty'),...field(w('nextDate'),nextDate,'wo-next-date'),
        ...field(w('nextKm'),nextKm,'wo-next-km')],async(key)=>{
          const lines=[...linesBox.querySelectorAll('.wo-line')].map(r=>({itemId:r.querySelector('select').value,qty:Number(r.querySelector('input').value)}));
          await api('POST','/workshop/orders',{branchId,vehicleId:vehicle.value,mileageAtVisit:Number(km.value),
            warrantyDays:Number(warranty.value),note:notes.value||null,
            nextServiceDate:nextDate.value||null,nextServiceKm:nextKm.value?Number(nextKm.value):null,lines},
            {'idempotency-key':key});
          toast(w('sent'));await render();
        });
    };
    const transition=(o,action,extra)=>async()=>{
      try{await api('POST',`/workshop/orders/${o.id}/${action}`,extra??{}, {'idempotency-key':newKey()});toast(w('sent'));await render();}
      catch(ex){error(ex);}
    };
    const payDialog=(o)=>{
      const method=select('wo-payment',['cash','card','transfer','credit'].map(m=>opt(m,w(m))));
      formModal(w('deliver'),[h('p',null,money(o.quote_total)),...field(w('deliver'),method,'wo-payment')],async(key)=>{
        const payments=method.value==='credit'?[]:[{method:method.value,amount:Number(o.quote_total)}];
        await api('POST',`/workshop/orders/${o.id}/deliver`,{payments},{'idempotency-key':key});
        toast(w('sent'));await render();
      });
    };
    const cancelDialog=(o)=>{
      const reason=val('cancel-repair-reason');
      formModal(w('cancel'),[...field(w('reason'),reason,'cancel-repair-reason')],async(key)=>{
        await api('POST',`/workshop/orders/${o.id}/cancel`,{reason:reason.value},{'idempotency-key':key});
        toast(w('cancel'));await render();
      });
    };
    const listing=orders.map(o=>{
      const actions=[];
      if(permitted&&canSale&&o.state==='quoted')actions.push(btn(w('approve'),transition(o,'approve'),'primary'));
      if(permitted&&o.state==='approved')actions.push(btn(w('start'),transition(o,'start'),'primary'));
      if(permitted&&o.state==='in_progress')actions.push(btn(w('complete'),transition(o,'complete'),'primary'));
      if(permitted&&canSale&&o.state==='completed')actions.push(btn(w('deliver'),()=>payDialog(o),'primary'));
      if(permitted&&['quoted','approved','in_progress','completed'].includes(o.state))actions.push(btn(w('cancel'),()=>cancelDialog(o),'danger'));
      return panel(h('div',{class:'row'},h('strong',{class:'grow'},`${plateTxt(o.plate)} · ${o.make} ${o.model}`),
        h('span',{class:'badge'},w(o.state))),
        h('p',{class:'muted'},o.issue_note||''),
        h('p',null,o.lines.map(l=>`${l.item} × ${qtyFmt(l.qty)}`).join(' · ')),
        h('p',null,`${money(o.quote_total)} · ${w('warranty')}: ${o.warranty_days}`+(o.warranty_until?` · ${w('warrantyUntil')} ${dayFmt(o.warranty_until)}`:'')),
        h('div',{class:'row'},...actions));
    });
    wrap.replaceChildren(title(w('repair'),permitted&&canSale&&products.length&&vehicles.length?btn('+ '+w('newQuote'),quote,'primary'):null),
      branchChoose(S,branchId),h('div',{class:'grid tiles'},listing.length?listing:panel(w('noData'))));
    refreshBranch(wrap,(v)=>{branchId=v;render().catch(error);});
  };
  await render();return wrap;
}

export async function workshopRemindersView(S){
  let branchId=S.branches[0]?.id;
  if(!branchId)return panel(w('noData'));
  const wrap=h('div');
  const render=async()=>{
    const {reminders}=await api('GET',`/workshop/reminders?branchId=${branchId}`);
    const contactLink=(r)=>{
      if(!r.phone)return null;
      let number=String(r.phone).replace(/[^0-9]/g,'');
      if(number.startsWith('0'))number='212'+number.slice(1);
      if(number.length<10||number.length>15)return null;
      const msg=getLang()==='ar'?`مرحباً، تذكير بموعد صيانة سيارتكم ${plateTxt(r.plate)}.`:
        `Bonjour, rappel d'entretien de votre véhicule ${plateTxt(r.plate)}.`;
      return h('a',{class:'btn',href:`https://wa.me/${number}?text=${encodeURIComponent(msg)}`,target:'_blank',rel:'noopener noreferrer'},'WhatsApp');
    };
    wrap.replaceChildren(title(w('reminders')),
      branchChoose(S,branchId),h('div',{class:'grid tiles'},reminders.length?reminders.map(r=>
        panel(h('strong',null,`${plateTxt(r.plate)} · ${r.make} ${r.model}`),
          h('p',{class:'muted'},r.customer??''),h('p',null,`${w('nextDate')}: ${r.next_service_date??'-'} · ${w('nextKm')}: ${r.next_service_km??'-'}`),
          contactLink(r))):panel(w('noData'))));
    refreshBranch(wrap,(v)=>{branchId=v;render().catch(error);});
  };
  await render();return wrap;
}
