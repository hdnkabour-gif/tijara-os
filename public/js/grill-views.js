import { api, field, friendly, h, modal, newKey, toast } from './lib.js';
import { dayFmt, getLang, money, qtyFmt, uom } from './i18n.js';

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
    notProduction:'Choisissez deux produits différents avec la même unité', addLine:'Ajouter un article',
    batch:'N° de lot', expiry:'À consommer avant le', serials:'Numéros de série (un par ligne)', supplierWarranty:'Garantie fournisseur jusqu’au',
    expiring:'À écouler en priorité (péremption ≤ 3 jours)', daysLeft:'jours restants', expired:'Périmé — à retirer de la vente',
    receipt:'Bon de réception', lineTotal:'Montant', expiryShort:'DLC', serialsShort:'N° de série', receivedBy:'Reçu par', details:'Détails', remove:'Retirer',
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
    notProduction:'اختر منتجين مختلفين بنفس وحدة القياس', addLine:'إضافة صنف',
    batch:'رقم الحصة (اللوط)', expiry:'تاريخ انتهاء الصلاحية', serials:'الأرقام التسلسلية (رقم في كل سطر)', supplierWarranty:'ضمان المورد حتى',
    expiring:'يجب بيعه أولاً (تنتهي صلاحيته خلال 3 أيام)', daysLeft:'أيام متبقية', expired:'منتهي الصلاحية — يُسحب من البيع',
    receipt:'سند الاستلام', lineTotal:'المبلغ', expiryShort:'نهاية الصلاحية', serialsShort:'الرقم التسلسلي', receivedBy:'استلمه', details:'التفاصيل', remove:'حذف',
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
  const key=newKey();   // one business command per dialog, reused on retry
  const err=h('div'),submit=h('button',{type:'submit',class:'btn primary'},w('save'));
  let busy=false;
  const m=modal(title,h('form',{onsubmit:async(e)=>{
    e.preventDefault();
    if(busy)return;
    busy=true;submit.disabled=true;
    try{await onSubmit(key);m.close();}
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
      const linesBox=h('div',{id:'grill-lines'});
      const addLine=()=>{
        const n=linesBox.children.length;
        const product=itemSelect(products,`grill-item-${n}`),qty=numberInput(`grill-qty-${n}`);
        const row=h('div',{class:'row grill-line'},h('div',{class:'grow'},product),h('div',null,qty),
          btn('✕',()=>{ if(linesBox.children.length>1) row.remove(); }));
        linesBox.appendChild(row);
      };
      addLine();
      formModal(w('create'),[...field(w('label'),label,'grill-label'),h('label',null,w('item')),linesBox,btn('+ '+w('addLine'),addLine)],async(key)=>{
        const lines=[...linesBox.querySelectorAll('.grill-line')].map(r=>({itemId:r.querySelector('select').value,qty:Number(r.querySelector('input').value)}));
        await api('POST','/grill/orders',{branchId,label:label.value||null,lines},{'idempotency-key':key});
        toast(w('create'));await render();
      });
    };
    const actions=async(o)=>{
      const button=[];
      if(o.state==='confirmed'&&S.me.permissions.includes('kitchen.manage'))button.push(btn(w('start'),async()=>{try{await api('POST',`/grill/orders/${o.id}/start`,{}, {'idempotency-key':newKey()});render();}catch(e){danger(e);}},'primary'));
      if(o.state==='in_preparation'&&S.me.permissions.includes('kitchen.manage'))button.push(btn(w('markReady'),async()=>{try{await api('POST',`/grill/orders/${o.id}/ready`,{}, {'idempotency-key':newKey()});render();}catch(e){danger(e);}},'primary'));
      if(o.state==='ready'&&S.me.permissions.includes('sale.create'))button.push(btn(w('collect'),()=>{
        const method=select('grill-payment',['cash','card','transfer'],p=>h('option',{value:p},w(p)));
        formModal(w('collect'),[h('p',null,money(o.total)),...field(w('collect'),method,'grill-payment')],async(key)=>{
          await api('POST',`/grill/orders/${o.id}/pay`,{payments:[{method:method.value,amount:Number(o.total)}]}, {'idempotency-key':key});
          toast(w('collect'));await render();
        });
      },'primary'));
      return button;
    };
    const rows=[];
    for(const o of orders)rows.push(card(h('div',{class:'row'},h('strong',{class:'grow'},o.service_label||o.id.slice(0,8)),h('span',{class:'badge'},stateName(o.state))),h('ul',{class:'order-lines kitchen-lines'},o.lines.map(l=>h('li',null,h('strong',null,`${l.item} × ${qtyFmt(l.qty)} ${uom(l.unit)}`),l.note?h('span',{class:'kitchen-note'},` — ${l.note}`):''))),h('p',null,money(o.total)),h('div',{class:'row'},...(await actions(o)))));
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
      const reference=h('input',{id:'purchase-ref'});
      const today=new Date().toISOString().slice(0,10),tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
      const linesBox=h('div',{id:'purchase-lines'});
      const lines=[];let n=0;
      // one line = one product; batch/expiry only for products tracked by batch, serial numbers only for serial products
      const addLine=()=>{
        const i=n++;
        const item=itemSelect(productList,`purchase-item-${i}`),qty=numberInput(`purchase-qty-${i}`),unitCost=numberInput(`purchase-cost-${i}`,'0','0.0001');
        const batch=h('input',{id:`purchase-batch-${i}`,maxlength:'60'}),expiry=h('input',{id:`purchase-exp-${i}`,type:'date',min:tomorrow});
        const serials=h('textarea',{id:`purchase-serials-${i}`,rows:'3'}),warranty=h('input',{id:`purchase-war-${i}`,type:'date',min:today});
        const extra=h('div');
        const row=h('div',{class:'card purchase-line'});
        const pick=()=>productList.find(p=>p.id===item.value);
        const refresh=()=>{
          const it=pick();extra.replaceChildren();
          qty.disabled=Boolean(it?.serial_tracking);
          if(it&&it.batch_tracking!=='none'){
            batch.required=it.batch_tracking==='required';
            extra.append(...field(w('batch'),batch,batch.id),...field(w('expiry'),expiry,expiry.id));
          }
          if(it?.serial_tracking)extra.append(...field(w('serials'),serials,serials.id),...field(w('supplierWarranty'),warranty,warranty.id));
        };
        const line={read:()=>{
          const it=pick(),list=serials.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
          const out={itemId:item.value,qty:it?.serial_tracking?list.length:Number(qty.value),unitCost:Number(unitCost.value)};
          if(it&&it.batch_tracking!=='none'){ if(batch.value.trim())out.batchNo=batch.value.trim(); if(expiry.value)out.expiresAt=expiry.value; }
          if(it?.serial_tracking){ out.serials=list; if(warranty.value)out.warrantyUntil=warranty.value; }
          return out;
        }};
        item.addEventListener('change',refresh);
        serials.addEventListener('input',()=>{ qty.value=String(serials.value.split(/\r?\n/).filter(x=>x.trim()).length); });
        const drop=btn(w('remove'),()=>{ if(lines.length<2)return; lines.splice(lines.indexOf(line),1); row.remove(); });
        row.append(...field(w('item'),item,item.id),...field(w('qty'),qty,qty.id),...field(w('cost'),unitCost,unitCost.id),extra,drop);
        lines.push(line);linesBox.append(row);refresh();
      };
      addLine();
      formModal(w('newSupply'),[...field(w('supplier'),supplier,'purchase-supplier'),...field(w('reference'),reference,'purchase-ref'),
        linesBox,btn('+ '+w('addLine'),addLine)],async(key)=>{
          await api('POST','/purchase-receipts',{branchId,supplierId:supplier.value,reference:reference.value||null,
            lines:lines.map(l=>l.read())}, {'idempotency-key':key});
          toast(w('received'));await render();
        });
    };
    const showReceipt=async(id)=>{
      const r=await api('GET',`/purchase-receipts/${id}`);
      modal(`${w('receipt')} ${r.reference||''}`,h('div',{id:'receipt-detail'},
        h('p',{class:'muted'},`${r.supplier} · ${new Date(r.created_at).toLocaleString()} · ${w('receivedBy')}: ${r.received_by??'—'}`),
        h('div',{class:'tablewrap'},h('table',null,
          h('thead',null,h('tr',null,[w('item'),w('qty'),w('lineTotal'),w('batch'),w('expiryShort'),w('serialsShort')].map(x=>h('th',null,x)))),
          h('tbody',null,r.lines.map(l=>h('tr',null,h('td',null,l.name),h('td',{class:'num'},qtyFmt(l.qty)),h('td',{class:'num'},money(l.line_total)),
            h('td',null,l.batch_no??''),h('td',null,dayFmt(l.expires_at)),
            h('td',null,(l.serial_nos??[]).join(', ')+(l.warranty_until?` (${w('supplierWarranty')} ${dayFmt(l.warranty_until)})`:''))))))),
        h('p',{class:'total'},money(r.total))));
    };
    const canStock=S.me.permissions.includes('stock.view');
    const [receipts,expiring]=branchId?await Promise.all([
      api('GET',`/purchase-receipts?branchId=${branchId}`).then(x=>x.receipts),
      canStock?api('GET',`/stock/expiring?branchId=${branchId}&days=3`).then(x=>x.batches):[]]):[[],[]];
    root.replaceChildren(head(w('suppliers'),h('div',{class:'row'},S.me.permissions.includes('purchases.manage')&&btn('+ '+w('addSupplier'),createSup),S.me.permissions.includes('purchases.manage')&&btn('+ '+w('receive'),receive,'primary'))),
      branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      expiring.length>0&&card(h('h2',null,w('expiring')),h('ul',{id:'expiring-list'},expiring.map(b=>h('li',null,
        h('strong',null,b.name),` · ${w('batch')} ${b.batch_no} · ${dayFmt(b.expires_on)} · ${qtyFmt(b.on_hand)} ${b.base_uom} · `,
        h('span',{class:Number(b.days_left)<=1?'badge bad':'badge'},Number(b.days_left)<=0?w('expired'):`${b.days_left} ${w('daysLeft')}`))))),
      card(h('h2',null,w('suppliers')),h('div',{class:'chips'},suppliers.map(s=>h('span',{class:'chip'},s.name+(s.active?'':` (${w('archived')})`))))),
      card(h('h2',null,w('newSupply')),receipts.length?h('ul',{id:'receipt-list'},receipts.map(r=>h('li',null,
        h('button',{type:'button',class:'linklike','data-receipt':r.id,onclick:()=>showReceipt(r.id).catch(danger)},
          `${new Date(r.created_at).toLocaleDateString()} · ${r.supplier} · ${r.reference||''} · ${money(r.total)}`)))):h('p',{class:'muted'},w('empty'))));
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
        ...field(w('output'),output,'prod-output'),...field(w('outputQty'),outputQty,'prod-outqty'),...field(w('waste'),wasteQty,'prod-waste')],async(key)=>{
          if(input.value===output.value){toast(w('notProduction'),true);return;}
          await api('POST','/production/transforms',{branchId,inputItemId:input.value,outputItemId:output.value,
            inputQty:Number(inputQty.value),outputQty:Number(outputQty.value),wasteQty:Number(wasteQty.value)},
            {'idempotency-key':key});
          toast(w('convert'));await render();
        });
    };
    root.replaceChildren(head(w('transform'),S.me.permissions.includes('production.manage')&&btn('+ '+w('convert'),transform,'primary')),
      branchSelector(S,branchId,(v)=>{branchId=v;render().catch(danger);}),
      card(h('h2',null,w('transform')),orders.length?orders.map(o=>h('p',null,`${o.id.slice(0,8)} · ${money(o.total_input_cost)}`)):h('p',{class:'muted'},w('empty'))));
  };
  if(!branchId)return card(w('empty'));await render();return root;
}
