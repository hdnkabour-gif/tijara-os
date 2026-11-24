import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disabledStore } from '../src/mediastore.js';
import { Api, createShop, key, platformAdmin, staff, startApp } from './api-helpers.js';
import { owner } from './helpers.js';
import { jpeg, mp4, png } from './media-fixtures.js';

let api:Api, admin:{token:string};
beforeAll(async()=>{api=await startApp();admin=await platformAdmin(api);});
afterAll(async()=>{vi.useRealTimers();await api.close();});
const as=(token:string)=>({token});
const ALL_WEEK=Object.fromEntries([0,1,2,3,4,5,6].map((d)=>[String(d),[['00:00','23:59']]]));
const upload=(token:string,itemId:string,data:Buffer,kind='image')=>api.call('POST',`/items/${itemId}/media?kind=${kind}`,{token,raw:data,headers:{'content-type':'application/octet-stream'}});

/** A butcher-grill shop with a published menu, beef (in stock) with options, and online orders open. */
async function menuShop(name='Menu shop',settings:object={}){
  const A=await createShop(api,admin,'pro',name,['butcher','grill']);
  const items=(await api.call('GET','/items',as(A.ownerToken))).json.items;
  const id=(sku:string)=>items.find((i:any)=>i.sku===sku).id;
  const beef=id('BUT-BOEUF'),grill=id('GRL-CUISSON'),kefta=id('BUT-KEFTA'),lamb=id('BUT-AGNEAU'),broch=id('GRL-BROCH');
  expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:beef,qty:10,unitCost:80}})).status).toBe(201);
  expect((await api.call('POST','/stock/receive',{token:A.ownerToken,headers:{'idempotency-key':key()},body:{branchId:A.branchId,itemId:kefta,qty:5,unitCost:70}})).status).toBe(201);
  for(const it of [beef,lamb,broch]) expect((await api.call('PATCH',`/items/${it}`,{token:A.ownerToken,body:{orderable:true}})).status).toBe(200);
  await api.call('PUT',`/items/${beef}/options`,{token:A.ownerToken,body:{groups:[
    {name:'Préparation',required:true,choices:[{label:'Nature'},{label:'Grillé',addItemId:grill,qtyMode:'same'}]},
    {name:'Épices',choices:[{label:'Avec épices'},{label:'Sans épices'}]}]}});
  const opts=(await api.call('GET',`/items/${beef}/options`,as(A.ownerToken))).json.groups;
  const choice=(label:string)=>opts.flatMap((g:any)=>g.choices).find((c:any)=>c.label===label).id;
  expect((await api.call('PUT',`/items/${beef}/menu`,{token:A.ownerToken,body:{category:'Viandes',description:'Bœuf local',ingredients:'Bœuf',allergens:[],weightLabel:'au kg',serves:2,prepMinutes:20}})).status).toBe(200);
  const r=await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:true,acceptingOrders:true,pickupEnabled:true,hours:ALL_WEEK,prepMinutes:0,slotMinutes:15,slotCapacity:3,daysAhead:1,...settings}});
  expect(r.status).toBe(200);
  const slug=(await api.call('GET','/menu/settings',as(A.ownerToken))).json.slug;
  const menu=async(ip?:string)=>api.call('GET',`/public/shops/${slug}/menu`,{ip});
  return {A,slug,beef,grill,kefta,lamb,broch,choice,menu};
}
/** Get a form token, then let 4 s "pass" (the server refuses orders filled in under 3 s). */
async function readyToOrder(menu:()=>Promise<any>){
  const m=(await menu()).json;
  vi.useFakeTimers({toFake:['Date'],now:Date.now()+4000});
  return m;
}
const order=(slug:string,body:object,o:{ip?:string,idem?:string}={})=>api.call('POST',`/public/shops/${slug}/orders`,{ip:o.ip,headers:{'idempotency-key':o.idem??`k-${crypto.randomUUID()}`},body});

