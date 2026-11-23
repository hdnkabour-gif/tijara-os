import { api, field, friendly, h, modal, newKey, toast } from './lib.js';
import { getLang, money, qtyFmt } from './i18n.js';

const dict = {
  fr: {
    grill:'Cuisine & grill', queue:'Commandes à préparer', create:'Envoyer à la cuisine', label:'Table / numéro de retrait',
    item:'Article', qty:'Quantité', branch:'Point de vente', waiting:'En attente', cooking:'Sur le gril', ready:'Prête',
    start:'Démarrer la préparation', markReady:'Marquer prête', collect:'Encaisser', cash:'Espèces', card:'Carte', transfer:'Virement',
    suppliers:'Fournisseurs & achats', supplier:'Fournisseur', addSupplier:'Ajouter un fournisseur', receive:'Réceptionner une livraison',
    reference:'Référence du bon', cost:'Coût unitaire', newSupply:'Réception de stock', received:'Livraison enregistrée',
    cashbook:'Clôture de caisse', float:'Fond de caisse', count:'Espèces comptées', open:'Ouvrir une session',
    close:'Clôturer', expected:'Attendu', difference:'Écart', shift:'Session', closed:'Clôturée', openState:'Ouverte',
    transform:'Découpe & transformation', input:'Viande d’origine', output:'Produit transformé', inputQty:'Quantité consommée',
    outputQty:'Quantité obtenue', waste:'Perte / déchets (kg)', convert:'Enregistrer la transformation',
    empty:'Aucune opération à afficher', save:'Valider', cancel:'Annuler', loading:'Actualiser', archived:'Archivé',
    notProduction:'Choisissez deux produits différents avec la même unité',
  },
  ar: {
    grill:'المطبخ والمشوي',queue:'طلبات التحضير',create:'إرسال إلى الشواء',label:'رقم الطاولة أو الطلب',
    item:'المنتج',qty:'الكمية',branch:'نقطة البيع',waiting:'في الانتظار',cooking:'على النار',ready:'جاهز',
    start:'بدء التحضير',markReady:'تحديد كجاهز',collect:'استخلاص الطلب',cash:'نقداً',card:'بطاقة',transfer:'تحويل',
    suppliers:'الموردون والمشتريات',supplier:'المورد',addSupplier:'إضافة مورد',receive:'تسجيل تسلم بضاعة',
    reference:'رقم سند التسليم',cost:'ثمن الشراء للوحدة',newSupply:'استلام المخزون',received:'تم تسجيل الاستلام',
    cashbook:'جلسات الصندوق',float:'رصيد بداية الصندوق',count:'النقد المحسوب',open:'فتح جلسة',
    close:'إغلاق',expected:'المبلغ المنتظر',difference:'الفارق',shift:'جلسة',closed:'مغلقة',openState:'مفتوحة',
    transform:'تقطيع وتحويل اللحوم',input:'اللحم الأصلي',output:'المنتج المحوّل',inputQty:'الكمية المستهلكة',
    outputQty:'الكمية المنتَجة',waste:'الفاقد/المخلفات (كلغ)',convert:'تسجيل التحويل',
    empty:'لا توجد عمليات للعرض',save:'تأكيد',cancel:'إلغاء',loading:'تحديث',archived:'مؤرشف',
    notProduction:'اختر منتجين مختلفين بنفس وحدة القياس',
  },
};
const w=(k)=>dict[getLang()][k]??k;
const btn=(label,callback,cls='')=>h('button',{class:'btn '+cls,type:'button',onclick:callback},label);
const head=(title,action)=>h('div',{class:'row'},h('h1',{class:'grow'},title),action);
const card=(...children)=>h('div',{class:'card'},...children);
const danger=(err)=>{toast(friendly(err),true);};
const branchDropdown=(S,current,cb)=>h('select',{id:'ops-branch',onchange:(e)=>cb(e.target.value)},
  S.branches.map((b)=>h('option',{value:b.id,selected:b.id===current},b.name)));
const formModal=(title,inputs,onSubmit)=>{
  const err=h('div'),submit=h('button',{type:'submit',class:'btn primary'},w('save'));
  let busy=false;
  const m=modal(title,h('form',{onsubmit:async(e)=>{
    e.preventDefault();
    if(busy)return;
    busy=true;submit.disabled=true;
    try{await onSubmit();m.close();}
    catch(ex){err.replaceChildren(h('div',{class:'error',role:'alert'},friendly(ex)));}
    finally{busy=false;submit.disabled=false;}
  }},...inputs,err,h('div',{class:'row'},submit,btn(w('cancel'),()=>m.close()))));
  return m;
};
const select=(id,list,mapper)=>h('select',{id},list.map(mapper));
const activeProducts=(items,onlyKg=false)=>items.filter(i=>i.active && (!onlyKg || (i.track_quantity && i.base_uom==='kg')));
const itemSelect=(items,id='ops-item')=>select(id,items,i=>h('option',{value:i.id},`${i.name} · ${money(i.price)}`));
const numberInput=(id,value='1',step='0.001')=>h('input',{id,type:'number',min:'0',step,value,required:true});
const branchSelector=(S,id,set)=>h('div',{class:'row'},h('label',{for:'ops-branch'},w('branch')),branchDropdown(S,id,set));
const stateName=(s)=>s==='confirmed'?w('waiting'):s==='in_preparation'?w('cooking'):w('ready');

