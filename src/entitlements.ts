/**
 * Issue #19 — one registry for the shop modules. What a member sees AND can call is
 *   plan feature (or platform override) ∩ module enabled by the shop ∩ role permission ∩ branch scope.
 * The activity chosen at creation only sets the starting default (SQL `module_default_enabled`, kept equal to
 * `activities` below by a test). 'core' (sales, stock, customers, invoices, team, settings) is always on.
 */
export type ModuleId = 'kitchen' | 'production' | 'workshop' | 'purchases' | 'cash' | 'orders' | 'online' | 'bookings' | 'delivery';
export interface ModuleDef {
  id: ModuleId;
  /** permissions that belong to the module (prefix match) */
  permPrefixes: string[];
  /** activities that switch it on by default; null = useful to every shop */
  activities: string[] | null;
  status: 'available' | 'planned';
}
export const MODULES: readonly ModuleDef[] = [
  { id: 'kitchen', permPrefixes: ['kitchen.'], activities: ['grill', 'restaurant'], status: 'available' },
  { id: 'production', permPrefixes: ['production.'], activities: ['butcher', 'grill'], status: 'available' },
  { id: 'workshop', permPrefixes: ['workshop.'], activities: ['mechanic'], status: 'available' },
  { id: 'orders', permPrefixes: ['orders.'], activities: ['butcher', 'grill', 'restaurant', 'grocery'], status: 'available' },
  { id: 'online', permPrefixes: [], activities: ['butcher', 'grill', 'restaurant', 'grocery'], status: 'available' },
  { id: 'purchases', permPrefixes: ['purchases.'], activities: null, status: 'available' },
  { id: 'cash', permPrefixes: ['cash.'], activities: null, status: 'available' },
  { id: 'bookings', permPrefixes: ['bookings.'], activities: null, status: 'planned' },
  { id: 'delivery', permPrefixes: ['delivery.'], activities: null, status: 'planned' },
];
export const MODULE_IDS = MODULES.map((m) => m.id);
/** modules the platform can allow/block per shop (plan features and overrides) */
export const PLATFORM_FEATURES = MODULE_IDS as readonly string[];

export function moduleOf(perm: string): ModuleId | 'core' {
  return MODULES.find((m) => m.permPrefixes.some((p) => perm.startsWith(p)))?.id ?? 'core';
}

/** The platform side: the plan includes it, unless the platform overrode it for this shop. */
export function platformAllows(planFeatures: unknown, overrides: Record<string, unknown> | null | undefined, id: string) {
  const o = overrides?.[id];
  return typeof o === 'boolean' ? o : Array.isArray(planFeatures) && planFeatures.includes(id);
}

export interface ModuleState { id: ModuleId; status: ModuleDef['status']; platformAllowed: boolean; shopEnabled: boolean; effective: boolean }
export function moduleStates(planFeatures: unknown, overrides: Record<string, unknown> | null | undefined, shopOff: string[]): ModuleState[] {
  return MODULES.map((m) => {
    const platformAllowed = platformAllows(planFeatures, overrides, m.id), shopEnabled = !shopOff.includes(m.id);
    return { id: m.id, status: m.status, platformAllowed, shopEnabled, effective: m.status === 'available' && platformAllowed && shopEnabled };
  });
}
export const effectiveSet = (states: ModuleState[]) => new Set<string>(states.filter((s) => s.effective).map((s) => s.id));
export const permAllowed = (eff: Set<string>, perm: string) => { const m = moduleOf(perm); return m === 'core' || eff.has(m); };

/** SQL fragment columns used by every check (plan features, overrides, modules switched off by the shop). */
export const ENTITLEMENT_SQL = `p.features AS plan_features, COALESCE(q.feature_overrides,'{}'::jsonb) AS feature_overrides,
  COALESCE((SELECT array_agg(tm.module) FROM tenant_modules tm WHERE tm.tenant_id=t.id AND NOT tm.enabled),'{}') AS shop_off`;

/** Effective modules of a shop, read inside its RLS context (for checks that are not tied to a permission). */
export async function shopModules(c: { query: (q: string, v: unknown[]) => Promise<{ rows: any[] }> }, tenantId: string) {
  const r = (await c.query(`SELECT ${ENTITLEMENT_SQL} FROM tenants t JOIN plans p ON p.id=t.plan_id
      LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=$1`, [tenantId])).rows[0];
  return r ? effectiveSet(moduleStates(r.plan_features, r.feature_overrides, r.shop_off)) : new Set<string>();
}
