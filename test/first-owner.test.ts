import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, PW, createShop, key, platformAdmin, startApp } from './api-helpers.js';
import { owner } from './helpers.js';

let api:Api, admin:{token:string,id:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
beforeEach(()=>{process.env.OWNER_RECOVERY='claim-link';});               // staging opt-in; production default is off
afterEach(()=>{delete process.env.OWNER_RECOVERY;});
const as=(token:string)=>({token});
const assign=(tenantId:string,body:object,token=admin.token)=>api.call('POST',`/platform/tenants/${tenantId}/first-owner`,{token,body});

/** Set the shop's memberships directly (as the database looked for old pilots / edge cases). */
async function memberships(tenantId:string,fn:(c:any,ownerRole:string)=>Promise<void>){
  const c=await owner.connect();
  try{ await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const role=(await c.query("SELECT id FROM roles WHERE tenant_id=$1 AND name='owner'",[tenantId])).rows[0].id;
    await fn(c,role); await c.query('COMMIT'); }
  finally{c.release();}
}
/** An old pilot made with "self owner": the platform account is the only active owner; the shop has real data. */
async function legacyPilot(name:string){
  const A=await createShop(api,admin,'pro',name,['butcher']);
  const beef=(await api.call('GET','/items',as(A.ownerToken))).json.items.find((i:any)=>i.sku==='BUT-BOEUF').id;
  const customer=(await api.call('POST','/customers',{token:A.ownerToken,body:{name:'Client historique'}})).json.id;
  await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef,qty:5,unitCost:80}});
  expect((await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,customerId:customer,lines:[{itemId:beef,qty:1}],payments:[{method:'cash',amount:120}]}})).status).toBe(201);
  await memberships(A.tenantId,async(c,role)=>{
    await c.query('UPDATE memberships SET active=false WHERE tenant_id=$1',[A.tenantId]);
    await c.query('INSERT INTO memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)',[A.tenantId,admin.id,role]);
  });
  return A;
}
const usersNamed=async(email:string)=>Number((await owner.query('SELECT count(*) FROM users WHERE lower(email)=lower($1)',[email])).rows[0].count);