export async function grillView(S){
  let branchId=S.branches[0]?.id;
  const root=h('div');
  const render=async()=>{
    if(!branchId){root.replaceChildren(card(w('empty')));return;}
    const [{orders},{items}]=await Promise.all([api('GET',`/grill/orders?branchId=${branchId}`),api('GET','/items')]);
    const products=activeProducts(items);
    const create=()=> {
      const label=h('input',{id:'grill-label',placeholder:w('label'),maxlength:'60'});
      const product=itemSelect(products,'grill-item'),qty=numberInput('grill-qty');
      formModal(w('create'),[...field(w('label'),label,'grill-label'),...field(w('item'),product,'grill-item'),...field(w('qty'),qty,'grill-qty')],async()=>{
        await api('POST','/grill/orders',{branchId,label:label.value||null,lines:[{itemId:product.value,qty:Number(qty.value)}]},{'idempotency-key':newKey()});
        toast(w('create'));await render();
      });
    };
    const actions=async(o)=>{
      const button=[];
      if(o.state==='confirmed'&&S.me.permissions.includes('kitchen.manage'))button.push(btn(w('start'),async()=>{try{await api('POST',`/grill/orders/${o.id}/start`,{}, {'idempotency-key':newKey()});render();}catch(e){danger(e);}},'primary'));
      if(o.state==='in_preparation'&&S.me.permissions.includes('kitchen.manage'))button.push(btn(w('markReady'),async()=>{try{await api('POST',`/grill/orders/${o.id}/ready`,{}, {'idempotency-key':newKey()});render();}catch(e){danger(e);}},'primary'));
      if(o.state==='ready'&&S.me.permissions.includes('sale.create'))button.push(btn(w('collect'),()=>{
        const method=select('grill-payment',['cash','card','transfer'],p=>h('option',{value:p},w(p)));
        formModal(w('collect'),[h('p',null,money(o.total)),...field(w('collect'),method,'grill-payment')],async()=>{
          await api('POST',`/grill/orders/${o.id}/pay`,{payments:[{method:method.value,amount:Number(o.total)}]}, {'idempotency-key':newKey()});
          toast(w('collect'));await render();
        });
      },'primary'));
      return button;
    };
    const rows=[];
    for(const o of orders)rows.push(card(h('div',{class:'row'},h('strong',{class:'grow'},o.service_label||o.id.slice(0,8)),h('span',{class:'badge'},stateName(o.state))),h('p',{class:'muted'},o.lines.map(l=>`${l.item} × ${qtyFmt(l.qty)} ${l.unit}`).join(' · ')),h('p',null,money(o.total)),h('div',{class:'row'},...(await actions(o)))));
    root.replaceChildren(head(w('grill'),S.me.permissions.includes('sale.create')?btn('+ '+w('create'),create,'primary'):null),
      branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      h('h2',null,w('queue')),h('div',{class:'grid tiles'},rows.length?rows:card(w('empty'))));
  };
  await render();return root;
}

