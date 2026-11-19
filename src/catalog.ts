import type pg from 'pg';
import { validation } from './errors.js';

export interface ItemDef {
  sku: string; name: string; kind: 'goods' | 'service' | 'composite';
  trackQuantity: boolean; fulfillment: 'stock' | 'backflush' | 'none';
  batchTracking?: 'none' | 'optional' | 'required'; serialTracking?: boolean;
  baseUom?: string; price?: number; costPolicyId?: string | null; attributes?: Record<string, unknown>;
}

export async function createItem(client: pg.PoolClient, tenantId: string, d: ItemDef): Promise<string> {
  const r = await client.query(
    `INSERT INTO items (tenant_id, sku, name, kind, track_quantity, batch_tracking, serial_tracking,
        fulfillment, base_uom, price, cost_policy_id, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tenantId, d.sku, d.name, d.kind, d.trackQuantity, d.batchTracking ?? 'none', d.serialTracking ?? false,
     d.fulfillment, d.baseUom ?? 'unit', d.price ?? 0, d.costPolicyId ?? null, JSON.stringify(d.attributes ?? {})]);
  return r.rows[0].id;
}

export interface PolicyParams {
  selection: 'fefo' | 'fifo'; valuation: 'weighted_average' | 'batch_actual'; allocation: 'by_weight' | 'by_relative_value';
}

export async function createCostPolicy(client: pg.PoolClient, tenantId: string, name: string, p: PolicyParams) {
  const pol = await client.query(`INSERT INTO cost_policies (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tenantId, name]);
  const policyId: string = pol.rows[0].id;
  const versionId = await addPolicyVersion(client, tenantId, policyId, p);
  return { policyId, versionId };
}

/** New version applies to FUTURE operations only; old movements keep their version id (design 6). */
export async function addPolicyVersion(client: pg.PoolClient, tenantId: string, policyId: string, p: PolicyParams) {
  const v = await client.query(
    `INSERT INTO cost_policy_versions (tenant_id, policy_id, version, selection_rule, valuation_method, allocation_method)
     VALUES ($1,$2,(SELECT COALESCE(max(version),0)+1 FROM cost_policy_versions WHERE policy_id=$2),$3,$4,$5) RETURNING id`,
    [tenantId, policyId, p.selection, p.valuation, p.allocation]);
  return v.rows[0].id as string;
}

export interface PolicyVersion {
  id: string | null; selection_rule: 'fefo' | 'fifo'; valuation_method: 'weighted_average' | 'batch_actual';
  allocation_method: 'by_weight' | 'by_relative_value';
}
const DEFAULT_POLICY: PolicyVersion = {
  id: null, selection_rule: 'fefo', valuation_method: 'weighted_average', allocation_method: 'by_weight',
};

export async function currentPolicyVersion(client: pg.PoolClient, itemId: string): Promise<PolicyVersion> {
  const r = await client.query(
    `SELECT v.id, v.selection_rule, v.valuation_method, v.allocation_method
       FROM items i JOIN cost_policy_versions v ON v.policy_id = i.cost_policy_id AND v.tenant_id = i.tenant_id
      WHERE i.id = $1 ORDER BY v.version DESC LIMIT 1`, [itemId]);
  return r.rows[0] ?? DEFAULT_POLICY;
}

export async function getItem(client: pg.PoolClient, itemId: string) {
  const r = await client.query(`SELECT * FROM items WHERE id = $1`, [itemId]);
  if (!r.rows[0]) throw validation(`item not found: ${itemId}`);
  return r.rows[0];
}

export async function createRecipe(
  client: pg.PoolClient, tenantId: string, itemId: string,
  lines: { componentItemId: string; qtyPerUnit: number }[], expectedWastePct = 0,
): Promise<string> {
  const v = await client.query(
    `INSERT INTO recipe_versions (tenant_id, item_id, version, expected_waste_pct)
     VALUES ($1,$2,(SELECT COALESCE(max(version),0)+1 FROM recipe_versions WHERE item_id=$2),$3) RETURNING id`,
    [tenantId, itemId, expectedWastePct]);
  const id: string = v.rows[0].id;
  for (const l of lines) {
    await client.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_version_id, component_item_id, qty_per_unit) VALUES ($1,$2,$3,$4)`,
      [tenantId, id, l.componentItemId, l.qtyPerUnit]);
  }
  return id;
}

export async function activeRecipe(client: pg.PoolClient, itemId: string) {
  const v = await client.query(
    `SELECT id FROM recipe_versions WHERE item_id=$1 ORDER BY version DESC LIMIT 1`, [itemId]);
  if (!v.rows[0]) throw validation(`no recipe for item ${itemId}`);
  const l = await client.query(
    `SELECT component_item_id, qty_per_unit FROM recipe_lines WHERE recipe_version_id=$1`, [v.rows[0].id]);
  return { id: v.rows[0].id as string, lines: l.rows as { component_item_id: string; qty_per_unit: string }[] };
}
