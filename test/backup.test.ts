import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createShop, key, platformAdmin, startApp, uniq } from './api-helpers.js';

const host = process.env.PGHOST ?? '127.0.0.1', db = process.env.PGDATABASE ?? 'tijara_test';
const URL_ = `postgres://backup_admin:${process.env.BACKUP_PASSWORD ?? 'backup_dev_pw'}@${host}/${db}`;
const PASS = 'a-very-long-unit-test-passphrase-0123456789';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bk-'));
const run = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(path.resolve('scripts', script), args, { env: { ...process.env, ...env }, encoding: 'utf8' });
const runAsync = (script: string, env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn(path.resolve('scripts', script), [], { env: { ...process.env, ...env } }); let stdout = '', stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d)); c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const mkName = (d: Date) => `tijara-${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump.enc`;

describe('retention policy', () => {
  it('K1: keeps recent dailies, weekly and monthly representatives, never the newest 3, prunes the rest', () => {
    const NOW = Date.UTC(2026, 10, 20, 3, 0, 0) / 1000;
    const names: string[] = [];
    for (let d = 0; d < 60; d++) names.push(mkName(new Date((NOW - d * 86400 - 3600) * 1000)));          // 60 daily backups
    for (let m = 2; m < 18; m++) names.push(mkName(new Date(Date.UTC(2026, 10 - m, 1, 2, 0, 0))));        // monthly ones up to 17 months back
    const r = spawnSync(path.resolve('scripts/retention.sh'), [], { input: names.join('\n'), env: { ...process.env, NOW: String(NOW) }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const del = new Set(r.stdout.split('\n').filter(Boolean)), keep = names.filter((n) => !del.has(n));
    const ageDays = (n: string) => { const t = n.slice(7, 22); return (NOW * 1000 - Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15))) / 86400000; };
    expect(names.slice(0, 3).every((n) => keep.includes(n))).toBe(true);                                   // newest 3 untouchable
    expect(names.filter((n) => ageDays(n) < 7).every((n) => keep.includes(n))).toBe(true);                // last week: all kept
    for (let w = 1; w <= 4; w++) expect(keep.some((n) => ageDays(n) >= w * 7 && ageDays(n) < (w + 1) * 7), `week ${w}`).toBe(true);
    expect(names.filter((n) => ageDays(n) > 12 * 31).every((n) => del.has(n))).toBe(true);                // older than a year: pruned
    expect(del.size).toBeGreaterThan(30); expect(keep.length).toBeLessThan(35);                           // it actually prunes
  });
});

