import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupDatabase,
  BACKUP_DIR_MODE,
  BACKUP_FILE_MODE,
  readArchive,
  readTableContents,
} from '../../tooling/migrate/src/backup';
import { OWNER_ROLE, PBE_SCHEMAS } from '../../tooling/migrate/src/config';
import {
  BACKUP_SCHEMAS,
  backupCoverageViolations,
  backupReadabilityViolations,
} from '../../tooling/migrate/src/conformance';
import { parseMigration } from '../../tooling/migrate/src/migration-files';
import { assertTestSchema, dbConfig, devReadOnly, ENV, ROOT, withClient } from './helpers';

/*
 * Backup-tool safety on the REAL local server (STAGE-07A-BACKUP-REVIEW.md F-4, F-5, F-6), with
 * NO role, permission or server change: pbe_test is only read, plus temporary zz_test_* schemas
 * (as other database tests do). The full v2 design, including the backup login, is tested on a
 * throw-away server in backup-v2.throwaway.db.spec.ts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-backup-tool-'));
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const owner = <T>(fn: (c: import('pg').Client) => Promise<T>) =>
  withClient(dbConfig('migrator'), fn, { asOwner: true });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('F-5 / F-6: atomic, owner-only backup files', () => {
  it('a successful backup appears only under its final name, owner-only (file 600, folder 700), fully decodable', () => {
    const dir = path.join(tmp, 'ok');
    const out = path.join(dir, 'pbe_test.dump');
    // Forced-RLS schema excluded ONLY to exercise the success path without a bypass role.
    const result = backupDatabase(ENV.binDir, dbConfig('migrator'), out, OWNER_ROLE, [
      'app',
      'zz_test_*',
    ]);
    expect(result.file).toBe(out);
    expect(fs.readdirSync(dir)).toEqual(['pbe_test.dump']);
    expect(mode(out)).toBe(BACKUP_FILE_MODE);
    expect(mode(dir)).toBe(BACKUP_DIR_MODE);
    expect(readArchive(ENV.binDir, out).tocEntries).toBeGreaterThan(10);
  });

  it('a FAILED backup leaves nothing behind: no final file and no partial file', () => {
    const dir = path.join(tmp, 'fail');
    const out = path.join(dir, 'pbe_test.dump');
    // pbe_test has forced-RLS tables (migration 0004) and pbe_migrator/pbe_owner cannot bypass RLS.
    expect(() =>
      backupDatabase(ENV.binDir, dbConfig('migrator'), out, OWNER_ROLE, ['zz_test_*']),
    ).toThrow(/pg_dump failed/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never overwrites an existing backup file', () => {
    const dir = path.join(tmp, 'exists');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'pbe_test.dump');
    fs.writeFileSync(out, 'previous backup', { mode: 0o600 });
    expect(() =>
      backupDatabase(ENV.binDir, dbConfig('migrator'), out, OWNER_ROLE, ['app', 'zz_test_*']),
    ).toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(out, 'utf8')).toBe('previous backup');
    expect(fs.readdirSync(dir)).toEqual(['pbe_test.dump']);
  });
});

describe('F-4: protected tables can never compare as "zero rows on both sides"', () => {
  const a = assertTestSchema(`zz_test_${randomBytes(5).toString('hex')}`);
  const b = assertTestSchema(`zz_test_${randomBytes(5).toString('hex')}`);

  beforeAll(async () => {
    await owner(async (c) => {
      for (const [schema, rows] of [
        [a, 3],
        [b, 2],
      ] as const) {
        await c.query(`CREATE SCHEMA ${schema}`);
        await c.query(
          `CREATE TABLE ${schema}.protected (id integer PRIMARY KEY, label text NOT NULL)`,
        );
        await c.query(
          `INSERT INTO ${schema}.protected SELECT g, 'row ' || g FROM generate_series(1, ${rows}) g`,
        );
        await c.query(`ALTER TABLE ${schema}.protected ENABLE ROW LEVEL SECURITY`);
        await c.query(`ALTER TABLE ${schema}.protected FORCE ROW LEVEL SECURITY`);
      }
    });
  });

  afterAll(async () => {
    await owner(async (c) => {
      await c.query(`DROP SCHEMA IF EXISTS ${a} CASCADE`);
      await c.query(`DROP SCHEMA IF EXISTS ${b} CASCADE`);
    });
  });

  it('the hazard is real: the owner, with row security on, silently sees 0 rows', async () => {
    const n = await owner(
      async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${a}.protected`)).rows[0].n as number,
    );
    expect(n).toBe(0);
  });

  it('the fixed reader sees the real rows in an owned copy, and leaves the table forced', async () => {
    const tables = await owner((c) => readTableContents(c, [a], { ownerOfCopy: true }));
    expect(tables.get(`${a}.protected`)?.rows).toBe(3);
    const forced = await owner(
      async (c) =>
        (
          await c.query(
            `SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = '${a}.protected'::regclass`,
          )
        ).rows[0].f as boolean,
    );
    expect(forced).toBe(true);
  });

  it('a reader that cannot bypass row security gets an ERROR, never a silent zero', async () => {
    await expect(owner((c) => readTableContents(c, [a], { ownerOfCopy: false }))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('missing rows are detected: 3 rows vs 2 rows differ in count and checksum', async () => {
    const [ta, tb] = await owner(async (c) => [
      await readTableContents(c, [a], { ownerOfCopy: true }),
      await readTableContents(c, [b], { ownerOfCopy: true }),
    ]);
    const x = ta.get(`${a}.protected`)!;
    const y = tb.get(`${b}.protected`)!;
    expect([x.rows, y.rows]).toEqual([3, 2]);
    expect(x.md5).not.toBe(y.md5);
  });
});

describe('backup-readability check (logic, with existing roles only)', () => {
  it('reports every table a role cannot read, and a missing role', async () => {
    const v = await withClient(dbConfig('migrator'), (c) =>
      backupReadabilityViolations(c, 'pbe_app', ['platform']),
    );
    expect(v).toEqual(
      expect.arrayContaining([
        'platform.password_credential (table): not readable',
        'platform.user_account (table): not readable',
      ]),
    );
    expect(v).not.toContain('platform.tenant (table): not readable'); // pbe_app may SELECT it (RLS)
    const missing = await withClient(dbConfig('migrator'), (c) =>
      backupReadabilityViolations(c, 'pbe_no_such_role'),
    );
    expect(missing).toEqual(['role pbe_no_such_role does not exist']);
    expect([...BACKUP_SCHEMAS]).toEqual(['app', 'platform', 'audit', 'training', 'pbe_meta']);
    // The drill compares PBE_SCHEMAS; it must cover every backed-up schema (plus "public").
    expect([...PBE_SCHEMAS].filter((x) => x !== 'public').sort()).toEqual(
      [...BACKUP_SCHEMAS].sort(),
    );
  });
});

describe('current real server state (after the Stage 8 integration phases, 2026-10-18)', () => {
  it('only pbe_backup has BYPASSRLS, with exactly the approved attributes; it can back up everything', async () => {
    const rows = await withClient(
      dbConfig('migrator'),
      async (c) =>
        (
          await c.query(
            `SELECT rolname, rolbypassrls, rolsuper, rolinherit, rolreplication, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit
               FROM pg_roles WHERE rolname LIKE 'pbe\\_%' ORDER BY 1`,
          )
        ).rows,
    );
    expect(rows.filter((r) => r.rolbypassrls).map((r) => r.rolname)).toEqual(['pbe_backup']);
    expect(rows.find((r) => r.rolname === 'pbe_backup')).toEqual({
      rolname: 'pbe_backup',
      rolbypassrls: true,
      rolsuper: false,
      rolinherit: false,
      rolreplication: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolconnlimit: 2,
    });
    const setting = await withClient(
      dbConfig('migrator'),
      async (c) =>
        (
          await c.query(
            `SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'pbe_backup'`,
          )
        ).rows,
    );
    expect(setting).toEqual([{ setconfig: ['default_transaction_read_only=on'] }]);
    // Coverage: the backup login can read and verify every PBE table, in both databases.
    expect(
      await withClient(dbConfig('migrator'), (c) => backupCoverageViolations(c, 'pbe_backup')),
    ).toEqual([]);
    expect(await devReadOnly((c) => backupCoverageViolations(c, 'pbe_backup'))).toEqual([]);
  });
});

describe('prepared files (static review)', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('migration 0005 passes the migration rules and only grants USAGE/SELECT to pbe_backup', () => {
    const file = '0005_backup_read_access.sql';
    const text = read(`db/migrations/${file}`);
    const parsed = parseMigration(file, Buffer.from(text), { ledgerSchema: 'pbe_meta' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.file?.phase).toBe('expand');
    const statements = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(statements).toEqual([
      'GRANT USAGE ON SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;',
    ]);
    // Applied in the Stage 8 integration phase (2026-10-18): it now lives in db/migrations only.
    expect(fs.existsSync(path.join(ROOT, 'db', 'migrations-proposed', file))).toBe(false);
  });

  it('the bootstrap gives BYPASSRLS to pbe_backup only; app, migrator, owner and restore stay NOBYPASSRLS', () => {
    const sql = read('db/bootstrap/bootstrap-local.sql');
    const alters = sql.split('\n').filter((l) => /^ALTER ROLE pbe_\w+\s+(NO)?LOGIN/.test(l));
    const bypass = alters.filter((l) => /\sBYPASSRLS\b/.test(l)).map((l) => l.split(/\s+/)[2]);
    expect(bypass).toEqual(['pbe_backup']);
    expect(alters.find((l) => l.includes('pbe_restore_drill'))).toMatch(/NOBYPASSRLS/);
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;/);
    expect(sql).not.toMatch(/pg_read_all_data/);
    expect(alters.find((l) => l.includes('pbe_backup'))).toMatch(
      /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS/,
    );
  });

  it('the proposed pg_hba lines allow pbe_backup only to pbe_dev and pbe_test, reject everything else', () => {
    const rules = read('db/bootstrap/pg_hba-pbe-backup.conf')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.split(/\s+/));
    expect(
      rules
        .filter((r) => r.at(-1) !== 'reject')
        .every((r) => r[1] === 'pbe_dev,pbe_test' && r[2] === 'pbe_backup'),
    ).toBe(true);
    expect(rules.filter((r) => r.at(-1) === 'reject').map((r) => [r[0], r[1], r[2]])).toEqual([
      ['host', 'all', 'pbe_backup'],
      ['host', 'replication', 'pbe_backup'],
      ['local', 'all', 'pbe_backup'],
      ['local', 'replication', 'pbe_backup'],
    ]);
    // Allow lines first (first match wins), SCRAM only, this computer only.
    expect(rules.slice(0, 2)).toEqual([
      ['host', 'pbe_dev,pbe_test', 'pbe_backup', '127.0.0.1/32', 'scram-sha-256'],
      ['host', 'pbe_dev,pbe_test', 'pbe_backup', '::1/128', 'scram-sha-256'],
    ]);
  });
});
