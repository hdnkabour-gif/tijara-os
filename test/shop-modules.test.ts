import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';
import { owner } from './helpers.js';
import { MODULES } from '../src/entitlements.js';
import { activityIds } from '../src/templates.js';

// Issue #19, beyond the acceptance spec in entitlements.test.ts: one registry, data kept, audited, roles never lose rights.
let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp(); admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});
const setModule=(token:string,id:string,enabled:boolean)=>api.call('PATCH','/tenant/modules/'+id,{token,body:{enabled}});
async function inShop<T>(tenantId:string,fn:(c:any)=>Promise<T>){
  const c=await owner.connect();
  try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const r=await fn(c);await c.query('COMMIT');return r;}
  finally{c.release();}
}

describe('Shop modules: registry, data kept, audit, roles',()=>{
  it('SM1: the SQL default per activity is exactly the TypeScript registry (one source of truth, checked)',async()=>{
    for(const m of MODULES.filter((x)=>x.status==='available'))
      for(const act of activityIds){
        const sql=(await owner.query('SELECT module_default_enabled($1::jsonb,$2) AS on',[JSON.stringify([act]),m.id])).rows[0].on;
        expect(sql,`${m.id}/${act}`).toBe(m.activities===null||m.activities.includes(act));
      }
    expect((await owner.query(`SELECT module_default_enabled('[]'::jsonb,'workshop') AS on`)).rows[0].on).toBe(true);   // no activity: general shop
  });

  it('SM2: switching a module off hides it everywhere and keeps its data; back on, everything is there; both changes are journaled',async()=>{
    const A=await createShop(api,admin,'pro','Garage',['mechanic']);
    const v=(await api.call('POST','/workshop/vehicles',{token:A.ownerToken,body:{plate:'21-A-321',make:'Dacia',model:'Logan',odometerKm:1000}})).json.id;
    const manager=await staff(api,A,'manager');
    expect((await api.call('GET','/tenant/modules',as(manager.token))).status).toBe(403);           // settings are the owner's
    expect((await setModule(A.ownerToken,'workshop',false)).status).toBe(200);
    for(const t of [A.ownerToken,manager.token]){
      expect((await api.call('GET',`/workshop/vehicles/${v}`,as(t))).status).toBe(403);
      expect((await api.call('GET','/me',as(t))).json.modules).not.toContain('workshop');
    }
    expect((await setModule(A.ownerToken,'workshop',true)).status).toBe(200);
    expect((await api.call('GET',`/workshop/vehicles/${v}`,as(manager.token))).json.vehicle).toMatchObject({plate:'21-A-321'});
    const log=(await api.call('GET','/audit',as(A.ownerToken))).json.entries.map((e:any)=>e.action);
    expect(log).toEqual(expect.arrayContaining(['module.disabled','module.enabled']));
    expect((await setModule(A.ownerToken,'teleport',true)).status).toBe(404);
    expect((await api.call('PATCH','/tenant/modules/kitchen',{token:A.ownerToken,body:{enabled:'yes'}})).status).toBe(400);
  });

  it('SM3: editing a role never strips rights of a module that is off, and cannot add them; the editor only offers usable rights',async()=>{
    const A=await createShop(api,admin,'pro','Grill roles',['grill']);
    const groups=(await api.call('GET','/permissions',as(A.ownerToken))).json.groups.flatMap((g:any)=>g.permissions);
    expect(groups).toContain('kitchen.view'); expect(groups).not.toContain('workshop.view');
    const roles=(await api.call('GET','/roles',as(A.ownerToken))).json.roles;
    const mgr=roles.find((r:any)=>r.name==='manager');
    expect(mgr.inactive).toEqual(expect.arrayContaining(['workshop.view','workshop.manage']));   // shown as inactive, still stored
    // the UI sends the visible rights + the inactive ones: accepted
    const visible=mgr.permissions.filter((p:string)=>!mgr.inactive.includes(p)&&p!=='cash.manage');
    expect((await api.call('PATCH',`/roles/${mgr.id}`,{token:A.ownerToken,body:{permissions:[...visible,...mgr.inactive]}})).status).toBe(200);
    const after=(await api.call('GET','/roles',as(A.ownerToken))).json.roles.find((r:any)=>r.name==='manager');
    expect(after.permissions).toEqual(expect.arrayContaining(['workshop.view','workshop.manage'])); expect(after.permissions).not.toContain('cash.manage');
    // adding an off-module right to a role that did not have it: refused
    const cashier=roles.find((r:any)=>r.name==='cashier');
    const add=await api.call('PATCH',`/roles/${cashier.id}`,{token:A.ownerToken,body:{permissions:[...cashier.permissions,'workshop.view']}});
    expect(add.status).toBe(403); expect(add.json.error.code).toBe('FEATURE_NOT_IN_PLAN');
    // multi-activity: once the owner switches the workshop on, the manager's kept rights work again
    expect((await setModule(A.ownerToken,'workshop',true)).status).toBe(200);
    const m=await staff(api,A,'manager');
    expect((await api.call('GET','/workshop/vehicles',as(m.token))).status).toBe(200);
  });

  it('SM4: migration backfill: an existing shop keeps a module it already used, even outside its activity; an unused one is hidden',async()=>{
    const used=await createShop(api,admin,'pro','Old grill with cars',['grill']), unused=await createShop(api,admin,'pro','Old grill',['grill']);
    expect((await setModule(used.ownerToken,'workshop',true)).status).toBe(200);
    expect((await api.call('POST','/workshop/vehicles',{token:used.ownerToken,body:{plate:'33-B-44',make:'Fiat',model:'Uno',odometerKm:5}})).status).toBe(201);
    for(const s of [used,unused]) await inShop(s.tenantId,async(c)=>{                     // as before migration 017: no module rows
      await c.query('DELETE FROM tenant_modules WHERE tenant_id=$1',[s.tenantId]);
      await c.query('SELECT tenant_backfill_module_defaults($1)',[s.tenantId]);
    });
    expect((await api.call('GET','/me',as(used.ownerToken))).json.modules).toEqual(expect.arrayContaining(['workshop','kitchen']));
    const um=(await api.call('GET','/me',as(unused.ownerToken))).json.modules;
    expect(um).toContain('kitchen'); expect(um).not.toContain('workshop');
  });

  it('SM5: a branch-limited manager cannot cancel a sale of another branch and does not see shop-wide customer balances',async()=>{
    const A=await createShop(api,admin,'pro','Two branches',['grocery']);
    const B=(await api.call('POST','/branches',{token:A.ownerToken,body:{name:'Annex'}})).json.id;
    const item=(await api.call('POST','/items',{token:A.ownerToken,body:{name:'Service',sku:'SRV-1',price:10,kind:'service',trackQuantity:false,fulfillment:'none'}})).json.id;
    const sale=(await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:B,lines:[{itemId:item,qty:1}],payments:[{method:'cash',amount:10}]}})).json;
    const m=await staff(api,A,'manager',[A.branchId]);
    const cancel=await api.call('POST',`/sales/${sale.orderId}/cancel`,{token:m.token,headers:{'idempotency-key':key()},body:{reason:'not my branch'}});
    expect(cancel.status).toBe(403);
    expect((await api.call('GET','/reports/summary',as(m.token))).json.receivables).toBeNull();
    expect((await api.call('GET','/reports/summary',as(A.ownerToken))).json.receivables).not.toBeNull();
  });

  it('SM6: example products are refused on a production server unless it is declared a demo',async()=>{
    const prod=await startApp(true);
    try{
      const body=(slug:string)=>({name:'Real shop',slug,plan:'pro',activities:['butcher'],starterCatalog:true,owner:{name:'O',email:`${slug}@test.local`,password:'Valid-Passw0rd-1'}});
      const r=await prod.call('POST','/platform/tenants',{token:admin.token,body:body(`real-${Date.now()}`)});
      expect(r.status).toBe(403); expect(r.json.error.code).toBe('DEMO_DISABLED');
      process.env.DEMO_CATALOG='on';
      expect((await prod.call('POST','/platform/tenants',{token:admin.token,body:body(`demo-${Date.now()}`)})).status).toBe(201);
    }finally{delete process.env.DEMO_CATALOG; await prod.close();}
  });
});
