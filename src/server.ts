import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { createApp } from './api.js';
import { makePool } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const production = process.env.APP_ENV === 'production';
// Version = exact git commit: env (GitHub-triggered deploys) or the VERSION file stamped into the build context by the upload script.
const stamped = (() => { try { return readFileSync('VERSION', 'utf8').trim(); } catch { return ''; } })();
const version = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.APP_VERSION || stamped || 'dev').slice(0, 7);

const app = createApp({
  runtime: makePool('runtime', 10), platform: makePool('platform', 3),
  uiRoot: process.env.UI_ROOT ?? 'public', production, trustProxy: process.env.TRUST_PROXY === 'true', version,
  expectedMigrations: readdirSync(process.env.MIGRATIONS_DIR ?? 'db/migrations').filter((f) => f.endsWith('.sql')).sort(),
});
http.createServer(app).listen(port, () => console.log(`tijara-os listening on :${port} (${version})`));
