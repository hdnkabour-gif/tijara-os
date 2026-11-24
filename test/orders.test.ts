import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});

/** A butcher-grill shop: beef 120 MAD/kg in stock, grilling service 20 MAD/kg, beef orderable with options. */
async function grillShop(name='Orders shop'){
  const A=await createShop(api,admin,'pro',name,['butcher','grill']);
  const items=(await api.call('GET','/items',as(A.ownerToken))).json.items;
  const beef=items.find((i:any)=>i.sku==='BUT-BOEUF').id, grill=items.find((i:any)=>i.sku==='GRL-CUISSON').id, lamb=items.find((i:any)=>i.sku==='BUT-AGNEAU').id;
  expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef,qty:10,unitCost:80}})).status).toBe(201);
  expect((await api.call('PATCH',`/items/${beef}`,{token:A.ownerToken,body:{orderable:true}})).status).toBe(200);
  expect((await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:{groups:[
    {name:'Préparation',required:true,choices:[{label:'Nature'},{label:'Grillé',addItemId:grill,qtyMode:'same'}]},
    {name:'Épices',choices:[{label:'Avec épices'},{label:'Sans épices'}]}]}})).status).toBe(200);
  const opts=(await api.call('GET',`/items/${beef}/options`,as(A.ownerToken))).json.groups;
  const choice=(label:string)=>opts.flatMap((g:any)=>g.choices).find((c:any)=>c.label===label).id;
  const order=(body:object,token=A.ownerToken,idem=key())=>api.call('POST','/order-requests',{token,headers:{'idempotency-key':idem},body:{branchId:A.branchId,...body}});
  const accept=(id:string,token=A.ownerToken,idem=key())=>api.call('POST',`/order-requests/${id}/accept`,{token,headers:{'idempotency-key':idem},body:{}});
  const stock=async()=>((await api.call('GET',`/stock?branchId=${A.branchId}`,as(A.ownerToken))).json.stock.find((s:any)=>s.sku==='BUT-BOEUF'));
  return {A,beef,grill,lamb,choice,order,accept,stock};
}