describe('D2 public menu: publication rules',()=>{
  it('PB1: nothing is public until published; suspended shops, plans without "online" and unknown slugs answer 404',async()=>{
    const A=await createShop(api,admin,'pro','Unpublished',['butcher']);
    const slug=(await api.call('GET','/menu/settings',as(A.ownerToken))).json.slug;
    expect((await api.call('GET',`/public/shops/${slug}/menu`)).status).toBe(404);
    expect((await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:false,acceptingOrders:true}})).status).toBe(400);  // publish first
    expect((await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:true,acceptingOrders:true,hours:{}}})).status).toBe(400); // hours first
    expect((await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:true,hours:{'1':[['18:00','11:00']]}}})).status).toBe(400);
    const cashier=await staff(api,A,'cashier');
    expect((await api.call('PUT','/menu/settings',{token:cashier.token,body:{published:true}})).status).toBe(403);
    expect((await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:true}})).status).toBe(200);
    expect((await api.call('GET',`/public/shops/${slug}/menu`)).status).toBe(200);
    // the platform switches the module off, or suspends the shop: the menu disappears (data kept)
    expect((await api.call('PATCH',`/platform/tenants/${A.tenantId}/controls`,{token:admin.token,body:{features:{online:false}}})).status).toBe(200);
    expect((await api.call('GET',`/public/shops/${slug}/menu`)).status).toBe(404);
    expect((await api.call('PATCH',`/platform/tenants/${A.tenantId}/controls`,{token:admin.token,body:{features:{online:true},status:'suspended',reason:'test'}})).status).toBe(200);
    expect((await api.call('GET',`/public/shops/${slug}/menu`)).status).toBe(404);
    expect((await api.call('GET','/public/shops/does-not-exist-shop/menu')).status).toBe(404);
    const T=await createShop(api,admin,'trial','Trial shop',['butcher']);                // the trial plan has no online module
    expect((await api.call('PUT','/menu/settings',{token:T.ownerToken,body:{published:true}})).status).toBe(403);
  });

  it('PB2: the menu shows only orderable products with their card, options and real availability - nothing internal',async()=>{
    const {A,menu,beef,lamb}=await menuShop('Card shop');
    const m=(await menu()).json;
    expect(m.shop.name).toBe('Card shop');
    expect(m.items.map((i:any)=>i.name).sort()).toEqual(['Brochette','Viande de bœuf','Viande d’agneau']);
    const b=m.items.find((i:any)=>i.id===beef);
    expect(b).toMatchObject({category:'Viandes',description:'Bœuf local',serves:2,prepMinutes:20,available:true});
    expect(b.options.map((g:any)=>g.name)).toEqual(['Préparation','Épices']);
    expect(m.items.find((i:any)=>i.id===lamb).available).toBe(false);                     // no lamb in stock
    expect(m.ordering.slots.length).toBeGreaterThan(0);
    expect(m.formToken).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    const text=JSON.stringify(m);
    expect(text).not.toMatch(/unit_?cost|on_hand|free_qty|reserved|sku|BUT-/i);          // no cost, stock figure or internal code
    // sold out by the owner: shown as unavailable and refused in a quote
    await api.call('PUT',`/items/${beef}/menu`,{token:A.ownerToken,body:{soldOut:true}});
    expect((await menu()).json.items.find((i:any)=>i.id===beef).available).toBe(false);
  });
});

