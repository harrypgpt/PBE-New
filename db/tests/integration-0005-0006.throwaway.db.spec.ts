import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientConfig } from 'pg';
import { ROLE_TEMPLATES } from '@pbe/contracts';
import {
  backupDatabase,
  compareBackupFiles,
  compareDatabases,
  createDisposableDatabase,
  dropDisposableDatabase,
  restoreDrill,
  restoreInto,
} from '../../tooling/migrate/src/backup';
import {
  BACKUP_SCHEMAS,
  backupCoverageViolations,
  backupPrivilegeAudit,
  checkTenantTables,
} from '../../tooling/migrate/src/conformance';
import { migrate } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ENV, ROOT, ThrowawayCluster, withClient } from './helpers';

/*
 * Stage 8 integration rehearsal (STAGE-08-INTEGRATION-PLAN.md): the proposed execution sequence,
 * step by step, on a PRIVATE throw-away PostgreSQL 18 server whose "pbe_dev" stands in for the
 * real one (real bootstrap, real migrations 0001–0004, Stage 7 data in forced-RLS tables). Then:
 * pre-migration backup and restore check → 0005 → backup → 0006 with project data → backup and
 * restore check → post-migration checks → FULL RECOVERY to the pre-migration state.
 * The real server, pbe_dev and pbe_test are never touched. Data is fictional.
 */

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-integration-'));
const dirs = { v4: path.join(tmp, 'm4'), v5: path.join(tmp, 'm5'), v6: path.join(tmp, 'm6') };
const DEV = 'pbe_dev';
const ADMIN = 'throwaway_admin';
const cfg = (user: string, db = DEV): ClientConfig => cluster.config(user, db);
const restoreRole = () => cfg('pbe_restore_drill', 'pbe_test');
type Row = Record<string, unknown>;

const q = (user: string, sql: string, params: unknown[] = [], db = DEV) =>
  withClient(cfg(user, db), async (c) => (await c.query(sql, params)).rows as Row[]);
const owner = (sql: string, params: unknown[] = []) =>
  withClient(cfg('pbe_migrator'), async (c) => (await c.query(sql, params)).rows as Row[], {
    asOwner: true,
  });
async function asApp<R>(
  tenant: string,
  user: string,
  fn: (q: (s: string, p?: unknown[]) => Promise<Row[]>) => Promise<R>,
) {
  return withClient(cfg('pbe_app'), async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [tenant, user],
      );
      const r = await fn(async (s, p = []) => (await c.query(s, p)).rows as Row[]);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}
const ledger = async () =>
  (await owner('SELECT version FROM pbe_meta.schema_migration ORDER BY 1')).map((r) => r.version);
const sqlCount = async (table: string) =>
  Number((await q(ADMIN, `SELECT count(*) AS n FROM ${table}`))[0]!.n);

let tenant = '';
let adminUser = '';
let adminMembership = '';
let preCopy = ''; // disposable copy of the PRE-migration state, kept for the recovery comparison
const preDump = path.join(tmp, 'backups', 'pre-migration-admin.dump');