describe('Phase D1: product options and the order inbox (through the existing sales engine)',()=>{
  it('OD1: options are validated and only the catalog manager can change them',async()=>{
    const {A,beef,grill}=await grillShop('Options rules');
    const cashier=await staff(api,A,'cashier');
    expect((await api.call('PUT',`/items/${beef}/options`,{token:cashier.token,body:{groups:[]}})).status).toBe(403);
    expect((await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:{groups:[{name:'Vide',choices:[]}]}})).status).toBe(400);
    expect((await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:{groups:[{name:'X',choices:[{label:'Self',addItemId:beef}]}]}})).status).toBe(400);
    // the cashier sees the menu with its options (only orderable products)
    const menu=(await api.call('GET','/order-menu',as(cashier.token))).json.items;
    expect(menu.map((i:any)=>i.sku)).toEqual(['BUT-BOEUF']);
    expect(menu[0].options.map((g:any)=>g.name)).toEqual(['Préparation','Épices']);
    expect(menu[0].options[0].choices.find((c:any)=>c.label==='Grillé').add_item_id).toBe(grill);
  });

  it('OD2: the server computes the price from items and options; invalid choices are refused; retries are idempotent',async()=>{
    const {beef,lamb,choice,order}=await grillShop('Intake rules');
    const grilled=[choice('Grillé'),choice('Sans épices')];
    expect((await order({lines:[{itemId:lamb,qty:1}]})).status).toBe(400);                                         // not orderable
    expect((await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Sans épices')]}]})).status).toBe(400);       // "Préparation" is required
    expect((await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature'),choice('Grillé')]}]})).status).toBe(400);   // one choice only
    expect((await order({lines:[{itemId:beef,qty:1,choiceIds:['00000000-0000-4000-8000-000000000000']}]})).status).toBe(400);
    expect((await order({mode:'dine_in',lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]})).status).toBe(400);    // a table is needed
    const idem=key();
    // a client-supplied price is ignored: 1.5 kg x 120 + grilling 1.5 kg x 20 = 210
    const r=await order({channel:'phone',customerName:'Client Test',customerPhone:'0600 00 00 00',lines:[{itemId:beef,qty:1.5,choiceIds:grilled,unitPrice:1}]},undefined,idem);
    expect(r.status).toBe(201); expect(Number(r.json.total)).toBe(210);
    const again=await order({channel:'phone',customerName:'Client Test',customerPhone:'0600 00 00 00',lines:[{itemId:beef,qty:1.5,choiceIds:grilled,unitPrice:1}]},undefined,idem);
    expect(again.json.id).toBe(r.json.id);
  });

  it('OD3: accepting creates ONE confirmed sale (stock reserved, grilling line added, choices visible to the kitchen)',async()=>{
    const {A,choice,order,accept,stock,beef}=await grillShop('Accept flow');
    const r=(await order({channel:'whatsapp',customerName:'Client WA',lines:[{itemId:beef,qty:1.5,choiceIds:[choice('Grillé'),choice('Sans épices')],note:'Bien cuit'}]})).json;
    const idem=key();
    const ok=await accept(r.id,undefined,idem);
    expect(ok.status).toBe(200); expect(Number(ok.json.total)).toBe(210);
    expect((await accept(r.id,undefined,idem)).json.orderId).toBe(ok.json.orderId);        // same command: same sale
    expect((await accept(r.id)).status).toBe(409);                                         // a new command: already accepted
    const s=await stock();
    expect(Number(s.on_hand)).toBe(10); expect(Number(s.reserved)).toBe(1.5);              // reserved, not yet sold
    const queue=(await api.call('GET',`/grill/orders?branchId=${A.branchId}`,as(A.ownerToken))).json.orders;
    const o=queue.find((x:any)=>x.id===ok.json.orderId);
    expect(o.service_label).toBe('Client WA');
    expect(o.lines.map((l:any)=>[l.item,Number(l.qty),l.note])).toEqual([['Viande de bœuf',1.5,'Grillé · Sans épices · Bien cuit'],['Cuisson grillade (par kg)',1.5,'↳ Viande de bœuf']]);
    const inbox=(await api.call('GET',`/order-requests?branchId=${A.branchId}`,as(A.ownerToken))).json.requests;
    expect(inbox.find((x:any)=>x.id===r.id)).toMatchObject({status:'accepted',sales_order_id:ok.json.orderId,order_state:'confirmed'});
  });

  it('OD4: not enough stock refuses the acceptance as a whole; the request stays pending, nothing is reserved',async()=>{
    const {choice,order,accept,stock,beef}=await grillShop('Short stock');
    const r=(await order({lines:[{itemId:beef,qty:50,choiceIds:[choice('Nature')]}]})).json;
    expect((await accept(r.id)).status).toBe(409);
    expect(Number((await stock()).reserved)).toBe(0);
  });

  it('OD5: rejection needs a reason and is final; branch, shop and permission boundaries hold',async()=>{
    const {A,choice,order,accept,beef}=await grillShop('Boundaries');
    const r=(await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]})).json;
    expect((await api.call('POST',`/order-requests/${r.id}/reject`,{token:A.ownerToken,body:{}})).status).toBe(400);
    expect((await api.call('POST',`/order-requests/${r.id}/reject`,{token:A.ownerToken,body:{reason:'Rupture'}})).status).toBe(200);
    expect((await accept(r.id)).status).toBe(409);
    // another shop never sees it; a branch-B employee cannot see or accept branch A's orders
    const B=await createShop(api,admin,'pro','Other',['butcher']);
    expect((await accept(r.id,B.ownerToken)).status).toBe(404);
    const b2=(await api.call('POST','/branches',{token:A.ownerToken,body:{name:'Branch B'}})).json.id;
    const cashierB=await staff(api,A,'cashier',[b2]);
    expect((await api.call('GET',`/order-requests?branchId=${A.branchId}`,as(cashierB.token))).status).toBe(403);
    const r2=(await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]})).json;
    expect((await accept(r2.id,cashierB.token)).status).toBe(403);
    // a role without orders.manage cannot take orders
    expect((await api.call('POST','/roles',{token:A.ownerToken,body:{name:'viewer',permissions:['orders.view','catalog.view']}})).status).toBe(201);
    const viewer=await staff(api,A,'viewer');
    expect((await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]},viewer.token)).status).toBe(403);
  });

  it('OD6: if the owner removes a choice after the order was taken, accepting re-checks it instead of selling it silently',async()=>{
    const {A,choice,order,accept,beef}=await grillShop('Changed options');
    const r=(await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Grillé')]}]})).json;
    expect((await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:{groups:[{name:'Préparation',required:true,choices:[{label:'Nature'}]}]}})).status).toBe(200);
    expect((await accept(r.id)).status).toBe(400);
    const inbox=(await api.call('GET',`/order-requests?branchId=${A.branchId}&status=pending`,as(A.ownerToken))).json.requests;
    expect(inbox.map((x:any)=>x.id)).toContain(r.id);
  });
});

