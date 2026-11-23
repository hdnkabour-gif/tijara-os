import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const user=(token:string)=>({token});

describe('Phase C vehicle and workshop lifecycle',()=>{
  it('WC1: quote then approval reserves inventory; delivery closes only once and issues the original sales invoice',async()=>{
    const A=await createShop(api,admin,'pro','Demo Garage',['mechanic']);
    const items=(await api.call('GET','/items',user(A.ownerToken))).json.items;
    const part=items.find((x:any)=>x.sku==='MEC-FILTRE').id;
    const service=items.find((x:any)=>x.sku==='MEC-VIDANGE').id;
    expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,itemId:part,qty:2,unitCost:30}})).status).toBe(201);
    const v=await api.call('POST','/workshop/vehicles',{token:A.ownerToken,body:{plate:'12-a-34567',make:'Dacia',model:'Logan',odometerKm:90000}});
    expect(v.status).toBe(201);
    expect((await api.call('POST','/workshop/vehicles',{token:A.ownerToken,
      body:{plate:'12-a-34567',make:'Dacia',model:'Logan'}})).status).toBe(409);
    expect((await api.call('PATCH',`/workshop/vehicles/${v.json.id}`,{token:A.ownerToken,body:{odometerKm:89999}})).status).toBe(409);
    const payload={branchId:A.branchId,vehicleId:v.json.id,mileageAtVisit:90000,warrantyDays:90,
      nextServiceDate:'2025-01-01',nextServiceKm:100000,
      note:'Oil change',lines:[{itemId:part,qty:1},{itemId:service,qty:1}]};
    const idem=key();
    const q=await api.call('POST','/workshop/orders',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload});
    expect(q.status).toBe(201);expect(Number(q.json.total)).toBe(210);
    expect((await api.call('POST','/workshop/orders',{token:A.ownerToken,headers:{'idempotency-key':idem},body:payload})).json.id).toBe(q.json.id);
    const orderId=q.json.id;
    expect((await api.call('GET',`/workshop/orders?branchId=${A.branchId}`,user(A.ownerToken))).json.orders[0].state).toBe('quoted');
    const approval=await api.call('POST',`/workshop/orders/${orderId}/approve`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}});
    expect(approval.status).toBe(200);
    const stockBefore=(await api.call('GET',`/stock?branchId=${A.branchId}`,user(A.ownerToken))).json.stock;
    expect(Number(stockBefore.find((x:any)=>x.sku==='MEC-FILTRE').on_hand)).toBe(2);
    expect(Number(stockBefore.find((x:any)=>x.sku==='MEC-FILTRE').reserved)).toBe(1);
    expect((await api.call('POST',`/workshop/orders/${orderId}/deliver`,{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{payments:[{method:'cash',amount:210}]}})).status).toBe(409);
    expect((await api.call('POST',`/workshop/orders/${orderId}/start`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    expect((await api.call('POST',`/workshop/orders/${orderId}/complete`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    const deliverKey=key(),pay={payments:[{method:'cash',amount:210}]};
    const paid=await api.call('POST',`/workshop/orders/${orderId}/deliver`,{token:A.ownerToken,headers:{'idempotency-key':deliverKey},body:pay});
    expect(paid.status).toBe(201);
    const retry=await api.call('POST',`/workshop/orders/${orderId}/deliver`,{token:A.ownerToken,headers:{'idempotency-key':deliverKey},body:pay});
    expect(retry.status).toBe(201);expect(retry.json.invoiceId).toBe(paid.json.invoiceId);
    const work=(await api.call('GET',`/workshop/orders?branchId=${A.branchId}`,user(A.ownerToken))).json.orders[0];
    expect(work).toMatchObject({state:'delivered',invoice_id:paid.json.invoiceId,warranty_days:90});
    expect((await api.call('POST',`/workshop/orders/${orderId}/cancel`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{reason:'after delivery'}})).status).toBe(409);
    const stockAfter=(await api.call('GET',`/stock?branchId=${A.branchId}`,user(A.ownerToken))).json.stock;
    expect(Number(stockAfter.find((x:any)=>x.sku==='MEC-FILTRE').on_hand)).toBe(1);
    expect(Number(stockAfter.find((x:any)=>x.sku==='MEC-FILTRE').reserved)).toBe(0);
    expect((await api.call('GET','/invoices',user(A.ownerToken))).json.invoices).toHaveLength(1);
    const due=(await api.call('GET',`/workshop/reminders?branchId=${A.branchId}`,user(A.ownerToken))).json.reminders;
    expect(due.some((x:any)=>x.id===orderId)).toBe(true);
  });

  it('WC2: cancellation of an approved repair releases reservations and never creates an invoice',async()=>{
    const A=await createShop(api,admin,'pro','Repair Cancellation',['mechanic']);
    const items=(await api.call('GET','/items',user(A.ownerToken))).json.items,part=items.find((x:any)=>x.sku==='MEC-FILTRE').id;
    await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:part,qty:1,unitCost:30}});
    const v=(await api.call('POST','/workshop/vehicles',{token:A.ownerToken,body:{plate:'77-b-001',make:'Renault',model:'Clio',odometerKm:500}})).json.id;
    const q=(await api.call('POST','/workshop/orders',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,vehicleId:v,mileageAtVisit:500,lines:[{itemId:part,qty:1}]}})).json.id;
    expect((await api.call('POST',`/workshop/orders/${q}/approve`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
    expect((await api.call('POST',`/workshop/orders/${q}/cancel`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{reason:'customer declined'}})).status).toBe(200);
    const s=(await api.call('GET',`/stock?branchId=${A.branchId}`,user(A.ownerToken))).json.stock;
    expect(Number(s.find((x:any)=>x.sku==='MEC-FILTRE').available)).toBe(1);
    expect((await api.call('GET','/invoices',user(A.ownerToken))).json.invoices).toHaveLength(0);
  });

  it('WC3: cross-tenant vehicle and order ids are isolated; read-only role cannot change vehicle',async()=>{
    const A=await createShop(api,admin,'pro','Garage A',['mechanic']),B=await createShop(api,admin,'pro','Garage B',['mechanic']);
    const v=(await api.call('POST','/workshop/vehicles',{token:A.ownerToken,body:{plate:'44-c-002',make:'Kia',model:'Picanto'}})).json.id;
    const other=await api.call('POST','/workshop/orders',{token:B.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:B.branchId,vehicleId:v,mileageAtVisit:0,lines:[{itemId:(await api.call('GET','/items',user(B.ownerToken))).json.items[0].id,qty:1}]}});
    expect(other.status).toBe(404);
    expect((await api.call('PATCH',`/workshop/vehicles/${v}`,{token:B.ownerToken,body:{make:'Foreign'}})).status).toBe(404);
    expect((await api.call('GET','/workshop/vehicles',user(B.ownerToken))).json.vehicles.find((x:any)=>x.id===v)).toBeUndefined();
    const cashier=await staff(api,A,'cashier');
    expect((await api.call('GET','/workshop/vehicles',user(cashier.token))).status).toBe(403);
    expect((await api.call('POST','/workshop/vehicles',{token:cashier.token,body:{plate:'AB-123',make:'Car',model:'One'}})).status).toBe(403);
  });
});
