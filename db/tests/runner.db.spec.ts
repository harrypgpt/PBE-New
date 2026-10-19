import fs from 'node:fs';
import path from 'node:path';
import { advisoryLockKey, migrate, status } from '../../tooling/migrate/src/runner';
import {
  dbConfig,
  exists,
  readSql,
  schemaExists,
  Scratch,
  testSchemaSql,
  withClient,
} from './helpers';

const scratches: Scratch[] = [];
function scratch(): Scratch {
  const s = new Scratch();
  scratches.push(s);
  return s;
}
afterAll(async () => {
  for (const s of scratches) await s.cleanup();
});

/** Three-step fixture: schema, table, data. */
function basic(s: Scratch): void {
  s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
  s.write(
    2,
    'create_table',
    'CREATE TABLE {s}.item (id integer PRIMARY KEY, label text NOT NULL);',
  );
  s.write(3, 'seed', "INSERT INTO {s}.item VALUES (1, 'a'), (2, 'b');", '-- pbe:phase migrate');
}

describe('first-time execution', () => {
  it('status on a fresh database lists everything as pending and creates nothing', async () => {
    const s = scratch();
    basic(s);
    const report = await status(s.options());
    expect(report.ledgerExists).toBe(false);
    expect(report.pending).toBe(3);
    expect(report.ok).toBe(true);
    expect(await schemaExists(s.ledgerSchema)).toBe(false);
  });

  it('applies all files in order, records checksums, and objects are owned by pbe_owner', async () => {
    const s = scratch();
    basic(s);
    const result = await migrate(s.options());
    expect(result.applied.map((a) => a.version)).toEqual([1, 2, 3]);
    const ledger = await s.ledger();
    expect(ledger.map((r) => [r.version, r.name, r.checksum_sha256])).toEqual([
      [1, 'create_schema', s.checksum(1, 'create_schema')],
      [2, 'create_table', s.checksum(2, 'create_table')],
      [3, 'seed', s.checksum(3, 'seed')],
    ]);
    expect(
      ledger.every((r) => r.applied_by === 'pbe_migrator' && r.runner_version === '1.0.0'),
    ).toBe(true);
    expect(ledger.map((r) => r.phase)).toEqual(['expand', 'expand', 'migrate']);
    const owner = await readSql(
      `SELECT pg_catalog.pg_get_userbyid(relowner) AS o FROM pg_catalog.pg_class WHERE oid = '${s.schema}.item'::regclass`,
    );
    expect(owner.rows[0].o).toBe('pbe_owner');
    expect((await readSql(`SELECT count(*)::int AS n FROM ${s.schema}.item`)).rows[0].n).toBe(2);
  });
});

