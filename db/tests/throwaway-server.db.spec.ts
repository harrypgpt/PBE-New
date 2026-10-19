import { randomBytes } from 'node:crypto';
import { SCHEMA_VERSIONS } from '../../apps/api/src/modules/db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { checkTenantTables } from '../../tooling/migrate/src/conformance';
import { migrate, status } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ROOT, ThrowawayCluster, withClient } from './helpers';

// Everything in this file runs against a PRIVATE, throw-away PostgreSQL 18 instance created in a
// temporary folder (socket only, no TCP) and deleted afterwards. The real local server is never
// touched: no superuser credentials for it are used or needed.

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-throwaway-'));
const BOOTSTRAP = path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql');
const TEARDOWN = path.join(ROOT, 'db', 'bootstrap', 'teardown-local.sql');

beforeAll(() => {
  cluster = ThrowawayCluster.start();
}, 120_000);
afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function databases(): Promise<string[]> {
  const res = await cluster.sql(
    "SELECT datname FROM pg_catalog.pg_database WHERE datname NOT LIKE 'template%' ORDER BY 1",
  );
  return res.rows.map((r) => r.datname as string);
}
async function pbeRoles(): Promise<string[]> {
  const res = await cluster.sql(
    "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'pbe\\_%' ORDER BY 1",
  );
  return res.rows.map((r) => r.rolname as string);
}

