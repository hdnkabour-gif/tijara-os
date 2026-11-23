import { audit } from './audit.js';
import { runCommand } from './commands.js';
import { withTenant } from './db.js';
import { SHOP_TZ, shopToday } from './clock.js';
import { HttpError, arr, bad, num, optStr, optUuid, oneOf, str, uuid } from './http.js';
import type { Authz, Kit } from './kit.js';
import { cancelOrder, confirmOrder, createOrder, payOrder } from './sales.js';

const moneyTypes = ['cash','card','transfer'] as const;
const plateName=(x:unknown)=>str(x,'plate',30).toUpperCase().replace(/\s+/g,' ').trim();
/** A warranty given on delivery ends N calendar days after the LOCAL delivery date (SHOP_TZ). */
const WARRANTY_UNTIL=`CASE WHEN w.delivered_at IS NOT NULL AND w.warranty_days>0
  THEN ((w.delivered_at AT TIME ZONE '${SHOP_TZ}')::date + w.warranty_days) END`;

/** Workshop uses existing sales-order + immutable invoice + stock reservation engines.
 * Quotes do NOT reserve stock; approval reserves, delivery issues the invoice.
 */
export function registerWorkshopRoutes(k:Kit){
  const {add,authorize,runtime,idemKey}=k;
  const protectedOrder=async(a:Authz,id:string)=>{
    const w=(await withTenant(runtime,a.ctx,c=>c.query('SELECT branch_id,state,sales_order_id FROM workshop_orders WHERE id=$1',[id]))).rows[0];
    if(!w)throw new HttpError(404,'NOT_FOUND','work order not found');
    a.assertBranch(w.branch_id);
    return w;
  };

  add('GET','/workshop/vehicles','session',async(rc)=>{
    const a=await authorize(rc,'workshop.view');
    const q=(rc.query.get('q')??'').trim();
    if(q.length>80)throw bad('search too long');
    const vehicles=(await withTenant(runtime,a.ctx,c=>c.query(
      `SELECT v.id,v.customer_id,v.plate,v.vin,v.make,v.model,v.odometer_km,v.updated_at,c.name AS customer_name
         FROM workshop_vehicles v LEFT JOIN customers c ON c.tenant_id=v.tenant_id AND c.id=v.customer_id
        WHERE ($1::text='' OR v.plate ILIKE '%'||$1||'%' OR v.make ILIKE '%'||$1||'%' OR v.model ILIKE '%'||$1||'%')
        ORDER BY v.updated_at DESC LIMIT 200`,[q]))).rows;
    return {body:{vehicles}};
  });
  add('POST','/workshop/vehicles','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),b=rc.body;
    const v={plate:plateName(b.plate),vin:b.vin==null?null:str(b.vin,'vin',50),make:str(b.make,'make',80),
      model:str(b.model,'model',80),customerId:optUuid(b.customerId,'customerId'),
      odometerKm:num(b.odometerKm??0,'odometerKm',{min:0})};
    if(!Number.isSafeInteger(v.odometerKm))throw bad('odometerKm must be an integer');
    const id=await withTenant(runtime,a.ctx,async(c)=>{
      const rows=await c.query(`INSERT INTO workshop_vehicles (tenant_id,customer_id,plate,vin,make,model,odometer_km)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.ctx.tenantId,v.customerId??null,v.plate,v.vin,v.make,v.model,v.odometerKm]);
      const id=rows.rows[0].id;
      await c.query('INSERT INTO workshop_vehicle_owners (tenant_id,vehicle_id,customer_id,plate,changed_by,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [a.ctx.tenantId,id,v.customerId??null,v.plate,a.ctx.userId??null,'initial']);
      await audit(c,a.ctx.tenantId,a.ctx.userId,'vehicle.created',{type:'vehicle',id},undefined,{plate:v.plate});
      return id;
    });
    return {status:201,body:{id}};
  });
  add('PATCH','/workshop/vehicles/:id','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),id=uuid(rc.params.id,'id'),b=rc.body;
    const make=b.make===undefined?null:str(b.make,'make',80);
    const model=b.model===undefined?null:str(b.model,'model',80);
    const plate=b.plate===undefined?null:plateName(b.plate);
    if(plate!==null&&plate.length<2)throw bad('plate is too short');
    const vinGiven=b.vin!==undefined, vin=b.vin==null||b.vin===''?null:str(b.vin,'vin',50);
    // customerId: absent = unchanged, null = no registered owner (walk-in), uuid = new owner
    const ownerGiven=b.customerId!==undefined, customerId=b.customerId==null||b.customerId===''?null:uuid(b.customerId,'customerId');
    const note=b.note==null||b.note===''?null:str(b.note,'note',300);
    const odometer=b.odometerKm===undefined?null:num(b.odometerKm,'odometerKm',{min:0});
    if(odometer!==null&&!Number.isSafeInteger(odometer))throw bad('odometerKm must be an integer');
    if(make===null&&model===null&&plate===null&&!vinGiven&&!ownerGiven&&odometer===null)throw bad('nothing to update');
    if(ownerGiven&&!a.permissions.includes('customers.view'))throw new HttpError(403,'FORBIDDEN','customers.view required to change the owner');
    await withTenant(runtime,a.ctx,async(c)=>{
      const old=(await c.query('SELECT plate,vin,make,model,customer_id,odometer_km FROM workshop_vehicles WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!old)throw new HttpError(404,'NOT_FOUND','vehicle not found');
      if(odometer!==null&&odometer<Number(old.odometer_km))throw new HttpError(409,'INVALID_STATE','odometer cannot move backwards');
      if(ownerGiven&&customerId!==null){
        const cust=(await c.query('SELECT active FROM customers WHERE id=$1',[customerId])).rows[0];
        if(!cust)throw new HttpError(404,'NOT_FOUND','customer not found');
        if(cust.active===false)throw new HttpError(409,'INVALID_STATE','customer is archived');
      }
      if(plate!==null&&plate!==old.plate){
        const taken=(await c.query('SELECT 1 FROM workshop_vehicles WHERE plate=$1 AND id<>$2',[plate,id])).rowCount;
        if(taken)throw new HttpError(409,'CONFLICT','another vehicle already has this plate');
      }
      const next={plate:plate??old.plate,vin:vinGiven?vin:old.vin,make:make??old.make,model:model??old.model,
        customer_id:ownerGiven?customerId:old.customer_id,odometer_km:odometer??Number(old.odometer_km)};
      await c.query('UPDATE workshop_vehicles SET plate=$2,vin=$3,make=$4,model=$5,customer_id=$6,odometer_km=$7,updated_at=now() WHERE id=$1',
        [id,next.plate,next.vin,next.make,next.model,next.customer_id,next.odometer_km]);
      const ownershipChanged=next.plate!==old.plate||next.customer_id!==old.customer_id;
      if(ownershipChanged)await c.query('INSERT INTO workshop_vehicle_owners (tenant_id,vehicle_id,customer_id,plate,changed_by,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [a.ctx.tenantId,id,next.customer_id,next.plate,a.ctx.userId??null,note]);
      const before={plate:old.plate,vin:old.vin,make:old.make,model:old.model,customerId:old.customer_id,odometerKm:Number(old.odometer_km)};
      const after={plate:next.plate,vin:next.vin,make:next.make,model:next.model,customerId:next.customer_id,odometerKm:next.odometer_km};
      await audit(c,a.ctx.tenantId,a.ctx.userId,ownershipChanged?'vehicle.ownership_changed':'vehicle.updated',{type:'vehicle',id},before,after,note?{note}:undefined);
    });
    return {body:{status:'ok'}};
  });

  /** One vehicle with its ownership history and every repair (with the computed warranty end). */
  add('GET','/workshop/vehicles/:id','session',async(rc)=>{
    const a=await authorize(rc,'workshop.view'),id=uuid(rc.params.id,'id');
    const out=await withTenant(runtime,a.ctx,async(c)=>{
      const vehicle=(await c.query(`SELECT v.id,v.customer_id,v.plate,v.vin,v.make,v.model,v.odometer_km,v.created_at,v.updated_at,c.name AS customer_name
        FROM workshop_vehicles v LEFT JOIN customers c ON c.tenant_id=v.tenant_id AND c.id=v.customer_id WHERE v.id=$1`,[id])).rows[0];
      if(!vehicle)throw new HttpError(404,'NOT_FOUND','vehicle not found');
      const owners=(await c.query(`SELECT o.customer_id,c.name AS customer_name,o.plate,o.changed_at,o.note,u.name AS changed_by
        FROM workshop_vehicle_owners o LEFT JOIN customers c ON c.tenant_id=o.tenant_id AND c.id=o.customer_id
        LEFT JOIN users u ON u.id=o.changed_by
        WHERE o.vehicle_id=$1 ORDER BY o.changed_at DESC,o.id LIMIT 100`,[id])).rows;
      // branch-scoped staff only see the repairs of their own branches
      const repairs=(await c.query(`SELECT w.id,w.branch_id,w.state,w.issue_note,w.quote_total,w.mileage_at_visit,w.warranty_days,
          w.created_at,w.delivered_at,w.invoice_id,(${WARRANTY_UNTIL})::text AS warranty_until,
          (${WARRANTY_UNTIL})>=(now() AT TIME ZONE '${SHOP_TZ}')::date AS in_warranty
        FROM workshop_orders w WHERE w.vehicle_id=$1 AND (cardinality($2::uuid[])=0 OR w.branch_id=ANY($2::uuid[]))
        ORDER BY w.created_at DESC LIMIT 100`,[id,a.branchIds])).rows;
      return {vehicle,owners,repairs};
    });
    return {body:out};
  });

  add('GET','/workshop/orders','session',async(rc)=>{
    const a=await authorize(rc,'workshop.view'),branchId=uuid(rc.query.get('branchId'),'branchId');
    a.assertBranch(branchId);
    const orders=(await withTenant(runtime,a.ctx,c=>c.query(`SELECT w.id,w.branch_id,w.vehicle_id,w.customer_id,w.sales_order_id,
      w.state,w.issue_note,w.quote_total,w.mileage_at_visit,w.warranty_days,w.next_service_date,w.next_service_km,
      w.created_at,w.approved_at,w.delivered_at,w.invoice_id,v.plate,v.make,v.model,(${WARRANTY_UNTIL})::text AS warranty_until,
      COALESCE(jsonb_agg(jsonb_build_object('item',l.item_name_at_quote,'sku',l.item_sku_at_quote,'qty',l.qty,'unitPrice',l.unit_price,'lineTotal',l.line_total)
          ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM workshop_orders w JOIN workshop_vehicles v ON v.tenant_id=w.tenant_id AND v.id=w.vehicle_id
      LEFT JOIN workshop_order_lines l ON l.tenant_id=w.tenant_id AND l.work_order_id=w.id
      LEFT JOIN items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id
      WHERE w.branch_id=$1 GROUP BY w.tenant_id,w.id,v.tenant_id,v.id ORDER BY w.created_at DESC LIMIT 100`,[branchId]))).rows;
    return {body:{orders}};
  });

  add('POST','/workshop/orders','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),b=rc.body;
    const branchId=uuid(b.branchId,'branchId'),vehicleId=uuid(b.vehicleId,'vehicleId');
    a.assertBranch(branchId);
    const lines=arr(b.lines,'lines',30).map((l,i)=>({
      itemId:uuid(l.itemId,`lines[${i}].itemId`),
      qty:num(l.qty,`lines[${i}].qty`,{positive:true})
    }));
    const warrantyDays=num(b.warrantyDays??0,'warrantyDays',{min:0});
    if(!Number.isInteger(warrantyDays)||warrantyDays>3650)throw bad('warrantyDays must be an integer from 0 to 3650');
    const mileage=num(b.mileageAtVisit,'mileageAtVisit',{min:0});
    if(!Number.isSafeInteger(mileage))throw bad('mileageAtVisit must be an integer');
    const p={branchId,vehicleId,lines,warrantyDays,mileage,
      note:b.note==null?null:str(b.note,'note',500),
      nextServiceDate:b.nextServiceDate==null?null:str(b.nextServiceDate,'nextServiceDate',10),
      nextServiceKm:b.nextServiceKm==null?null:num(b.nextServiceKm,'nextServiceKm',{min:0})};
    if(p.nextServiceDate&&!/^\d{4}-\d{2}-\d{2}$/.test(p.nextServiceDate))throw bad('invalid service date');
    if(p.nextServiceKm!==null&&!Number.isSafeInteger(p.nextServiceKm))throw bad('nextServiceKm must be integer');
    // A "next service" that is already due would appear in the reminders immediately: refuse it.
    if(p.nextServiceKm!==null&&p.nextServiceKm<=mileage)throw bad('nextServiceKm must be greater than the current mileage');
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'workshop_quote',payload:p},async(cc)=>{
      // Time-dependent check lives inside the command: a replay of an already committed quote returns the stored result
      // even after the date has passed, instead of a 400 that would hide the quote from the client.
      if(p.nextServiceDate&&p.nextServiceDate<=shopToday())throw bad('nextServiceDate must be in the future');
      const vehicle=(await cc.client.query('SELECT * FROM workshop_vehicles WHERE id=$1 FOR UPDATE',[vehicleId])).rows[0];
      if(!vehicle)throw new HttpError(404,'NOT_FOUND','vehicle not found');
      if(mileage<Number(vehicle.odometer_km))throw new HttpError(409,'INVALID_STATE','mileage is lower than recorded odometer');
      const id=(await cc.client.query(`INSERT INTO workshop_orders (tenant_id,branch_id,vehicle_id,customer_id,issue_note,
        mileage_at_visit,warranty_days,next_service_date,next_service_km,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [cc.tenantId,branchId,vehicleId,vehicle.customer_id,p.note,mileage,warrantyDays,p.nextServiceDate,p.nextServiceKm,cc.userId??null])).rows[0].id;
      for(const l of lines){
        const item=(await cc.client.query('SELECT id,sku,name,price,active,serial_tracking FROM items WHERE id=$1',[l.itemId])).rows[0];
        if(!item||!item.active)throw new HttpError(400,'VALIDATION','item is missing or archived');
        if(item.serial_tracking)throw bad('serial tracked parts require a dedicated serial selection step');
        await cc.client.query(`INSERT INTO workshop_order_lines (tenant_id,work_order_id,item_id,item_name_at_quote,item_sku_at_quote,qty,unit_price,line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,round($6::numeric*$7::numeric,2))`,
           [cc.tenantId,id,l.itemId,item.name,item.sku,l.qty,item.price]);
      }
      const total=(await cc.client.query(`UPDATE workshop_orders SET quote_total=COALESCE(
          (SELECT sum(line_total) FROM workshop_order_lines WHERE work_order_id=$1),0) WHERE id=$1 RETURNING quote_total`,[id])).rows[0].quote_total;
      await cc.client.query('UPDATE workshop_vehicles SET odometer_km=$2,updated_at=now() WHERE id=$1',[vehicleId,mileage]);
      await audit(cc.client,cc.tenantId,cc.userId,'workshop.quoted',{type:'workshop_order',id},undefined,{total});
      return {id,total};
    });
    return {status:201,body:result};
  });

  add('POST','/workshop/orders/:id/approve','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),id=uuid(rc.params.id,'id');
    if(!a.permissions.includes('sale.create'))throw new HttpError(403,'FORBIDDEN','sale.create required');
    await protectedOrder(a,id);
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'workshop_approve',payload:{id}},async(cc)=>{
      const w=(await cc.client.query('SELECT * FROM workshop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!w||w.state!=='quoted')throw new HttpError(409,'INVALID_STATE','only quotes may be approved');
      const lines=(await cc.client.query('SELECT item_id,qty,unit_price FROM workshop_order_lines WHERE work_order_id=$1 ORDER BY id',[id])).rows;
      const order=await createOrder(cc,{branchId:w.branch_id,customerId:w.customer_id??undefined,
        lines:lines.map(l=>({itemId:l.item_id,qty:Number(l.qty),unitPrice:Number(l.unit_price)}))});
      await confirmOrder(cc,order.orderId);
      await cc.client.query(`UPDATE workshop_orders SET state='approved',sales_order_id=$2,approved_at=now(),approved_by=$3 WHERE id=$1`,
        [id,order.orderId,cc.userId??null]);
      await audit(cc.client,cc.tenantId,cc.userId,'workshop.approved',{type:'workshop_order',id},undefined,{salesOrderId:order.orderId});
      return {salesOrderId:order.orderId};
    });
    return {body:result};
  });

  for(const [verb,from,to] of [['start','approved','in_progress'],['complete','in_progress','completed']] as const){
    add('POST',`/workshop/orders/:id/${verb}`,'session',async(rc)=>{
      const a=await authorize(rc,'workshop.manage'),id=uuid(rc.params.id,'id');
      await protectedOrder(a,id);
      const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:`workshop_${verb}`,payload:{id}},async(cc)=>{
        const w=(await cc.client.query('SELECT state FROM workshop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(w?.state!==from)throw new HttpError(409,'INVALID_STATE',`expected ${from}`);
        await cc.client.query('UPDATE workshop_orders SET state=$2 WHERE id=$1',[id,to]);
        await audit(cc.client,cc.tenantId,cc.userId,`workshop.${verb}`,{type:'workshop_order',id});
        return {state:to};
      });
      return {body:result};
    });
  }

  add('POST','/workshop/orders/:id/deliver','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),id=uuid(rc.params.id,'id');
    if(!a.permissions.includes('sale.create'))throw new HttpError(403,'FORBIDDEN','sale.create required');
    await protectedOrder(a,id);
    const payments=(rc.body.payments==null?[]:Array.isArray(rc.body.payments)?rc.body.payments:bad('payments must be an array')).map((p:any,i:number)=>({
      method:oneOf(p.method,`payments[${i}].method`,moneyTypes),
      amount:num(p.amount,`payments[${i}].amount`,{positive:true})}));
    if(payments.length>5)throw bad('too many payments');
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'workshop_deliver',payload:{id,payments}},async(cc)=>{
      const w=(await cc.client.query('SELECT * FROM workshop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!w||w.state!=='completed'||!w.sales_order_id)throw new HttpError(409,'INVALID_STATE','work order must be completed');
      const res=await payOrder(cc,{orderId:w.sales_order_id,payments});
      await cc.client.query("UPDATE workshop_orders SET state='delivered',delivered_at=now(),invoice_id=$2 WHERE id=$1",[id,res.invoiceId]);
      await audit(cc.client,cc.tenantId,cc.userId,'workshop.delivered',{type:'workshop_order',id},undefined,{invoiceId:res.invoiceId});
      return res;
    });
    return {status:201,body:result};
  });

  add('POST','/workshop/orders/:id/cancel','session',async(rc)=>{
    const a=await authorize(rc,'workshop.manage'),id=uuid(rc.params.id,'id'),reason=str(rc.body.reason,'reason',300);
    await protectedOrder(a,id);
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'workshop_cancel',payload:{id,reason}},async(cc)=>{
      const w=(await cc.client.query('SELECT state,sales_order_id FROM workshop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!w||['cancelled','delivered'].includes(w.state))throw new HttpError(409,'INVALID_STATE','cannot cancel delivered or cancelled work order');
      if(w.sales_order_id){
        if(!a.permissions.includes('sale.void'))throw new HttpError(403,'FORBIDDEN','sale.void required for reserved stock cancellation');
        await cancelOrder(cc,{orderId:w.sales_order_id,reason});
      }
      await cc.client.query("UPDATE workshop_orders SET state='cancelled' WHERE id=$1",[id]);
      await audit(cc.client,cc.tenantId,cc.userId,'workshop.cancelled',{type:'workshop_order',id},undefined,{reason});
      return {state:'cancelled'};
    });
    return {body:result};
  });

  add('GET','/workshop/reminders','session',async(rc)=>{
    const a=await authorize(rc,'workshop.view'),branchId=uuid(rc.query.get('branchId'),'branchId');
    a.assertBranch(branchId);
    // Only the LATEST delivered visit of each vehicle counts: once the car came back for its service, the old reminder is done.
    // The reminder goes to the CURRENT owner of the car, not whoever owned it at the time of the old repair.
    const reminders=(await withTenant(runtime,a.ctx,c=>c.query(`SELECT * FROM (
        SELECT DISTINCT ON (w.vehicle_id) w.id,w.branch_id,w.vehicle_id,w.delivered_at,w.warranty_days,w.next_service_date,w.next_service_km,
          v.plate,v.make,v.model,v.odometer_km,c.name AS customer,c.phone
        FROM workshop_orders w
        JOIN workshop_vehicles v ON v.tenant_id=w.tenant_id AND v.id=w.vehicle_id
        LEFT JOIN customers c ON c.tenant_id=v.tenant_id AND c.id=v.customer_id
        WHERE w.state='delivered'
        ORDER BY w.vehicle_id,w.delivered_at DESC) last
      WHERE last.branch_id=$1
        AND (last.next_service_date<=(now() AT TIME ZONE '${SHOP_TZ}')::date OR last.next_service_km<=last.odometer_km)
      ORDER BY last.delivered_at DESC LIMIT 100`,[branchId]))).rows;
    return {body:{reminders}};
  });
}