describe('Phase D1 review fixes: empty choices, saving options, paying and cancelling accepted orders',()=>{
  it('OD7: a product without options can be ordered (empty choice list), options can be removed, and re-saving keeps choice ids',async()=>{
    const {A,lamb,beef,choice,order,accept}=await grillShop('No options');
    expect((await api.call('PUT',`/items/${lamb}/options`,{token:A.ownerToken,body:{groups:[]}})).status).toBe(200);     // no options at all
    expect((await api.call('PATCH',`/items/${lamb}`,{token:A.ownerToken,body:{orderable:true}})).status).toBe(200);
    expect((await order({lines:[{itemId:lamb,qty:1,choiceIds:[]}]})).status).toBe(201);
    // optional groups left empty: only the required one is picked
    expect((await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]})).status).toBe(201);
    // a pending order survives the owner re-saving the options unchanged (ids are sent back and kept)
    const pending=(await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Grillé'),choice('Sans épices')]}]})).json.id;
    const groups=(await api.call('GET',`/items/${beef}/options`,as(A.ownerToken))).json.groups;
    const again={groups:groups.map((g:any)=>({id:g.id,name:g.name,required:g.required,multiple:g.multiple,
      choices:g.choices.map((c:any)=>({id:c.id,label:c.label,addItemId:c.add_item_id??undefined,qtyMode:c.qty_mode}))}))};
    expect((await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:again})).status).toBe(200);
    const after=(await api.call('GET',`/items/${beef}/options`,as(A.ownerToken))).json.groups;
    expect(after.flatMap((g:any)=>g.choices.map((c:any)=>c.id)).sort()).toEqual(groups.flatMap((g:any)=>g.choices.map((c:any)=>c.id)).sort());
    expect((await accept(pending)).status).toBe(200);
    // an id from ANOTHER product is not adopted: it is a new choice
    const lambGroups={groups:[{id:groups[0].id,name:'Copie',choices:[{id:groups[0].choices[0].id,label:'Copie'}]}]};
    expect((await api.call('PUT',`/items/${lamb}/options`,{token:A.ownerToken,body:lambGroups})).status).toBe(200);
    const lambOpts=(await api.call('GET',`/items/${lamb}/options`,as(A.ownerToken))).json.groups;
    expect(lambOpts[0].id).not.toBe(groups[0].id);
    expect((await api.call('GET',`/items/${beef}/options`,as(A.ownerToken))).json.groups).toHaveLength(2);   // beef untouched
  });

  it('OD8: an accepted order is paid from the inbox (at once if not for the kitchen, else once ready) or cancelled to release stock',async()=>{
    const {A,beef,choice,order,accept,stock}=await grillShop('Checkout');
    const pay=(id:string,amount:number,token=A.ownerToken,idem=key())=>api.call('POST',`/order-requests/${id}/pay`,{token,headers:{'idempotency-key':idem},body:{payments:[{method:'cash',amount}]}});
    // counter pickup, not for the kitchen: 2 kg raw = 240
    const raw=(await order({toKitchen:false,lines:[{itemId:beef,qty:2,choiceIds:[choice('Nature')]}]})).json.id;
    expect((await pay(raw,240)).status).toBe(409);                                       // not accepted yet
    expect((await accept(raw)).status).toBe(200);
    const idem=key(), paid=await pay(raw,240,undefined,idem);
    expect(paid.status).toBe(201);
    expect((await pay(raw,240,undefined,idem)).json.invoiceId).toBe(paid.json.invoiceId);   // a retry never charges twice
    expect((await pay(raw,240)).status).toBe(409);
    let s=await stock(); expect(Number(s.on_hand)).toBe(8); expect(Number(s.reserved)).toBe(0);
    const inbox=(await api.call('GET',`/order-requests?branchId=${A.branchId}`,as(A.ownerToken))).json.requests;
    expect(inbox.find((x:any)=>x.id===raw).order_state).toBe('closed');
    // for the kitchen: no payment before the kitchen marks it ready
    const grilled=(await order({lines:[{itemId:beef,qty:1,choiceIds:[choice('Grillé')]}]})).json.id;
    const accepted=(await accept(grilled)).json;
    expect((await pay(grilled,140)).status).toBe(409);
    for(const step of ['start','ready']) expect((await api.call('POST',`/grill/orders/${accepted.orderId}/${step}`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    expect((await pay(grilled,140)).status).toBe(201);
    // cancelling an accepted order releases its reservation; a cashier (no sale.void) cannot
    const later=(await order({toKitchen:false,lines:[{itemId:beef,qty:3,choiceIds:[choice('Nature')]}]})).json.id;
    expect((await accept(later)).status).toBe(200);
    expect(Number((await stock()).reserved)).toBe(3);
    const cashier=await staff(api,A,'cashier');
    expect((await api.call('POST',`/order-requests/${later}/cancel`,{token:cashier.token,headers:{'idempotency-key':key()},body:{reason:'Client absent'}})).status).toBe(403);
    expect((await api.call('POST',`/order-requests/${later}/cancel`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{reason:'Client absent'}})).status).toBe(200);
    s=await stock(); expect(Number(s.reserved)).toBe(0); expect(Number(s.on_hand)).toBe(7);
  });
});
