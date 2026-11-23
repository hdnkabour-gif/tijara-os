import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// allowed module dependencies (design section 13); enforced mechanically
const ALLOWED: Record<string, string[]> = {
  errors: [], db: [], audit: [],
  auth: [], http: [],
  api: ['auth', 'audit', 'commands', 'catalog', 'db', 'errors', 'inventory', 'tenancy', 'sales', 'http', 'templates', 'static', 'permissions', 'admin', 'kit'],
  static: [],
  permissions: [],
  admin: ['audit', 'auth', 'db', 'errors', 'http', 'kit', 'permissions'],
  kit: ['auth', 'db'],
  server: ['api', 'db'], migrate: ['bootstrap'], bootstrap: [],           // entrypoints: no business-module dependencies
  commands: ['db', 'errors'],
  tenancy: ['db', 'catalog', 'templates'],
  templates: ['catalog'],
  catalog: ['errors'],
  inventory: ['commands', 'catalog', 'errors'],
  production: ['commands', 'catalog', 'inventory', 'errors'],
  approvals: ['audit', 'errors', 'tenancy'],
  payments: ['commands', 'errors'],
  sales: ['commands', 'catalog', 'inventory', 'errors', 'approvals', 'payments', 'audit'],
};
const imports = (name: string) =>
  [...readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]);

describe('module boundaries', () => {
  const files = readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => f.replace('.ts', ''));
  it('every source module is declared and imports only what the architecture allows', () => {
    expect(files.sort()).toEqual(Object.keys(ALLOWED).sort());
    for (const f of files) {
      const bad = [...new Set(imports(f))].filter((d) => !ALLOWED[f].includes(d));
      expect(bad, `${f} imports forbidden ${bad.join(',')}`).toEqual([]);
    }
  });
  it('inventory never depends on sales/payments/production; there are no import cycles', () => {
    for (const forbidden of ['sales', 'payments', 'production', 'approvals']) expect(imports('inventory')).not.toContain(forbidden);
    const seen = new Set<string>(), stack = new Set<string>();
    const visit = (n: string) => {
      expect(stack.has(n), `cycle through ${n}`).toBe(false);
      if (seen.has(n)) return;
      seen.add(n); stack.add(n);
      for (const d of imports(n)) visit(d);
      stack.delete(n);
    };
    files.forEach(visit);
  });
});
