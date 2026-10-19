import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupDatabase,
  compareDatabases,
  createDisposableDatabase,
  dropDisposableDatabase,
  readArchive,
  restoreDrill,
  restoreInto,
} from '../../tooling/migrate/src/backup';
import {
  OWNER_ROLE,
  PBE_SCHEMAS,
  migrationsDir,
  snapshotFile,
} from '../../tooling/migrate/src/config';
import {
  diffFingerprints,
  schemaFingerprint,
  snapshotLines,
} from '../../tooling/migrate/src/fingerprint';
import { loadMigrations } from '../../tooling/migrate/src/migration-files';
import { migrate, status } from '../../tooling/migrate/src/runner';
import {
  backupConfig,
  databaseExists,
  dbConfig,
  devReadOnly,
  ENV,
  ownerSql,
  readSql,
  restoreConfig,
  ROOT,
  Scratch,
  withClient,
} from './helpers';

// ADR-020. Runs sequentially in one file because it resets and rebuilds pbe_test.
// pbe_dev is only read, inside READ ONLY transactions.

const REAL_DIR = migrationsDir(ROOT);
const realOptions = () => ({ connection: dbConfig('migrator'), migrationsDir: REAL_DIR });
const FIXTURE = 'zz_fixture_restore';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-restore-'));

