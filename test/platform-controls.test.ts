import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { Api,createShop,key,platformAdmin,staff,startApp,uniq,PW } from './api-helpers.js';

import { withTenant } from '../src/db.js';
import { owner } from './helpers.js';

let api: Api, admin: {token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const token=(s:string)=>({token:s});
const control=(shopId:string,body:any)=>api.call('PATCH',`/platform/tenants/${shopId}/controls`,{...token(admin.token),body});

describe('Platform subscriptions, suspension, and limits',()=>{
  it('PC1: only platform admin can pause/re-enable a shop without data loss; existing sessions are blocked immediately',async()=>{
    const A=await createShop(api,admin,'pro','Shop Suspended',['grocery']);
    const B=await createShop(api,admin,'pro','Shop Still Active',['grocery']);
    const before=(await api.call('GET','/items',token(A.ownerToken))).json.items;
    const plans=await api.call('GET','/platform/plans',token(admin.token));
    expect(plans.status).toBe(200);
    expect(plans.json.plans.map((p:any)=>p.id)).toEqual(expect.arrayContaining(['trial','basic','pro','complete']));
    const unauthorized=await api.call('PATCH',`/platform/tenants/${B.tenantId}/controls`,{
      ...token(A.ownerToken),body:{status:'suspended',reason:'hostile change'}});
    expect(unauthorized.status).toBe(403);
    const suspended=await control(A.tenantId,{status:'suspended',reason:'Staging trial paused'});
    expect(suspended.status).toBe(200);
    expect((await api.call('GET','/items',token(A.ownerToken))).status).toBe(423);
    expect((await api.call('POST','/sales/quick',{...token(A.ownerToken),headers:{'idempotency-key':key()},body:{branchId:A.branchId,lines:[],payments:[]}})).status).toBe(423);
    const shop=await api.call('GET','/tenant',token(A.ownerToken));
    expect(shop.json).toMatchObject({status:'suspended',statusReason:'Staging trial paused'});
    expect((await api.call('GET','/items',token(B.ownerToken))).status).toBe(200);
    expect((await api.call('GET','/platform/tenants',token(admin.token))).json.tenants.find((x:any)=>x.id===A.tenantId)?.status).toBe('suspended');
    expect((await control(A.tenantId,{status:'active'})).status).toBe(200);
    const resumed=await api.call('GET','/items',token(A.ownerToken));
    expect(resumed.status).toBe(200);
    expect(resumed.json.items.map((x:any)=>x.id).sort()).toEqual(before.map((x:any)=>x.id).sort());
  });

  it('PC2: feature restrictions depend on plan even if the shop owner role has workshop permission',async()=>{
    const A=await createShop(api,admin,'pro','Plan Test',['mechanic']);
    expect((await api.call('GET','/workshop/vehicles',token(A.ownerToken))).status).toBe(200);
    expect((await control(A.tenantId,{plan:'trial'})).status).toBe(200);
    const forbidden=await api.call('GET','/workshop/vehicles',token(A.ownerToken));
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.error.code).toBe('FEATURE_NOT_IN_PLAN');
    // Issue #19: a trial cannot be given modules beyond its plan (paid plans can receive add-ons, see CC4)
    const up=await control(A.tenantId,{features:{workshop:true}});
    expect(up.status).toBe(403); expect(up.json.error.code).toBe('PLAN_UPGRADE_REQUIRED');
    expect((await api.call('GET','/workshop/vehicles',token(A.ownerToken))).status).toBe(403);
    expect((await control(A.tenantId,{plan:'pro',features:{workshop:true}})).status).toBe(200);
    expect((await api.call('GET','/workshop/vehicles',token(A.ownerToken))).status).toBe(200);
    expect((await control(A.tenantId,{features:{workshop:false}})).status).toBe(200);
    expect((await api.call('GET','/workshop/vehicles',token(A.ownerToken))).status).toBe(403);
    expect((await control(A.tenantId,{features:{}})).status).toBe(200);
    expect((await control(A.tenantId,{plan:'complete'})).status).toBe(200);
    expect((await api.call('GET','/workshop/vehicles',token(A.ownerToken))).status).toBe(200);
  });

  it('PC3: custom branch/customer/staff/monthly-order limits are enforced by DB with no deletion',async()=>{
    const A=await createShop(api,admin,'pro','Limits Shop',['grill']);
    const updated=await control(A.tenantId,{limits:{
      max_users:1,max_branches:1,max_customers:1,max_monthly_orders:1,max_items:100
    }});
    expect(updated.status).toBe(200);
    const newBranch=await api.call('POST','/branches',{...token(A.ownerToken),body:{name:'Over Limit'}});
    expect(newBranch.status).toBe(403);expect(newBranch.json.error.code).toBe('QUOTA');
    const user=await api.call('POST','/users',{...token(A.ownerToken),body:{email:`limit.${uniq('member')}@test.local`,
      name:'Employee',roleName:'cashier',password:PW}});
    expect(user.status).toBe(403);expect(user.json.error.code).toBe('QUOTA');
    const [customer1,customer2]=await Promise.all([api.call('POST','/customers',{...token(A.ownerToken),body:{name:'Client X'}}),
      api.call('POST','/customers',{...token(A.ownerToken),body:{name:'Client Y'}})]);
    expect([customer1.status,customer2.status].sort()).toEqual([201,403]);
    expect((await api.call('GET','/customers',token(A.ownerToken))).json.customers).toHaveLength(1);
    const item=(await api.call('GET','/items',token(A.ownerToken))).json.items.find((x:any)=>x.sku==='GRL-CUISSON');
    const sale=()=>api.call('POST','/sales/quick',{...token(A.ownerToken),headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,lines:[{itemId:item.id,qty:1}],payments:[{method:'cash',amount:20}]}});
    expect((await sale()).status).toBe(201);
    const declined=await sale();
    expect(declined.status).toBe(403);expect(declined.json.error.code).toBe('QUOTA');
    expect((await api.call('GET','/invoices',token(A.ownerToken))).json.invoices).toHaveLength(1);
    const view=(await api.call('GET','/platform/tenants',token(admin.token))).json.tenants.find((x:any)=>x.id===A.tenantId);
    expect(view).toMatchObject({max_users:1,max_branches:1,max_customers:1,max_monthly_orders:1});
    expect(view.items).toBeGreaterThanOrEqual(1);
    expect((await control(A.tenantId,{limits:{max_customers:null,max_monthly_orders:null}})).status).toBe(200);
    expect((await api.call('POST','/customers',{...token(A.ownerToken),body:{name:'Client Z'}})).status).toBe(201);
  });
  it('PC4: expired trial is blocked but upgrading restores full shop data',async()=>{
    const A=await createShop(api,admin,'trial','Temporary Trial',['grocery']);
    const items=(await api.call('GET','/items',token(A.ownerToken))).json.items.map((x:any)=>x.id).sort();
    await withTenant(owner,{tenantId:A.tenantId},async(c)=>{
      await c.query("UPDATE tenants SET trial_expires_at=now()-interval '1 day' WHERE id=$1",[A.tenantId]);
    });
    const blocked=await api.call('GET','/items',token(A.ownerToken));
    expect(blocked.status).toBe(423); expect(blocked.json.error.code).toBe('TRIAL_EXPIRED');
    const publicTenant=await api.call('GET','/tenant',token(A.ownerToken));
    expect(publicTenant.json.status).toBe('trial_expired');
    expect((await control(A.tenantId,{plan:'basic'})).status).toBe(200);
    const restored=await api.call('GET','/items',token(A.ownerToken));
    expect(restored.status).toBe(200);
    expect(restored.json.items.map((x:any)=>x.id).sort()).toEqual(items);
  });

});
