import type { CommandCtx } from './commands.js';
import { invalidState, validation } from './errors.js';

export type PaymentIn = { method: 'cash' | 'card' | 'transfer'; amount: number };

export async function nextInvoiceNo(cc: CommandCtx): Promise<string> {
  const r = await cc.client.query(
    `INSERT INTO invoice_counters (tenant_id, series, last_no) VALUES ($1,'A',1)
     ON CONFLICT (tenant_id, series) DO UPDATE SET last_no = invoice_counters.last_no + 1 RETURNING last_no`, [cc.tenantId]);
  return `A-${String(r.rows[0].last_no).padStart(6, '0')}`;
}

export async function customerBalance(c: import('pg').PoolClient, customerId: string): Promise<number> {
  const r = await c.query(`SELECT COALESCE(sum(amount),0) AS b FROM receivable_entries WHERE customer_id=$1`, [customerId]);
  return Number(r.rows[0].b);
}

export async function invoicePaid(c: import('pg').PoolClient, invoiceId: string): Promise<number> {
  const r = await c.query(`SELECT COALESCE(sum(amount),0) AS p FROM payment_allocations WHERE invoice_id=$1`, [invoiceId]);
  return Number(r.rows[0].p);
}

async function addPayment(cc: CommandCtx, invoice: { id: string; customer_id: string | null }, pay: PaymentIn) {
  const p = await cc.client.query(
    `INSERT INTO payments (tenant_id, method, amount, customer_id, command_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [cc.tenantId, pay.method, pay.amount, invoice.customer_id, cc.commandId]);
  await cc.client.query(
    `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4)`,
    [cc.tenantId, p.rows[0].id, invoice.id, pay.amount]);
  if (invoice.customer_id) {
    await cc.client.query(
      `INSERT INTO receivable_entries (tenant_id, customer_id, invoice_id, payment_id, kind, amount) VALUES ($1,$2,$3,$4,'payment',$5)`,
      [cc.tenantId, invoice.customer_id, invoice.id, p.rows[0].id, -pay.amount]);
  }
  return p.rows[0].id as string;
}

/** Issue the invoice for a closed-out order and record the initial payments (full, partial or none -> credit). */
export async function issueInvoiceAndPay(cc: CommandCtx, order: { id: string; customer_id: string | null; total: string }, payments: PaymentIn[]) {
  const total = Number(order.total);
  const paid = Math.round(payments.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  if (payments.some((x) => x.amount <= 0)) throw validation('payment amounts must be positive');
  if (paid > total) throw validation(`payments ${paid} exceed invoice total ${total}`);
  const due = Math.round((total - paid) * 100) / 100;
  if (due > 0) {
    if (!order.customer_id) throw validation('unpaid balance requires an identified customer (credit sale)');
    const cust = (await cc.client.query(`SELECT credit_limit, active FROM customers WHERE id=$1 FOR UPDATE`, [order.customer_id])).rows[0];
    if (!cust?.active) throw invalidState('archived customer cannot purchase on credit');
    const bal = await customerBalance(cc.client, order.customer_id);
    if (bal + due > Number(cust.credit_limit)) throw invalidState(`credit limit exceeded (${bal + due} > ${cust.credit_limit})`);
  }
  const no = await nextInvoiceNo(cc);
  // Snapshot commercial identity at issuance, not print time: edits must not rewrite old invoices.
  const inv = await cc.client.query(
    `INSERT INTO invoices (tenant_id, order_id, invoice_no, customer_id, total, display_snapshot)
      SELECT o.tenant_id, o.id, $2, o.customer_id, $3,
        jsonb_build_object(
          'shop', jsonb_build_object('name', t.name, 'company', COALESCE(t.settings->'company','{}'::jsonb)),
          'branchName', b.name, 'customerName', cu.name, 'customerPhone', cu.phone)
      FROM sales_orders o
      JOIN tenants t ON t.id=o.tenant_id
      JOIN branches b ON b.tenant_id=o.tenant_id AND b.id=o.branch_id
      LEFT JOIN customers cu ON cu.tenant_id=o.tenant_id AND cu.id=o.customer_id
      WHERE o.tenant_id=$1 AND o.id=$4 RETURNING id`,
    [cc.tenantId, no, total, order.id]);
  if (!inv.rows.length) throw invalidState('order not found when issuing invoice');
  const invoice = { id: inv.rows[0].id as string, customer_id: order.customer_id };
  if (order.customer_id) {
    await cc.client.query(
      `INSERT INTO receivable_entries (tenant_id, customer_id, invoice_id, kind, amount) VALUES ($1,$2,$3,'charge',$4)`,
      [cc.tenantId, order.customer_id, invoice.id, total]);
  }
  for (const p of payments) await addPayment(cc, invoice, p);
  return { invoiceId: invoice.id, invoiceNo: no, total, paid, due };
}

/** Later collection against an existing invoice (partial payments / credit settlement). */
export async function collectPayment(cc: CommandCtx, p: { invoiceId: string; payment: PaymentIn }) {
  const inv = (await cc.client.query(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [p.invoiceId])).rows[0];
  if (!inv || inv.status !== 'issued') throw invalidState('invoice not payable');
  const due = Math.round((Number(inv.total) - (await invoicePaid(cc.client, inv.id))) * 100) / 100;
  if (p.payment.amount <= 0 || p.payment.amount > due) throw validation(`payment must be between 0 and the due amount ${due}`);
  await addPayment(cc, { id: inv.id, customer_id: inv.customer_id }, p.payment);
  return { due: Math.round((due - p.payment.amount) * 100) / 100 };
}

export async function refundInvoice(cc: CommandCtx, invoiceId: string) {
  const inv = (await cc.client.query(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
  if (!inv || inv.status !== 'issued') throw invalidState('invoice not refundable');
  const pays = await cc.client.query(
    `SELECT p.id, p.method, pa.amount FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id AND p.tenant_id = pa.tenant_id
      WHERE pa.invoice_id=$1 AND pa.amount > 0`, [invoiceId]);
  for (const p of pays.rows) {
    const rp = await cc.client.query(
      `INSERT INTO payments (tenant_id, method, amount, customer_id, command_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cc.tenantId, p.method, -Number(p.amount), inv.customer_id, cc.commandId]);
    await cc.client.query(
      `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4)`,
      [cc.tenantId, rp.rows[0].id, invoiceId, -Number(p.amount)]);
    if (inv.customer_id) {
      await cc.client.query(
        `INSERT INTO receivable_entries (tenant_id, customer_id, invoice_id, payment_id, kind, amount) VALUES ($1,$2,$3,$4,'payment',$5)`,
        [cc.tenantId, inv.customer_id, invoiceId, rp.rows[0].id, Number(p.amount)]);
    }
  }
  if (inv.customer_id) {
    await cc.client.query(
      `INSERT INTO receivable_entries (tenant_id, customer_id, invoice_id, kind, amount) VALUES ($1,$2,$3,'adjustment',$4)`,
      [cc.tenantId, inv.customer_id, invoiceId, -Number(inv.total)]);
  }
  await cc.client.query(`UPDATE invoices SET status='void' WHERE id=$1`, [invoiceId]);
}