describe('D2 photos and videos (files outside PostgreSQL)',()=>{
  it('PB3: real images only, metadata stripped, sizes bounded; videos are short MP4/WebM; only the catalog manager uploads',async()=>{
    const {A,beef,lamb,slug}=await menuShop('Media shop');
    const r=await upload(A.ownerToken,beef,png(64,48,'GPS 33.58N 7.62W'));
    expect(r.status).toBe(201); expect(r.json).toMatchObject({type:'image/png',width:64,height:48});
    const stored=Buffer.from(await (await fetch(`${api.base}/media/${r.json.id}`,{headers:{authorization:`Bearer ${A.ownerToken}`}})).arrayBuffer());
    expect(stored.includes(Buffer.from('GPS'))).toBe(false);                                // tEXt chunk removed
    const j=await upload(A.ownerToken,beef,jpeg(80,60,'GPSLatitude 33.58'));
    expect(j.status).toBe(201);
    const jStored=Buffer.from(await (await fetch(`${api.base}/media/${j.json.id}`,{headers:{authorization:`Bearer ${A.ownerToken}`}})).arrayBuffer());
    expect(jStored.includes(Buffer.from('GPSLatitude'))).toBe(false);                      // EXIF segment removed
    // dangerous or fake files
    expect((await upload(A.ownerToken,beef,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status).toBe(400);
    expect((await upload(A.ownerToken,beef,Buffer.from('<html><script>x</script></html>'))).status).toBe(400);
    expect((await upload(A.ownerToken,beef,png(10,10))).status).toBe(400);                  // too small
    expect((await upload(A.ownerToken,beef,Buffer.concat([png(64,48),Buffer.alloc(3_100_000)]))).status).toBe(400);   // > 3 MB photo
    expect((await upload(A.ownerToken,beef,Buffer.alloc(16_000_000),'video')).status).toBe(413);
    expect((await upload(A.ownerToken,beef,png(64,48),'video')).status).toBe(400);           // a photo is not a video
    expect((await upload(A.ownerToken,beef,mp4(45_000),'video')).status).toBe(400);          // > 30 s
    const v=await upload(A.ownerToken,beef,mp4(5_000),'video');
    expect(v.status).toBe(201); expect(v.json.durationMs).toBe(5000);
    expect((await upload(A.ownerToken,beef,mp4(4_000),'video')).status).toBe(409);           // one video per product
    const cashier=await staff(api,A,'cashier');
    expect((await upload(cashier.token,beef,png())).status).toBe(403);
    // thumbnail: a small JPEG only
    expect((await api.call('PUT',`/media/${r.json.id}/thumb`,{token:A.ownerToken,raw:png(40,40)})).status).toBe(400);
    expect((await api.call('PUT',`/media/${r.json.id}/thumb`,{token:A.ownerToken,raw:jpeg(400,300)})).status).toBe(200);
    // public serving: the right type, nosniff, a sandboxed CSP; video byte ranges for phones
    const pub=await fetch(`${api.base}/public/shops/${slug}/media/${r.json.id}`);
    expect(pub.status).toBe(200); expect(pub.headers.get('content-type')).toBe('image/png');
    expect(pub.headers.get('x-content-type-options')).toBe('nosniff'); expect(pub.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect((await fetch(`${api.base}/public/shops/${slug}/media/${r.json.id}?thumb=1`)).headers.get('content-type')).toBe('image/jpeg');
    const part=await fetch(`${api.base}/public/shops/${slug}/media/${v.json.id}`,{headers:{range:'bytes=0-99'}});
    expect(part.status).toBe(206); expect(part.headers.get('content-range')).toMatch(/^bytes 0-99\//); expect((await part.arrayBuffer()).byteLength).toBe(100);
    // a non-orderable product's media is never public
    const hidden=await upload(A.ownerToken,lamb,png());
    expect((await api.call('PATCH',`/items/${lamb}`,{token:A.ownerToken,body:{orderable:false}})).status).toBe(200);
    expect((await fetch(`${api.base}/public/shops/${slug}/media/${hidden.json.id}`)).status).toBe(404);
  });

  it('PB4: order, delete and isolation: another shop never reads or deletes these files; a deleted file is gone',async()=>{
    const {A,beef,slug}=await menuShop('Media order');
    const B=await createShop(api,admin,'pro','Other media',['butcher']);
    const x=(await upload(A.ownerToken,beef,png())).json.id, y=(await upload(A.ownerToken,beef,jpeg())).json.id;
    expect((await api.call('PUT',`/items/${beef}/media-order`,{token:A.ownerToken,body:{ids:[x]}})).status).toBe(400);    // all ids, once
    expect((await api.call('PUT',`/items/${beef}/media-order`,{token:A.ownerToken,body:{ids:[y,x]}})).status).toBe(200);
    const listed=(await api.call('GET','/menu/items',as(A.ownerToken))).json.items.find((i:any)=>i.id===beef).media.map((m:any)=>m.id);
    expect(listed).toEqual([y,x]);
    expect((await fetch(`${api.base}/media/${x}`,{headers:{authorization:`Bearer ${B.ownerToken}`}})).status).toBe(404);
    expect((await api.call('DELETE',`/media/${x}`,as(B.ownerToken))).status).toBe(404);
    const key0=(await owner.query("SELECT storage_key FROM item_media WHERE id=$1",[x])).rows;   // owner pool: RLS hides it without a tenant
    expect(key0).toHaveLength(0);
    expect((await api.call('DELETE',`/media/${x}`,as(A.ownerToken))).status).toBe(200);
    expect((await fetch(`${api.base}/public/shops/${slug}/media/${x}`)).status).toBe(404);
    expect((await fetch(`${api.base}/media/${x}`,{headers:{authorization:`Bearer ${A.ownerToken}`}})).status).toBe(404);
  });

  it('PB5: without persistent storage (production without MEDIA_DIR) uploads are refused, never written to a disk that a redeploy wipes',async()=>{
    const noStore=await startApp(false,disabledStore('media storage is not configured'));
    try{
      const A=await createShop(noStore,admin,'pro','No storage',['butcher']);
      const beef=(await noStore.call('GET','/items',as(A.ownerToken))).json.items.find((i:any)=>i.sku==='BUT-BOEUF').id;
      const r=await noStore.call('POST',`/items/${beef}/media?kind=image`,{token:A.ownerToken,raw:png()});
      expect(r.status).toBe(503); expect(r.json.error.code).toBe('MEDIA_UNAVAILABLE');
      expect((await noStore.call('GET','/menu/settings',as(A.ownerToken))).json.mediaStorage).toBe(false);
    }finally{await noStore.close();}
  });
});

describe('D2 online orders: server price, slots, anti-abuse, inbox, tracking',()=>{
  it('PB6: the price is computed by the server; "compose your plate" adds fixed portions linked to stock',async()=>{
    const {A,slug,beef,kefta,broch,choice}=await menuShop('Quote shop');
    const q=await api.call('POST',`/public/shops/${slug}/quote`,{body:{lines:[{itemId:beef,qty:1.5,choiceIds:[choice('Grillé'),choice('Sans épices')],unitPrice:1}]}});
    expect(q.status).toBe(200); expect(Number(q.json.total)).toBe(210);                     // 1.5 x 120 + 1.5 x 20
    expect(q.json.lines[0].choices).toEqual(['Grillé','Sans épices']);
    // a composed plate: the brochette base (12) + a 250 g kefta portion (0.25 x 110 = 27.5)
    expect((await api.call('PUT',`/items/${broch}/options`,{token:A.ownerToken,body:{groups:[{name:'Viandes',required:true,multiple:true,
      choices:[{label:'Kefta 250 g',addItemId:kefta,qtyMode:'fixed',addQty:0.25}]}]}})).status).toBe(200);
    expect((await api.call('PUT',`/items/${broch}/options`,{token:A.ownerToken,body:{groups:[{name:'X',choices:[{label:'Sans produit',qtyMode:'fixed',addQty:1}]}]}})).status).toBe(400);
    const keftaChoice=(await api.call('GET',`/items/${broch}/options`,as(A.ownerToken))).json.groups[0].choices[0].id;
    const plate=await api.call('POST',`/public/shops/${slug}/quote`,{body:{lines:[{itemId:broch,qty:2,choiceIds:[keftaChoice]}]}});
    expect(Number(plate.json.total)).toBe(51.5);                                              // 2 x 12 + 0.25 x 110
    expect((await api.call('POST',`/public/shops/${slug}/quote`,{body:{lines:[{itemId:broch,qty:1}]}})).status).toBe(400);   // a meat is required
    await api.call('PUT',`/items/${beef}/menu`,{token:A.ownerToken,body:{soldOut:true}});
    expect((await api.call('POST',`/public/shops/${slug}/quote`,{body:{lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]}})).status).toBe(400);
  });

  it('PB7: an online order lands in the D1 inbox (no stock reserved), is idempotent, and survives bot and abuse checks',async()=>{
    const {A,slug,menu,beef,choice}=await menuShop('Online order');
    const m=await readyToOrder(menu);
    try{
      const base={formToken:m.formToken,mode:'pickup',wantedAt:m.ordering.slots[0].at,customerName:'Client Web',customerPhone:'+212 600 000 000',contactConsent:true,
        lines:[{itemId:beef,qty:1.5,choiceIds:[choice('Grillé')]}]};
      expect((await order(slug,{...base,website:'http://spam'})).status).toBe(400);         // honeypot
      expect((await order(slug,{...base,formToken:'1.forged'})).status).toBe(400);
      expect((await order(slug,{...base,customerPhone:'call me'})).status).toBe(400);
      expect((await order(slug,{...base,wantedAt:'2020-01-01T10:00:00.000Z'})).status).toBe(400);   // not an offered slot
      expect((await order(slug,{...base,mode:'dine_in',tableLabel:'4'})).status).toBe(400);           // dine-in not offered
      const idem=`k-${crypto.randomUUID()}`;
      const r=await order(slug,base,{idem});
      expect(r.status).toBe(201); expect(Number(r.json.total)).toBe(210); expect(r.json.tracking).toMatch(/^[A-Za-z0-9_-]{54}$/);
      expect((await order(slug,base,{idem})).json.tracking).toBe(r.json.tracking);         // a retry returns the same order
      const inbox=(await api.call('GET',`/order-requests?branchId=${A.branchId}&status=pending`,as(A.ownerToken))).json.requests;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({channel:'web',customer_name:'Client Web',status:'pending'});
      const s=(await api.call('GET',`/stock?branchId=${A.branchId}`,as(A.ownerToken))).json.stock.find((x:any)=>x.sku==='BUT-BOEUF');
      expect(Number(s.reserved)).toBe(0);                                                   // not a sale before acceptance
      const stored=(await owner.connect());
      try{ await stored.query("SELECT set_config('app.tenant_id',$1,false)",[A.tenantId]);
        const row=(await stored.query('SELECT tracking_hash FROM order_requests WHERE channel=$1',['web'])).rows[0];
        expect(row.tracking_hash).toBe(crypto.createHash('sha256').update(r.json.tracking).digest('hex'));   // only the hash is stored
        const stored2=(await stored.query("SELECT result::text AS r FROM business_commands WHERE command_type='public_order'")).rows;
        expect(stored2.length).toBe(1); expect(stored2[0].r).not.toContain(r.json.tracking);           // not in the replay record either
      }finally{ await stored.query("SELECT set_config('app.tenant_id','',false)"); stored.release(); }
      // a closed online ordering is refused without touching the cashier
      expect((await api.call('PUT','/menu/settings',{token:A.ownerToken,body:{published:true,acceptingOrders:false,hours:ALL_WEEK}})).status).toBe(200);
      expect((await order(slug,base)).status).toBe(409);
    }finally{vi.useRealTimers();}
  });

  it('PB8: a too-fast form is refused; a full slot is refused; two customers racing for the last place get one order',async()=>{
    const {slug,menu,beef,choice}=await menuShop('Slots',{slotCapacity:1});
    const fresh=(await menu()).json;
    const line={itemId:beef,qty:1,choiceIds:[choice('Nature')]};
    expect((await order(slug,{formToken:fresh.formToken,mode:'pickup',wantedAt:fresh.ordering.slots[0].at,customerName:'A',customerPhone:'0600000001',lines:[line]})).status).toBe(429);
    const m=await readyToOrder(menu);
    try{
      const at=m.ordering.slots[1].at, body=(n:string)=>({formToken:m.formToken,mode:'pickup',wantedAt:at,customerName:n,customerPhone:'0600000002',lines:[line]});
      // six customers at the same moment for ONE place: exactly one order is taken
      const all=await Promise.all(['A','B','C','D','E','F'].map((n)=>order(slug,body(n))));
      expect(all.map((r)=>r.status).sort()).toEqual([201,409,409,409,409,409]);
      expect((await order(slug,body('Troisième'))).status).toBe(409);
      // the slot is shown as full on the menu
      expect((await menu()).json.ordering.slots.find((s:any)=>s.at===at).left).toBe(0);
    }finally{vi.useRealTimers();}
  });

  it('PB9: one IP cannot flood a shop with orders (rate limit)',async()=>{
    const {slug,menu,beef,choice}=await menuShop('Rate limit',{slotCapacity:50});
    const m=await readyToOrder(menu);
    try{
      const codes=[];
      for(let i=0;i<10;i++) codes.push((await order(slug,{formToken:m.formToken,mode:'pickup',wantedAt:m.ordering.slots[0].at,customerName:`C${i}`,customerPhone:'0600000003',
        lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]},{ip:'10.250.1.1'})).status);
      expect(codes.filter((c)=>c===201)).toHaveLength(8);
      expect(codes.slice(8)).toEqual([429,429]);
    }finally{vi.useRealTimers();}
  });

  it('PB10: the tracking link shows the status and the order only (no name, no phone); other tokens see nothing',async()=>{
    const {A,slug,menu,beef,choice}=await menuShop('Tracking');
    const m=await readyToOrder(menu);
    let tracking='';
    try{
      tracking=(await order(slug,{formToken:m.formToken,mode:'pickup',wantedAt:m.ordering.slots[0].at,customerName:'Nom Privé',customerPhone:'0611223344',
        lines:[{itemId:beef,qty:1,choiceIds:[choice('Nature')]}]})).json.tracking;
    }finally{vi.useRealTimers();}
    const track=()=>api.call('POST','/public/track',{body:{token:tracking}});
    let t=(await track()).json;
    expect(t).toMatchObject({shop:'Tracking',step:'received',mode:'pickup'});
    expect(JSON.stringify(t)).not.toMatch(/Nom Privé|0611223344/);
    // staff accept -> kitchen -> ready -> paid: the customer follows each step
    const req=(await api.call('GET',`/order-requests?branchId=${A.branchId}&status=pending`,as(A.ownerToken))).json.requests[0].id;
    const acc=(await api.call('POST',`/order-requests/${req}/accept`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).json;
    expect((await track()).json.step).toBe('accepted');
    await api.call('POST',`/grill/orders/${acc.orderId}/start`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}});
    expect((await track()).json.step).toBe('preparing');
    await api.call('POST',`/grill/orders/${acc.orderId}/ready`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}});
    expect((await track()).json.step).toBe('ready');
    await api.call('POST',`/order-requests/${req}/pay`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{payments:[{method:'cash',amount:Number(acc.total)}]}});
    expect((await track()).json.step).toBe('collected');
    // wrong, altered or other-shop tokens find nothing
    const altered=tracking.slice(0,-3)+(tracking.endsWith('AAA')?'BBB':'AAA');
    for(const bad of ['nope','x'.repeat(54),altered]) expect((await api.call('POST','/public/track',{body:{token:bad}})).status).toBe(404);
  });
});