beforeAll(async () => {
  cluster = ThrowawayCluster.start();
  const run = cluster.psqlFile(
    path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'),
    bootstrapCredentials().env,
  );
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const f of fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql') && f < '0005')) {
    for (const d of Object.values(dirs))
      fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(d, f));
  }
  for (const d of [dirs.v5, dirs.v6]) {
    fs.copyFileSync(
      path.join(ROOT, 'db', 'migrations', '0005_backup_read_access.sql'),
      path.join(d, '0005_backup_read_access.sql'),
    );
  }
  fs.copyFileSync(
    path.join(ROOT, 'db', 'migrations', '0006_projects_scenarios.sql'),
    path.join(dirs.v6, '0006_projects_scenarios.sql'),
  );
  // The real pbe_dev's state today: 0001–0004.
  await migrate({ connection: cfg('pbe_migrator'), migrationsDir: dirs.v4 });
  await migrate({ connection: cfg('pbe_migrator', 'pbe_test'), migrationsDir: dirs.v4 });
  // Stage 7 data in forced-RLS tables, written as the API does.
  adminUser = String(
    (
      await owner(
        `INSERT INTO platform.user_account (email, display_name) VALUES ('int-admin@example.test', 'Fictional Admin') RETURNING id`,
      )
    )[0]!.id,
  );
  tenant = String(
    (
      await owner(
        `INSERT INTO platform.tenant (slug, display_name) VALUES ('fictional-int', 'Fictional Int') RETURNING id`,
      )
    )[0]!.id,
  );
  adminMembership = await asApp(tenant, adminUser, async (x) => {
    const m = String(
      (
        await x(
          `INSERT INTO app.membership (tenant_id, user_id, email, display_name) VALUES (app.current_tenant_id(), $1, 'int-admin@example.test', 'Fictional Admin') RETURNING id`,
          [adminUser],
        )
      )[0]!.id,
    );
    for (const t of ROLE_TEMPLATES) {
      await x(
        `INSERT INTO app.role (tenant_id, name, template_key) VALUES (app.current_tenant_id(), $1, $2)`,
        [t.name, t.key],
      );
    }
    await x(
      `INSERT INTO app.membership_role (tenant_id, membership_id, role_id) SELECT app.current_tenant_id(), $1, id FROM app.role WHERE template_key = 'tenant_administrator'`,
      [m],
    );
    await x(
      `INSERT INTO app.department (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional R&D')`,
    );
    return m;
  });
}, 240_000);

