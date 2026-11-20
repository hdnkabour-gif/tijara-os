import crypto from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/bootstrap.js';
import { consumeReset } from '../src/auth.js';
import { startApp, uniq } from './api-helpers.js';
import { owner, runtime } from './helpers.js';

// app_owner owns these tables (RLS not forced on them) so it stands in for the privileged migration job
async function withOwnerClient<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ host: '127.0.0.1', database: process.env.PGDATABASE ?? 'tijara_test', user: 'app_owner', password: process.env.APP_OWNER_PASSWORD ?? 'owner_dev_pw' });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const newInvite = () => crypto.randomBytes(32).toString('base64url');

describe('platform admin bootstrap', () => {
  it('B1: the invitation secret is supplied by the operator, never logged, stored only as a hash; single use; no-op afterwards', async () => {
    await owner.query('DELETE FROM platform_admins');
    const email = `boot.${uniq('b')}@test.local`, invite = newInvite();
    const logs: string[] = [];
    expect(await withOwnerClient((c) => bootstrapAdmin(c, email, invite, (m) => logs.push(m)))).toBe(true);
    expect(logs.join('\n')).not.toContain(invite);                       // the secret never reaches any log line
    expect(logs.join('\n')).not.toContain(email);                        // nor the address
    expect((await owner.query('SELECT password_hash FROM users WHERE email=$1', [email])).rows[0].password_hash).toBeNull();
    expect((await owner.query('SELECT 1 FROM password_resets WHERE token_hash=$1', [invite])).rowCount).toBe(0);   // only the hash is stored
    expect((await owner.query('SELECT 1 FROM password_resets WHERE token_hash=$1', [crypto.createHash('sha256').update(invite).digest('hex')])).rowCount).toBe(1);

    const api = await startApp();
    expect((await api.call('POST', '/auth/login', { body: { email, password: 'Anything-Goes-1' } })).status).toBe(401);
    await consumeReset(runtime, invite, 'Chosen-By-Admin-77');
    const l = await api.call('POST', '/auth/login', { body: { email, password: 'Chosen-By-Admin-77' } });
    expect(l.status).toBe(200);
    expect((await api.call('GET', '/me', { token: l.json.token })).json.isPlatformAdmin).toBe(true);
    await expect(consumeReset(runtime, invite, 'Second-Try-Password-1')).rejects.toThrow();                       // single use
    expect(await withOwnerClient((c) => bootstrapAdmin(c, `o.${uniq('o')}@test.local`, newInvite(), () => {}))).toBe(false);
    expect((await owner.query('SELECT count(*)::int n FROM platform_admins')).rows[0].n).toBe(1);
    await api.close();
  });

  it('B2: expired invitations are refused; weak/invalid secrets and emails are rejected before anything is written', async () => {
    await owner.query('DELETE FROM platform_admins');
    const email = `boot2.${uniq('b')}@test.local`, invite = newInvite();
    await withOwnerClient((c) => bootstrapAdmin(c, email, invite, () => {}));
    await owner.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);
    await expect(consumeReset(runtime, invite, 'Chosen-By-Admin-77')).rejects.toThrow();
    await owner.query('DELETE FROM platform_admins');
    await expect(withOwnerClient((c) => bootstrapAdmin(c, 'not-an-email', newInvite(), () => {}))).rejects.toThrow(/valid email/);
    await expect(withOwnerClient((c) => bootstrapAdmin(c, email, 'short', () => {}))).rejects.toThrow(/32-128/);
    await expect(withOwnerClient((c) => bootstrapAdmin(c, email, 'has spaces and is long enough to pass the length check xx', () => {}))).rejects.toThrow(/32-128/);
    expect((await owner.query('SELECT count(*)::int n FROM platform_admins')).rows[0].n).toBe(0);
  });
});
