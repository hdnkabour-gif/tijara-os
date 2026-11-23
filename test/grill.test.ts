import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';

let api: Api, admin: { token: string };
beforeAll(async () => { api = await startApp(); admin = await platformAdmin(api); });
afterAll(async () => { await api.close(); });
const withToken = (token: string) => ({ token });
const bySku = (items: any[], sku: string) => items.find((it) => it.sku === sku)?.id as string;

describe('Phase B grill, purchases, cash and production', () => {
  it('GB1: grill order reserves stock, starts once, is ready before payment; ledger and invoice stay consistent', async () => {
    const A = await createShop(api, admin, 'pro', 'Grill test', ['butcher','grill']);
    const B = await createShop(api, admin);
    const beef = bySku((await api.call('GET','/items',withToken(A.ownerToken))).json.items,'BUT-BOEUF');
    expect(beef).toBeTruthy();
    expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,itemId:beef,qty:5,unitCost:70}})).status).toBe(201);
    const idem = key(), payload={branchId:A.branchId,label:'Table 3',lines:[{itemId:beef,qty:1.5}]};
    const made=await api.call('POST','/grill/orders',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(made.status).toBe(201);
    const replay=await api.call('POST','/grill/orders',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(replay.json.orderId).toBe(made.json.orderId);
    const id=made.json.orderId;
    const open=(await api.call('GET',`/grill/orders?branchId=${A.branchId}`,withToken(A.ownerToken))).json.orders;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({id,service_label:'Table 3',state:'confirmed'});
    const before=await api.call('POST',`/grill/orders/${id}/pay`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{payments:[{method:'cash',amount:180}]}});
    expect(before.status).toBe(409);
    expect((await api.call('POST',`/grill/orders/${id}/start`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    expect((await api.call('POST',`/grill/orders/${id}/start`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(409);
    expect((await api.call('POST',`/grill/orders/${id}/ready`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    const foreignQueue = await api.call('GET',`/grill/orders?branchId=${A.branchId}`,withToken(B.ownerToken));
    expect(foreignQueue.status).toBe(200); expect(foreignQueue.json.orders).toHaveLength(0);
    const paid=await api.call('POST',`/grill/orders/${id}/pay`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{payments:[{method:'cash',amount:180}]}});
    expect(paid.status).toBe(201);
    const invoices=(await api.call('GET','/invoices',withToken(A.ownerToken))).json.invoices;
    expect(invoices.filter((i:any)=>i.order_id===id)).toHaveLength(1);
    expect((await api.call('GET',`/grill/orders?branchId=${A.branchId}`,withToken(A.ownerToken))).json.orders).toHaveLength(0);
    const stock=(await api.call('GET',`/stock?branchId=${A.branchId}`,withToken(A.ownerToken))).json.stock;
    expect(Number(stock.find((x:any)=>x.sku==='BUT-BOEUF').on_hand)).toBe(3.5);
  });

  it('GB2: supplier receipt is atomic and idempotent, archives block new buying, other tenant stays isolated', async () => {
    const A=await createShop(api,admin,'pro','Purchases',['butcher']),B=await createShop(api,admin,'pro','Other',['butcher']);
    const item=bySku((await api.call('GET','/items',withToken(A.ownerToken))).json.items,'BUT-AGNEAU');
    const sup=(await api.call('POST','/suppliers',{token:A.ownerToken,body:{name:'Supplier Example'}}));
    expect(sup.status).toBe(201);
    const foreign=(await api.call('POST','/purchase-receipts',{token:B.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:B.branchId,supplierId:sup.json.id,lines:[{itemId:item,qty:2,unitCost:80}]}}));
    expect(foreign.status).toBe(404);
    const idem=key(),payload={branchId:A.branchId,supplierId:sup.json.id,reference:'TEST-01',lines:[{itemId:item,qty:2,unitCost:80}]};
    const first=await api.call('POST','/purchase-receipts',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(first.status).toBe(201);
    const retry=await api.call('POST','/purchase-receipts',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(retry.status).toBe(201); expect(retry.json.id).toBe(first.json.id);
    expect(Number(first.json.total)).toBe(160);
    const s=(await api.call('GET',`/stock?branchId=${A.branchId}`,withToken(A.ownerToken))).json.stock;
    expect(Number(s.find((x:any)=>x.sku==='BUT-AGNEAU').on_hand)).toBe(2);
    expect((await api.call('PATCH',`/suppliers/${sup.json.id}`,{token:A.ownerToken,body:{active:false}})).status).toBe(200);
    expect((await api.call('POST','/purchase-receipts',{token:A.ownerToken,headers:{'idempotency-key':key()},body:payload})).status).toBe(409);
  });

  it('GB3: cash session expected balance is opening float plus actual cash transactions', async () => {
    const A=await createShop(api,admin,'pro','Cash',['grill']);
    const item=bySku((await api.call('GET','/items',withToken(A.ownerToken))).json.items,'GRL-CUISSON');
    const opened=await api.call('POST','/cash-sessions',{token:A.ownerToken,body:{branchId:A.branchId,openingFloat:100}});
    expect(opened.status).toBe(201);
    expect((await api.call('POST','/cash-sessions',{token:A.ownerToken,body:{branchId:A.branchId,openingFloat:100}})).status).toBe(409);
    const sale=await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{
      branchId:A.branchId,lines:[{itemId:item,qty:1}],payments:[{method:'cash',amount:20}]
    }});
    expect(sale.status).toBe(201);
    const closed=await api.call('POST',`/cash-sessions/${opened.json.id}/close`,{token:A.ownerToken,body:{countedCash:119}});
    expect(closed.status).toBe(200);
    expect(closed.json).toMatchObject({expected:120,counted:119,difference:-1});
    expect((await api.call('POST',`/cash-sessions/${opened.json.id}/close`,{token:A.ownerToken,body:{countedCash:119}})).status).toBe(409);
  });

  it('GB4: meat transformation uses existing stock ledger, conserves mass, and is idempotent', async () => {
    const A=await createShop(api,admin,'pro','Transform',['butcher']);
    const items=(await api.call('GET','/items',withToken(A.ownerToken))).json.items;
    const beef=bySku(items,'BUT-BOEUF'),kefta=bySku(items,'BUT-KEFTA');
    expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,itemId:beef,qty:5,unitCost:80}})).status).toBe(201);
    const payload={branchId:A.branchId,inputItemId:beef,outputItemId:kefta,inputQty:5,outputQty:4.5,wasteQty:.5};
    const idem=key();
    const t=await api.call('POST','/production/transforms',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(t.status).toBe(201);
    expect(Number(t.json.totalInputCost)).toBe(400);
    expect((await api.call('POST','/production/transforms',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload})).json.id).toBe(t.json.id);
    const stock=(await api.call('GET',`/stock?branchId=${A.branchId}`,withToken(A.ownerToken))).json.stock;
    expect(Number(stock.find((x:any)=>x.sku==='BUT-BOEUF').on_hand)).toBe(0);
    expect(Number(stock.find((x:any)=>x.sku==='BUT-KEFTA').on_hand)).toBe(4.5);
    expect((await api.call('POST','/production/transforms',{token:A.ownerToken,headers:{'idempotency-key':key()},body:payload})).status).toBe(409);
    expect((await api.call('POST','/production/transforms',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{...payload,outputQty:6}})).status).toBe(400);
  });
});
