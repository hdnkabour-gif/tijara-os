import crypto from 'node:crypto';
import type pg from 'pg';
import { Ctx, withTenant } from './db.js';
import { conflict } from './errors.js';

export interface CommandCtx {
  client: pg.PoolClient;
  tenantId: string;
  userId?: string;
  commandId: string;
  /** next movement sequence inside this command (unique per command) */
  nextSeq(): number;
  /** test-only fault injection point */
  fault(point: string): void;
}

export interface CommandSpec { key: string; type: string; payload: unknown; fault?: (point: string) => void }

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Business-command wrapper (design 5.6): one idempotency key per business command,
 * any number of ledger movements per command, all-or-nothing in one transaction.
 */
export async function runCommand<T>(
  pool: pg.Pool, ctx: Ctx, spec: CommandSpec, handler: (cc: CommandCtx) => Promise<T>,
): Promise<T> {
  const hash = crypto.createHash('sha256').update(spec.type + '|' + stableJson(spec.payload)).digest('hex');
  return withTenant(pool, ctx, async (client) => {
    const ins = await client.query(
      `INSERT INTO business_commands (tenant_id, idempotency_key, command_type, request_hash, created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
      [ctx.tenantId, spec.key, spec.type, hash, ctx.userId ?? null]);
    if (ins.rowCount === 0) {
      const ex = await client.query(
        `SELECT request_hash, status, result FROM business_commands WHERE idempotency_key = $1`, [spec.key]);
      const row = ex.rows[0];
      if (row.request_hash !== hash) throw conflict(`idempotency key reuse with a different request: ${spec.key}`);
      if (row.status === 'succeeded') return row.result as T;
      throw conflict(`command ${spec.key} is in progress`);
    }
    const commandId: string = ins.rows[0].id;
    let seq = 0;
    const cc: CommandCtx = {
      client, tenantId: ctx.tenantId, userId: ctx.userId, commandId,
      nextSeq: () => ++seq, fault: (p) => spec.fault?.(p),
    };
    const result = await handler(cc);
    await client.query(`UPDATE business_commands SET status='succeeded', result=$2 WHERE id=$1 AND tenant_id=$3`,
      [commandId, JSON.stringify(result ?? null), ctx.tenantId]);
    return result;
  });
}
