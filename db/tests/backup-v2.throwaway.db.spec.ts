import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientConfig } from 'pg';
import {
  backupDatabase,
  BACKUP_FILE_MODE,
  compareDatabases,
  createDisposableDatabase,
  dropDisposableDatabase,
  readArchive,
  restoreDrill,
  restoreInto,
} from '../../tooling/migrate/src/backup';
import { LEDGER_TABLE } from '../../tooling/migrate/src/runner';
import {
  BACKUP_SCHEMAS,
  backupCoverageViolations,
  backupPrivilegeAudit,
  INTERNALLY_GUARDED_BUILTINS,
  backupReadabilityViolations,
} from '../../tooling/migrate/src/conformance';
import { migrate, status } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ENV, ROOT, ThrowawayCluster, withClient } from './helpers';

/*
 * Backup design v2 (STAGE-07A-BACKUP-REVIEW.md) tested END TO END on a PRIVATE, throw-away
 * PostgreSQL 18 instance (temporary folder, socket only, deleted afterwards). The real local server
 * is never touched. Here the real bootstrap SQL creates pbe_backup, the real migrations 0001–0004
 * plus the PROPOSED 0005 are applied, and real rows are written into forced-RLS tables.
 */

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-backup-v2-'));
const migrationsDir = path.join(tmp, 'migrations');
const BOOTSTRAP = path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql');
const ROWS = 3;
let tenantId = '';
let tenant2Id = '';
let roleId = '';

const cfg = (user: string, db: string): ClientConfig => cluster.config(user, db);
const as = <T>(user: string, db: string, sql: string, params: unknown[] = []) =>
  withClient(cfg(user, db), async (c) => (await c.query(sql, params)).rows as T[]);
const asOwner = <T>(db: string, sql: string, params: unknown[] = []) =>
  withClient(cfg('pbe_migrator', db), async (c) => (await c.query(sql, params)).rows as T[], {
    asOwner: true,
  });

