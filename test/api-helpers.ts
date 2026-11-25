import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/api.js';
import { hashPassword } from '../src/auth.js';
import { createUser } from '../src/tenancy.js';
import { owner, platform, runtime } from './helpers.js';

export const PW = 'Correct-Horse-9';
export interface Res { status: number; json: any; headers: Headers }

export async function startApp(production = false, media?: import('../src/mediastore.js').MediaStore) {
  const server = http.createServer(createApp({ runtime, platform, production, trustProxy: true, uiRoot: 'public', media }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, o: { token?: string; body?: unknown; raw?: string | Buffer; headers?: Record<string, string>; ip?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(256)}`, ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: string | Buffer | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] ??= 'application/json'; }
    const r = await fetch(base + path, { method, headers, body: body as any });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: r.status, json, headers: r.headers };
  };
  return { server, base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
export type Api = Awaited<ReturnType<typeof startApp>>;

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}${crypto.randomBytes(2).toString('hex')}`;

/** A platform administrator able to create shops via the API. */
export async function platformAdmin(api: Api) {
  const email = `admin.${uniq('p')}@test.local`;
  const id = await createUser(platform, email, 'Platform Admin', await hashPassword(PW));
  await owner.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [id]);
  const r = await api.call('POST', '/auth/login', { body: { email, password: PW } });
  return { id, email, token: r.json.token as string };
}

export interface Shop { tenantId: string; branchId: string; ownerEmail: string; ownerToken: string; slug: string }
export async function createShop(api: Api, admin: { token: string }, plan = 'pro', name = 'Shop', activities?: string[]): Promise<Shop> {
  const slug = uniq('shop').toLowerCase();
  const ownerEmail = `owner.${slug}@test.local`;
  const r = await api.call('POST', '/platform/tenants', { token: admin.token, body: { name, slug, plan, activities, owner: { email: ownerEmail, name: `Owner ${slug}`, password: PW } } });
  if (r.status !== 201) throw new Error(`createShop failed: ${r.status} ${JSON.stringify(r.json)}`);
  const l = await api.call('POST', '/auth/login', { body: { email: ownerEmail, password: PW } });
  return { tenantId: r.json.tenantId, branchId: r.json.branchId, ownerEmail, ownerToken: l.json.token, slug };
}
/** Owner creates a staff member and returns a token for them. */
export async function staff(api: Api, shop: Shop, roleName: string, branchIds: string[] = []) {
  const email = `${roleName}.${uniq('u')}@test.local`;
  const c = await api.call('POST', '/users', { token: shop.ownerToken, body: { email, name: roleName, password: PW, roleName, branchIds } });
  if (c.status !== 201) throw new Error(`staff failed: ${c.status} ${JSON.stringify(c.json)}`);
  const l = await api.call('POST', '/auth/login', { body: { email, password: PW } });
  return { email, userId: c.json.id as string, token: l.json.token as string };
}
export const key = () => crypto.randomUUID();