describe('runner refuses over-privileged sessions (real superuser on a throw-away server)', () => {
  it('the connected role really is a superuser (test precondition)', async () => {
    const res = await cluster.sql(
      'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user',
    );
    expect(res.rows[0].rolsuper).toBe(true);
  });

  it('migrate refuses a superuser with UNSAFE_SESSION and creates nothing', async () => {
    const options = {
      connection: cluster.config(cluster.admin),
      migrationsDir: migrationsDir(ROOT),
    };
    await expect(migrate(options)).rejects.toMatchObject({ code: 'UNSAFE_SESSION' });
    await expect(status(options)).rejects.toMatchObject({ code: 'UNSAFE_SESSION' });
    const res = await cluster.sql(
      "SELECT pg_catalog.to_regnamespace('pbe_meta') IS NULL AS absent",
    );
    expect(res.rows[0].absent).toBe(true);
  });

  it('migrate refuses a non-superuser that has BYPASSRLS', async () => {
    await cluster.sql('CREATE ROLE rls_bypasser LOGIN BYPASSRLS');
    await expect(
      migrate({
        connection: cluster.config('rls_bypasser'),
        migrationsDir: migrationsDir(ROOT),
        ownerRole: null,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_SESSION' });
  });

  it('control: an ordinary role is accepted, so the refusals above are specific', async () => {
    await cluster.sql('CREATE ROLE plain_user LOGIN');
    await cluster.sql('CREATE DATABASE plain_db OWNER plain_user');
    const dir = fs.mkdtempSync(path.join(tmp, 'mig-'));
    fs.writeFileSync(
      path.join(dir, '0001_a.sql'),
      '-- pbe:phase expand\nCREATE SCHEMA control_ok;\n',
    );
    const result = await migrate({
      connection: cluster.config('plain_user', 'plain_db'),
      migrationsDir: dir,
      ownerRole: null,
    });
    expect(result.applied.map((a) => a.version)).toEqual([1]);
  });
});

describe('bootstrap and teardown scripts (only ever run on the throw-away server)', () => {
  const verifiers = () => bootstrapCredentials().env;
  const disposable = `pbe_restore_check_${randomBytes(5).toString('hex')}`;

  it('bootstrap creates the roles and both databases, and is safe to run twice', async () => {
    const first = cluster.psqlFile(BOOTSTRAP, verifiers());
    expect(first.status).toBe(0);
    const second = cluster.psqlFile(BOOTSTRAP, verifiers());
    expect(second.status).toBe(0);
    expect(await pbeRoles()).toEqual([
      'pbe_app',
      'pbe_backup',
      'pbe_migrator',
      'pbe_owner',
      'pbe_restore_drill',
    ]);
    expect(await databases()).toEqual(expect.arrayContaining(['pbe_dev', 'pbe_test']));
    const res = await cluster.sql(
      "SELECT rolname, rolsuper, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname LIKE 'pbe\\_%' ORDER BY 1",
    );
    expect(res.rows).toEqual([
      {
        rolname: 'pbe_app',
        rolsuper: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: true,
      },
      {
        // The ONLY PBE role with BYPASSRLS (Stage 7A backup design v2).
        rolname: 'pbe_backup',
        rolsuper: false,
        rolcreatedb: false,
        rolbypassrls: true,
        rolcanlogin: true,
      },
      {
        rolname: 'pbe_migrator',
        rolsuper: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: true,
      },
      {
        rolname: 'pbe_owner',
        rolsuper: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: false,
      },
      {
        rolname: 'pbe_restore_drill',
        rolsuper: false,
        rolcreatedb: true,
        rolbypassrls: false,
        rolcanlogin: true,
      },
    ]);
  });

  it('a second bootstrap leaves existing data in pbe_dev untouched', async () => {
    await cluster.sql('CREATE TABLE public.keep_me (v text)', [], 'pbe_dev');
    await cluster.sql("INSERT INTO public.keep_me VALUES ('still here')", [], 'pbe_dev');
    expect(cluster.psqlFile(BOOTSTRAP, verifiers()).status).toBe(0);
    const res = await cluster.sql('SELECT v FROM public.keep_me', [], 'pbe_dev');
    expect(res.rows).toEqual([{ v: 'still here' }]);
  });

  it('PostgreSQL itself limits the restore role: it can create and drop its own database, never pbe_dev or pbe_test', async () => {
    const asRestore = (sql: string, db = 'pbe_test') =>
      withClient(cluster.config('pbe_restore_drill', db), (c) => c.query(sql));
    const own = `pbe_restore_check_${randomBytes(5).toString('hex')}`;
    await asRestore(`CREATE DATABASE ${own}`);
    await expect(asRestore('DROP DATABASE pbe_dev')).rejects.toMatchObject({ code: '42501' });
    await expect(asRestore('DROP DATABASE pbe_test', own)).rejects.toMatchObject({ code: '42501' });
    await expect(asRestore('SELECT 1', 'pbe_dev')).rejects.toMatchObject({ code: '42501' });
    await expect(asRestore('SET ROLE pbe_owner')).rejects.toMatchObject({ code: '42501' });
    await asRestore(`DROP DATABASE ${own}`);
    expect(await databases()).toEqual(expect.arrayContaining(['pbe_dev', 'pbe_test']));
    expect(await databases()).not.toContain(own);
  });

  it('pbe_migrator cannot create databases, not even by acting as pbe_owner', async () => {
    const asMigrator = (sql: string) =>
      withClient(cluster.config('pbe_migrator', 'pbe_test'), async (c) => {
        await c.query('SET ROLE pbe_owner');
        return c.query(sql);
      });
    await expect(asMigrator('CREATE DATABASE pbe_restore_check_0123456789')).rejects.toMatchObject({
      code: '42501',
    });
  });

  describe('Stage 3 controls: real migrations and a template table on the throw-away server', () => {
    const FX = 'zz_test_control';
    const appAs = (user: string, statement: string, setup: string[] = []) =>
      withClient(cluster.config(user, 'pbe_test'), async (c) => {
        for (const s of setup) await c.query(s);
        return c.query(statement);
      });

    beforeAll(async () => {
      // Real migrations (0001, 0002) applied by the real runner as pbe_migrator.
      const result = await migrate({
        connection: cluster.config('pbe_migrator', 'pbe_test'),
        migrationsDir: migrationsDir(ROOT),
      });
      expect(result.applied.map((a) => a.version)).toEqual([...SCHEMA_VERSIONS]);
      const template = fs.readFileSync(
        path.join(ROOT, 'db', 'templates', 'tenant-table.sql'),
        'utf8',
      );
      await cluster.sql(`CREATE SCHEMA ${FX} AUTHORIZATION pbe_owner`, [], 'pbe_test');
      await cluster.sql(`GRANT USAGE ON SCHEMA ${FX} TO pbe_app`, [], 'pbe_test');
      await cluster.sql(
        `SET ROLE pbe_owner; ${template.replaceAll('{schema}', FX)}`,
        [],
        'pbe_test',
      );
      // Superuser seeds two fictional tenants (a superuser is not subject to RLS).
      await cluster.sql(
        `WITH t AS (INSERT INTO platform.tenant (slug, display_name)
                    VALUES ('zz-control-a', 'Control A'), ('zz-control-b', 'Control B') RETURNING id)
         INSERT INTO ${FX}.project (tenant_id, name) SELECT id, 'row' FROM t`,
        [],
        'pbe_test',
      );
    }, 120_000);

    it('baseline: pbe_app without tenant context sees no rows', async () => {
      expect((await appAs('pbe_app', `SELECT * FROM ${FX}.project`)).rows).toHaveLength(0);
    });

    it('D3 control: a superuser bypasses RLS and sees every tenant’s rows', async () => {
      const rows = await cluster.sql(
        `SELECT DISTINCT tenant_id FROM ${FX}.project`,
        [],
        'pbe_test',
      );
      expect(rows.rows).toHaveLength(2);
    });

    it('D4 control: a BYPASSRLS role sees every tenant’s rows, even with row_security = off; pbe_app gets an error instead', async () => {
      await cluster.sql('CREATE ROLE zz_control_bypass LOGIN BYPASSRLS', [], 'pbe_test');
      await cluster.sql('GRANT CONNECT ON DATABASE pbe_test TO zz_control_bypass', [], 'pbe_test');
      await cluster.sql(`GRANT USAGE ON SCHEMA ${FX} TO zz_control_bypass`, [], 'pbe_test');
      await cluster.sql(`GRANT SELECT ON ${FX}.project TO zz_control_bypass`, [], 'pbe_test');
      const bypass = await appAs(
        'zz_control_bypass',
        `SELECT DISTINCT tenant_id FROM ${FX}.project`,
        ['SET row_security = off'],
      );
      expect(bypass.rows).toHaveLength(2);
      await expect(
        appAs('pbe_app', `SELECT * FROM ${FX}.project`, ['SET row_security = off']),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('conformance rule runtime_not_owner: if pbe_app owned a tenant table it could switch RLS off — the check reports it', async () => {
      await cluster.sql(`ALTER TABLE ${FX}.project OWNER TO pbe_app`, [], 'pbe_test');
      const violations = await withClient(cluster.config(cluster.admin, 'pbe_test'), (c) =>
        checkTenantTables(c, FX),
      );
      expect(violations.map((v) => v.rule)).toContain('runtime_not_owner');
      // Why the rule matters: as owner, pbe_app can now disable RLS (proven, then the table is dropped).
      await appAs('pbe_app', `ALTER TABLE ${FX}.project DISABLE ROW LEVEL SECURITY`);
      await cluster.sql(`DROP SCHEMA ${FX} CASCADE`, [], 'pbe_test');
    });
  });

  it('teardown never drops pbe_dev: it removes pbe_test and temporary databases, then stops and keeps the roles', async () => {
    await cluster.sql(`CREATE DATABASE ${disposable} OWNER pbe_restore_drill`);
    await cluster.sql('CREATE DATABASE pbe_restore_check_keepme'); // wrong pattern: must survive
    await cluster.sql('CREATE DATABASE unrelated_db'); // not PBE: must survive

    const run = cluster.psqlFile(TEARDOWN);
    expect(run.status).toBe(0);
    expect(run.output).toMatch(/TEARDOWN STOPPED: pbe_dev exists/);
    const dbs = await databases();
    expect(dbs).toEqual(
      expect.arrayContaining(['pbe_dev', 'pbe_restore_check_keepme', 'unrelated_db']),
    );
    expect(dbs).not.toContain('pbe_test');
    expect(dbs).not.toContain(disposable);
    expect(await pbeRoles()).toEqual([
      'pbe_app',
      'pbe_backup',
      'pbe_migrator',
      'pbe_owner',
      'pbe_restore_drill',
    ]);
    const res = await cluster.sql('SELECT v FROM public.keep_me', [], 'pbe_dev');
    expect(res.rows).toEqual([{ v: 'still here' }]);
  });

  it('teardown removes the roles only after pbe_dev has been removed deliberately by hand', async () => {
    await cluster.sql('DROP DATABASE pbe_dev'); // the manual, deliberate step (throw-away server only)
    const run = cluster.psqlFile(TEARDOWN);
    expect(run.status).toBe(0);
    expect(run.output).toMatch(/TEARDOWN COMPLETE/);
    expect(await pbeRoles()).toEqual([]);
    expect(await databases()).toEqual(
      expect.arrayContaining(['unrelated_db', 'pbe_restore_check_keepme']),
    );
  });
});