beforeAll(async () => {
  cluster = ThrowawayCluster.start();
  const run = cluster.psqlFile(BOOTSTRAP, bootstrapCredentials().env);
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  fs.mkdirSync(migrationsDir);
  for (const f of fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql') && f < '0006')) {
    fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrationsDir, f));
  }
  fs.copyFileSync(
    path.join(ROOT, 'db', 'migrations', '0005_backup_read_access.sql'),
    path.join(migrationsDir, '0005_backup_read_access.sql'),
  );
  for (const db of ['pbe_dev', 'pbe_test']) {
    const r = await migrate({ connection: cfg('pbe_migrator', db), migrationsDir });
    expect(r.applied.map((a) => a.version)).toEqual([1, 2, 3, 4, 5]);
  }
  // Real rows in forced-RLS tables, written the way the API does (pbe_app with tenant context).
  tenantId = (
    await asOwner<{ id: string }>(
      'pbe_dev',
      `INSERT INTO platform.tenant (slug, display_name) VALUES ('fictional-org', 'Fictional Org') RETURNING id`,
    )
  )[0]!.id;
  await withClient(cfg('pbe_app', 'pbe_dev'), async (c) => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    for (let i = 1; i <= ROWS; i += 1) {
      await c.query(`INSERT INTO app.department (tenant_id, name) VALUES ($1, $2)`, [
        tenantId,
        `Fictional dept ${i}`,
      ]);
    }
    await c.query(`INSERT INTO app.tenant_setting (tenant_id) VALUES ($1)`, [tenantId]);
    await c.query(
      `INSERT INTO audit.audit_event (tenant_id, actor_kind, action, target_type) VALUES ($1, 'member', 'department.created', 'department')`,
      [tenantId],
    );
    await c.query('COMMIT');
    // A composite foreign-key chain (role → role_permission → permission catalogue) and a second
    // organisation, so the restore check covers relationships and more than one tenant.
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    roleId = (
      await c.query<{ id: string }>(
        `INSERT INTO app.role (tenant_id, name) VALUES ($1, 'Fictional reviewer') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    await c.query(
      `INSERT INTO app.role_permission (tenant_id, role_id, permission) VALUES ($1, $2, 'tenant.members.read'), ($1, $2, 'tenant.roles.read')`,
      [tenantId, roleId],
    );
    await c.query('COMMIT');
  });
  tenant2Id = (
    await asOwner<{ id: string }>(
      'pbe_dev',
      `INSERT INTO platform.tenant (slug, display_name) VALUES ('second-fictional-org', 'Second Fictional Org') RETURNING id`,
    )
  )[0]!.id;
  await withClient(cfg('pbe_app', 'pbe_dev'), async (c) => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant2Id]);
    await c.query(`INSERT INTO app.tenant_setting (tenant_id) VALUES ($1)`, [tenant2Id]);
    await c.query(`INSERT INTO app.role (tenant_id, name) VALUES ($1, 'Second org role')`, [
      tenant2Id,
    ]);
    await c.query('COMMIT');
  });
}, 180_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('roles after the v2 bootstrap', () => {
  it('pbe_backup is the ONLY non-superuser with BYPASSRLS; app, migrator, owner and restore did not gain it', async () => {
    const rows = await as<{ rolname: string; rolbypassrls: boolean }>(
      'throwaway_admin',
      'postgres',
      `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'pbe\\_%' ORDER BY 1`,
    );
    expect(rows).toEqual([
      { rolname: 'pbe_app', rolbypassrls: false },
      { rolname: 'pbe_backup', rolbypassrls: true },
      { rolname: 'pbe_migrator', rolbypassrls: false },
      { rolname: 'pbe_owner', rolbypassrls: false },
      { rolname: 'pbe_restore_drill', rolbypassrls: false },
    ]);
    const others = await as<{ rolname: string }>(
      'throwaway_admin',
      'postgres',
      `SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY 1`,
    );
    expect(others.map((r) => r.rolname)).toEqual(['pbe_backup']);
  });

  it('pbe_backup has no memberships, cannot create databases or roles, no replication, max 2 sessions', async () => {
    const [r] = await as<Record<string, unknown>>(
      'throwaway_admin',
      'postgres',
      `SELECT rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolsuper, rolconnlimit,
       (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
       (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS members
       FROM pg_roles r WHERE rolname = 'pbe_backup'`,
    );
    expect(r).toEqual({
      rolinherit: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolsuper: false,
      rolconnlimit: 2,
      memberships: 0,
      members: 0,
    });
  });
});

describe('every PBE table is readable by the backup identity (migration 0005)', () => {
  it.each(['pbe_dev', 'pbe_test'])('%s: no unreadable table, sequence or schema', async (db) => {
    expect(
      await withClient(cfg('pbe_migrator', db), (c) =>
        backupReadabilityViolations(c, 'pbe_backup'),
      ),
    ).toEqual([]);
  });

  it('a new table without the grant is reported (the check fails the build)', async () => {
    await asOwner('pbe_test', 'CREATE TABLE platform.zz_new_table (id integer)');
    try {
      expect(
        await withClient(cfg('pbe_migrator', 'pbe_test'), (c) =>
          backupReadabilityViolations(c, 'pbe_backup'),
        ),
      ).toEqual(['platform.zz_new_table (table): not readable']);
    } finally {
      await asOwner('pbe_test', 'DROP TABLE platform.zz_new_table');
    }
  });

  it('pbe_backup reads every row of a forced-RLS table (bypass works only for it)', async () => {
    const [b] = await as<{ n: number }>(
      'pbe_backup',
      'pbe_dev',
      'SELECT count(*)::int AS n FROM app.department',
    );
    expect(b!.n).toBe(ROWS);
    const [m] = await asOwner<{ n: number }>(
      'pbe_dev',
      'SELECT count(*)::int AS n FROM app.department',
    );
    expect(m!.n).toBe(0); // the owner (no bypass, forced RLS) sees nothing: why a bypass is needed
  });
});

describe('the backup login cannot write, create, grant or escalate', () => {
  // Read-only default is switched OFF first, to prove the PRIVILEGES refuse (not just the setting).
  it.each([
    [
      'insert',
      `INSERT INTO app.department (tenant_id, name) VALUES ('${'00000000-0000-7000-8000-000000000000'}', 'x')`,
    ],
    ['update', `UPDATE platform.tenant SET display_name = 'x'`],
    ['delete', 'DELETE FROM audit.audit_event'],
    ['truncate', 'TRUNCATE app.department'],
    ['create table in a PBE schema', 'CREATE TABLE app.zz_x (id integer)'],
    ['create table in public', 'CREATE TABLE public.zz_x (id integer)'],
    ['create temporary table', 'CREATE TEMP TABLE zz_x (id integer)'],
    ['become the owner', 'SET ROLE pbe_owner'],
    ['create a role', 'CREATE ROLE zz_x'],
    ['create a database', 'CREATE DATABASE zz_x'],
    ['change own attributes', 'ALTER ROLE pbe_backup CREATEDB'],
    ['run a reviewed identity function', `SELECT platform.auth_login_lookup('x')`],
    [
      'run the operator function',
      `SELECT platform.operator_platform_role_set('00000000-0000-7000-8000-000000000000', 'platform_owner', true)`,
    ],
  ])('%s is refused', async (_label, sql) => {
    await expect(
      withClient(cfg('pbe_backup', 'pbe_dev'), async (c) => {
        await c.query('SET default_transaction_read_only = off');
        await c.query(sql);
      }),
    ).rejects.toThrow(/permission denied|must be owner|not allowed|must have/i);
  });

  it('grant: it cannot pass on any right (PostgreSQL only warns, so the effect is checked)', async () => {
    const notices: string[] = [];
    await withClient(cfg('pbe_backup', 'pbe_dev'), async (c) => {
      c.on('notice', (n) => notices.push(n.message ?? ''));
      await c.query('SET default_transaction_read_only = off');
      await c.query('GRANT SELECT ON platform.user_account TO pbe_app');
    });
    expect(notices).toContain('no privileges were granted for "user_account"');
    const [r] = await as<{ can: boolean }>(
      'throwaway_admin',
      'pbe_dev',
      `SELECT has_table_privilege('pbe_app', 'platform.user_account', 'SELECT') AS can`,
    );
    expect(r!.can).toBe(false);
  });

  it('its sessions start read-only by default (extra layer)', async () => {
    await expect(
      as('pbe_backup', 'pbe_dev', 'SELECT 1 FROM app.department FOR UPDATE'),
    ).rejects.toThrow(/read-only transaction/);
  });
});

describe('no access outside PBE data', () => {
  it('cannot read an unrelated schema in a PBE database, or unrelated data in "postgres"', async () => {
    await cluster.sql('CREATE SCHEMA zz_unrelated', [], 'pbe_dev');
    await cluster.sql(
      `CREATE TABLE zz_unrelated.secrets AS SELECT 'not PBE data'::text AS v`,
      [],
      'pbe_dev',
    );
    await cluster.sql(
      `CREATE TABLE public.unrelated AS SELECT 'other application data'::text AS v`,
      [],
      'postgres',
    );
    await expect(as('pbe_backup', 'pbe_dev', 'SELECT * FROM zz_unrelated.secrets')).rejects.toThrow(
      /permission denied/,
    );
    // Before the pg_hba.conf rule, PostgreSQL's default lets anyone CONNECT to "postgres", but
    // pbe_backup still has no read right there (no cluster-wide pg_read_all_data).
    await expect(as('pbe_backup', 'postgres', 'SELECT * FROM public.unrelated')).rejects.toThrow(
      /permission denied/,
    );
    // Clean up: an unreadable schema in pbe_dev would (correctly) make the later backups fail.
    await cluster.sql('DROP SCHEMA zz_unrelated CASCADE', [], 'pbe_dev');
  });

  // The full matrix (TCP IPv4/IPv6, sockets, replication, SCRAM, the proposed file verbatim) is in
  // backup-credentials.throwaway.db.spec.ts; this server is socket-only.
  it('with the pg_hba.conf rule (local-socket form), only pbe_dev and pbe_test accept it', async () => {
    const hba = path.join(cluster.dir, 'data', 'pg_hba.conf');
    const original = fs.readFileSync(hba, 'utf8');
    fs.writeFileSync(
      hba,
      `local pbe_dev,pbe_test pbe_backup trust\nlocal all pbe_backup reject\n${original}`,
    );
    await cluster.sql('SELECT pg_reload_conf()');
    await new Promise((r) => setTimeout(r, 500));
    for (const db of ['postgres', 'template1']) {
      await expect(as('pbe_backup', db, 'SELECT 1')).rejects.toThrow(
        /pg_hba\.conf rejects connection/,
      );
    }
    for (const db of ['pbe_dev', 'pbe_test']) {
      expect(await as<{ ok: number }>('pbe_backup', db, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
    }
    // Other roles are unaffected by the rule.
    expect(await as<{ ok: number }>('pbe_app', 'pbe_dev', 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });
});

describe('backup and restore with real rows in protected tables', () => {
  it('backup as pbe_backup (no role switch) succeeds, owner-only file, archive holds every protected row', () => {
    const out = path.join(tmp, 'dumps', 'pbe_dev.dump');
    const result = backupDatabase(ENV.binDir, cfg('pbe_backup', 'pbe_dev'), out, null);
    expect(fs.statSync(result.file).mode & 0o777).toBe(BACKUP_FILE_MODE);
    expect(readArchive(ENV.binDir, out).rows.get('app.department')).toBe(ROWS);
    expect(fs.readdirSync(path.dirname(out))).toEqual(['pbe_dev.dump']);
  });

  it('the legacy path (migrator as owner) fails loudly and leaves no file', () => {
    const out = path.join(tmp, 'legacy', 'pbe_dev.dump');
    expect(() =>
      backupDatabase(ENV.binDir, cfg('pbe_migrator', 'pbe_dev'), out, 'pbe_owner'),
    ).toThrow(/pg_dump failed/);
    expect(fs.readdirSync(path.dirname(out))).toEqual([]);
  });

  it('the full restore drill passes WITHOUT any bypass for the restore role, with real row counts', async () => {
    const report = await restoreDrill({
      binDir: ENV.binDir,
      source: cfg('pbe_backup', 'pbe_dev'),
      dumpRole: null,
      restore: cfg('pbe_restore_drill', 'pbe_test'),
      ownerRole: 'pbe_owner',
      migrationsDir,
      schemas: BACKUP_SCHEMAS,
      backupFile: path.join(tmp, 'drill', 'pbe_dev.dump'),
      coverageRole: 'pbe_backup',
    });
    expect(report.ok).toBe(true);
    const rows = Object.fromEntries(
      report.comparison.tables.map((t) => [t.table, [t.sourceRows, t.targetRows, t.contentEqual]]),
    );
    expect(rows).toMatchObject({
      'platform.tenant': [2, 2, true],
      'app.role': [2, 2, true],
      'app.role_permission': [2, 2, true],
      'app.tenant_setting': [2, 2, true],
    });
    expect(report.cleanedUp).toBe(true);
    expect(report.comparison.tables.find((t) => t.table === 'app.department')).toEqual({
      table: 'app.department',
      sourceRows: ROWS,
      targetRows: ROWS,
      contentEqual: true,
    });
    expect(report.comparison.tables.find((t) => t.table === 'audit.audit_event')?.sourceRows).toBe(
      1,
    );
  });

  it('a copy with MISSING protected rows fails verification (no silent zero-vs-zero)', async () => {
    const out = path.join(tmp, 'missing', 'pbe_dev.dump');
    backupDatabase(ENV.binDir, cfg('pbe_backup', 'pbe_dev'), out, null);
    const restore = cfg('pbe_restore_drill', 'pbe_test');
    const name = await createDisposableDatabase(restore);
    const copy = { ...restore, database: name };
    try {
      restoreInto(ENV.binDir, copy, out);
      // Lose one protected row in the copy (the restore role owns its copy).
      await withClient(copy, async (c) => {
        await c.query('BEGIN');
        await c.query('ALTER TABLE app.department NO FORCE ROW LEVEL SECURITY');
        await c.query(`DELETE FROM app.department WHERE name = 'Fictional dept 1'`);
        await c.query('ALTER TABLE app.department FORCE ROW LEVEL SECURITY');
        await c.query('COMMIT');
      });
      const cmp = await compareDatabases(cfg('pbe_backup', 'pbe_dev'), copy, BACKUP_SCHEMAS, {
        pbe_restore_drill: 'pbe_owner',
      });
      expect(cmp.ok).toBe(false);
      expect(cmp.tables.find((t) => t.table === 'app.department')).toEqual({
        table: 'app.department',
        sourceRows: ROWS,
        targetRows: ROWS - 1,
        contentEqual: false,
      });
    } finally {
      await dropDisposableDatabase(restore, name);
    }
  });

  it('the restore role cannot modify the original databases', async () => {
    await expect(as('pbe_restore_drill', 'pbe_dev', 'SELECT 1')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(
        'pbe_restore_drill',
        'pbe_test',
        `INSERT INTO app.department (tenant_id, name) VALUES ('${tenantId}', 'x')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

const REFUSED = /permission denied|must be owner|must be superuser|Only roles with|must have/i;

/** Runs `sql` as pbe_backup with its read-only default switched OFF; returns how it ended. */
async function attemptAsBackup(sql: string): Promise<string | null> {
  try {
    await withClient(cfg('pbe_backup', 'pbe_dev'), async (c) => {
      await c.query('SET default_transaction_read_only = off');
      await c.query(sql);
    });
    return `ALLOWED: ${sql}`;
  } catch (e) {
    const message = (e as Error).message;
    return REFUSED.test(message) ? null : `UNEXPECTED ERROR: ${sql}: ${message}`;
  }
}

describe('least privilege: catalogue-wide audit and direct attempts', () => {
  it.each(['pbe_dev', 'pbe_test'])(
    '%s: audit finds nothing (attributes, memberships, ownership, every write privilege, functions, settings)',
    async (db) => {
      const audit = await withClient(cfg('pbe_migrator', db), (c) =>
        backupPrivilegeAudit(c, 'pbe_backup'),
      );
      expect(audit.violations).toEqual([]);
      // Database ACLs alone still allow "postgres" and "template1" (PostgreSQL default): that is
      // why the pg_hba.conf rule is required.
      expect(audit.connectable).toEqual(['pbe_dev', 'pbe_test', 'postgres', 'template1']);
    },
  );

  it('the audit is not vacuous: each planted violation is reported', async () => {
    const plant = [
      [
        'pbe_test',
        'GRANT INSERT ON app.department TO pbe_backup',
        'REVOKE INSERT ON app.department FROM pbe_backup',
      ],
      [
        'pbe_test',
        'GRANT CREATE ON SCHEMA platform TO pbe_backup',
        'REVOKE CREATE ON SCHEMA platform FROM pbe_backup',
      ],
      [
        'pbe_test',
        'GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO pbe_backup',
        'REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM pbe_backup',
      ],
      [
        'pbe_test',
        'GRANT EXECUTE ON FUNCTION platform.auth_login_lookup(text) TO pbe_backup',
        'REVOKE EXECUTE ON FUNCTION platform.auth_login_lookup(text) FROM pbe_backup',
      ],
      [
        'pbe_test',
        'GRANT TEMPORARY ON DATABASE pbe_test TO pbe_backup',
        'REVOKE TEMPORARY ON DATABASE pbe_test FROM pbe_backup',
      ],
      ['postgres', 'GRANT pbe_app TO pbe_backup', 'REVOKE pbe_app FROM pbe_backup'],
      ['postgres', 'ALTER ROLE pbe_app BYPASSRLS', 'ALTER ROLE pbe_app NOBYPASSRLS'],
      ['postgres', 'ALTER ROLE pbe_backup CREATEDB', 'ALTER ROLE pbe_backup NOCREATEDB'],
    ] as const;
    for (const [db, sql] of plant) await cluster.sql(sql, [], db);
    try {
      const { violations } = await withClient(cfg('pbe_migrator', 'pbe_test'), (c) =>
        backupPrivilegeAudit(c, 'pbe_backup'),
      );
      expect(violations).toEqual(
        expect.arrayContaining([
          'app.department: INSERT',
          'schema platform: CREATE',
          'built-in function lo_create(oid): EXECUTE',
          'function platform.auth_login_lookup(text): EXECUTE (SECURITY DEFINER)',
          'database TEMPORARY privilege in the current database',
          'membership: pbe_backup is a member of pbe_app',
          'another non-superuser role has BYPASSRLS: pbe_app',
          'attribute rolcreatedb is true, expected false',
        ]),
      );
    } finally {
      for (const [db, , undo] of plant) await cluster.sql(undo, [], db);
    }
    const after = await withClient(cfg('pbe_migrator', 'pbe_test'), (c) =>
      backupPrivilegeAudit(c, 'pbe_backup'),
    );
    expect(after.violations).toEqual([]);
  });

  it('cannot change policies, disable protections, write through built-in functions or reach server files', async () => {
    const [p] = await as<{ policyname: string }>(
      'throwaway_admin',
      'pbe_dev',
      `SELECT policyname FROM pg_policies WHERE schemaname = 'app' AND tablename = 'department' LIMIT 1`,
    );
    const policy = p!.policyname;
    const attempts = [
      'ALTER TABLE app.department DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE app.department NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE app.department OWNER TO pbe_backup',
      `DROP POLICY ${policy} ON app.department`,
      `ALTER POLICY ${policy} ON app.department USING (true)`,
      'CREATE POLICY zz_open ON app.department USING (true)',
      'ALTER TABLE app.department ADD COLUMN zz integer',
      'DROP TABLE app.department',
      `COMMENT ON TABLE app.department IS 'x'`,
      'CREATE STATISTICS app.zz_st ON tenant_id, name FROM app.department',
      'REINDEX TABLE app.department',
      'BEGIN; LOCK TABLE app.department IN ROW EXCLUSIVE MODE; ROLLBACK',
      'SELECT 1 FROM app.department FOR SHARE',
      'SELECT 1 FROM app.department FOR KEY SHARE',
      'UPDATE app.department SET name = name',
      `DELETE FROM pbe_meta.${LEDGER_TABLE}`,
      'TRUNCATE platform.user_account',
      'SELECT lo_create(0)',
      'SELECT lo_creat(-1)',
      `SELECT lo_from_bytea(0, 'x')`,
      `SELECT lo_import('/etc/hosts')`,
      `SELECT pg_logical_emit_message(true, 'x', 'y')`,
      `SELECT pg_logical_emit_message(false, 'x', 'y'::bytea)`,
      `SELECT pg_read_file('postgresql.conf')`,
      `SELECT pg_ls_dir('.')`,
      'SELECT pg_switch_wal()',
      'SELECT pg_reload_conf()',
      'SELECT pg_stat_reset()',
      `COPY app.department TO '/tmp/pbe-zz-copy'`,
      `COPY (SELECT 1) TO PROGRAM 'true'`,
      `CREATE FUNCTION public.zz() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      'CREATE SCHEMA zz_x',
      'CREATE PUBLICATION zz FOR ALL TABLES',
      `ALTER SYSTEM SET work_mem = '1MB'`,
      `ALTER DATABASE pbe_dev SET work_mem = '1MB'`,
      'SET session_replication_role = replica',
      'GRANT pbe_owner TO pbe_backup',
      'ALTER ROLE pbe_backup CONNECTION LIMIT 50',
      `COMMENT ON ROLE pbe_backup IS 'x'`,
    ];
    const outcomes: string[] = [];
    for (const sql of attempts) {
      const r = await attemptAsBackup(sql);
      if (r) outcomes.push(r);
    }
    expect(outcomes).toEqual([]);
  });

  it('built-ins that PUBLIC may run but that check permission inside are all refused', async () => {
    // A large object owned by the administrator, so the large-object writes have a real target.
    const [lo] = (
      await cluster.sql(`SELECT lo_from_bytea(0, 'admin data')::int AS oid`, [], 'pbe_dev')
    ).rows;
    const oid = Number(lo.oid);
    const attempts: Record<(typeof INTERNALLY_GUARDED_BUILTINS)[number], string> = {
      lo_put: `SELECT lo_put(${oid}, 0, 'x')`,
      lowrite: `SELECT lowrite(lo_open(${oid}, 131072), 'x')`,
      lo_truncate: `SELECT lo_truncate(lo_open(${oid}, 131072), 0)`,
      lo_truncate64: `SELECT lo_truncate64(lo_open(${oid}, 131072), 0)`,
      lo_unlink: `SELECT lo_unlink(${oid})`,
      pg_create_physical_replication_slot: `SELECT pg_create_physical_replication_slot('zz_slot')`,
      pg_create_logical_replication_slot: `SELECT pg_create_logical_replication_slot('zz_slot', 'pgoutput')`,
      pg_copy_physical_replication_slot: `SELECT pg_copy_physical_replication_slot('zz_a', 'zz_b')`,
      pg_copy_logical_replication_slot: `SELECT pg_copy_logical_replication_slot('zz_a', 'zz_b')`,
      pg_drop_replication_slot: `SELECT pg_drop_replication_slot('zz_slot')`,
      pg_sync_replication_slots: 'SELECT pg_sync_replication_slots()',
      pg_import_system_collations: `SELECT pg_import_system_collations('app'::regnamespace)`,
    };
    try {
      const outcomes: string[] = [];
      for (const sql of Object.values(attempts)) {
        const r = await attemptAsBackup(sql);
        if (r) outcomes.push(r);
      }
      expect(outcomes).toEqual([]);
      const [still] = (
        await cluster.sql(`SELECT convert_from(lo_get(${oid}), 'UTF8') AS v`, [], 'pbe_dev')
      ).rows;
      expect(still.v).toBe('admin data'); // unchanged
    } finally {
      await cluster.sql(`SELECT lo_unlink(${oid})`, [], 'pbe_dev');
    }
  });

  it('what PostgreSQL still lets ANY role do to itself is detected: the audit and the drill refuse', async () => {
    await withClient(cfg('pbe_backup', 'pbe_dev'), async (c) => {
      await c.query('SET default_transaction_read_only = off');
      await c.query('ALTER ROLE pbe_backup RESET default_transaction_read_only');
      await c.query('ALTER ROLE pbe_backup SET search_path = app');
      await c.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO pbe_app');
    });
    try {
      const audit = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
        backupPrivilegeAudit(c, 'pbe_backup'),
      );
      expect(audit.violations).toEqual(
        expect.arrayContaining([
          'role setting default_transaction_read_only=on is missing',
          'role setting search_path=app',
          expect.stringMatching(/^owns pg_default_acl \d+$/),
        ]),
      );
      const coverage = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
        backupCoverageViolations(c, 'pbe_backup'),
      );
      expect(coverage).toContain('default privileges defined for role pbe_backup');
      const file = path.join(tmp, 'self-change', 'pbe_dev.dump');
      await expect(drill(file)).rejects.toThrow(/Backup coverage check failed/);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await cluster.sql('ALTER ROLE pbe_backup SET default_transaction_read_only = on');
      await cluster.sql('ALTER ROLE pbe_backup RESET search_path');
      await cluster.sql(
        'ALTER DEFAULT PRIVILEGES FOR ROLE pbe_backup REVOKE SELECT ON TABLES FROM pbe_app',
        [],
        'pbe_dev',
      );
    }
    const audit = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
      backupPrivilegeAudit(c, 'pbe_backup'),
    );
    expect(audit.violations).toEqual([]);
  });
});

const drill = (backupFile: string) =>
  restoreDrill({
    binDir: ENV.binDir,
    source: cfg('pbe_backup', 'pbe_dev'),
    dumpRole: null,
    restore: cfg('pbe_restore_drill', 'pbe_test'),
    ownerRole: 'pbe_owner',
    migrationsDir,
    schemas: BACKUP_SCHEMAS,
    backupFile,
    coverageRole: 'pbe_backup',
  });

describe('coverage: unreadable or omitted objects make backups and drills FAIL', () => {
  it('an unreadable table: reported, pg_dump fails leaving no file, comparison fails, drill refuses', async () => {
    await asOwner('pbe_dev', 'CREATE TABLE platform.zz_forgotten (id integer)');
    await asOwner('pbe_dev', 'INSERT INTO platform.zz_forgotten VALUES (1)');
    try {
      const coverage = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
        backupCoverageViolations(c, 'pbe_backup'),
      );
      expect(coverage).toEqual(['platform.zz_forgotten (table): not readable']);
      const out = path.join(tmp, 'unreadable', 'pbe_dev.dump');
      expect(() => backupDatabase(ENV.binDir, cfg('pbe_backup', 'pbe_dev'), out, null)).toThrow(
        /pg_dump failed/,
      );
      expect(fs.readdirSync(path.dirname(out))).toEqual([]);
      await expect(
        compareDatabases(
          cfg('pbe_backup', 'pbe_dev'),
          cfg('pbe_backup', 'pbe_dev'),
          BACKUP_SCHEMAS,
          {},
          { targetIsOwnedCopy: false },
        ),
      ).rejects.toThrow(/permission denied for table zz_forgotten/);
      const file = path.join(tmp, 'unreadable-drill', 'pbe_dev.dump');
      await expect(drill(file)).rejects.toThrow(/Backup coverage check failed/);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await asOwner('pbe_dev', 'DROP TABLE platform.zz_forgotten');
    }
  });

  it('a PBE-owned schema outside the backup list is reported even when readable, and the drill refuses', async () => {
    await asOwner('pbe_dev', 'CREATE SCHEMA zz_extra');
    await asOwner('pbe_dev', 'CREATE TABLE zz_extra.data AS SELECT 1 AS v');
    await asOwner('pbe_dev', 'GRANT USAGE ON SCHEMA zz_extra TO pbe_backup');
    await asOwner('pbe_dev', 'GRANT SELECT ON zz_extra.data TO pbe_backup');
    try {
      const coverage = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
        backupCoverageViolations(c, 'pbe_backup'),
      );
      expect(coverage).toEqual(['schema zz_extra: owned by pbe_owner but not in BACKUP_SCHEMAS']);
      await expect(drill(path.join(tmp, 'extra', 'pbe_dev.dump'))).rejects.toThrow(
        /Backup coverage check failed/,
      );
    } finally {
      await asOwner('pbe_dev', 'DROP SCHEMA zz_extra CASCADE');
    }
  });

  it('an unexpected large object is reported', async () => {
    const [lo] = (await cluster.sql('SELECT lo_create(0)::text AS oid', [], 'pbe_dev')).rows;
    try {
      const coverage = await withClient(cfg('pbe_migrator', 'pbe_dev'), (c) =>
        backupCoverageViolations(c, 'pbe_backup'),
      );
      expect(coverage).toEqual(['1 large object(s) present']);
    } finally {
      await cluster.sql(`SELECT lo_unlink(${Number(lo.oid)})`, [], 'pbe_dev');
    }
  });
});

describe('new migrations cannot silently omit the backup grant', () => {
  const header = (name: string) =>
    `-- ${name}\n-- Purpose: test fixture.\n-- Stage:   7A test\n-- Author:  test\n-- pbe:phase expand\n\n`;

  it('a migration adding a table WITHOUT the grant is rolled back; WITH the grant it applies', async () => {
    const dir = path.join(tmp, 'migrations-0006');
    fs.mkdirSync(dir);
    for (const f of fs.readdirSync(migrationsDir)) {
      fs.copyFileSync(path.join(migrationsDir, f), path.join(dir, f));
    }
    const file = path.join(dir, '0006_zz_new_data.sql');
    fs.writeFileSync(
      file,
      `${header('0006_zz_new_data.sql')}CREATE TABLE platform.zz_new_data (id integer PRIMARY KEY);\n`,
    );
    const connection = cfg('pbe_migrator', 'pbe_test');
    await expect(migrate({ connection, migrationsDir: dir })).rejects.toMatchObject({
      details: expect.arrayContaining([
        expect.stringContaining(
          '0006_zz_new_data.sql leaves data the backup login (pbe_backup) cannot read',
        ),
        'platform.zz_new_data (table): not readable',
      ]),
    });
    const st = await status({ connection, migrationsDir: dir });
    expect([st.entries.filter((e) => e.state === 'applied').length, st.pending]).toEqual([5, 1]);
    const [t] = await as<{ t: string | null }>(
      'pbe_migrator',
      'pbe_test',
      `SELECT to_regclass('platform.zz_new_data')::text AS t`,
    );
    expect(t!.t).toBeNull(); // rolled back

    fs.writeFileSync(
      file,
      `${header('0006_zz_new_data.sql')}CREATE TABLE platform.zz_new_data (id integer PRIMARY KEY);\nGRANT SELECT ON platform.zz_new_data TO pbe_backup;\n`,
    );
    const r = await migrate({ connection, migrationsDir: dir });
    expect(r.applied.map((a) => a.version)).toEqual([6]);
    expect(await withClient(connection, (c) => backupCoverageViolations(c, 'pbe_backup'))).toEqual(
      [],
    );
  });
});

describe('incomplete backups are never promoted to completed backups', () => {
  const fakeBin = path.join(tmp, 'fake-bin');
  const realPgDump = path.join(ENV.binDir, 'pg_dump');

  beforeAll(() => {
    fs.mkdirSync(fakeBin);
    // A stand-in pg_dump that runs the real one, then simulates a failure mode.
    fs.writeFileSync(
      path.join(fakeBin, 'pg_dump'),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
const r = spawnSync(process.env.PBE_REAL_PG_DUMP, args, { stdio: 'inherit' });
const mode = process.env.PBE_FAKE_DUMP_MODE;
if (mode === 'truncated-but-exit-0') { const b = fs.readFileSync(file); fs.writeFileSync(file, b.subarray(0, Math.floor(b.length / 2))); process.exit(0); }
if (mode === 'empty-but-exit-0') { fs.writeFileSync(file, ''); process.exit(0); }
if (mode === 'complete-but-exit-1') process.exit(1);
if (mode === 'killed') process.kill(process.pid, 'SIGKILL');
process.exit(r.status === null ? 1 : r.status);
`,
      { mode: 0o755 },
    );
    fs.symlinkSync(path.join(ENV.binDir, 'pg_restore'), path.join(fakeBin, 'pg_restore'));
    process.env.PBE_REAL_PG_DUMP = realPgDump;
  });

  afterAll(() => {
    delete process.env.PBE_FAKE_DUMP_MODE;
    delete process.env.PBE_REAL_PG_DUMP;
  });

  it.each(['truncated-but-exit-0', 'empty-but-exit-0', 'complete-but-exit-1', 'killed'])(
    'pg_dump %s: error, nothing under the final name, no partial file, earlier backups untouched',
    (mode) => {
      const dir = path.join(tmp, `incomplete-${mode}`);
      const earlier = path.join(dir, 'earlier.dump');
      backupDatabase(ENV.binDir, cfg('pbe_backup', 'pbe_dev'), earlier, null);
      const before = fs.readFileSync(earlier);
      process.env.PBE_FAKE_DUMP_MODE = mode;
      try {
        expect(() =>
          backupDatabase(fakeBin, cfg('pbe_backup', 'pbe_dev'), path.join(dir, 'new.dump'), null),
        ).toThrow(/pg_dump failed|pg_restore/);
      } finally {
        delete process.env.PBE_FAKE_DUMP_MODE;
      }
      expect(fs.readdirSync(dir)).toEqual(['earlier.dump']);
      expect(fs.readFileSync(earlier).equals(before)).toBe(true);
    },
  );

  it('control: the stand-in with no failure mode produces a normal, complete backup', () => {
    const out = path.join(tmp, 'incomplete-control', 'new.dump');
    backupDatabase(fakeBin, cfg('pbe_backup', 'pbe_dev'), out, null);
    expect(readArchive(ENV.binDir, out).rows.get('app.department')).toBe(ROWS);
  });
});

describe('the restored copy: relationships, expected data and protections', () => {
  it('same data and relationships across both organisations; constraints valid; RLS still enabled and forced', async () => {
    const out = path.join(tmp, 'relations', 'pbe_dev.dump');
    backupDatabase(ENV.binDir, cfg('pbe_backup', 'pbe_dev'), out, null);
    const restore = cfg('pbe_restore_drill', 'pbe_test');
    const name = await createDisposableDatabase(restore);
    const copy = { ...restore, database: name };
    try {
      restoreInto(ENV.binDir, copy, out);
      const facts = async (c: import('pg').Client) => ({
        tenants: (await c.query(`SELECT slug FROM platform.tenant ORDER BY slug`)).rows.map(
          (r) => r.slug,
        ),
        departments: (
          await c.query(
            `SELECT t.slug, d.name FROM app.department d JOIN platform.tenant t ON t.id = d.tenant_id ORDER BY 1, 2`,
          )
        ).rows.map((r) => `${r.slug}/${r.name}`),
        rolePermissions: (
          await c.query(
            `SELECT t.slug, r.name, rp.permission, p.scope FROM app.role_permission rp
               JOIN app.role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
               JOIN platform.tenant t ON t.id = r.tenant_id
               JOIN platform.permission p ON p.code = rp.permission ORDER BY 1, 2, 3`,
          )
        ).rows.map((r) => `${r.slug}/${r.name}/${r.permission}/${r.scope}`),
        roles: Number((await c.query('SELECT count(*) AS n FROM app.role')).rows[0].n),
        settings: Number((await c.query('SELECT count(*) AS n FROM app.tenant_setting')).rows[0].n),
        audit: (await c.query('SELECT action FROM audit.audit_event')).rows.map((r) => r.action),
        orphans: Number(
          (
            await c.query(
              `SELECT (SELECT count(*) FROM app.department d WHERE NOT EXISTS (SELECT 1 FROM platform.tenant t WHERE t.id = d.tenant_id))
                    + (SELECT count(*) FROM app.role_permission rp WHERE NOT EXISTS (SELECT 1 FROM app.role r WHERE r.tenant_id = rp.tenant_id AND r.id = rp.role_id)) AS n`,
            )
          ).rows[0].n,
        ),
      });
      const catalogue = async (c: import('pg').Client) => ({
        foreignKeys: (
          await c.query(
            `SELECT conrelid::regclass::text || ':' || conname || ':' || convalidated AS k FROM pg_constraint
              WHERE contype = 'f' AND connamespace::regnamespace::text = ANY($1) ORDER BY 1`,
            [BACKUP_SCHEMAS],
          )
        ).rows.map((r) => r.k),
        rls: (
          await c.query(
            `SELECT c.oid::regclass::text || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity AS k FROM pg_class c
              WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r' ORDER BY 1`,
          )
        ).rows.map((r) => r.k),
        policies: (
          await c.query(
            `SELECT schemaname || '.' || tablename || ':' || policyname || ':' || coalesce(qual, '') AS k FROM pg_policies ORDER BY 1`,
          )
        ).rows.map((r) => r.k),
      });
      // Source read by the backup login (bypasses RLS); copy read by its owner with FORCE lifted
      // inside a transaction that is rolled back.
      const source = await withClient(cfg('pbe_backup', 'pbe_dev'), async (c) => ({
        ...(await facts(c)),
        ...(await catalogue(c)),
      }));
      const restored = await withClient(copy, async (c) => {
        const cat = await catalogue(c); // before anything is lifted
        await c.query('BEGIN');
        try {
          for (const t of ['department', 'role', 'role_permission', 'tenant_setting']) {
            await c.query(`ALTER TABLE app.${t} NO FORCE ROW LEVEL SECURITY`);
          }
          return { ...(await facts(c)), ...cat };
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(restored).toEqual(source);
      expect(restored.tenants).toEqual(['fictional-org', 'second-fictional-org']);
      expect(restored.departments).toEqual([
        'fictional-org/Fictional dept 1',
        'fictional-org/Fictional dept 2',
        'fictional-org/Fictional dept 3',
      ]);
      expect(restored.rolePermissions).toEqual([
        'fictional-org/Fictional reviewer/tenant.members.read/tenant',
        'fictional-org/Fictional reviewer/tenant.roles.read/tenant',
      ]);
      expect([restored.roles, restored.settings, restored.orphans]).toEqual([2, 2, 0]);
      expect(restored.audit).toEqual(['department.created']);
      expect(restored.foreignKeys.length).toBeGreaterThan(10);
      expect(restored.foreignKeys.every((k) => k.endsWith(':true'))).toBe(true);
      expect(restored.rls.length).toBe(7);
      expect(restored.rls.every((k) => k.endsWith(':true:true'))).toBe(true);
    } finally {
      await dropDisposableDatabase(restore, name);
    }
  });
});
