import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';
import { owner } from './helpers.js';

let api:Api, admin:{token:string,id:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});
const ask=(token:string,tenantId:string,body:object)=>api.call('POST',`/platform/tenants/${tenantId}/support-requests`,{token,body});
const enter=(token:string,tenantId:string,grantId:string)=>api.call('POST','/platform/support/enter',{token,body:{tenantId,grantId}});
const reason='Le client signale un prix faux sur la caisse';

describe('PR-C support access with the owner\'s explicit consent',()=>{
  it('SA1: the platform has no standing access to a shop: no membership switch, no entry without an approved grant',async()=>{
    const A=await createShop(api,admin,'pro','No standing access',['butcher']);
    expect((await api.call('POST','/auth/switch-tenant',{token:admin.token,body:{tenantId:A.tenantId}})).status).not.toBe(200);
    const r=await ask(admin.token,A.tenantId,{reason,minutes:60,scope:'view'});
    expect(r.status).toBe(201);
    expect((await enter(admin.token,A.tenantId,r.json.id)).status).toBe(403);          // asked, not approved
    expect((await api.call('GET','/items',as(admin.token))).status).toBe(400);           // still no shop
    // validation and one waiting request at a time
    expect((await ask(admin.token,A.tenantId,{reason:'help',minutes:60})).status).toBe(400);
    expect((await ask(admin.token,A.tenantId,{reason,minutes:5000})).status).toBe(400);
    expect((await ask(admin.token,A.tenantId,{reason,minutes:60})).status).toBe(409);
    // shop users cannot ask for themselves
    expect((await ask(A.ownerToken,A.tenantId,{reason,minutes:60})).status).toBe(403);
  });

  it('SA2: owner approves (narrower), support works within scope, every request is journaled, revocation is immediate',async()=>{
    const A=await createShop(api,admin,'pro','Consent shop',['butcher']);
    await api.call('POST','/customers',{token:A.ownerToken,body:{name:'Client du commerce'}});
    const req=(await ask(admin.token,A.tenantId,{reason,minutes:120,scope:'assist'})).json.id;
    // only the OWNER decides: not a cashier, not a manager
    // even a staff role that may manage users is not the owner
    expect((await api.call('POST','/roles',{token:A.ownerToken,body:{name:'team_admin',permissions:['users.manage','catalog.view']}})).status).toBe(201);
    const cashier=await staff(api,A,'cashier'),manager=await staff(api,A,'manager'),teamAdmin=await staff(api,A,'team_admin');
    for(const t of [cashier.token,manager.token,teamAdmin.token]) expect((await api.call('POST',`/support/grants/${req}/approve`,{token:t,body:{}})).status).toBe(403);
    const list=(await api.call('GET','/support/grants',as(A.ownerToken))).json.grants;
    expect(list[0]).toMatchObject({id:req,status:'requested',scope:'assist',minutes:120,reason,active:false});
    expect((await api.call('POST',`/support/grants/${req}/approve`,{token:A.ownerToken,body:{minutes:200}})).status).toBe(400);   // longer than asked
    expect((await api.call('POST',`/support/grants/${req}/approve`,{token:A.ownerToken,body:{minutes:30,scope:'view'}})).status).toBe(200);
    expect((await api.call('POST',`/support/grants/${req}/approve`,{token:A.ownerToken,body:{}})).status).toBe(409);            // already decided

    expect((await enter(admin.token,A.tenantId,req)).status).toBe(200);
    const me=(await api.call('GET','/me',as(admin.token))).json;
    expect(me.activeTenantId).toBe(A.tenantId);
    expect(me.support).toMatchObject({id:req,scope:'view'});
    expect(me.permissions).toContain('catalog.view');
    expect(me.permissions).not.toContain('sale.create');
    expect((await api.call('GET','/items',as(admin.token))).status).toBe(200);
    expect((await api.call('GET','/customers',as(admin.token))).status).toBe(200);
    // view scope: nothing can be changed, sold or received
    expect((await api.call('POST','/customers',{token:admin.token,body:{name:'x'}})).status).toBe(403);
    expect((await api.call('PATCH','/tenant',{token:admin.token,body:{name:'Hacked'}})).status).toBe(403);
    const beef=(await api.call('GET','/items',as(A.ownerToken))).json.items.find((i:any)=>i.sku==='BUT-BOEUF').id;
    expect((await api.call('POST','/sales/quick',{token:admin.token,headers:{'idempotency-key':key()},body:{branchId:A.branchId,lines:[{itemId:beef,qty:1}],payments:[]}})).status).toBe(403);
    // the owner sees exactly what support did
    const journal=(await api.call('GET',`/audit?refId=${req}`,as(A.ownerToken))).json.entries;
    const actions=journal.map((e:any)=>e.action);
    expect(actions).toEqual(expect.arrayContaining(['support.requested','support.approved','support.entered','support.request']));
    // EVERY request is journaled, including handlers that do not use the permission helper (/me, /tenant)
    expect((await api.call('GET','/tenant',as(admin.token))).status).toBe(200);
    const paths=(await api.call('GET',`/audit?refId=${req}`,as(A.ownerToken))).json.entries.filter((e:any)=>e.action==='support.request').map((e:any)=>e.meta.path);
    expect(paths).toEqual(expect.arrayContaining(['/me','/items','/customers','/sales/quick','/tenant']));
    // revocation takes effect on the very next request
    expect((await api.call('POST',`/support/grants/${req}/revoke`,{token:A.ownerToken,body:{}})).status).toBe(200);
    expect((await api.call('GET','/items',as(admin.token))).status).toBe(400);
    expect((await api.call('GET','/me',as(admin.token))).json.activeTenantId).toBeNull();
    expect((await enter(admin.token,A.tenantId,req)).status).toBe(403);
  });

  it('SA3: an expired grant stops working by itself; a refused request never works',async()=>{
    const A=await createShop(api,admin,'pro','Expiry shop',['butcher']);
    const g=(await ask(admin.token,A.tenantId,{reason,minutes:15})).json.id;
    await api.call('POST',`/support/grants/${g}/approve`,{token:A.ownerToken,body:{}});
    expect((await enter(admin.token,A.tenantId,g)).status).toBe(200);
    expect((await api.call('GET','/items',as(admin.token))).status).toBe(200);
    const c=await owner.connect();                                              // simulate the end of the 15 minutes
    try { await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[A.tenantId]);
      await c.query("UPDATE support_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[g]); await c.query('COMMIT'); }
    finally { c.release(); }
    expect((await api.call('GET','/items',as(admin.token))).status).toBe(400);
    const r=(await ask(admin.token,A.tenantId,{reason,minutes:30})).json.id;
    expect((await api.call('POST',`/support/grants/${r}/refuse`,{token:A.ownerToken,body:{}})).status).toBe(200);
    expect((await enter(admin.token,A.tenantId,r)).status).toBe(403);
    const mine=(await api.call('GET',`/platform/tenants/${A.tenantId}/support-requests`,as(admin.token))).json.requests;
    expect(mine.map((x:any)=>[x.status,x.usable])).toEqual([['refused',false],['approved',false]]);
  });

  it('SA4: a grant serves only the admin who asked for it, and only on its own shop',async()=>{
    const A=await createShop(api,admin,'pro','Grant owner shop',['butcher']),B=await createShop(api,admin,'pro','Other shop',['butcher']);
    const other=await platformAdmin(api);
    const g=(await ask(admin.token,A.tenantId,{reason,minutes:60})).json.id;
    await api.call('POST',`/support/grants/${g}/approve`,{token:A.ownerToken,body:{}});
    expect((await enter(other.token,A.tenantId,g)).status).toBe(403);                    // another platform admin
    expect((await enter(admin.token,B.tenantId,g)).status).toBe(403);                    // another shop
    expect((await enter(A.ownerToken,A.tenantId,g)).status).toBe(403);                   // not a platform admin at all
    // the other shop's owner does not even see this request
    expect((await api.call('GET','/support/grants',as(B.ownerToken))).json.grants).toHaveLength(0);
    expect((await api.call('POST',`/support/grants/${g}/revoke`,{token:B.ownerToken,body:{}})).status).toBe(409);
    // leaving support mode returns the admin to the platform
    expect((await enter(admin.token,A.tenantId,g)).status).toBe(200);
    expect((await api.call('POST','/support/leave',{token:admin.token,body:{}})).status).toBe(200);
    expect((await api.call('GET','/me',as(admin.token))).json.activeTenantId).toBeNull();
  });

  it('SA5: "assist" can fix settings and the catalog, never sell, take payments, move stock or manage staff',async()=>{
    const A=await createShop(api,admin,'pro','Assist shop',['butcher']);
    const g=(await ask(admin.token,A.tenantId,{reason,minutes:60,scope:'assist'})).json.id;
    await api.call('POST',`/support/grants/${g}/approve`,{token:A.ownerToken,body:{}});
    expect((await enter(admin.token,A.tenantId,g)).status).toBe(200);
    const beef=(await api.call('GET','/items',as(admin.token))).json.items.find((i:any)=>i.sku==='BUT-BOEUF');
    expect((await api.call('PATCH',`/items/${beef.id}`,{token:admin.token,body:{price:125}})).status).toBe(200);
    expect((await api.call('PATCH','/tenant',{token:admin.token,body:{company:{footer:'Merci'}}})).status).toBe(200);
    expect((await api.call('POST','/sales/quick',{token:admin.token,headers:{'idempotency-key':key()},body:{branchId:A.branchId,lines:[{itemId:beef.id,qty:1}],payments:[]}})).status).toBe(403);
    expect((await api.call('POST','/stock/receive',{token:admin.token,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef.id,qty:1,unitCost:1}})).status).toBe(403);
    expect((await api.call('POST','/users',{token:admin.token,body:{email:'x@test.local',name:'x',password:'Correct-Horse-9',roleName:'cashier'}})).status).toBe(403);
    expect((await api.call('GET','/support/grants',as(admin.token))).status).toBe(403);   // support cannot approve itself
    const journal=(await api.call('GET',`/audit?refId=${g}`,as(A.ownerToken))).json.entries;
    expect(journal.some((e:any)=>e.action==='support.request'&&e.meta.method==='PATCH'&&e.meta.path===`/items/${beef.id}`)).toBe(true);
  });
});
