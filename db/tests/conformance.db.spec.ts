import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkTenantTables, type ConformanceRule } from '../../tooling/migrate/src/conformance';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { assertTestSchema, dbConfig, ROOT, testSchemaSql, withClient } from './helpers';

// T10/T11 (STAGE-03-PLAN.md §3.6): the RLS conformance check accepts the template, accepts the
// real app schema, and rejects each kind of non-conforming table. Fixtures live in temporary
// zz_test_* schemas in pbe_test and are dropped afterwards, even on failure.

const TEMPLATE = fs.readFileSync(path.join(ROOT, 'db', 'templates', 'tenant-table.sql'), 'utf8');
const created: string[] = [];

async function fixture(extraSql: (s: string) => string = () => ''): Promise<string> {
  const s = assertTestSchema(`zz_test_${randomBytes(5).toString('hex')}`);
  created.push(s);
  await testSchemaSql(s, `CREATE SCHEMA ${s}`);
  await testSchemaSql(s, TEMPLATE.replaceAll('{schema}', s));
  const extra = extraSql(s);
  if (extra) await testSchemaSql(s, extra);
  return s;
}

const check = (schema: string) =>
  withClient(dbConfig('migrator'), (c) => checkTenantTables(c, schema));
const rules = async (schema: string): Promise<ConformanceRule[]> =>
  [...new Set((await check(schema)).map((v) => v.rule))].sort();

beforeAll(async () => {
  await migrate({ connection: dbConfig('migrator'), migrationsDir: migrationsDir(ROOT) });
});
afterAll(async () => {
  for (const s of created) await testSchemaSql(s, `DROP SCHEMA IF EXISTS ${s} CASCADE`);
});

describe('RLS conformance check', () => {
  it('T10: the real app schema conforms (no tables yet, so nothing can be wrong)', async () => {
    expect(await check('app')).toEqual([]);
  });

  it('T10: tables built from db/templates/tenant-table.sql conform', async () => {
    expect(await check(await fixture())).toEqual([]);
  });

  it.each<[string, (s: string) => string, ConformanceRule[]]>([
    [
      'a table without tenant_id',
      (s) => `CREATE TABLE ${s}.loose (id uuid PRIMARY KEY);
              ALTER TABLE ${s}.loose ENABLE ROW LEVEL SECURITY; ALTER TABLE ${s}.loose FORCE ROW LEVEL SECURITY;`,
      ['tenant_id_column', 'tenant_policy'],
    ],
    [
      'a nullable tenant_id',
      (s) => `ALTER TABLE ${s}.scenario DROP CONSTRAINT scenario_pkey;
              ALTER TABLE ${s}.scenario ADD COLUMN zz int; ALTER TABLE ${s}.scenario ALTER COLUMN tenant_id DROP NOT NULL;`,
      ['tenant_id_column'],
    ],
    [
      'row-level security switched off',
      (s) => `ALTER TABLE ${s}.project DISABLE ROW LEVEL SECURITY`,
      ['rls_enabled'],
    ],
    [
      'row-level security not forced',
      (s) => `ALTER TABLE ${s}.project NO FORCE ROW LEVEL SECURITY`,
      ['rls_forced'],
    ],
    [
      'the tenant policy removed',
      (s) => `DROP POLICY tenant_isolation ON ${s}.project`,
      ['tenant_policy'],
    ],
    [
      'a policy that ignores the tenant',
      (s) => `DROP POLICY tenant_isolation ON ${s}.project;
              CREATE POLICY open_door ON ${s}.project FOR ALL TO pbe_app USING (true) WITH CHECK (true);`,
      ['tenant_policy'],
    ],
    [
      'no foreign key to platform.tenant',
      (s) => `ALTER TABLE ${s}.project DROP CONSTRAINT project_tenant_id_fkey`,
      ['tenant_fk'],
    ],
    [
      'a foreign key that leaves out tenant_id',
      (s) => `ALTER TABLE ${s}.project ADD CONSTRAINT project_id_key UNIQUE (id);
              ALTER TABLE ${s}.scenario DROP CONSTRAINT scenario_tenant_id_project_id_fkey;
              ALTER TABLE ${s}.scenario ADD CONSTRAINT scenario_project_only_fkey
                FOREIGN KEY (project_id) REFERENCES ${s}.project (id);`,
      ['composite_fk'],
    ],
    [
      'TRUNCATE granted to pbe_app',
      (s) => `GRANT TRUNCATE ON ${s}.project TO pbe_app`,
      ['no_truncate'],
    ],
    [
      'privileges granted to PUBLIC',
      (s) => `GRANT SELECT ON ${s}.project TO PUBLIC`,
      ['no_public_access'],
    ],
  ])('T11: rejects %s', async (_label, breakIt, expected) => {
    const s = await fixture(breakIt);
    const found = await rules(s);
    expect(found).toEqual(expected);
  });
});
