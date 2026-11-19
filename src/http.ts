import type http from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const bad = (m: string) => new HttpError(400, 'VALIDATION', m);

const MAX_BODY = 100_000;
export async function readJson(req: http.IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const ct = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0, tooLarge = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      tooLarge = true;                                   // keep draining (discarding) so the client can read our 413
      if (size > 5_000_000) { req.destroy(); break; }    // but never absorb unbounded uploads
      continue;
    }
    chunks.push(c as Buffer);
  }
  if (tooLarge) throw new HttpError(413, 'TOO_LARGE', 'request body too large');
  if (size === 0) return {};
  if (!String(ct).startsWith('application/json')) throw new HttpError(415, 'UNSUPPORTED', 'content-type must be application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('invalid JSON'); }
}

export function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  });
  res.end(JSON.stringify(body));
}

// ── validators ──
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuid = (v: unknown, name: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(`${name} must be a UUID`); return v; };
export const optUuid = (v: unknown, name: string) => (v == null ? undefined : uuid(v, name));
export const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${name} is required (max ${max} chars)`);
  return v.trim();
};
export const optStr = (v: unknown, name: string, max = 200) => (v == null ? undefined : str(v, name, max));
export const num = (v: unknown, name: string, o: { min?: number; positive?: boolean } = {}): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${name} must be a number`);
  if (o.positive && v <= 0) throw bad(`${name} must be > 0`);
  if (o.min != null && v < o.min) throw bad(`${name} must be >= ${o.min}`);
  if (v > 1e9) throw bad(`${name} is too large`);
  return v;
};
export const optNum = (v: unknown, name: string, o: { min?: number; positive?: boolean } = {}) => (v == null ? undefined : num(v, name, o));
export const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw bad(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
};
export const arr = (v: unknown, name: string, max = 100): any[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw bad(`${name} must be a non-empty array (max ${max})`);
  return v;
};
export const email = (v: unknown): string => {
  const s = str(v, 'email', 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('invalid email');
  return s;
};

/** tiny in-memory sliding-window limiter (per process; a shared store is needed once we scale out) */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits = new Map();
    return true;
  }
}
