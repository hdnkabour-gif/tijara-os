import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where media FILES live: never in PostgreSQL, never in the container's ephemeral disk in production.
 * Driver "fs" writes under MEDIA_DIR, which must be a PERSISTENT volume (Railway Volume) in staging/production.
 * Without MEDIA_DIR in production the store is DISABLED: uploads are refused (503) instead of being lost at the next deploy.
 * Keys are 48 random hex characters (unguessable) and are the only file names ever used (no user input in paths).
 */
export interface MediaStore {
  enabled: boolean;
  reason?: string;
  put(key: string, data: Buffer): Promise<void>;
  open(key: string): { size: number; stream(start?: number, end?: number): fs.ReadStream } | null;
  remove(key: string): Promise<void>;
}
const KEY = /^[a-f0-9]{48}$/;
export const newKey = () => crypto.randomBytes(24).toString('hex');

export function fsStore(dir: string): MediaStore {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error('invalid media key');
    return path.join(dir, key.slice(0, 2), key);                // fan-out directory, no user-controlled path
  };
  return {
    enabled: true,
    async put(key, data) {
      const f = file(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(tmp, f);                            // atomic: a reader never sees a half-written file
    },
    open(key) {
      try {
        const f = file(key), st = fs.statSync(f);
        return { size: st.size, stream: (start, end) => fs.createReadStream(f, { start, end }) };
      } catch { return null; }
    },
    async remove(key) { await fs.promises.rm(file(key), { force: true }); },
  };
}

export function disabledStore(reason: string): MediaStore {
  const no = async () => { throw new Error(reason); };
  return { enabled: false, reason, put: no, open: () => null, remove: async () => {} };
}

/** MEDIA_DIR set: persistent fs store. Not set: a temporary dir in development/tests, DISABLED in production. */
export function mediaStoreFromEnv(production: boolean): MediaStore {
  const dir = process.env.MEDIA_DIR;
  if (dir) return fsStore(dir);
  if (production) return disabledStore('media storage is not configured (MEDIA_DIR on a persistent volume)');
  return fsStore(path.join(process.env.TMPDIR ?? '/tmp', 'tijara-media-dev'));
}
