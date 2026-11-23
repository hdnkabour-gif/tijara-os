import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{await api.close();});
const as=(token:string)=>({token});
// 1x1 PNG
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const controls=(id:string,body:object)=>api.call('PATCH',`/platform/tenants/${id}/controls`,{token:admin.token,body});

describe('PR-B platform control center (metadata only)',()=>{
  it('CC1: shop users, owners included, cannot open any platform page',async()=>{
    const A=await createShop(api,admin,'pro','Not an admin',['butcher']);
    for(const path of ['/platform/overview',`/platform/tenants/${A.tenantId}`,'/platform/audit'])
      expect((await api.call('GET',path,as(A.ownerToken))).status).toBe(403);
  });

  it('CC2: the overview counts real shops and raises alerts from real states (suspension, full quota)',async()=>{
    const A=await createShop(api,admin,'pro','Overview A',['butcher']),B=await createShop(api,admin,'basic','Overview B',['mechanic']);
    expect((await controls(B.tenantId,{status:'suspended',reason:'Unpaid test invoice'})).status).toBe(200);
    expect((await controls(A.tenantId,{limits:{max_items:4}})).status).toBe(200);   // the butcher template has 4 items: 100 %
    const o=(await api.call('GET','/platform/overview',as(admin.token))).json;
    expect(o.shops).toBeGreaterThanOrEqual(2);
    expect(o.byStatus.suspended).toBeGreaterThanOrEqual(1);
    expect(o.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({tenantId:B.tenantId,kind:'suspended',detail:'Unpaid test invoice'}),
      expect.objectContaining({tenantId:A.tenantId,kind:'quota_full',detail:'items 4/4'})]));
    expect(o.health).toMatchObject({offsiteBackup:'not_configured',lastRestoreDrill:null});
    expect([0,null]).toContain(o.health.pendingMigrations);   // null = this test server was not given the expected list (production server is)
    expect(o.health.lastMigration.name).toMatch(/^012_/);
  });

  it('CC3: the 360° card shows plan, usage, owners, roles, branches and history, but never the shop business data',async()=>{
    const A=await createShop(api,admin,'pro','Card shop',['butcher']);
    await staff(api,A,'cashier');
    const customer=(await api.call('POST','/customers',{token:A.ownerToken,body:{name:'Secret Customer Name',phone:'0600000000'}})).json.id;
    const beef=(await api.call('GET','/items',as(A.ownerToken))).json.items.find((i:any)=>i.sku==='BUT-BOEUF').id;
    await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef,qty:10,unitCost:80}});
    expect((await api.call('POST','/sales/quick',{token:A.ownerToken,headers:{'idempotency-key':key()},
      body:{branchId:A.branchId,customerId:customer,lines:[{itemId:beef,qty:1.234}],payments:[{method:'cash',amount:148.08}]}})).status).toBe(201);
    expect((await controls(A.tenantId,{features:{delivery:false}})).status).toBe(200);
    const card=await api.call('GET',`/platform/tenants/${A.tenantId}`,as(admin.token));
    expect(card.status).toBe(200);
    expect(card.json).toMatchObject({name:'Card shop',plan:'pro',status:'active'});
    expect(card.json.people.owners).toEqual([expect.objectContaining({email:A.ownerEmail})]);
    expect(card.json.people.roles).toEqual(expect.arrayContaining([expect.objectContaining({role:'cashier',active:1})]));
    expect(card.json.people.branches).toHaveLength(1);
    expect(card.json.usage.find((u:any)=>u.key==='customers').used).toBe(1);            // a counter, not the customer
    expect(card.json.features.delivery).toBe(false);
    expect(card.json.history.map((h:any)=>h.action)).toEqual(expect.arrayContaining(['tenant.created','tenant.controls_changed']));
    const text=JSON.stringify(card.json);
    expect(text).not.toMatch(/Secret Customer Name|0600000000|148\.08|BUT-BOEUF/);
    expect((await api.call('GET',`/platform/tenants/00000000-0000-4000-8000-000000000000`,as(admin.token))).status).toBe(404);
    const feed=(await api.call('GET',`/platform/audit?tenantId=${A.tenantId}`,as(admin.token))).json.entries;
    expect(feed.every((e:any)=>e.tenant_id===A.tenantId)).toBe(true);
    expect(feed.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PR-B shop side: my plan (read-only) and branding',()=>{
  it('CC4: every member sees their own plan, limits, usage and modules; nobody can change them from the shop',async()=>{
    const A=await createShop(api,admin,'basic','Plan shop',['butcher']);
    expect((await controls(A.tenantId,{limits:{max_users:7},features:{bookings:true}})).status).toBe(200);
    const cashier=await staff(api,A,'cashier');
    const p=(await api.call('GET','/tenant/plan',as(cashier.token))).json;
    expect(p).toMatchObject({plan:'basic',status:'active'});
    expect(p.usage.find((u:any)=>u.key==='users')).toMatchObject({used:2,limit:7});
    expect(p.features).toMatchObject({bookings:true,delivery:false,kitchen:true});
    // the shop cannot raise its own plan or limits
    expect((await api.call('PATCH',`/platform/tenants/${A.tenantId}/controls`,{token:A.ownerToken,body:{plan:'complete'}})).status).toBe(403);
  });

  it('CC5: branding is per shop, validated, owner-only, and the logo is never served to another shop',async()=>{
    const A=await createShop(api,admin,'pro','Brand A',['butcher']),B=await createShop(api,admin,'pro','Brand B',['butcher']);
    const cashier=await staff(api,A,'cashier');
    expect((await api.call('PUT','/tenant/branding',{token:cashier.token,body:{primaryColor:'#b91c1c'}})).status).toBe(403);
    expect((await api.call('PUT','/tenant/branding',{token:A.ownerToken,body:{primaryColor:'red'}})).status).toBe(400);
    expect((await api.call('PUT','/tenant/branding',{token:A.ownerToken,body:{primaryColor:'#B91C1C',accentColor:'#d4a017'}})).status).toBe(200);
    expect((await api.call('GET','/tenant/branding',as(cashier.token))).json).toMatchObject({primaryColor:'#b91c1c',accentColor:'#d4a017',hasLogo:false});
    expect((await api.call('GET','/tenant/branding',as(B.ownerToken))).json).toMatchObject({primaryColor:null,hasLogo:false});
    // logos: real image bytes only (no SVG/HTML pretending to be a PNG), at most 64 KB
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await api.call('PUT','/tenant/logo',{token:A.ownerToken,body:{data:svg}})).status).toBe(400);
    const big=Buffer.concat([Buffer.from(PNG,'base64'),Buffer.alloc(70000)]).toString('base64');
    expect((await api.call('PUT','/tenant/logo',{token:A.ownerToken,body:{data:big}})).status).toBeGreaterThanOrEqual(400);
    expect((await api.call('PUT','/tenant/logo',{token:cashier.token,body:{data:PNG}})).status).toBe(403);
    expect((await api.call('PUT','/tenant/logo',{token:A.ownerToken,body:{data:PNG}})).json).toMatchObject({type:'image/png'});
    const img=await fetch(`${api.base}/tenant/logo`,{headers:{authorization:`Bearer ${cashier.token}`}});
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await img.arrayBuffer()).equals(Buffer.from(PNG,'base64'))).toBe(true);
    expect((await fetch(`${api.base}/tenant/logo`,{headers:{authorization:`Bearer ${B.ownerToken}`}})).status).toBe(404);
    // removing the logo, and the journal keeps the trace
    expect((await api.call('DELETE','/tenant/logo',{token:A.ownerToken})).status).toBe(200);
    expect((await api.call('GET','/tenant/branding',as(A.ownerToken))).json.hasLogo).toBe(false);
    const actions=(await api.call('GET','/audit',as(A.ownerToken))).json.entries.map((e:any)=>e.action);
    expect(actions).toEqual(expect.arrayContaining(['branding.colors_updated','branding.logo_updated','branding.logo_removed']));
    // a suspended shop cannot change its branding (data is kept)
    expect((await controls(A.tenantId,{status:'suspended',reason:'test'})).status).toBe(200);
    expect((await api.call('PUT','/tenant/branding',{token:A.ownerToken,body:{primaryColor:'#000000'}})).status).toBe(423);
  });
});
