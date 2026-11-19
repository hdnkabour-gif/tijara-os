import { readdirSync } from 'node:fs';
import http from 'node:http';
import { createApp } from './api.js';
import { makePool } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const production = process.env.APP_ENV === 'production';
const version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? 'dev';

const app = createApp({
  runtime: makePool('runtime', 10), platform: makePool('platform', 3),
  production, trustProxy: process.env.TRUST_PROXY === 'true', version,
  expectedMigrations: readdirSync(process.env.MIGRATIONS_DIR ?? 'db/migrations').filter((f) => f.endsWith('.sql')).sort(),
});
http.createServer(app).listen(port, () => console.log(`tijara-os listening on :${port} (${version})`));
