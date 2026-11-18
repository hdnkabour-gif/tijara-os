import type pg from 'pg';

export async function audit(
  client: pg.PoolClient, tenantId: string, actorId: string | undefined, action: string,
  ref?: { type: string; id: string }, before?: unknown, after?: unknown, meta?: unknown,
) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, ref_type, ref_id, before, after, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, actorId ?? null, action, ref?.type ?? null, ref?.id ?? null,
     before === undefined ? null : JSON.stringify(before),
     after === undefined ? null : JSON.stringify(after),
     meta === undefined ? null : JSON.stringify(meta)]);
}