describe('repeated execution', () => {
  it('a second run applies nothing and leaves the ledger untouched; a new file applies alone', async () => {
    const s = scratch();
    basic(s);
    await migrate(s.options());
    const before = await s.ledger();
    const again = await migrate(s.options());
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(3);
    expect(await s.ledger()).toEqual(before);

    s.write(4, 'add_column', 'ALTER TABLE {s}.item ADD COLUMN note text;');
    const next = await migrate(s.options());
    expect(next.applied.map((a) => a.version)).toEqual([4]);
    expect((await s.ledger()).map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect((await status(s.options())).entries.every((e) => e.state === 'applied')).toBe(true);
  });
});

describe('integrity checks on applied files', () => {
  it('detects a modified applied file, applies nothing, and recovers when the original is restored', async () => {
    const s = scratch();
    basic(s);
    await migrate(s.options());
    const original = s.read(2, 'create_table');
    s.write(4, 'later', 'CREATE TABLE {s}.later (id integer);');
    fs.appendFileSync(
      path.join(s.dir, s.fileName(2, 'create_table')),
      '-- harmless-looking edit\n',
    );

    await expect(migrate(s.options())).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(await exists(`${s.schema}.later`)).toBe(false);
    expect((await s.ledger()).map((r) => r.version)).toEqual([1, 2, 3]);
    const report = await status(s.options());
    expect(report.ok).toBe(false);
    expect(report.entries.find((e) => e.version === 2)?.state).toBe('modified');

    // Documented recovery: restore the original file from git history.
    fs.writeFileSync(path.join(s.dir, s.fileName(2, 'create_table')), original);
    const recovered = await migrate(s.options());
    expect(recovered.applied.map((a) => a.version)).toEqual([4]);
  });

  it('refuses when the last applied file is deleted', async () => {
    const s = scratch();
    basic(s);
    await migrate(s.options());
    fs.rmSync(path.join(s.dir, s.fileName(3, 'seed')));
    await expect(migrate(s.options())).rejects.toMatchObject({ code: 'MISSING_FILE' });
  });

  it('refuses when a middle applied file is deleted (numbering gap)', async () => {
    const s = scratch();
    basic(s);
    await migrate(s.options());
    fs.rmSync(path.join(s.dir, s.fileName(2, 'create_table')));
    await expect(migrate(s.options())).rejects.toMatchObject({ code: 'INVALID_FILES' });
  });

  it('refuses when an applied file is renamed', async () => {
    const s = scratch();
    basic(s);
    await migrate(s.options());
    fs.renameSync(
      path.join(s.dir, s.fileName(2, 'create_table')),
      path.join(s.dir, s.fileName(2, 'make_table')),
    );
    await expect(migrate(s.options())).rejects.toMatchObject({ code: 'NAME_MISMATCH' });
  });
});

describe('invalid file sets are rejected before the database is touched', () => {
  it.each([
    [
      'numbering gap',
      (s: Scratch) => {
        s.write(1, 'a', 'CREATE SCHEMA {s};');
        s.write(3, 'c', 'CREATE TABLE {s}.c (id integer);');
      },
    ],
    [
      'duplicate version',
      (s: Scratch) => {
        s.write(1, 'a', 'CREATE SCHEMA {s};');
        s.write(1, 'b', 'CREATE TABLE {s}.b (id integer);');
      },
    ],
    [
      'role statement',
      (s: Scratch) => {
        s.write(1, 'a', 'CREATE SCHEMA {s};\nCREATE ROLE intruder;');
      },
    ],
    [
      'transaction control',
      (s: Scratch) => {
        s.write(1, 'a', 'CREATE SCHEMA {s};\nCOMMIT;');
      },
    ],
    [
      'destructive statement outside contract phase',
      (s: Scratch) => {
        s.write(1, 'a', 'CREATE SCHEMA {s};\nDROP SCHEMA {s};');
      },
    ],
  ])('%s → INVALID_FILES, no ledger and no objects created', async (_label, setup) => {
    const s = scratch();
    setup(s);
    await expect(migrate(s.options())).rejects.toMatchObject({ code: 'INVALID_FILES' });
    expect(await schemaExists(s.ledgerSchema)).toBe(false);
    expect(await schemaExists(s.schema)).toBe(false);
  });
});

describe('failure during a migration, rollback and recovery', () => {
  it('rolls back the failing file completely, keeps earlier files, skips later ones, releases the lock, then recovers', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    s.write(
      2,
      'broken',
      'CREATE TABLE {s}.part (id integer);\nINSERT INTO {s}.part VALUES (1);\nSELECT * FROM {s}.does_not_exist;',
    );
    s.write(3, 'later', 'CREATE TABLE {s}.later (id integer);');

    const err = await migrate(s.options()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
    const failure = err as { message: string; details: string[] };
    expect(failure.message).toMatch(/0002_broken\.sql failed and was rolled back/);
    expect(failure.details.join()).toMatch(/SQLSTATE 42P01 at line 4/);

    expect((await s.ledger()).map((r) => r.version)).toEqual([1]);
    expect(await schemaExists(s.schema)).toBe(true); // file 1 committed
    expect(await exists(`${s.schema}.part`)).toBe(false); // file 2 fully rolled back
    expect(await exists(`${s.schema}.later`)).toBe(false); // file 3 never attempted

    // The lock was released: an immediate second run fails on the same file, not on the lock.
    await expect(migrate(s.options({ lockTimeoutMs: 1000 }))).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
    });

    // Documented recovery: an unapplied file may be corrected and the run repeated.
    s.write(2, 'broken', 'CREATE TABLE {s}.part (id integer);\nINSERT INTO {s}.part VALUES (1);');
    const recovered = await migrate(s.options());
    expect(recovered.applied.map((a) => a.version)).toEqual([2, 3]);
    const ledger = await s.ledger();
    expect(ledger.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(ledger[1]?.checksum_sha256).toBe(s.checksum(2, 'broken'));
    expect((await status(s.options())).ok).toBe(true);
  });

  it('survives the runner connection being killed mid-migration (simulated crash)', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    s.write(2, 'slow', 'CREATE TABLE {s}.slow (id integer);\nSELECT pg_catalog.pg_sleep(5);');
    const run = migrate(s.options()).catch((e: unknown) => e);

    // Find the runner's backend while it is inside migration 2, and terminate it.
    const appName = `pbe-migrate:migrate:${s.ledgerSchema}`;
    let terminated = false;
    for (let i = 0; i < 50 && !terminated; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await withClient(dbConfig('migrator'), (c) =>
        c.query(
          `SELECT pg_catalog.pg_terminate_backend(pid) AS t FROM pg_catalog.pg_stat_activity
            WHERE application_name = $1 AND query LIKE '%pg_sleep%'`,
          [appName],
        ),
      );
      terminated = res.rows.some((r) => r.t === true);
    }
    expect(terminated).toBe(true);
    const err = await run;
    expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((err as { details: string[] }).details.join()).toMatch(/SQLSTATE 57P01/);

    expect((await s.ledger()).map((r) => r.version)).toEqual([1]);
    expect(await exists(`${s.schema}.slow`)).toBe(false);

    // The lock died with the session; a new run proceeds immediately.
    s.write(2, 'slow', 'CREATE TABLE {s}.slow (id integer);');
    const recovered = await migrate(s.options({ lockTimeoutMs: 1000 }));
    expect(recovered.applied.map((a) => a.version)).toEqual([2]);
  });
});

