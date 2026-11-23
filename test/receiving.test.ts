import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});
const day=(n:number)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const sku=(items:any[],s:string)=>items.find((x:any)=>x.sku===s).id;

async function supplierShop(activities:string[],name='Receiving'){
  const A=await createShop(api,admin,'pro',name,activities);
  const items=(await api.call('GET','/items',as(A.ownerToken))).json.items;
  const sup=(await api.call('POST','/suppliers',{token:A.ownerToken,body:{name:'Supplier Example'}})).json.id;
  const receive=(lines:object[],idem=key())=>api.call('POST','/purchase-receipts',{token:A.ownerToken,headers:{'idempotency-key':idem},
    body:{branchId:A.branchId,supplierId:sup,reference:'BL-TEST',lines}});
  const stockOf=async(s:string)=>Number(((await api.call('GET',`/stock?branchId=${A.branchId}`,as(A.ownerToken))).json.stock
    .find((x:any)=>x.sku===s)?.on_hand)??0);
  return {A,items,sup,receive,stockOf};
}

describe('PR-A supplier receiving: batch, expiry, serial numbers',()=>{
  it('RA1: meat received with batch + expiry is traceable, shows in the expiry watch list, and a batch keeps ONE expiry',async()=>{
    const {A,items,receive,stockOf}=await supplierShop(['butcher']);
    const beef=sku(items,'BUT-BOEUF');
    const r=await receive([{itemId:beef,qty:12.5,unitCost:90,batchNo:'L-0001',expiresAt:day(2)}]);
    expect(r.status).toBe(201);
    const detail=(await api.call('GET',`/purchase-receipts/${r.json.id}`,as(A.ownerToken))).json;
    expect(detail.lines[0]).toMatchObject({sku:'BUT-BOEUF',batch_no:'L-0001',serial_nos:[]});
    expect(String(detail.lines[0].expires_at).slice(0,10)).toBe(day(2));
    expect(Number(detail.total)).toBe(1125);
    // expiry watch: in the 3-day window, not in the "today" window
    const soon=(await api.call('GET',`/stock/expiring?branchId=${A.branchId}&days=3`,as(A.ownerToken))).json.batches;
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({sku:'BUT-BOEUF',batch_no:'L-0001',days_left:2});
    expect(Number(soon[0].on_hand)).toBe(12.5);
    expect((await api.call('GET',`/stock/expiring?branchId=${A.branchId}&days=0`,as(A.ownerToken))).json.batches).toHaveLength(0);
    // same batch number again with ANOTHER expiry: refused, and nothing of that receipt is stored (atomic)
    const clash=await receive([{itemId:sku(items,'BUT-AGNEAU'),qty:3,unitCost:100},{itemId:beef,qty:1,unitCost:90,batchNo:'L-0001',expiresAt:day(9)}]);
    expect(clash.status).toBe(409);
    expect(await stockOf('BUT-AGNEAU')).toBe(0);
    expect(await stockOf('BUT-BOEUF')).toBe(12.5);
    // same batch, same expiry: accepted (a second delivery of the same lot)
    expect((await receive([{itemId:beef,qty:2,unitCost:90,batchNo:'L-0001',expiresAt:day(2)}])).status).toBe(201);
    expect(await stockOf('BUT-BOEUF')).toBe(14.5);
  });

  it('RA2: bad expiry input is refused with 400 (already expired, impossible date, expiry without batch)',async()=>{
    const {items,receive}=await supplierShop(['butcher']);
    const beef=sku(items,'BUT-BOEUF');
    expect((await receive([{itemId:beef,qty:1,unitCost:90,batchNo:'OLD',expiresAt:day(-1)}])).status).toBe(400);
    expect((await receive([{itemId:beef,qty:1,unitCost:90,batchNo:'X',expiresAt:'2027-02-30'}])).status).toBe(400);
    expect((await receive([{itemId:beef,qty:1,unitCost:90,expiresAt:day(5)}])).status).toBe(400);
    expect((await receive([{itemId:beef,qty:1,unitCost:90,batchNo:'TODAY',expiresAt:day(0)}])).status).toBe(400);   // not sellable any more today
    expect((await receive([{itemId:beef,qty:1,unitCost:90,batchNo:'TOMORROW',expiresAt:day(1)}])).status).toBe(201);
  });

  it('RA3: serial-tracked equipment needs one serial per unit; serials and supplier warranty are stored and then sellable at the POS',async()=>{
    const {A,items,receive,stockOf}=await supplierShop(['security_systems','equipment'],'Alarm shop');
    const det=sku(items,'SEC-DETECT'),pipe=sku(items,'EQP-TUYAU');
    expect((await receive([{itemId:det,qty:2,unitCost:200}])).status).toBe(400);                                     // no serials
    expect((await receive([{itemId:det,qty:2,unitCost:200,serials:['D-1']}])).status).toBe(400);                     // count mismatch
    expect((await receive([{itemId:det,qty:2,unitCost:200,serials:['D-1','D-1']}])).status).toBe(400);               // duplicate in request
    expect((await receive([{itemId:pipe,qty:2,unitCost:5,serials:['P-1','P-2']}])).status).toBe(400);                // item not serial-tracked
    expect((await receive([{itemId:pipe,qty:2,unitCost:5,warrantyUntil:day(30)}])).status).toBe(400);               // warranty without serials
    const ok=await receive([{itemId:det,qty:2,unitCost:200,serials:['D-1','D-2'],warrantyUntil:day(730)},{itemId:pipe,qty:10,unitCost:5}]);
    expect(ok.status).toBe(201);
    const detail=(await api.call('GET',`/purchase-receipts/${ok.json.id}`,as(A.ownerToken))).json;
    expect(detail.lines.find((l:any)=>l.sku==='SEC-DETECT').serial_nos).toEqual(['D-1','D-2']);
    expect(String(detail.lines.find((l:any)=>l.sku==='SEC-DETECT').warranty_until).slice(0,10)).toBe(day(730));
    expect(await stockOf('SEC-DETECT')).toBe(2);
    // a serial that is already in stock cannot be received twice: whole receipt refused
    expect((await receive([{itemId:pipe,qty:1,unitCost:5},{itemId:det,qty:1,unitCost:200,serials:['D-2']}])).status).toBe(409);
    expect(await stockOf('EQP-TUYAU')).toBe(10);
    // the received serial is sold at the POS
    const sale=await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,lines:[{itemId:det,qty:1,serialNo:'D-1'}],payments:[{method:'cash',amount:450}]}});
    expect(sale.status).toBe(201);
    expect(await stockOf('SEC-DETECT')).toBe(1);
  });

  it('RA4: a committed receipt replayed after its batch has expired returns the stored result (no 400, no duplicate)',async()=>{
    const {A,items,receive}=await supplierShop(['butcher']);
    const line={itemId:sku(items,'BUT-BOEUF'),qty:4,unitCost:90,batchNo:'L-RPL',expiresAt:day(1)};
    const idem=key();
    const first=await receive([line],idem);
    expect(first.status).toBe(201);
    vi.useFakeTimers({toFake:['Date'],now:Date.now()+4*86400000});
    try{
      const again=await receive([line],idem);
      expect(again.status).toBe(201);expect(again.json.id).toBe(first.json.id);
    }finally{vi.useRealTimers();}
    expect((await api.call('GET',`/purchase-receipts?branchId=${A.branchId}`,as(A.ownerToken))).json.receipts).toHaveLength(1);
  });

  it('RA5: receipts and the expiry list stay inside the shop and the branch',async()=>{
    const {A,receive,items}=await supplierShop(['butcher']);
    const B=await createShop(api,admin,'pro','Other butcher',['butcher']);
    const r=await receive([{itemId:sku(items,'BUT-BOEUF'),qty:1,unitCost:90,batchNo:'L-ISO',expiresAt:day(1)}]);
    expect((await api.call('GET',`/purchase-receipts/${r.json.id}`,as(B.ownerToken))).status).toBe(404);
    // another shop asking for A's branch id sees nothing (RLS), never A's batches
    const peek=await api.call('GET',`/stock/expiring?branchId=${A.branchId}&days=30`,as(B.ownerToken));
    expect(peek.status===200?peek.json.batches:[]).toHaveLength(0);
    expect((await api.call('GET',`/stock/expiring?branchId=${B.branchId}`,as(B.ownerToken))).json.batches).toHaveLength(0);
  });
});

