import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, PW, createShop, key, platformAdmin, staff, startApp, uniq } from './api-helpers.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp(); admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const me=async(token:string)=>(await api.call('GET','/me',{token})).json;
const setModule=(token:string,id:string,enabled:boolean)=>api.call('PATCH','/tenant/modules/'+id,{token,body:{enabled}});
const control=(id:string,body:object)=>api.call('PATCH','/platform/tenants/'+id+'/controls',{token:admin.token,body});

describe('shop activity, subscription, owner settings and employee grants',()=>{
  it('commercial provisioning leaves a real catalog empty',async()=>{
    const slug=uniq('empty'), email=slug+'@test.local';
    const r=await api.call('POST','/platform/tenants',{token:admin.token,body:{
      name:'Synthetic grill',slug,plan:'pro',activities:['grill','butcher'],owner:{name:'Owner',email,password:PW}
    }});
    expect(r.status).toBe(201);
    const token=(await api.call('POST','/auth/login',{body:{email,password:PW}})).json.token;
    expect((await api.call('GET','/items',{token})).json.items).toEqual([]);
    expect((await api.call('GET','/branches',{token})).json.branches).toHaveLength(1);
  });

  it.each([
    {activity:'grill',enabled:'kitchen.view',disabled:'workshop.view',paths:['/workshop/vehicles','/workshop/reminders','/workshop/vehicles/'+key()]},
    {activity:'mechanic',enabled:'workshop.view',disabled:'kitchen.view',paths:['/grill/orders','/production/transforms']}
  ])('$activity hides other activities and enforces GET, writes and subresources',async({activity,enabled,disabled,paths})=>{
    const A=await createShop(api,admin,'pro',activity,[activity]), token=A.ownerToken;
    expect((await me(token)).permissions).toContain(enabled);
    expect((await me(token)).permissions).not.toContain(disabled);
    for(const path of paths) expect((await api.call('GET',path+'?branchId='+A.branchId,{token})).status,path).toBe(403);
    expect((await api.call('POST',paths[0],{token,body:{}})).status).toBe(403);
    if(activity==='mechanic'){
      expect((await api.call('POST','/order-requests',{token,body:{branchId:A.branchId,toKitchen:true},headers:{'idempotency-key':key()}})).status).toBe(403);
    }
  });

  it('owner choices take effect in existing sessions and cannot exceed platform or plan',async()=>{
    const A=await createShop(api,admin,'pro','Combined',['grill','mechanic']);
    const B=await createShop(api,admin,'pro','Other grill',['grill']);
    const manager=await staff(api,A,'manager');
    expect((await me(manager.token)).permissions).toEqual(expect.arrayContaining(['workshop.view','kitchen.view']));
    expect((await setModule(manager.token,'kitchen',false)).status).toBe(403);
    expect((await setModule(A.ownerToken,'kitchen',false)).status).toBe(200);
    expect((await me(manager.token)).permissions).not.toContain('kitchen.view');
    expect((await api.call('GET','/grill/orders?branchId='+A.branchId,{token:manager.token})).status).toBe(403);
    expect((await me(B.ownerToken)).permissions).toContain('kitchen.view');
    expect((await control(A.tenantId,{features:{kitchen:false,orders:false}})).status).toBe(200);
    for(const id of ['kitchen','orders']) expect((await setModule(A.ownerToken,id,true)).status).toBe(403);
    const item=(await api.call('GET','/items',{token:A.ownerToken})).json.items[0];
    for(const path of ['/order-menu','/items/'+item.id+'/options'])
      expect((await api.call('GET',path,{token:A.ownerToken})).status,path).toBe(403);
    expect((await api.call('POST','/roles',{token:A.ownerToken,body:{name:'line_cook',permissions:['kitchen.manage']}})).status).toBe(403);
    expect((await control(A.tenantId,{features:{},plan:'trial'})).status).toBe(200);
    expect((await setModule(A.ownerToken,'workshop',true)).status).toBe(403);
    expect((await control(A.tenantId,{features:{workshop:true}})).status).toBe(403);
    expect((await setModule(A.ownerToken,'delivery',true)).status).toBe(400);
  });

  it('branch-scoped members see only their invoices and totals, and the default cashier gets no management grants',async()=>{
    const A=await createShop(api,admin,'pro','Split',['grill']), token=A.ownerToken;
    const B=(await api.call('POST','/branches',{token,body:{name:'Other branch'}})).json.id;
    const item=(await api.call('POST','/items',{token,body:{name:'Service',sku:'BILL',price:10,kind:'service',trackQuantity:false,fulfillment:'none'}})).json.id;
    const sales=[];
    for(const [branchId,qty] of [[A.branchId,1],[B,2]] as const) {
      const r=await api.call('POST','/sales/quick',{token,headers:{'idempotency-key':key()},body:{branchId,
        lines:[{itemId:item,qty}],payments:[{method:'cash',amount:10*qty}]}});
      expect(r.status).toBe(201); sales.push(r.json.invoiceId);
    }
    const manager=await staff(api,A,'manager',[A.branchId]), cashier=await staff(api,A,'cashier',[A.branchId]);
    expect((await api.call('GET','/invoices',{token:manager.token})).json.invoices.map((r:any)=>r.id)).toEqual([sales[0]]);
    expect((await api.call('GET','/invoices/'+sales[1],{token:manager.token})).status).toBe(404);
    expect((await api.call('GET','/reports/summary',{token:manager.token})).json.salesToday).toBe(10);
    for(const p of ['catalog.manage','report.view_profit','settings.manage','users.manage','cash.manage'])
      expect((await me(cashier.token)).permissions).not.toContain(p);
    expect((await api.call('PATCH','/items/'+item,{token:cashier.token,body:{price:1}})).status).toBe(403);
  });
});
