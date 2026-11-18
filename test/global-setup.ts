import { readFileSync } from 'node:fs';
import { makePool } from '../src/db.js';

/** Fresh schema on every test run: drop, recreate and apply migrations as app_owner. */
export default async function setup() {
  const owner = makePool('owner', 1);
  try {
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('CREATE SCHEMA public');
    await owner.query(readFileSync(new URL('../db/migrations/001_schema.sql', import.meta.url), 'utf8'));
  } finally {
    await owner.end();
  }
}