describe('backup job: verified, encrypted, alerting', () => {
  const restoreDb = `bk_restore_${uniq('r').toLowerCase()}`;
  afterAll(async () => { const c = new pg.Client({ host, database: 'postgres', user: 'backup_admin', password: 'backup_dev_pw' }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${restoreDb}`); await c.end(); });

  it('K2: produces an encrypted file + checksum; read-back verified; restore works; tampering and wrong passphrase are refused', async () => {
    const api = await startApp(); const adm = await platformAdmin(api);
    const s = await createShop(api, adm, 'pro', 'Backup K2', ['butcher']);
    const beef = (await api.call('GET', '/items', { token: s.ownerToken })).json.items.find((i: any) => i.sku === 'BUT-BOEUF').id;
    await api.call('POST', '/stock/receive', { token: s.ownerToken, headers: { 'idempotency-key': key() }, body: { branchId: s.branchId, itemId: beef, qty: 9, unitCost: 80 } });
    await api.close();

    const dest = path.join(tmp, 'ok');
    const r = run('backup-job.sh', [], { BACKUP_DATABASE_URL: URL_, BACKUP_PASSPHRASE: PASS, BACKUP_DEST: `file:${dest}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/backup ok: tijara-\d{8}T\d{6}Z\.dump\.enc/);
    // the outcome is recorded for the Control Center (what really happened, not a configuration flag)
    const rec = new pg.Client({ connectionString: URL_ }); await rec.connect();
    const lastEv = (await rec.query("SELECT ok, detail FROM platform_backup_events WHERE kind='backup' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(lastEv.ok).toBe(true);
    expect(lastEv.detail).toMatchObject({ dest: 'file', name: expect.stringMatching(/^tijara-.*\.dump\.enc$/) });
    expect(JSON.stringify(lastEv.detail)).not.toContain(PASS);
    await rec.end();
    expect(r.stdout + r.stderr).not.toContain(PASS);
    const files = readdirSync(dest), enc = files.find((f) => f.endsWith('.enc'))!;
    expect(files).toContain(`${enc}.sha256`);
    const raw = readFileSync(path.join(dest, enc));
    expect(raw.includes(Buffer.from('CREATE TABLE')) || raw.includes(Buffer.from('PGDMP')) || raw.includes(Buffer.from('stock_movements'))).toBe(false);   // ciphertext only

    // restore from the stored file into a fresh database; numbers match
    const root = new pg.Client({ host, database: 'postgres', user: 'backup_admin', password: 'backup_dev_pw' }); await root.connect();
    await root.query(`CREATE DATABASE ${restoreDb} OWNER app_owner`); await root.end();
    const rr = run('restore-from-backup.sh', [path.join(dest, enc), `postgres://backup_admin:backup_dev_pw@${host}/${restoreDb}`], { BACKUP_PASSPHRASE: PASS });
    expect(rr.status, rr.stderr).toBe(0); expect(rr.stdout).toContain('checksum ok');
    const q = async (d: string, sql: string) => { const c = new pg.Client({ host, database: d, user: 'backup_admin', password: 'backup_dev_pw' }); await c.connect(); const x = (await c.query(sql)).rows[0]; await c.end(); return x; };
    const cmp = `SELECT (SELECT count(*) FROM stock_movements)::int m, (SELECT count(*) FROM items)::int i, (SELECT count(*) FROM tenants)::int t`;
    expect(await q(restoreDb, cmp)).toEqual(await q(db, cmp));

    // tampered ciphertext: refused BEFORE anything is restored
    const bad = path.join(tmp, 'tampered.dump.enc'); const buf = Buffer.from(raw); buf[buf.length - 20] ^= 0xff; writeFileSync(bad, buf);
    writeFileSync(`${bad}.sha256`, readFileSync(path.join(dest, `${enc}.sha256`), 'utf8').replace(enc, 'tampered.dump.enc'));
    const t = run('restore-from-backup.sh', [bad, `postgres://backup_admin:backup_dev_pw@${host}/${restoreDb}`], { BACKUP_PASSPHRASE: PASS });
    expect(t.status).toBe(2); expect(t.stderr).toContain('REFUSING');
    // wrong passphrase: cannot decrypt
    const w = run('restore-from-backup.sh', [path.join(dest, enc), `postgres://backup_admin:backup_dev_pw@${host}/${restoreDb}`], { BACKUP_PASSPHRASE: 'x'.repeat(30) });
    expect(w.status).not.toBe(0);
  }, 120_000);

  it('K3: a failing backup alerts the webhook (no secrets in the alert) and exits non-zero; weak passphrase is refused', async () => {
    const got: string[] = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(b); res.end('ok'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const hook = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
    // 3 params: broken database, weak passphrase
    const a = await runAsync('backup-job.sh', { BACKUP_DATABASE_URL: `postgres://backup_admin:backup_dev_pw@${host}/does_not_exist_db`, BACKUP_PASSPHRASE: PASS, BACKUP_DEST: `file:${path.join(tmp, 'fail1')}`, ALERT_WEBHOOK_URL: hook });
    const b = await runAsync('backup-job.sh', { BACKUP_DATABASE_URL: URL_, BACKUP_PASSPHRASE: 'Weak9Qz', BACKUP_DEST: `file:${path.join(tmp, 'fail2')}`, ALERT_WEBHOOK_URL: hook });
    srv.close();
    expect(a.status).not.toBe(0); expect(b.status).not.toBe(0);
    // the weak-passphrase failure (database reachable) is recorded as a FAILED backup, without the passphrase
    const rec2 = new pg.Client({ connectionString: URL_ }); await rec2.connect();
    const failed = (await rec2.query("SELECT ok, detail FROM platform_backup_events WHERE kind='backup' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(failed.ok).toBe(false);
    expect(failed.detail.error).toMatch(/BACKUP_PASSPHRASE shorter/);
    expect(JSON.stringify(failed.detail)).not.toContain('Weak9Qz');
    await rec2.end();
    expect(got).toHaveLength(2);
    for (const body of got) { expect(JSON.parse(body).text).toMatch(/Tijara OS backup FAILED/); expect(body).not.toContain(PASS); expect(body).not.toContain('backup_dev_pw'); }
    expect(() => readdirSync(path.join(tmp, 'fail1')).filter((f) => f.endsWith('.enc'))).not.toThrow();
    expect(readdirSync(path.join(tmp, 'fail1')).filter((f) => f.endsWith('.enc'))).toHaveLength(0);     // nothing half-written is left as a "backup"
    void execFileSync;
  }, 60_000);
});