describe('Old platform-owned pilots get ONE real owner who chooses the password; nobody else is eligible',()=>{
  it('FO1: legacy pilot: flagged, owner created WITHOUT a password, claims it once, finds the data; the platform still cannot enter',async()=>{
    const A=await legacyPilot('Pilote historique');
    expect((await api.call('GET','/platform/overview',as(admin.token))).json.alerts).toEqual(expect.arrayContaining([expect.objectContaining({tenantId:A.tenantId,kind:'no_owner'})]));
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(true);
    const B=await createShop(api,admin,'pro','Shop with owner',['butcher']);
    expect((await assign(A.tenantId,{name:'X',email:'x1@test.local'},B.ownerToken)).status).toBe(403);   // not a platform admin
    const email=`real.owner.${Date.now()}@test.local`;
    const r=await assign(A.tenantId,{name:'Vrai Proprio',email,password:'chosen-by-admin-1'});              // a password sent is ignored
    expect(r.status).toBe(201);
    expect(r.json.claimPath).toMatch(/^\/app\/#\/reset\?token=tj_/);
    expect((await api.call('POST','/auth/login',{body:{email,password:'chosen-by-admin-1'}})).status).toBe(401);   // no password exists yet
    const token=r.json.claimPath.split('token=')[1];
    const stored=(await owner.query('SELECT pr.token_hash FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE lower(u.email)=$1',[email])).rows;
    expect(stored).toHaveLength(1); expect(stored[0].token_hash).not.toContain(token);                        // only the hash is stored
    // the owner sets the password through the one-time link, then logs in and finds everything
    expect((await api.call('POST','/auth/reset',{body:{token,newPassword:PW}})).status).toBe(200);
    expect((await api.call('POST','/auth/reset',{body:{token,newPassword:'Another-Pass-77'}})).status).toBe(400);   // single use
    const tok=(await api.call('POST','/auth/login',{body:{email,password:PW}})).json.token;
    expect((await api.call('POST','/auth/switch-tenant',{token:tok,body:{tenantId:A.tenantId}})).status).toBe(200);
    expect((await api.call('GET','/customers',as(tok))).json.customers.map((c:any)=>c.name)).toContain('Client historique');
    expect((await api.call('GET','/invoices',as(tok))).json.invoices).toHaveLength(1);
    expect(Number((await api.call('GET',`/stock?branchId=${A.branchId}`,as(tok))).json.stock.find((s:any)=>s.sku==='BUT-BOEUF').on_hand)).toBe(4);
    // flag gone, audit names the owner's user id (no password), no second owner, the platform still refused
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(false);
    const audit=(await api.call('GET',`/platform/audit?tenantId=${A.tenantId}`,as(admin.token))).json.entries.find((e:any)=>e.action==='tenant.owner_assigned');
    expect(audit.meta.ownerUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(audit)).not.toMatch(/tj_|password/i);
    expect((await assign(A.tenantId,{name:'Intrus',email:`intrus.${Date.now()}@test.local`})).status).toBe(409);
    expect((await api.call('POST','/auth/switch-tenant',{token:admin.token,body:{tenantId:A.tenantId}})).status).not.toBe(200);
    expect((await api.call('GET','/customers',as(admin.token))).status).not.toBe(200);
  });

  it('FO2: NOT eligible: a shop with a merchant owner, a shop with no owner at all, a shop whose merchant owner is only deactivated',async()=>{
    const withOwner=await createShop(api,admin,'pro','Normal shop',['butcher']);
    const noOwner=await createShop(api,admin,'pro','No owner at all',['butcher']);
    await memberships(noOwner.tenantId,async(c)=>{ await c.query('UPDATE memberships SET active=false WHERE tenant_id=$1',[noOwner.tenantId]); });
    const deactivated=await createShop(api,admin,'pro','Deactivated owner',['butcher']);
    await memberships(deactivated.tenantId,async(c)=>{ await c.query('UPDATE memberships SET active=false WHERE tenant_id=$1',[deactivated.tenantId]); });
    for(const s of [withOwner,noOwner,deactivated]){
      const email=`not.eligible.${s.tenantId.slice(0,8)}@test.local`;
      expect((await assign(s.tenantId,{name:'Intrus',email})).status).toBe(409);
      expect(await usersNamed(email)).toBe(0);                                                             // nothing created
      expect((await api.call('GET',`/platform/tenants/${s.tenantId}`,as(admin.token))).json.needsOwner).toBe(false);
    }
    const alerts=(await api.call('GET','/platform/overview',as(admin.token))).json.alerts.filter((a:any)=>a.kind==='no_owner').map((a:any)=>a.tenantId);
    for(const s of [withOwner,noOwner,deactivated]) expect(alerts).not.toContain(s.tenantId);
  });

  it('FO3: disabled by default (production) and atomic: a taken e-mail or a race creates no orphan account',async()=>{
    const A=await legacyPilot('Pilote atomique');
    delete process.env.OWNER_RECOVERY;
    const r0=await assign(A.tenantId,{name:'Proprio',email:`p0.${Date.now()}@test.local`});
    expect(r0.status).toBe(403); expect(r0.json.error.code).toBe('RECOVERY_DISABLED');
    process.env.OWNER_RECOVERY='claim-link';
    const B=await createShop(api,admin,'pro','Taken address shop',['butcher']);
    expect((await assign(A.tenantId,{name:'Doublon',email:B.ownerEmail})).status).toBe(409);               // e-mail already used
    expect((await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token))).json.needsOwner).toBe(true);
    // two operators at the same moment: exactly one owner, the other request creates nothing
    const e1=`race.one.${Date.now()}@test.local`, e2=`race.two.${Date.now()}@test.local`;
    const both=await Promise.all([assign(A.tenantId,{name:'Un',email:e1}),assign(A.tenantId,{name:'Deux',email:e2})]);
    expect(both.map((r)=>r.status).sort()).toEqual([201,409]);
    expect((await usersNamed(e1))+(await usersNamed(e2))).toBe(1);
  });
});
