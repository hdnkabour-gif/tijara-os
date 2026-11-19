import { readdirSync, readFileSync } from 'node:fs';
import { makePool } from '../src/db.js';

/** Fresh schema on every test run: drop, recreate and apply migrations as app_owner. */
export default async function setup() {
  const owner = makePool('owner', 1);
  try {
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('CREATE SCHEMA public');
    const dir = new URL('../db/migrations/', import.meta.url);
    await owner.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await owner.query(readFileSync(new URL(f, dir), 'utf8'));
      await owner.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    }
  } finally {
    await owner.end();
  }
}