export async function suppliersView(S){
  let branchId=S.branches[0]?.id; const root=h('div');
  const render=async()=>{
    const [{suppliers},{items}]=await Promise.all([api('GET','/suppliers'),api('GET','/items')]);
    const productList=activeProducts(items).filter(i=>i.track_quantity);
    const createSup=()=>{
      const name=h('input',{id:'sup-name',required:true}),phone=h('input',{id:'sup-phone'});
      formModal(w('addSupplier'),[...field(w('supplier'),name,'sup-name'),...field('Téléphone / الهاتف',phone,'sup-phone')],async()=>{
        await api('POST','/suppliers',{name:name.value,phone:phone.value||undefined});toast(w('addSupplier'));await render();
      });
    };
    const receive=()=>{
      const people=suppliers.filter(s=>s.active);
      if(!people.length||!productList.length){toast(w('empty'),true);return;}
      const supplier=select('purchase-supplier',people,s=>h('option',{value:s.id},s.name));
      const item=itemSelect(productList,'purchase-item'),qty=numberInput('purchase-qty'),unitCost=numberInput('purchase-cost','0','0.0001');
      const reference=h('input',{id:'purchase-ref'});
      formModal(w('newSupply'),[...field(w('supplier'),supplier,'purchase-supplier'),...field(w('reference'),reference,'purchase-ref'),
        ...field(w('item'),item,'purchase-item'),...field(w('qty'),qty,'purchase-qty'),...field(w('cost'),unitCost,'purchase-cost')],async()=>{
          await api('POST','/purchase-receipts',{branchId,supplierId:supplier.value,reference:reference.value||null,
            lines:[{itemId:item.value,qty:Number(qty.value),unitCost:Number(unitCost.value)}]}, {'idempotency-key':newKey()});
          toast(w('received'));await render();
        });
    };
    const receipts=branchId?(await api('GET',`/purchase-receipts?branchId=${branchId}`)).receipts:[];
    root.replaceChildren(head(w('suppliers'),h('div',{class:'row'},S.me.permissions.includes('purchases.manage')&&btn('+ '+w('addSupplier'),createSup),S.me.permissions.includes('purchases.manage')&&btn('+ '+w('receive'),receive,'primary'))),
      branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      card(h('h2',null,w('suppliers')),h('div',{class:'chips'},suppliers.map(s=>h('span',{class:'chip'},s.name+(s.active?'':` (${w('archived')})`)))),
      card(h('h2',null,w('newSupply')),receipts.length?receipts.map(r=>h('p',null,`${r.supplier} · ${r.reference||''} · ${money(r.total)}`)):h('p',{class:'muted'},w('empty'))));
  };
  await render();return root;
}

export async function cashView(S){
  let branchId=S.branches[0]?.id; const root=h('div');
  const render=async()=>{
    const {sessions}=await api('GET',`/cash-sessions?branchId=${branchId}`);
    const actions=()=>{
      const canManage=S.me.permissions.includes('cash.manage');
      const open=()=>{
        const fl=numberInput('opening-float','0','0.01');
        formModal(w('open'),[...field(w('float'),fl,'opening-float')],async()=>{
          await api('POST','/cash-sessions',{branchId,openingFloat:Number(fl.value)});toast(w('open'));await render();
        });
      };
      return canManage&&!sessions.some(s=>!s.closed_at)?btn('+ '+w('open'),open,'primary'):null;
    };
    root.replaceChildren(head(w('cashbook'),actions()),branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      h('div',{class:'grid tiles'},sessions.length?sessions.map(s=>{
        const close=()=>{
          const amt=numberInput('close-count','0','0.01');
          formModal(w('close'),[...field(w('count'),amt,'close-count')],async()=>{
            const r=await api('POST',`/cash-sessions/${s.id}/close`,{countedCash:Number(amt.value)});
            toast(`${w('difference')}: ${money(r.difference)}`);await render();
          });
        };
        return card(h('div',{class:'row'},h('strong',null,w('shift')),h('span',{class:'badge'},s.closed_at?w('closed'):w('openState'))),
          h('p',null,`${w('float')}: ${money(s.opening_float)}`),s.closed_at&&h('p',null,`${w('expected')}: ${money(s.expected_cash)} · ${w('difference')}: ${money(s.difference)}`),
          !s.closed_at&&S.me.permissions.includes('cash.manage')&&btn(w('close'),close,'primary'));
      }):card(w('empty'))));
  };
  if(!branchId)return card(w('empty'));await render();return root;
}

export async function transformsView(S){
  let branchId=S.branches[0]?.id;const root=h('div');
  const render=async()=>{
    const [{items},{orders}]=await Promise.all([api('GET','/items'),api('GET',`/production/transforms?branchId=${branchId}`)]);
    const products=activeProducts(items,true);
    const transform=()=>{
      if(products.length<2){toast(w('empty'),true);return;}
      const input=itemSelect(products,'prod-input'),output=itemSelect(products,'prod-output'),
        inputQty=numberInput('prod-inqty','1'),outputQty=numberInput('prod-outqty','0.95'),wasteQty=numberInput('prod-waste','0.05');
      formModal(w('transform'),[...field(w('input'),input,'prod-input'),...field(w('inputQty'),inputQty,'prod-inqty'),
        ...field(w('output'),output,'prod-output'),...field(w('outputQty'),outputQty,'prod-outqty'),...field(w('waste'),wasteQty,'prod-waste')],async()=>{
          if(input.value===output.value){toast(w('notProduction'),true);return;}
          await api('POST','/production/transforms',{branchId,inputItemId:input.value,outputItemId:output.value,
            inputQty:Number(inputQty.value),outputQty:Number(outputQty.value),wasteQty:Number(wasteQty.value)},
            {'idempotency-key':newKey()});
          toast(w('convert'));await render();
        });
    };
    root.replaceChildren(head(w('transform'),S.me.permissions.includes('production.manage')&&btn('+ '+w('convert'),transform,'primary')),
      branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      card(h('h2',null,w('transform')),orders.length?orders.map(o=>h('p',null,`${o.id.slice(0,8)} · ${money(o.total_input_cost)}`)):h('p',{class:'muted'},w('empty'))));
  };
  if(!branchId)return card(w('empty'));await render();return root;
}
