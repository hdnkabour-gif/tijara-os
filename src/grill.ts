import { audit } from './audit.js';
import { runCommand } from './commands.js';
import { withTenant } from './db.js';
import { SHOP_TZ, shopToday } from './clock.js';
import { HttpError, arr, bad, num, optDate, optNum, optStr, optUuid, oneOf, str, uuid } from './http.js';
import { consumeDirect, receiveStock } from './inventory.js';
import type { Kit, Authz } from './kit.js';
import { confirmOrder, createOrder, markReady, payOrder, startPreparation } from './sales.js';

const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;
const MAX_LINES = 30;

/** Phase B: existing financial/stock engines remain the single source of truth.
 * All movements use runCommand for serializability and replay safety.
 */
export function registerGrillRoutes(k: Kit) {
  const { add, authorize, runtime, idemKey } = k;
  const branchOrder = async (a: Authz, id: string) => {
    const r = (await withTenant(runtime, a.ctx, (c) => c.query(
      'SELECT branch_id, state FROM sales_orders WHERE id=$1', [id]))).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'order not found');
    a.assertBranch(r.branch_id);
    return r;
  };

  add('GET', '/grill/orders', 'session', async (rc) => {
    const a = await authorize(rc, 'kitchen.view');
    const branchId = uuid(rc.query.get('branchId'), 'branchId');
    a.assertBranch(branchId);
    const orders = (await withTenant(runtime, a.ctx, (c) => c.query(
      `SELECT o.id, o.branch_id, o.service_label, o.state, o.total, o.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('item',l.item_name_at_sale,'qty',COALESCE(l.actual_qty,l.ordered_qty),
                  'unit',l.base_uom_at_sale,'prepStarted',l.prep_started,'note',l.note) ORDER BY l.line_no)
                  FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS lines
         FROM sales_orders o
         JOIN sales_order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.prep_required
        WHERE o.branch_id=$1 AND o.state IN ('confirmed','in_preparation','ready')
        GROUP BY o.tenant_id,o.id ORDER BY o.created_at LIMIT 100`, [branchId]))).rows;
    return { body: { orders } };
  });

  add('POST', '/grill/orders', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.create'), b = rc.body;
    const branchId = uuid(b.branchId, 'branchId');
    a.assertBranch(branchId);
    const allowPrice = a.permissions.includes('sale.price_override');
    const lines = arr(b.lines, 'lines', MAX_LINES).map((l, i) => {
      if (l.unitPrice != null && !allowPrice) throw new HttpError(403, 'FORBIDDEN', 'price override not allowed');
      return {
        itemId: uuid(l.itemId, `lines[${i}].itemId`),
        qty: num(l.qty, `lines[${i}].qty`, { positive: true }),
        unitPrice: optNum(l.unitPrice, `lines[${i}].unitPrice`, { min: 0 }),
        actualQty: optNum(l.actualQty, `lines[${i}].actualQty`, { positive: true }),
        prepRequired: true,
      };
    });
    // Weigh first at order creation if actualQty differs: the kitchen flow intentionally
    // reserves the declared quantity. A later scale-adjustment API can be added separately.
    if (lines.some((x) => x.actualQty != null && x.actualQty !== x.qty)) throw bad('use final weighed quantity before sending to grill');
    const p = {
      branchId, customerId: optUuid(b.customerId, 'customerId'),
      label: b.label == null ? null : str(b.label, 'label', 60), lines,
    };
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'grill_order_create', payload: p }, async (cc) => {
      const { orderId } = await createOrder(cc, p);
      await cc.client.query('UPDATE sales_orders SET service_label=$2 WHERE id=$1', [orderId, p.label]);
      await confirmOrder(cc, orderId);
      await audit(cc.client, cc.tenantId, cc.userId, 'grill.order_created', { type: 'sales_order', id: orderId }, undefined, { label: p.label });
      return { orderId };
    });
    return { status: 201, body: result };
  });

  for (const [action, permission] of [['start', 'kitchen.manage'], ['ready', 'kitchen.manage']] as const) {
    add('POST', `/grill/orders/:id/${action}`, 'session', async (rc) => {
      const a = await authorize(rc, permission), id = uuid(rc.params.id, 'id');
      await branchOrder(a, id);
      const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: `grill_${action}`, payload: { id } }, async (cc) => {
        if (action === 'start') await startPreparation(cc, id);
        else await markReady(cc, id);
        await audit(cc.client, cc.tenantId, cc.userId, `grill.${action}`, { type: 'sales_order', id });
        return { status: action === 'start' ? 'in_preparation' : 'ready' };
      });
      return { body: result };
    });
  }

  add('POST', '/grill/orders/:id/pay', 'session', async (rc) => {
    const a = await authorize(rc, 'sale.create'), id = uuid(rc.params.id, 'id');
    await branchOrder(a, id);
    const payments = arr(rc.body.payments, 'payments', 5).map((p, i) => ({
      method: oneOf(p.method, `payments[${i}].method`, PAYMENT_METHODS),
      amount: num(p.amount, `payments[${i}].amount`, { positive: true }),
    }));
    const result = await runCommand(runtime, a.ctx, { key: idemKey(rc), type: 'grill_pay', payload: { id, payments } }, async (cc) => {
      const o = (await cc.client.query('SELECT state FROM sales_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (o?.state !== 'ready') throw new HttpError(409, 'INVALID_STATE', 'the grill must mark the order ready before payment');
      const invoice = await payOrder(cc, { orderId: id, payments });
      await audit(cc.client, cc.tenantId, cc.userId, 'grill.paid', { type: 'sales_order', id }, undefined, { invoiceId: invoice.invoiceId });
      return invoice;
    });
    return { status: 201, body: result };
  });

  // Supplier directory and stock receipts use tenant RLS + branch permissions.
  add('GET', '/suppliers', 'session', async (rc) => {
    const a = await authorize(rc, 'purchases.view');
    const suppliers = (await withTenant(runtime, a.ctx, (c) => c.query(
      'SELECT id,name,phone,active,created_at FROM suppliers ORDER BY name'))).rows;
    return { body: { suppliers } };
  });
  add('POST', '/suppliers', 'session', async (rc) => {
    const a = await authorize(rc, 'purchases.manage');
    const name = str(rc.body.name, 'name', 150);
    const phone = optStr(rc.body.phone, 'phone', 30) ?? null;
    const id = await withTenant(runtime, a.ctx, async (c) => {
      const id = (await c.query('INSERT INTO suppliers (tenant_id,name,phone) VALUES ($1,$2,$3) RETURNING id', [a.ctx.tenantId,name,phone])).rows[0].id;
      await audit(c,a.ctx.tenantId,a.ctx.userId,'supplier.created',{type:'supplier',id});
      return id;
    });
    return { status: 201, body: { id } };
  });
  add('PATCH', '/suppliers/:id', 'session', async (rc) => {
    const a = await authorize(rc, 'purchases.manage'), id = uuid(rc.params.id, 'id');
    const name = rc.body.name === undefined ? null : str(rc.body.name,'name',150);
    const active = rc.body.active === undefined ? null : rc.body.active;
    if (name === null && active === null) throw bad('nothing to update');
    if (active !== null && typeof active !== 'boolean') throw bad('active must be boolean');
    await withTenant(runtime, a.ctx, async (c) => {
      const r = await c.query('UPDATE suppliers SET name=COALESCE($2,name),active=COALESCE($3,active) WHERE id=$1', [id,name,active]);
      if (!r.rowCount) throw new HttpError(404,'NOT_FOUND','supplier not found');
      await audit(c,a.ctx.tenantId,a.ctx.userId,'supplier.updated',{type:'supplier',id});
    });
    return { body: { status: 'ok' } };
  });
  add('GET', '/purchase-receipts', 'session', async (rc) => {
    const a = await authorize(rc, 'purchases.view');
    const branch = rc.query.get('branchId');
    if (branch) a.assertBranch(uuid(branch,'branchId'));
    const rows = (await withTenant(runtime,a.ctx,(c)=>c.query(
      `SELECT r.id,r.branch_id,r.reference,r.total,r.created_at,s.name AS supplier
         FROM purchase_receipts r JOIN suppliers s ON s.tenant_id=r.tenant_id AND s.id=r.supplier_id
         WHERE ($1::uuid IS NULL OR r.branch_id=$1)
           AND (cardinality($2::uuid[])=0 OR r.branch_id=ANY($2::uuid[]))
         ORDER BY r.created_at DESC LIMIT 100`,[branch??null,a.branchIds]))).rows;
    return { body: { receipts: rows } };
  });
  add('GET','/purchase-receipts/:id','session',async (rc)=>{
    const a=await authorize(rc,'purchases.view'),id=uuid(rc.params.id,'id');
    const out=await withTenant(runtime,a.ctx,async(c)=>{
      const receipt=(await c.query(`SELECT r.id,r.branch_id,r.reference,r.total,r.created_at,s.name AS supplier,u.name AS received_by
        FROM purchase_receipts r JOIN suppliers s ON s.tenant_id=r.tenant_id AND s.id=r.supplier_id
        LEFT JOIN users u ON u.id=r.created_by WHERE r.id=$1`,[id])).rows[0];
      if(!receipt)throw new HttpError(404,'NOT_FOUND','receipt not found');
      a.assertBranch(receipt.branch_id);
      const lines=(await c.query(`SELECT l.item_id,i.sku,i.name,l.qty,l.unit_cost,l.line_total,l.batch_no,l.expires_at::text AS expires_at,l.serial_nos,l.warranty_until::text AS warranty_until
        FROM purchase_receipt_lines l JOIN items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id WHERE l.receipt_id=$1 ORDER BY l.id`,[id])).rows;
      return {...receipt,lines};
    });
    return {body:out};
  });
  /** Batches still in stock that expire within N days (default 3): what the butcher must sell or transform first. */
  add('GET','/stock/expiring','session',async (rc)=>{
    const a=await authorize(rc,'stock.view'),branchId=uuid(rc.query.get('branchId'),'branchId');
    a.assertBranch(branchId);
    const days=Number(rc.query.get('days')??3);
    if(!Number.isInteger(days)||days<0||days>365)throw bad('days must be an integer from 0 to 365');
    const batches=(await withTenant(runtime,a.ctx,(c)=>c.query(`SELECT i.id AS item_id,i.sku,i.name,i.base_uom,b.batch_no,b.expires_at,(b.expires_at AT TIME ZONE '${SHOP_TZ}')::date::text AS expires_on,
        sum(sb.on_hand) AS on_hand,sum(sb.reserved) AS reserved,
        ((b.expires_at AT TIME ZONE '${SHOP_TZ}')::date - (now() AT TIME ZONE '${SHOP_TZ}')::date) AS days_left
      FROM stock_balances sb JOIN batches b ON b.tenant_id=sb.tenant_id AND b.id=sb.batch_id
      JOIN items i ON i.tenant_id=sb.tenant_id AND i.id=sb.item_id
      WHERE sb.branch_id=$1 AND sb.stock_status='sellable' AND sb.on_hand>0 AND b.expires_at IS NOT NULL
        AND (b.expires_at AT TIME ZONE '${SHOP_TZ}')::date <= (now() AT TIME ZONE '${SHOP_TZ}')::date + $2::int
      GROUP BY i.id,i.sku,i.name,i.base_uom,b.batch_no,b.expires_at ORDER BY b.expires_at,i.name LIMIT 200`,[branchId,days]))).rows;
    return {body:{batches}};
  });
  add('POST','/purchase-receipts','session',async (rc)=>{
    const a=await authorize(rc,'purchases.manage');
    if (!a.permissions.includes('stock.receive')) throw new HttpError(403,'FORBIDDEN','stock.receive required');
    const b=rc.body, branchId=uuid(b.branchId,'branchId'), supplierId=uuid(b.supplierId,'supplierId');
    a.assertBranch(branchId);
    const lines=arr(b.lines,'lines',MAX_LINES).map((l,i)=>{
      const serials=l.serials==null?[]:arr(l.serials,`lines[${i}].serials`,500).map((x,j)=>str(x,`lines[${i}].serials[${j}]`,80));
      if(new Set(serials).size!==serials.length)throw bad(`lines[${i}].serials contains the same serial number twice`);
      const line={
        itemId:uuid(l.itemId,`lines[${i}].itemId`),
        qty:num(l.qty,`lines[${i}].qty`,{positive:true}),
        unitCost:num(l.unitCost,`lines[${i}].unitCost`,{min:0}),
        batchNo:l.batchNo===''?undefined:optStr(l.batchNo,`lines[${i}].batchNo`,60),
        expiresAt:optDate(l.expiresAt,`lines[${i}].expiresAt`),
        warrantyUntil:optDate(l.warrantyUntil,`lines[${i}].warrantyUntil`),
        serials,
      };
      if(line.expiresAt&&!line.batchNo)throw bad(`lines[${i}]: an expiry date needs a batch number`);
      if(serials.length&&serials.length!==line.qty)throw bad(`lines[${i}]: give exactly one serial number per unit`);
      if(line.warrantyUntil&&!serials.length)throw bad(`lines[${i}]: a supplier warranty is recorded per serial number`);
      return line;
    });
    const p={branchId,supplierId,reference:b.reference==null?null:str(b.reference,'reference',80),lines};
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'purchase_receipt',payload:p},async(cc)=>{
      const sup=(await cc.client.query('SELECT active FROM suppliers WHERE id=$1',[supplierId])).rows[0];
      if (!sup) throw new HttpError(404,'NOT_FOUND','supplier not found');
      if (!sup.active) throw new HttpError(409,'INVALID_STATE','supplier archived');
      // Time-dependent rule inside the command: a replay of a committed receipt keeps returning its stored result.
      const today=shopToday();
      // stock stops being sellable on its expiry date, so a lot expiring today could never be sold
      lines.forEach((l,i)=>{ if(l.expiresAt&&l.expiresAt<=today)throw bad(`lines[${i}]: this batch is expired or expires today`); });
      const id=(await cc.client.query('INSERT INTO purchase_receipts (tenant_id,supplier_id,branch_id,reference,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [cc.tenantId,supplierId,branchId,p.reference,cc.userId??null])).rows[0].id;
      for(const l of lines){
        const item=(await cc.client.query('SELECT sku,serial_tracking FROM items WHERE id=$1',[l.itemId])).rows[0];
        if(!item)throw new HttpError(404,'NOT_FOUND','item not found');
        if(item.serial_tracking&&!l.serials.length)throw bad(`${item.sku}: enter the serial number of every unit received`);
        if(!item.serial_tracking&&l.serials.length)throw bad(`${item.sku} is not tracked by serial number`);
        await cc.client.query(`INSERT INTO purchase_receipt_lines (tenant_id,receipt_id,item_id,qty,unit_cost,line_total,batch_no,expires_at,serial_nos,warranty_until)
          VALUES ($1,$2,$3,$4,$5,round($4::numeric*$5::numeric,2),$6,$7,$8,$9)`,
          [cc.tenantId,id,l.itemId,l.qty,l.unitCost,l.batchNo??null,l.expiresAt,l.serials,l.warrantyUntil]);
        await receiveStock(cc,{itemId:l.itemId,qty:l.qty,unitCost:l.unitCost,batchNo:l.batchNo,expiresAt:l.expiresAt,branchId,
          serials:l.serials.length?l.serials.map((serialNo)=>({serialNo,...(l.warrantyUntil?{warrantyUntil:l.warrantyUntil}:{})})):undefined,
          sourceType:'purchase_receipt',sourceId:id});
      }
      const total=(await cc.client.query(`UPDATE purchase_receipts SET total=(SELECT sum(line_total) FROM purchase_receipt_lines WHERE receipt_id=$1)
        WHERE id=$1 RETURNING total`,[id])).rows[0].total;
      await audit(cc.client,cc.tenantId,cc.userId,'purchase.received',{type:'purchase_receipt',id},undefined,{total});
      return {id,total};
    });
    return {status:201,body:result};
  });

  // Opening/closing cash never modifies payment history; it reconciles it.
  add('GET','/cash-sessions','session',async(rc)=>{
    const a=await authorize(rc,'cash.view'),branchId=uuid(rc.query.get('branchId'),'branchId');
    a.assertBranch(branchId);
    const sessions=(await withTenant(runtime,a.ctx,(c)=>c.query(
      'SELECT * FROM cash_sessions WHERE branch_id=$1 ORDER BY opened_at DESC LIMIT 50',[branchId]))).rows;
    return {body:{sessions}};
  });
  add('POST','/cash-sessions','session',async(rc)=>{
    const a=await authorize(rc,'cash.manage'),branchId=uuid(rc.body.branchId,'branchId');
    a.assertBranch(branchId);
    const openingFloat=num(rc.body.openingFloat,'openingFloat',{min:0});
    const id=await withTenant(runtime,a.ctx,async(c)=>{
      const r=await c.query('INSERT INTO cash_sessions (tenant_id,branch_id,opened_by,opening_float) VALUES ($1,$2,$3,$4) RETURNING id',
        [a.ctx.tenantId,branchId,a.ctx.userId,openingFloat]);
      await audit(c,a.ctx.tenantId,a.ctx.userId,'cash.opened',{type:'cash_session',id:r.rows[0].id});
      return r.rows[0].id;
    });
    return {status:201,body:{id}};
  });
  add('POST','/cash-sessions/:id/close','session',async(rc)=>{
    const a=await authorize(rc,'cash.manage'),id=uuid(rc.params.id,'id');
    const counted=num(rc.body.countedCash,'countedCash',{min:0});
    const result=await withTenant(runtime,a.ctx,async(c)=>{
      const session=(await c.query('SELECT * FROM cash_sessions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!session) throw new HttpError(404,'NOT_FOUND','cash session not found');
      a.assertBranch(session.branch_id);
      if(session.closed_at) throw new HttpError(409,'INVALID_STATE','cash session already closed');
      const now=(await c.query('SELECT now() AS t')).rows[0].t;
      const turnover=(await c.query(`SELECT COALESCE(sum(pa.amount),0) AS total FROM payment_allocations pa
          JOIN payments p ON p.tenant_id=pa.tenant_id AND p.id=pa.payment_id
          JOIN invoices inv ON inv.tenant_id=pa.tenant_id AND inv.id=pa.invoice_id
          JOIN sales_orders so ON so.tenant_id=inv.tenant_id AND so.id=inv.order_id
         WHERE so.branch_id=$1 AND p.method='cash' AND p.created_at >= $2 AND p.created_at <= $3`,
         [session.branch_id,session.opened_at,now])).rows[0].total;
      const expected=Math.round((Number(session.opening_float)+Number(turnover))*100)/100;
      const difference=Math.round((counted-expected)*100)/100;
      await c.query('UPDATE cash_sessions SET closed_by=$2,closed_at=$3,counted_cash=$4,expected_cash=$5,difference=$6 WHERE id=$1',
        [id,a.ctx.userId,now,counted,expected,difference]);
      await audit(c,a.ctx.tenantId,a.ctx.userId,'cash.closed',{type:'cash_session',id},undefined,{expected,difference});
      return {id,expected,counted,difference};
    });
    return {body:result};
  });

  // Meat transformation (e.g. 5 kg meat -> 4.6 kg kefta) is one atomic, auditable stock command.
  add('POST','/production/transforms','session',async(rc)=>{
    const a=await authorize(rc,'production.manage'),b=rc.body,branchId=uuid(b.branchId,'branchId');
    a.assertBranch(branchId);
    const p={branchId,inputItemId:uuid(b.inputItemId,'inputItemId'),outputItemId:uuid(b.outputItemId,'outputItemId'),
      inputQty:num(b.inputQty,'inputQty',{positive:true}),outputQty:num(b.outputQty,'outputQty',{positive:true}),
      wasteQty:optNum(b.wasteQty,'wasteQty',{min:0})??0};
    if(p.inputItemId===p.outputItemId)throw bad('input/output must be different items');
    if(Math.abs(Math.round((p.outputQty+p.wasteQty-p.inputQty)*10000))>1)throw bad('input mass must equal output plus recorded waste');
    const result=await runCommand(runtime,a.ctx,{key:idemKey(rc),type:'production_transform',payload:p},async(cc)=>{
      const itemRows=(await cc.client.query('SELECT id,base_uom,track_quantity FROM items WHERE id=ANY($1::uuid[])',
        [[p.inputItemId,p.outputItemId]])).rows;
      if(itemRows.length!==2||itemRows.some(x=>!x.track_quantity)||itemRows[0].base_uom!==itemRows[1].base_uom)
        throw bad('both items must track stock and use the same unit');
      const id=(await cc.client.query(`INSERT INTO production_orders (tenant_id,branch_id,type,command_id,allocation_method,total_input_cost,created_by)
         VALUES ($1,$2,'transform',$3,'actual',0,$4) RETURNING id`,[cc.tenantId,branchId,cc.commandId,cc.userId??null])).rows[0].id;
      const consumed=await consumeDirect(cc,{branchId,itemId:p.inputItemId,qty:p.inputQty,type:'production_consume',sourceType:'production_order',sourceId:id});
      const unitCost=Math.round(consumed.totalCost/p.outputQty*1e4)/1e4;
      await receiveStock(cc,{branchId,itemId:p.outputItemId,qty:p.outputQty,unitCost,type:'production_output',sourceType:'production_order',sourceId:id});
      await cc.client.query('UPDATE production_orders SET total_input_cost=$2 WHERE id=$1',[id,consumed.totalCost]);
      await cc.client.query(`INSERT INTO production_lines (tenant_id,production_order_id,kind,item_id,qty,unit_cost)
           VALUES ($1,$2,'input',$3,$4,$5),($1,$2,'output',$6,$7,$8)`,
        [cc.tenantId,id,p.inputItemId,p.inputQty,Math.round(consumed.totalCost/p.inputQty*1e4)/1e4,p.outputItemId,p.outputQty,unitCost]);
      if(p.wasteQty>0)await cc.client.query(`INSERT INTO production_lines (tenant_id,production_order_id,kind,item_id,qty,reason)
         VALUES ($1,$2,'waste',$3,$4,'processing_loss')`,[cc.tenantId,id,p.inputItemId,p.wasteQty]);
      await audit(cc.client,cc.tenantId,cc.userId,'production.transformed',{type:'production_order',id},undefined,p);
      return {id,totalInputCost:consumed.totalCost,unitCost};
    });
    return {status:201,body:result};
  });
  add('GET','/production/transforms','session',async(rc)=>{
    const a=await authorize(rc,'stock.view'),branchId=uuid(rc.query.get('branchId'),'branchId');
    a.assertBranch(branchId);
    const rows=(await withTenant(runtime,a.ctx,(c)=>c.query(
      "SELECT id,branch_id,total_input_cost,created_at FROM production_orders WHERE branch_id=$1 AND type='transform' ORDER BY created_at DESC LIMIT 100",
      [branchId]))).rows;
    return {body:{orders:rows}};
  });
}