describe('D2 review fixes',()=>{
  it('PB11: a shop without the kitchen module pays an online order at once; production without PUBLIC_FORM_SECRET refuses online orders',async()=>{
    const {A,slug,menu,beef,choice}=await menuShop('No kitchen');
    expect((await api.call('PATCH',`/platform/tenants/${A.tenantId}/controls`,{token:admin.token,body:{features:{kitchen:false}}})).status).toBe(200);
    const m=await readyToOrder(menu);
    try{
      expect((await order(slug,{formToken:m.formToken,mode:'pickup',wantedAt:m.ordering.slots[0].at,customerName:'Client',customerPhone:'0600000004',
        lines:[{itemId:beef,qty:2,choiceIds:[choice('Nature')]}]})).status).toBe(201);
    }finally{vi.useRealTimers();}
    const req=(await api.call('GET',`/order-requests?branchId=${A.branchId}&status=pending`,as(A.ownerToken))).json.requests[0];
    expect(req.to_kitchen).toBe(false);
    const acc=(await api.call('POST',`/order-requests/${req.id}/accept`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{}})).json;
    expect((await api.call('POST',`/order-requests/${req.id}/pay`,{token:A.ownerToken,headers:{'idempotency-key':key()},body:{payments:[{method:'cash',amount:Number(acc.total)}]}})).status).toBe(201);
    // production without the secret: the menu still shows, online orders are refused (never an unstable secret)
    const prod=await startApp(true);
    try{
      const r=await prod.call('POST',`/public/shops/${slug}/orders`,{headers:{'idempotency-key':`k-${crypto.randomUUID()}`},body:{}});
      expect(r.status).toBe(503); expect(r.json.error.code).toBe('NOT_CONFIGURED');
      expect((await prod.call('GET',`/public/shops/${slug}/menu`)).status).toBe(200);
    }finally{await prod.close();}
  });
});