describe('PR-A vehicles: owner and plate changes, warranty end, reminders',()=>{
  async function garage(name='Garage'){
    const A=await createShop(api,admin,'pro',name,['mechanic']);
    const items=(await api.call('GET','/items',as(A.ownerToken))).json.items;
    const customer=async(n:string)=>(await api.call('POST','/customers',{token:A.ownerToken,body:{name:n}})).json.id as string;
    const vehicle=async(plate:string,km=50000,customerId?:string)=>(await api.call('POST','/workshop/vehicles',{token:A.ownerToken,
      body:{plate,make:'Dacia',model:'Sandero',odometerKm:km,customerId}})).json.id as string;
    // quote -> approve -> start -> complete -> deliver, service only (no stock needed)
    const repair=async(vehicleId:string,km:number,extra:object={})=>{
      const q=await api.call('POST','/workshop/orders',{token:A.ownerToken,headers:{'idempotency-key':key()},
        body:{branchId:A.branchId,vehicleId,mileageAtVisit:km,lines:[{itemId:sku(items,'MEC-VIDANGE'),qty:1}],...extra}});
      expect(q.status).toBe(201);
      for(const step of ['approve','start','complete'])
        expect((await api.call('POST',`/workshop/orders/${q.json.id}/${step}`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).status).toBe(200);
      expect((await api.call('POST',`/workshop/orders/${q.json.id}/deliver`,{token:A.ownerToken,headers:{'idempotency-key':key()},
        body:{payments:[{method:'cash',amount:150}]}})).status).toBe(201);
      return q.json.id as string;
    };
    return {A,items,customer,vehicle,repair};
  }

  it('RV1: owner and plate can be changed; every change is kept in the vehicle history and in the audit journal',async()=>{
    const {A,customer,vehicle}=await garage();
    const first=await customer('First owner'),second=await customer('Second owner');
    const v=await vehicle('11-A-1111',50000,first);
    const r=await api.call('PATCH',`/workshop/vehicles/${v}`,{token:A.ownerToken,body:{customerId:second,plate:'22 b 2222',note:'car sold'}});
    expect(r.status).toBe(200);
    const view=(await api.call('GET',`/workshop/vehicles/${v}`,as(A.ownerToken))).json;
    expect(view.vehicle).toMatchObject({plate:'22 B 2222',customer_id:second,customer_name:'Second owner'});
    expect(view.owners.map((o:any)=>[o.customer_name,o.plate,o.note])).toEqual([['Second owner','22 B 2222','car sold'],['First owner','11-A-1111','initial']]);
    // back to "no registered owner"
    expect((await api.call('PATCH',`/workshop/vehicles/${v}`,{token:A.ownerToken,body:{customerId:null}})).status).toBe(200);
    expect((await api.call('GET',`/workshop/vehicles/${v}`,as(A.ownerToken))).json.owners).toHaveLength(3);
    // a make/model correction is not an ownership change
    expect((await api.call('PATCH',`/workshop/vehicles/${v}`,{token:A.ownerToken,body:{model:'Logan'}})).status).toBe(200);
    expect((await api.call('GET',`/workshop/vehicles/${v}`,as(A.ownerToken))).json.owners).toHaveLength(3);
    const entries=(await api.call('GET',`/audit?refId=${v}`,as(A.ownerToken))).json.entries;
    expect(entries.every((e:any)=>e.ref_id===v)).toBe(true);
    expect(entries.map((e:any)=>e.action)).toEqual(['vehicle.updated','vehicle.ownership_changed','vehicle.ownership_changed','vehicle.created']);
    const owned=entries[2];   // the sale: newest first, so after the later 'no owner' change and the model correction
    expect(owned.before).toMatchObject({plate:'11-A-1111',customerId:first});
    expect(owned.after).toMatchObject({plate:'22 B 2222',customerId:second});
    expect(entries[1].after).toMatchObject({plate:'22 B 2222',customerId:null});
  });

  it('RV2: owner/plate changes are validated (duplicate plate, archived or foreign customer, permission)',async()=>{
    const {A,customer,vehicle}=await garage('Garage rules');
    const B=await createShop(api,admin,'pro','Other garage',['mechanic']);
    const foreign=(await api.call('POST','/customers',{token:B.ownerToken,body:{name:'Foreign'}})).json.id;
    const old=await customer('Archived owner');
    expect((await api.call('PATCH',`/customers/${old}`,{token:A.ownerToken,body:{active:false}})).status).toBe(200);
    const v1=await vehicle('33-C-3333'),v2=await vehicle('44-D-4444');
    expect((await api.call('PATCH',`/workshop/vehicles/${v2}`,{token:A.ownerToken,body:{plate:'33-c-3333'}})).status).toBe(409);
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:A.ownerToken,body:{customerId:old}})).status).toBe(409);
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:A.ownerToken,body:{customerId:foreign}})).status).toBe(404);
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:A.ownerToken,body:{plate:'x'}})).status).toBe(400);
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:B.ownerToken,body:{plate:'55-E-5555'}})).status).toBe(404);
    // a mechanic role without customer access may fix the plate but not hand the car to another customer
    expect((await api.call('POST','/roles',{token:A.ownerToken,body:{name:'mechanic_only',permissions:['workshop.view','workshop.manage']}})).status).toBe(201);
    const m=await staff(api,A,'mechanic_only');
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:m.token,body:{customerId:null}})).status).toBe(403);
    expect((await api.call('PATCH',`/workshop/vehicles/${v1}`,{token:m.token,body:{plate:'66-F-6666'}})).status).toBe(200);
    expect((await api.call('GET',`/workshop/vehicles/${v1}`,as(A.ownerToken))).json.owners).toHaveLength(2);
  });

  it('RV3: the warranty end is the local delivery date + warranty days, visible on the order and the vehicle history',async()=>{
    const {A,vehicle,repair}=await garage('Garage warranty');
    const v=await vehicle('77-G-7777',30000);
    const withWarranty=await repair(v,30000,{warrantyDays:90});
    const noWarranty=await repair(v,30500,{warrantyDays:0});
    const local=new Date(Date.now()+3600000).toISOString().slice(0,10);   // Morocco = UTC+1
    const expected=new Date(Date.parse(`${local}T00:00:00Z`)+90*86400000).toISOString().slice(0,10);
    const orders=(await api.call('GET',`/workshop/orders?branchId=${A.branchId}`,as(A.ownerToken))).json.orders;
    expect(String(orders.find((o:any)=>o.id===withWarranty).warranty_until).slice(0,10)).toBe(expected);
    expect(orders.find((o:any)=>o.id===noWarranty).warranty_until).toBeNull();
    const repairs=(await api.call('GET',`/workshop/vehicles/${v}`,as(A.ownerToken))).json.repairs;
    expect(repairs.find((r:any)=>r.id===withWarranty).in_warranty).toBe(true);
    expect(repairs.find((r:any)=>r.id===noWarranty).in_warranty).toBeNull();
    expect(repairs).toHaveLength(2);
  });

  it('RV4: only the latest visit of a car can be due, and the reminder goes to the CURRENT owner',async()=>{
    const {A,customer,vehicle,repair}=await garage('Garage reminders');
    const seller=await customer('Seller'),buyer=await customer('Buyer');
    const v=await vehicle('88-H-8888',10000,seller);
    const firstVisit=await repair(v,10000,{nextServiceKm:15000});
    // the car is sold, then driven past the service mileage: due, and the buyer must be called
    expect((await api.call('PATCH',`/workshop/vehicles/${v}`,{token:A.ownerToken,body:{customerId:buyer,odometerKm:16000}})).status).toBe(200);
    let due=(await api.call('GET',`/workshop/reminders?branchId=${A.branchId}`,as(A.ownerToken))).json.reminders;
    expect(due.map((r:any)=>[r.id,r.customer])).toEqual([[firstVisit,'Buyer']]);
    // the service is done: the old reminder must disappear (the new visit is not due yet)
    await repair(v,16000,{nextServiceKm:26000});
    due=(await api.call('GET',`/workshop/reminders?branchId=${A.branchId}`,as(A.ownerToken))).json.reminders;
    expect(due).toHaveLength(0);
  });
});
