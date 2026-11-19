import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { bootstrapAdmin } from '../src/bootstrap.js';
import { consumeReset } from '../src/auth.js';
import { startApp, PW, uniq } from './api-helpers.js';
import { owner, runtime } from './helpers.js';

// app_owner owns these tables (RLS not forced on them) so it stands in for the privileged migration job
async function withOwnerClient<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ host: '127.0.0.1', database: process.env.PGDATABASE ?? 'tijara_test', user: 'app_owner', password: process.env.APP_OWNER_PASSWORD ?? 'owner_dev_pw' });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

describe('platform admin bootstrap', () => {
  it('B1: issues a one-time invitation without any password; works exactly once; is a no-op afterwards', async () => {
    await owner.query('DELETE FROM platform_admins');                   // isolate from admins created by other test files
    const email = `boot.${uniq('b')}@test.local`;
    const logs: string[] = [];
    const token = await withOwnerClient((c) => bootstrapAdmin(c, email, (m) => logs.push(m)));
    expect(token).toMatch(/^tj_/);
    const u = (await owner.query('SELECT password_hash FROM users WHERE email=$1', [email])).rows[0];
    expect(u.password_hash).toBeNull();                                  // no password exists anywhere
    expect((await owner.query('SELECT 1 FROM password_resets WHERE token_hash=$1', [token])).rowCount).toBe(0);   // only the hash is stored
    expect(logs.join(' ')).toContain('single use');

    const api = await startApp();
    expect((await api.call('POST', '/auth/login', { body: { email, password: PW } })).status).toBe(401);          // cannot log in yet
    await consumeReset(runtime, token!, 'Chosen-By-Admin-77');
    const l = await api.call('POST', '/auth/login', { body: { email, password: 'Chosen-By-Admin-77' } });
    expect(l.status).toBe(200);
    expect((await api.call('GET', '/me', { token: l.json.token })).json.isPlatformAdmin).toBe(true);
    await expect(consumeReset(runtime, token!, 'Second-Try-Password-1')).rejects.toThrow();                      // single use

    expect(await withOwnerClient((c) => bootstrapAdmin(c, `other.${uniq('o')}@test.local`, () => {}))).toBeNull();  // admin exists -> no-op
    expect((await owner.query('SELECT count(*)::int n FROM platform_admins')).rows[0].n).toBe(1);
    await api.close();
  });

  it('B2: an expired invitation cannot be used and bad emails are rejected', async () => {
    await owner.query('DELETE FROM platform_admins');
    const email = `boot2.${uniq('b')}@test.local`;
    const token = await withOwnerClient((c) => bootstrapAdmin(c, email, () => {}));
    await owner.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);
    await expect(consumeReset(runtime, token!, 'Chosen-By-Admin-77')).rejects.toThrow();
    await owner.query('DELETE FROM platform_admins');
    await expect(withOwnerClient((c) => bootstrapAdmin(c, 'not-an-email', () => {}))).rejects.toThrow(/valid email/);
  });
});