afterAll(async () => {
  try {
    if (preCopy) await dropDisposableDatabase(restoreRole(), preCopy).catch(() => undefined);
  } finally {
    cluster?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The steps depend on each other and run in order (Jest runs tests in a file sequentially).
describe('Stage 8 integration rehearsal on a throw-away server', () => {
  it('step 0 — today’s state: ledger 1–4; the backup login exists but cannot back up (B-1 reproduced)', async () => {
    expect(await ledger()).toEqual([1, 2, 3, 4]);
    const violations = await withClient(cfg('pbe_migrator'), (c) =>
      backupCoverageViolations(c, 'pbe_backup'),
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(() =>
      backupDatabase(ENV.binDir, cfg('pbe_backup'), path.join(tmp, 'backups', 'b1.dump'), null),
    ).toThrow(/pg_dump failed/);
    expect(fs.existsSync(path.join(tmp, 'backups', 'b1.dump'))).toBe(false);
    // The migrator path fails too on forced-RLS tables (never a silently empty copy).
    expect(() =>
      backupDatabase(
        ENV.binDir,
        cfg('pbe_migrator'),
        path.join(tmp, 'backups', 'legacy.dump'),
        'pbe_owner',
      ),
    ).toThrow(/pg_dump failed/);
  });

  it('step 1 — pre-migration backup as the ADMINISTRATOR is complete, and its restored copy is identical', async () => {
    const b = backupDatabase(ENV.binDir, cfg(ADMIN), preDump, null);
    expect(b.bytes).toBeGreaterThan(0);
    preCopy = await createDisposableDatabase(restoreRole());
    restoreInto(ENV.binDir, { ...restoreRole(), database: preCopy }, preDump);
    const cmp = await compareDatabases(
      cfg(ADMIN),
      { ...restoreRole(), database: preCopy },
      BACKUP_SCHEMAS,
      { pbe_restore_drill: 'pbe_owner' },
    );
    expect(cmp.ok).toBe(true);
    const rows = Object.fromEntries(cmp.tables.map((t) => [t.table, t.targetRows]));
    expect(rows).toMatchObject({
      'app.membership': 1,
      'app.role': 6,
      'app.department': 1,
      'platform.tenant': 1,
    });
  });

  it('step 2 — 0005 applies; the backup login now covers everything; privilege audit clean', async () => {
    expect(
      (await migrate({ connection: cfg('pbe_migrator'), migrationsDir: dirs.v5 })).applied.map(
        (a) => a.version,
      ),
    ).toEqual([5]);
    expect(
      await withClient(cfg('pbe_migrator'), (c) => backupCoverageViolations(c, 'pbe_backup')),
    ).toEqual([]);
    expect(
      await withClient(cfg(ADMIN), (c) => backupPrivilegeAudit(c, 'pbe_backup')).then(
        (a) => a.violations,
      ),
    ).toEqual([]);
  });

  it('step 3 — backup and restore drill as the backup login at 0005: identical', async () => {
    const r = await restoreDrill({
      binDir: ENV.binDir,
      source: cfg('pbe_backup'),
      dumpRole: null,
      restore: restoreRole(),
      ownerRole: 'pbe_owner',
      migrationsDir: dirs.v5,
      schemas: BACKUP_SCHEMAS,
      backupFile: path.join(tmp, 'backups', 'after-0005.dump'),
      coverageRole: 'pbe_backup',
    });
    expect(r.ok).toBe(true);
    expect(r.cleanedUp).toBe(true);
  });

  it('step 3b — compare-backups: the administrator’s pre-migration backup and the first backup-login backup hold the SAME data', async () => {
    const r = await compareBackupFiles({
      binDir: ENV.binDir,
      restore: restoreRole(),
      first: preDump,
      second: path.join(tmp, 'backups', 'after-0005.dump'),
      schemas: BACKUP_SCHEMAS,
    });
    expect(r.ledger).toEqual({ first: [1, 2, 3, 4], second: [1, 2, 3, 4, 5] });
    expect(r.tables.filter((t) => !t.contentEqual)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tables.find((t) => t.table === 'app.membership')).toMatchObject({
      firstRows: 1,
      secondRows: 1,
    });
  });

  it('step 4 — 0006 applies; existing template roles get the project permissions; conformance and coverage clean', async () => {
    expect(
      (await migrate({ connection: cfg('pbe_migrator'), migrationsDir: dirs.v6 })).applied.map(
        (a) => a.version,
      ),
    ).toEqual([6]);
    expect(await ledger()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await withClient(cfg('pbe_migrator'), (c) => checkTenantTables(c, 'app'))).toEqual([]);
    expect(
      await withClient(cfg('pbe_migrator'), (c) => backupCoverageViolations(c, 'pbe_backup')),
    ).toEqual([]);
    expect(
      await withClient(cfg(ADMIN), (c) => backupPrivilegeAudit(c, 'pbe_backup')).then(
        (a) => a.violations,
      ),
    ).toEqual([]);
    const perms = await asApp(tenant, adminUser, (x) =>
      x(
        `SELECT rp.permission FROM app.role_permission rp JOIN app.role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id WHERE r.template_key = 'tenant_administrator' AND rp.permission LIKE 'tenant.%projects%' ORDER BY 1`,
      ),
    );
    expect(perms.map((p) => p.permission)).toEqual([
      'tenant.allprojects.read',
      'tenant.projects.create',
      'tenant.projects.manage',
      'tenant.projects.read',
    ]);
  });

  it('step 5 — project data written; backup and restore drill at 0006: identical, incl. triggers, policies and functions', async () => {
    await asApp(tenant, adminUser, async (x) => {
      const p = String(
        (
          await x(
            `INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form, route, release_type, scope_status, scope_vocabulary_version, created_by_membership)
         VALUES (app.current_tenant_id(), 'Fictional project', 'Fictionalol', 50, 'mg', 'tablet', 'oral', 'immediate_release', 'supported', 'draft-2026-10-18', $1) RETURNING id`,
            [adminMembership],
          )
        )[0]!.id,
      );
      await x(
        `INSERT INTO app.project_department (tenant_id, project_id, department_id) SELECT app.current_tenant_id(), $1, id FROM app.department`,
        [p],
      );
      for (const code of ['F001', 'F002']) {
        await x(
          `INSERT INTO app.scenario (tenant_id, project_id, code, created_by_membership) VALUES (app.current_tenant_id(), $1, $2, $3)`,
          [p, code, adminMembership],
        );
      }
      await x(`UPDATE app.project SET next_scenario_number = 3 WHERE id = $1`, [p]);
      const archived = String(
        (
          await x(
            `INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form, route, release_type, scope_status, scope_reasons, scope_vocabulary_version, created_by_membership)
         VALUES (app.current_tenant_id(), 'Fictional archived', 'Fictionalol', 5, 'mg', 'tablet', 'nasal', 'immediate_release', 'unsupported', ARRAY['Nasal products are outside the supported scope.'], 'draft-2026-10-18', $1) RETURNING id`,
            [adminMembership],
          )
        )[0]!.id,
      );
      await x(`UPDATE app.project SET status = 'archived' WHERE id = $1`, [archived]);
      return null;
    });
    const r = await restoreDrill({
      binDir: ENV.binDir,
      source: cfg('pbe_backup'),
      dumpRole: null,
      restore: restoreRole(),
      ownerRole: 'pbe_owner',
      migrationsDir: dirs.v6,
      schemas: BACKUP_SCHEMAS,
      backupFile: path.join(tmp, 'backups', 'after-0006.dump'),
      coverageRole: 'pbe_backup',
      keepOnFailure: false,
    });
    expect(r.ok).toBe(true);
    expect(r.comparison.fingerprint.equal).toBe(true);
    const rows = Object.fromEntries(
      r.comparison.tables.map((t) => [t.table, [t.sourceRows, t.targetRows, t.contentEqual]]),
    );
    expect(rows).toMatchObject({
      'app.project': [2, 2, true],
      'app.project_department': [1, 1, true],
      'app.scenario': [2, 2, true],
    });
  });

  it('step 5b — compare-backups detects real differences (0006 adds rows and changes role permissions)', async () => {
    const r = await compareBackupFiles({
      binDir: ENV.binDir,
      restore: restoreRole(),
      first: path.join(tmp, 'backups', 'after-0005.dump'),
      second: path.join(tmp, 'backups', 'after-0006.dump'),
      schemas: BACKUP_SCHEMAS,
      onlyInSecond: ['app.project', 'app.project_department', 'app.scenario'],
    });
    expect(r.ok).toBe(false);
    const differing = r.tables.filter((t) => !t.contentEqual).map((t) => t.table);
    expect(differing).toEqual(
      expect.arrayContaining(['app.role_permission', 'platform.permission']),
    );
    // No temporary database is left behind.
    const left = await cluster.sql(
      `SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'pbe_restore_check_%' AND datname <> $1`,
      [preCopy],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('step 6 — the archived project stays protected after migration (trigger active)', async () => {
    await expect(
      asApp(tenant, adminUser, (x) =>
        x(`UPDATE app.project SET name = 'x' WHERE status = 'archived'`),
      ),
    ).rejects.toThrow(/is archived and can no longer be changed/);
  });

  it('step 7 — RECOVERY: pbe_dev is recreated from the pre-migration backup; identical to before; back at 0001–0004', async () => {
    await cluster.sql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DEV],
    );
    await cluster.sql(`DROP DATABASE ${DEV}`);
    const r = spawnSync(
      path.join(ENV.binDir, 'pg_restore'),
      [
        '-h',
        cluster.dir,
        '-p',
        String(cluster.port),
        '-U',
        ADMIN,
        '--create',
        '--exit-on-error',
        '--dbname',
        'postgres',
        preDump,
      ],
      { encoding: 'utf8' },
    );
    expect([r.status, r.stderr.trim()]).toEqual([0, '']);
    expect(await ledger()).toEqual([1, 2, 3, 4]);
    const cmp = await compareDatabases(
      cfg(ADMIN),
      { ...restoreRole(), database: preCopy },
      BACKUP_SCHEMAS,
      { pbe_restore_drill: 'pbe_owner' },
    );
    expect(cmp.ok).toBe(true);
    // Database-level rights came back with --create: the application can connect again.
    expect(await q('pbe_app', 'SELECT current_database() AS d')).toEqual([{ d: DEV }]);
    expect(await sqlCount('app.membership')).toBe(1);
    // The projects tables are gone again (0006 undone).
    expect(await q(ADMIN, `SELECT to_regclass('app.project') IS NULL AS gone`)).toEqual([
      { gone: true },
    ]);
    // Back in the B-1 state: the backup login has no read access again (0005 undone).
    expect(
      (await withClient(cfg('pbe_migrator'), (c) => backupCoverageViolations(c, 'pbe_backup')))
        .length,
    ).toBeGreaterThan(0);
  });
});