describe('concurrency protection (two sessions in one process; see concurrency.db.spec.ts for two processes)', () => {
  it('two simultaneous runs apply each migration exactly once', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    s.write(2, 'slow_table', 'SELECT pg_catalog.pg_sleep(1);\nCREATE TABLE {s}.t (id integer);');
    const [a, b] = await Promise.all([migrate(s.options()), migrate(s.options())]);
    const counts = [a.applied.length, b.applied.length].sort();
    expect(counts).toEqual([0, 2]);
    expect((await s.ledger()).map((r) => r.version)).toEqual([1, 2]);
  });

  it('gives up with LOCK_TIMEOUT while another session holds the lock, then succeeds once it is released', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    await withClient(dbConfig('migrator'), async (holder) => {
      await holder.query('SELECT pg_catalog.pg_advisory_lock($1::bigint)', [
        advisoryLockKey(s.ledgerSchema),
      ]);
      const started = Date.now();
      await expect(migrate(s.options({ lockTimeoutMs: 800 }))).rejects.toMatchObject({
        code: 'LOCK_TIMEOUT',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
      expect(await schemaExists(s.ledgerSchema)).toBe(false);
      await holder.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [
        advisoryLockKey(s.ledgerSchema),
      ]);
    });
    expect((await migrate(s.options())).applied.map((a) => a.version)).toEqual([1]);
  });
});

describe('unsafe operations', () => {
  it('refuses pending contract-phase migrations without --allow-contract, applying nothing at all', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};\nCREATE TABLE {s}.old (id integer);');
    s.write(2, 'drop_old', 'DROP TABLE {s}.old;', '-- pbe:phase contract');
    const err = await migrate(s.options()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONTRACT_NOT_ALLOWED', details: ['0002_drop_old.sql'] });
    expect(await s.ledger()).toEqual([]);
    expect(await schemaExists(s.schema)).toBe(false);

    const ok = await migrate(s.options({ allowContract: true }));
    expect(ok.applied.map((a) => a.version)).toEqual([1, 2]);
    expect(await exists(`${s.schema}.old`)).toBe(false);
    expect((await s.ledger()).map((r) => r.phase)).toEqual(['expand', 'contract']);
  });

  it('runs migrations with search_path = pg_catalog, so unqualified object names fail', async () => {
    const s = scratch();
    // Uniquely named so that, if a broken runner ever let it through, it is recognisable and
    // removed below (a mutation test once created such a table in pbe_dev.public).
    const name = `${s.schema}_unqualified`;
    try {
      s.write(1, 'unqualified', `CREATE TABLE ${name} (id integer);`);
      const err = await migrate(s.options()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
      expect((err as { details: string[] }).details.join()).toMatch(/SQLSTATE 42501/);
      expect(await s.ledger()).toEqual([]);
      expect(await exists(`public.${name}`)).toBe(false);
    } finally {
      await withClient(
        dbConfig('migrator'),
        (c) => c.query(`DROP TABLE IF EXISTS public.${name}`),
        {
          asOwner: true,
        },
      );
    }
  });

  it('commits a migration and its ledger row together: if the ledger insert fails, the migration is rolled back', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    await migrate(s.options());
    // Make every further ledger insert fail (a trigger in this test's own ledger schema).
    await testSchemaSql(
      s.ledgerSchema,
      `CREATE FUNCTION ${s.ledgerSchema}.refuse() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'ledger insert refused by test'; END $$`,
    );
    await testSchemaSql(
      s.ledgerSchema,
      `CREATE TRIGGER refuse BEFORE INSERT ON ${s.ledgerSchema}.schema_migration
         FOR EACH ROW EXECUTE FUNCTION ${s.ledgerSchema}.refuse()`,
    );
    s.write(2, 'create_table', 'CREATE TABLE {s}.t (id integer);');
    const err = await migrate(s.options()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((err as { details: string[] }).details.join()).toMatch(/SQLSTATE P0001/);
    expect(await exists(`${s.schema}.t`)).toBe(false);
    expect((await s.ledger()).map((r) => r.version)).toEqual([1]);
  });

  it('cannot be run by the runtime role pbe_app (no CREATE on the database)', async () => {
    const s = scratch();
    s.write(1, 'create_schema', 'CREATE SCHEMA {s};');
    await expect(
      migrate(s.options({ connection: dbConfig('app'), ownerRole: null })),
    ).rejects.toMatchObject({
      code: '42501',
    });
    expect(await schemaExists(s.ledgerSchema)).toBe(false);
  });
});
