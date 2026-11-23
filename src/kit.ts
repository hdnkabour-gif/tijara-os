import type http from 'node:http';
import type pg from 'pg';
import type { SessionInfo } from './auth.js';
import type { Ctx } from './db.js';

/** Shared request types so route modules never import the main API module (no cycles). */
export interface Rc {
  req: http.IncomingMessage; body: any; query: URLSearchParams; params: Record<string, string>;
  token: string | null; session: SessionInfo | null; ip: string; viaCookie: boolean;
}
export type Handler = (rc: Rc) => Promise<{ status?: number; body: unknown; headers?: Record<string, string | string[]> }>;
export interface Authz {
  ctx: Ctx & { userId: string }; branchIds: string[]; permissions: string[]; roleName: string;
  assertBranch(branchId: string): void;
}
export interface Kit {
  add(method: string, path: string, auth: 'public' | 'session', handler: Handler): void;
  authorize(rc: Rc, perm: string): Promise<Authz>;
  idemKey(rc: Rc): string;
  runtime: pg.Pool; platform: pg.Pool;
}