beforeAll(async () => {
  // Reset pbe_test to empty (dbConfig refuses any database not named *_test).
  await ownerSql(
    `DROP SCHEMA IF EXISTS ${FIXTURE}, app, platform, training, audit, pbe_meta CASCADE`,
  );
  await ownerSql('GRANT USAGE ON SCHEMA public TO PUBLIC'); // undo 0001 so the rebuild starts from default
});
afterAll(async () => {
  await ownerSql(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('real migrations rebuilt from empty in pbe_test', () => {
  it('apply every file in db/migrations with matching checksums', async () => {
    const files = loadMigrations(REAL_DIR, { ledgerSchema: 'pbe_meta' });
    expect(files.problems).toEqual([]);
    const result = await migrate(realOptions());
    expect(result.applied.map((a) => a.fileName)).toEqual(files.files.map((f) => f.fileName));
    const ledger = await readSql(
      'SELECT version, name, checksum_sha256 FROM pbe_meta.schema_migration ORDER BY 1',
    );
    expect(ledger.rows).toEqual(
      files.files.map((f) => ({ version: f.version, name: f.name, checksum_sha256: f.checksum })),
    );
  });

  it('are idempotent and status reports nothing pending', async () => {
    expect((await migrate(realOptions())).applied).toEqual([]);
    const report = await status(realOptions());
    expect(report.ok).toBe(true);
    expect(report.pending).toBe(0);
  });

  it('create the schema skeleton owned by pbe_owner, with the intended access rules', async () => {
    const res = await readSql(
      `SELECT nspname, pg_catalog.pg_get_userbyid(nspowner) AS owner,
              pg_catalog.has_schema_privilege('pbe_app', nspname, 'USAGE') AS app_usage,
              pg_catalog.has_schema_privilege('pbe_app', nspname, 'CREATE') AS app_create
         FROM pg_catalog.pg_namespace WHERE nspname = ANY($1) ORDER BY nspname`,
      [PBE_SCHEMAS],
    );
    const bySchema = Object.fromEntries(res.rows.map((r) => [r.nspname, r]));
    for (const s of ['app', 'platform', 'training', 'audit', 'pbe_meta']) {
      expect(bySchema[s]?.owner).toBe('pbe_owner');
    }
    expect(['app', 'platform', 'audit', 'pbe_meta'].map((s) => bySchema[s]?.app_usage)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(bySchema.training?.app_usage).toBe(false);
    expect(bySchema.public?.app_usage).toBe(false);
    expect(res.rows.every((r) => r.app_create === false)).toBe(true);
  });
});

describe('pbe_dev (read-only checks)', () => {
  it('pbe_dev has every migration applied and nothing pending', async () => {
    const files = loadMigrations(REAL_DIR, { ledgerSchema: 'pbe_meta' });
    const rows = await devReadOnly((c) =>
      c.query('SELECT version, name, checksum_sha256 FROM pbe_meta.schema_migration ORDER BY 1'),
    );
    expect(rows.rows).toEqual(
      files.files.map((f) => ({ version: f.version, name: f.name, checksum_sha256: f.checksum })),
    );
  });

  it('pbe_dev has the same schema as pbe_test rebuilt from scratch, and as the committed snapshot', async () => {
    const dev = await devReadOnly((c) => schemaFingerprint(c, PBE_SCHEMAS));
    const test = await withClient(dbConfig('migrator'), (c) => schemaFingerprint(c, PBE_SCHEMAS));
    expect(diffFingerprints(test, dev)).toEqual({ equal: true, onlyInFirst: [], onlyInSecond: [] });
    const snapshot = fs
      .readFileSync(snapshotFile(ROOT), 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(diffFingerprints(snapshot, snapshotLines(dev)).equal).toBe(true);
  });
});

describe('database roles (catalogue checks)', () => {
  it('pbe_app is not superuser, has no BYPASSRLS, cannot create roles or databases, and owns nothing', async () => {
    const res = await readSql(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication,
              pg_catalog.pg_has_role(rolname, 'pbe_owner', 'MEMBER') AS member_of_owner,
              (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relowner = r.oid) AS owned_relations,
              (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspowner = r.oid) AS owned_schemas,
              (SELECT count(*)::int FROM pg_catalog.pg_database WHERE datdba = r.oid) AS owned_databases
         FROM pg_catalog.pg_roles r WHERE rolname IN ('pbe_app', 'pbe_migrator', 'pbe_owner') ORDER BY rolname`,
    );
    const role = Object.fromEntries(res.rows.map((r) => [r.rolname, r]));
    expect(role.pbe_app).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolcanlogin: true,
      member_of_owner: false,
      owned_relations: 0,
      owned_schemas: 0,
      owned_databases: 0,
    });
    expect(role.pbe_migrator).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      member_of_owner: true,
    });
    expect(role.pbe_owner).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreatedb: false,
    });
  });

  it.each([
    ['create a schema', 'CREATE SCHEMA app_intruder'],
    ['create a table in app', 'CREATE TABLE app.intruder (id integer)'],
    ['create a table in public', 'CREATE TABLE public.intruder (id integer)'],
    ['create a table in training', 'CREATE TABLE training.intruder (id integer)'],
    ['create a temporary table', 'CREATE TEMP TABLE intruder (id integer)'],
    ['create a database', 'CREATE DATABASE pbe_intruder'],
    [
      'write the migration ledger',
      "INSERT INTO pbe_meta.schema_migration VALUES (99, 'x', repeat('0', 64), 'expand', true, now(), 'x', 0, 'x')",
    ],
    ['drop a schema', 'DROP SCHEMA audit'],
    ['act as pbe_owner', 'SET ROLE pbe_owner'],
  ])('pbe_app cannot %s (SQLSTATE 42501)', async (_label, sql) => {
    await expect(withClient(dbConfig('app'), (c) => c.query(sql))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('pbe_restore_drill may create databases but is not a member of pbe_owner and owns nothing in pbe_test', async () => {
    const res = await readSql(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin,
              pg_catalog.pg_has_role(oid, 'pbe_owner', 'MEMBER') AS member_of_owner,
              (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relowner = r.oid) AS owned_relations,
              (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspowner = r.oid) AS owned_schemas,
              pg_catalog.has_database_privilege(oid, 'pbe_dev', 'CONNECT') AS can_connect_dev
         FROM pg_catalog.pg_roles r WHERE rolname = 'pbe_restore_drill'`,
    );
    expect(res.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: true,
      rolcreaterole: false,
      rolcanlogin: true,
      member_of_owner: false,
      owned_relations: 0,
      owned_schemas: 0,
      can_connect_dev: false,
    });
  });

  it.each([
    ['drop pbe_dev', 'DROP DATABASE pbe_dev'],
    ['act as pbe_owner', 'SET ROLE pbe_owner'],
    ['read the pbe_test migration ledger', 'SELECT * FROM pbe_meta.schema_migration'],
    ['create a schema in pbe_test', 'CREATE SCHEMA zz_intruder'],
  ])('PostgreSQL refuses: pbe_restore_drill cannot %s (SQLSTATE 42501)', async (_label, sql) => {
    await expect(withClient(restoreConfig(), (c) => c.query(sql))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('PostgreSQL refuses: pbe_restore_drill cannot connect to pbe_dev', async () => {
    await expect(
      withClient({ ...restoreConfig(), database: 'pbe_dev' }, (c) => c.query('SELECT 1')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('PostgreSQL refuses: pbe_migrator cannot create a database, even acting as pbe_owner', async () => {
    await expect(
      withClient(
        dbConfig('migrator'),
        (c) => c.query('CREATE DATABASE pbe_restore_check_0123456789'),
        {
          asOwner: true,
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('pbe_app can read (only read) the migration ledger', async () => {
    const res = await withClient(dbConfig('app'), (c) =>
      c.query('SELECT count(*)::int AS n FROM pbe_meta.schema_migration'),
    );
    expect(res.rows[0].n).toBeGreaterThan(0);
  });
});

describe('schema drift detection', () => {
  it('two schemas built from the same migrations are identical; a manual change is detected', async () => {
    const [a, b] = [new Scratch(), new Scratch()];
    try {
      for (const s of [a, b]) {
        s.write(
          1,
          'create',
          'CREATE SCHEMA {s};\nCREATE TABLE {s}.t (id integer PRIMARY KEY, v text NOT NULL);',
        );
        await migrate(s.options());
      }
      const fp = (s: Scratch) =>
        withClient(dbConfig('migrator'), (c) =>
          schemaFingerprint(c, [s.schema], { [s.schema]: 'S' }),
        );
      expect(diffFingerprints(await fp(a), await fp(b)).equal).toBe(true);
      await b.sql(`ALTER TABLE ${b.schema}.t ADD COLUMN sneaky text`);
      const diff = diffFingerprints(await fp(a), await fp(b));
      expect(diff.equal).toBe(false);
      expect(diff.onlyInSecond.join()).toMatch(/column S \| t \| sneaky/);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

describe('temporary databases: only pbe_restore_check_<hex> may ever be dropped', () => {
  it.each([
    'pbe_dev',
    'pbe_test',
    'postgres',
    'pbe_restore_check_keepme',
    'pbe_restore_check_0123456789; DROP',
  ])('refuses to drop "%s"', async (name) => {
    await expect(dropDisposableDatabase(restoreConfig(), name)).rejects.toMatchObject({
      code: 'UNSAFE_TARGET',
    });
  });

  it('pbe_dev and pbe_test still exist after those attempts', async () => {
    expect(await databaseExists('pbe_dev')).toBe(true);
    expect(await databaseExists('pbe_test')).toBe(true);
  });
});

describe('backup and restore drill (fixture in pbe_test → temporary database)', () => {
  const schemas = [...PBE_SCHEMAS, FIXTURE];

  beforeAll(async () => {
    // Explicit fixture: awkward values on purpose (quotes, tabs, new lines, backslashes,
    // unicode, NULLs, JSON, exact decimals, time zones, binary) plus 1,000 generated rows.
    await ownerSql(`CREATE SCHEMA ${FIXTURE}`);
    await ownerSql(`CREATE TABLE ${FIXTURE}.sample (
        id integer PRIMARY KEY,
        label text NOT NULL,
        amount numeric(12, 4),
        seen_at timestamptz,
        flag boolean,
        doc jsonb,
        raw bytea)`);
    await ownerSql(`INSERT INTO ${FIXTURE}.sample VALUES
        (1, E'quote '' tab \\t newline \\n backslash \\\\ end', 1234.5678, '2026-10-17 10:00:00+05:30', true, '{"a": [1, 2], "b": null}', '\\x00ff10'),
        (2, 'unicode: µg/mL · ±5% · 日本語 · émulsion', NULL, NULL, NULL, NULL, NULL),
        (3, '', 0, '1970-01-01 00:00:00+00', false, '[]', '\\x')`);
    await ownerSql(`INSERT INTO ${FIXTURE}.sample
        SELECT g, 'row ' || g, g / 7.0, timestamptz '2026-01-01' + g * interval '1 minute', g % 2 = 0,
               jsonb_build_object('n', g), decode(md5(g::text), 'hex')
          FROM generate_series(4, 1003) g`);
    // Like every PBE schema (migration 0005), the fixture is readable by the backup login.
    await ownerSql(`GRANT USAGE ON SCHEMA ${FIXTURE} TO pbe_backup`);
    await ownerSql(`GRANT SELECT ON ${FIXTURE}.sample TO pbe_backup`);
  });

  it('backup → verify artifact → restore into a temporary database → identical → usable → temporary database dropped', async () => {
    const lines: string[] = [];
    let report: Awaited<ReturnType<typeof restoreDrill>> | undefined;
    try {
      report = await restoreDrill({
        binDir: ENV.binDir,
        source: backupConfig(),
        dumpRole: null, // the backup login (read-only, BYPASSRLS), since the integration phase
        restore: restoreConfig(),
        ownerRole: OWNER_ROLE,
        migrationsDir: REAL_DIR,
        schemas,
        backupFile: path.join(tmp, 'pbe_test.dump'),
        excludeSchemas: ['zz_test_*'],
        log: (l) => lines.push(l),
      });
      // Artifact
      expect(report.backup.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(report.backup.file).subarray(0, 5).toString()).toBe('PGDMP');
      expect(report.archive.schemas).toEqual(
        expect.arrayContaining(['app', 'audit', 'pbe_meta', 'platform', 'training', FIXTURE]),
      );
      expect(report.archive.ledgerRows).toBeGreaterThan(0);
      // Restored schema, ledger and fixture data
      expect(report.comparison.fingerprint).toEqual({
        equal: true,
        onlyInFirst: [],
        onlyInSecond: [],
      });
      expect(report.comparison.ledger.equal).toBe(true);
      expect(report.comparison.tables).toEqual(
        expect.arrayContaining([
          { table: `${FIXTURE}.sample`, sourceRows: 1003, targetRows: 1003, contentEqual: true },
          expect.objectContaining({ table: 'pbe_meta.schema_migration', contentEqual: true }),
        ]),
      );
      // Usable
      expect(report.usable).toEqual({
        statusOk: true,
        pending: 0,
        migrateApplied: 0,
        writeReadOk: true,
      });
      // Clean-up of only the temporary database
      expect(report.ok).toBe(true);
      expect(report.cleanedUp).toBe(true);
      expect(report.restoredInto).toMatch(/^pbe_restore_check_[0-9a-f]{10}$/);
      expect(await databaseExists(report.restoredInto)).toBe(false);
      expect(await databaseExists('pbe_dev')).toBe(true);
      expect(await databaseExists('pbe_test')).toBe(true);
      expect(lines.join('\n')).toMatch(/dropped temporary database pbe_restore_check_/);
    } finally {
      // A failed drill keeps its temporary database for diagnosis; the test must not leak it.
      if (report && !report.cleanedUp)
        await dropDisposableDatabase(restoreConfig(), report.restoredInto);
    }
  });

  it('restored values match exactly, and the comparison detects changed values and changed privileges', async () => {
    const dump = path.join(tmp, 'manual.dump');
    backupDatabase(ENV.binDir, backupConfig(), dump, null, ['zz_test_*']);
    expect(readArchive(ENV.binDir, dump).rows.get(`${FIXTURE}.sample`)).toBe(1003);
    const name = await createDisposableDatabase(restoreConfig());
    const target = { ...restoreConfig(), database: name };
    const asOwner = { pbe_restore_drill: OWNER_ROLE };
    try {
      restoreInto(ENV.binDir, target, dump);
      expect((await compareDatabases(backupConfig(), target, schemas, asOwner)).ok).toBe(true);

      // Value-by-value check of the awkward fixture rows (text, decimals, time zones, JSON, binary).
      const pick = `SELECT id, label, amount::text AS amount, seen_at, flag, doc::text AS doc,
                           encode(raw, 'hex') AS raw_hex, raw IS NULL AS raw_null,
                           octet_length(label) AS label_bytes
                      FROM ${FIXTURE}.sample WHERE id IN (1, 2, 3) ORDER BY id`;
      const before = await readSql(pick);
      const after = await withClient(target, (c) => c.query(pick));
      expect(after.rows).toEqual(before.rows);
      expect(after.rows[0].label).toBe("quote ' tab \t newline \n backslash \\ end");
      expect(after.rows[0].raw_hex).toBe('00ff10');
      expect(after.rows[1].label).toBe('unicode: µg/mL · ±5% · 日本語 · émulsion');
      expect(after.rows[1]).toMatchObject({
        amount: null,
        seen_at: null,
        flag: null,
        doc: null,
        raw_null: true,
      });
      expect(after.rows[2]).toMatchObject({
        label: '',
        label_bytes: 0,
        amount: '0.0000',
        raw_hex: '',
        raw_null: false,
      });

      // A privilege change in the copy must be reported (privileges are compared, not ignored).
      await withClient(target, (c) => c.query('GRANT USAGE ON SCHEMA training TO pbe_app'));
      const privilegeReport = await compareDatabases(backupConfig(), target, schemas, asOwner);
      expect(privilegeReport.ok).toBe(false);
      expect(privilegeReport.fingerprint.onlyInSecond.join()).toMatch(
        /schema training \| pbe_owner \| \{[^}]*pbe_app=U/,
      );
      await withClient(target, (c) => c.query('REVOKE USAGE ON SCHEMA training FROM pbe_app'));

      await withClient(target, (c) =>
        c.query(`UPDATE ${FIXTURE}.sample SET label = 'tampered' WHERE id = 500`),
      );
      const report = await compareDatabases(backupConfig(), target, schemas, asOwner);
      expect(report.ok).toBe(false);
      expect(report.tables).toEqual(
        expect.arrayContaining([
          { table: `${FIXTURE}.sample`, sourceRows: 1003, targetRows: 1003, contentEqual: false },
        ]),
      );
    } finally {
      await dropDisposableDatabase(restoreConfig(), name);
    }
    expect(await databaseExists(name)).toBe(false);
  });

  it('a failed verification keeps the temporary database for diagnosis (then it is dropped by name)', async () => {
    // The fixture schema is left out of the backup but required by the comparison → must fail.
    const report = await restoreDrill({
      binDir: ENV.binDir,
      source: backupConfig(),
      dumpRole: null, // the backup login (read-only, BYPASSRLS), since the integration phase
      restore: restoreConfig(),
      ownerRole: OWNER_ROLE,
      migrationsDir: REAL_DIR,
      schemas,
      backupFile: path.join(tmp, 'incomplete.dump'),
      excludeSchemas: ['zz_test_*', FIXTURE],
    });
    try {
      expect(report.ok).toBe(false);
      expect(report.cleanedUp).toBe(false);
      expect(report.comparison.tables).toEqual(
        expect.arrayContaining([
          { table: `${FIXTURE}.sample`, sourceRows: 1003, targetRows: null, contentEqual: false },
        ]),
      );
      expect(await databaseExists(report.restoredInto)).toBe(true);
    } finally {
      await dropDisposableDatabase(restoreConfig(), report.restoredInto);
    }
    expect(await databaseExists(report.restoredInto)).toBe(false);
  });

  it('a damaged archive is rejected', () => {
    const good = fs.readFileSync(path.join(tmp, 'manual.dump'));
    const damaged = path.join(tmp, 'damaged.dump');
    fs.writeFileSync(damaged, good.subarray(0, Math.floor(good.length / 2)));
    expect(() => readArchive(ENV.binDir, damaged)).toThrow(/pg_restore/);
  });
});
