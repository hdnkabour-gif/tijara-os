import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, PW, createShop, key, platformAdmin, startApp } from './api-helpers.js';
import { owner } from './helpers.js';

let api:Api, admin:{token:string,id:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});

/** Re-create the state of an old pilot made with "self owner": the platform account is the only active owner. */
async function legacyPilot(name:string){
  const A=await createShop(api,admin,'pro',name,['butcher']);
  const beef=(await api.call('GET','/items',as(A.ownerToken))).json.items.find((i:any)=>i.sku==='BUT-BOEUF').id;
  const customer=(await api.call('POST','/customers',{token:A.ownerToken,body:{name:'Client historique'}})).json.id;
  await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef,qty:5,unitCost:80}});
  expect((await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,customerId:customer,lines:[{itemId:beef,qty:1}],payments:[{method:'cash',amount:120}]}})).status).toBe(201);
  const c=await owner.connect();
  try{
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[A.tenantId]);
    const role=(await c.query("SELECT id FROM roles WHERE tenant_id=$1 AND name='owner'",[A.tenantId])).rows[0].id;
    await c.query('UPDATE memberships SET active=false WHERE tenant_id=$1',[A.tenantId]);                  // the merchant owner never existed
    await c.query('INSERT INTO memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)',[A.tenantId,admin.id,role]);
    await c.query('COMMIT');
  }finally{c.release();}
  return {A,beef};
}

describe('Old platform-owned pilots get ONE real owner; the platform can never use this to enter a shop',()=>{
  it('FO1: the shop is flagged, a real owner is created, the data is intact, and the platform still cannot enter',async()=>{
    const {A}=await legacyPilot('Pilote historique');
    const overview=(await api.call('GET','/platform/overview',as(admin.token))).json;
    expect(overview.alerts).toEqual(expect.arrayContaining([expect.objectContaining({tenantId:A.tenantId,kind:'no_owner'})]));
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(true);
    // validation and authorization
    expect((await api.call('POST',`/platform/tenants/${A.tenantId}/first-owner`,{token:admin.token,body:{name:'Vrai Proprio',email:'weak@test.local',password:'short'}})).status).toBe(400);
    const B=await createShop(api,admin,'pro','Shop with owner',['butcher']);
    expect((await api.call('POST',`/platform/tenants/${A.tenantId}/first-owner`,{token:B.ownerToken,body:{name:'X',email:'x1@test.local',password:PW}})).status).toBe(403);
    const email=`real.owner.${Date.now()}@test.local`;
    const r=await api.call('POST',`/platform/tenants/${A.tenantId}/first-owner`,{token:admin.token,body:{name:'Vrai Proprio',email,password:PW}});
    expect(r.status).toBe(201);
    // the real owner logs in and finds everything: customer, invoice, stock
    const login=await api.call('POST','/auth/login',{body:{email,password:PW}});
    expect(login.status).toBe(200);
    const tok=login.json.token;
    expect((await api.call('POST','/auth/switch-tenant',{token:tok,body:{tenantId:A.tenantId}})).status).toBe(200);
    expect((await api.call('GET','/customers',as(tok))).json.customers.map((c:any)=>c.name)).toContain('Client historique');
    expect((await api.call('GET','/invoices',as(tok))).json.invoices).toHaveLength(1);
    const stock=(await api.call('GET',`/stock?branchId=${A.branchId}`,as(tok))).json.stock.find((s:any)=>s.sku==='BUT-BOEUF');
    expect(Number(stock.on_hand)).toBe(4);
    // flag gone, decision recorded, and no second owner can be pushed in by the platform
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(false);
    expect((await api.call('GET',`/platform/audit?tenantId=${A.tenantId}`,as(admin.token))).json.entries.map((e:any)=>e.action)).toContain('tenant.owner_assigned');
    expect((await api.call('POST',`/platform/tenants/${A.tenantId}/first-owner`,{token:admin.token,body:{name:'Intrus',email:`intrus.${Date.now()}@test.local`,password:PW}})).status).toBe(409);
    // the platform account itself still has no access to the shop
    expect((await api.call('POST','/auth/switch-tenant',{token:admin.token,body:{tenantId:A.tenantId}})).status).not.toBe(200);
    expect((await api.call('GET','/customers',as(admin.token))).status).not.toBe(200);
  });

  it('FO2: refused for a shop that already has a merchant owner, and for an e-mail already in use',async()=>{
    const B=await createShop(api,admin,'pro','Normal shop',['butcher']);
    expect((await api.call('POST',`/platform/tenants/${B.tenantId}/first-owner`,{token:admin.token,body:{name:'Intrus',email:`intrus2.${Date.now()}@test.local`,password:PW}})).status).toBe(409);
    const {A}=await legacyPilot('Pilote email');
    expect((await api.call('POST',`/platform/tenants/${A.tenantId}/first-owner`,{token:admin.token,body:{name:'Doublon',email:B.ownerEmail,password:PW}})).status).toBe(409);
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(true);   // still to be fixed, nothing half-done
  });
});
