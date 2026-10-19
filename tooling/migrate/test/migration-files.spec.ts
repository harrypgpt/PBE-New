import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMigrations, parseMigration, sha256Hex } from '../src/migration-files';

const OPTS = { ledgerSchema: 'pbe_meta' };
const parse = (name: string, sql: string) => parseMigration(name, Buffer.from(sql), OPTS);
const expand = (body: string) => `-- pbe:phase expand\n${body}\n`;
const contract = (body: string) => `-- pbe:phase contract\n${body}\n`;

const dirs: string[] = [];
function folder(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-mig-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('parseMigration — accepted files', () => {
  it('parses version, name, phase, transaction mode and the SHA-256 of the exact bytes', () => {
    const sql = expand('CREATE SCHEMA app;');
    const { file, problems } = parse('0001_schema_skeleton.sql', sql);
    expect(problems).toEqual([]);
    expect(file).toMatchObject({
      version: 1,
      name: 'schema_skeleton',
      phase: 'expand',
      transactional: true,
    });
    expect(file?.checksum).toBe(sha256Hex(sql));
  });

  it('treats a line-ending change as a different checksum', () => {
    const lf = parse('0001_a.sql', expand('CREATE SCHEMA a;')).file?.checksum;
    const crlf = parse('0001_a.sql', expand('CREATE SCHEMA a;').replace(/\n/g, '\r\n')).file
      ?.checksum;
    expect(lf).not.toBe(crlf);
  });

  it.each([
    ['DROP NOT NULL (an expand change)', 'ALTER TABLE app.t ALTER COLUMN c DROP NOT NULL;'],
    ['SET LOCAL', "SET LOCAL lock_timeout = '1s';"],
    [
      'keywords inside strings and comments',
      "COMMENT ON SCHEMA app IS 'DROP TABLE; COMMIT'; -- BEGIN",
    ],
    ['statements inside a DO block (not inspected)', 'DO $$ BEGIN EXECUTE 1; END $$;'],
    ['GRANT on the ledger schema', 'GRANT SELECT ON pbe_meta.schema_migration TO pbe_app;'],
    ['ALTER TYPE … ADD VALUE', "ALTER TYPE app.state ADD VALUE 'x';"],
  ])('allows %s in an expand migration', (_label, body) => {
    expect(parse('0001_a.sql', expand(body)).problems).toEqual([]);
  });

  it('allows a single re-runnable no-transaction statement', () => {
    const { file, problems } = parse(
      '0002_idx.sql',
      '-- pbe:phase expand\n-- pbe:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON app.t (c);\n',
    );
    expect(problems).toEqual([]);
    expect(file?.transactional).toBe(false);
  });

  it.each([
    'DROP TABLE app.old;',
    'TRUNCATE app.t;',
    'DELETE FROM app.t;',
    'ALTER TABLE app.t DROP COLUMN c;',
    'ALTER TABLE app.t RENAME TO t2;',
    'ALTER TABLE app.t ALTER COLUMN c TYPE bigint;',
  ])('allows destructive "%s" in a contract migration', (body) => {
    expect(parse('0003_c.sql', contract(body)).problems).toEqual([]);
  });
});

describe('parseMigration — rejected files', () => {
  it.each([['1_x.sql'], ['0001-x.sql'], ['0001_Upper.sql'], ['0001_x.SQL'], ['0001_.sql']])(
    'rejects badly named file %s',
    (name) => {
      expect(parse(name, expand('SELECT 1;')).problems[0]).toMatch(/name must look like/);
    },
  );

  it('rejects a missing phase header', () => {
    expect(parse('0001_a.sql', 'CREATE SCHEMA a;').problems.join()).toMatch(
      /missing "-- pbe:phase/,
    );
  });

  it('rejects an unknown phase and unknown directives', () => {
    expect(parse('0001_a.sql', '-- pbe:phase later\nSELECT 1;').problems.join()).toMatch(
      /unknown phase/,
    );
    expect(parse('0001_a.sql', expand('-- pbe:skip-checks\nSELECT 1;')).problems.join()).toMatch(
      /unknown directive/,
    );
  });

  it('rejects an empty file', () => {
    expect(parse('0001_a.sql', expand('-- nothing here')).problems.join()).toMatch(
      /no SQL statements/,
    );
  });

  it.each([
    ['BEGIN;', /transaction control/],
    ['COMMIT;', /transaction control/],
    ['ROLLBACK;', /transaction control/],
    ['START TRANSACTION;', /transaction control/],
    ['SAVEPOINT s;', /transaction control/],
    ['CREATE ROLE intruder;', /roles are managed/],
    ['ALTER ROLE pbe_app SUPERUSER;', /roles are managed/],
    ['DROP DATABASE pbe_dev;', /databases are managed/],
    ["ALTER SYSTEM SET fsync = 'off';", /server configuration/],
    ['SET ROLE postgres;', /changing role/],
    ['SET SESSION AUTHORIZATION postgres;', /changing role/],
    ['SET search_path = app;', /use SET LOCAL/],
    ['RESET search_path;', /RESET/],
    ['\\i other.sql', /psql meta-commands/],
  ])('rejects "%s" anywhere', (body, why) => {
    expect(parse('0001_a.sql', expand(body)).problems.join()).toMatch(why);
  });

  it.each([
    'DROP TABLE app.old;',
    'DROP SCHEMA app CASCADE;',
    'TRUNCATE app.t;',
    'DELETE FROM app.t WHERE true;',
    'ALTER TABLE app.t DROP COLUMN c;',
    'ALTER TABLE app.t DROP CONSTRAINT k;',
    'ALTER TABLE app.t RENAME COLUMN a TO b;',
    'ALTER TABLE app.t ALTER COLUMN c SET DATA TYPE bigint;',
  ])('rejects destructive "%s" outside a contract migration', (body) => {
    for (const phase of ['expand', 'migrate']) {
      expect(parse('0001_a.sql', `-- pbe:phase ${phase}\n${body}\n`).problems.join()).toMatch(
        /allowed only in a contract-phase/,
      );
    }
  });

  it('rejects statements that modify the ledger schema', () => {
    expect(
      parse(
        '0001_a.sql',
        expand('INSERT INTO pbe_meta.schema_migration VALUES (1);'),
      ).problems.join(),
    ).toMatch(/must not modify the migration ledger/);
    expect(
      parse('0001_a.sql', contract('DROP TABLE pbe_meta.schema_migration;')).problems.join(),
    ).toMatch(/must not modify the migration ledger/);
  });

  it('rejects a no-transaction file with more than one statement or without IF [NOT] EXISTS', () => {
    const two =
      '-- pbe:phase expand\n-- pbe:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON app.t (c);\nSELECT 1;\n';
    expect(parse('0002_x.sql', two).problems.join()).toMatch(/exactly one statement/);
    const unsafe =
      '-- pbe:phase expand\n-- pbe:no-transaction\nCREATE INDEX CONCURRENTLY i ON app.t (c);\n';
    expect(parse('0002_x.sql', unsafe).problems.join()).toMatch(/re-runnable/);
  });

  it('reports the line of the offending statement', () => {
    expect(parse('0001_a.sql', expand('CREATE SCHEMA a;\n\nBEGIN;')).problems.join()).toMatch(
      /line 4/,
    );
  });
});

describe('loadMigrations — folder checks', () => {
  it('loads a valid folder in version order and ignores README.md', () => {
    const dir = folder({
      '0002_b.sql': expand('CREATE SCHEMA b;'),
      '0001_a.sql': expand('CREATE SCHEMA a;'),
      'README.md': '# notes',
    });
    const res = loadMigrations(dir, OPTS);
    expect(res.problems).toEqual([]);
    expect(res.files.map((f) => f.version)).toEqual([1, 2]);
  });

  it('rejects a numbering gap', () => {
    const res = loadMigrations(
      folder({ '0001_a.sql': expand('SELECT 1;'), '0003_c.sql': expand('SELECT 1;') }),
      OPTS,
    );
    expect(res.problems.join()).toMatch(/numbering gap: expected version 2 but found 3/);
  });

  it('rejects a duplicate version', () => {
    const res = loadMigrations(
      folder({ '0001_a.sql': expand('SELECT 1;'), '0001_b.sql': expand('SELECT 1;') }),
      OPTS,
    );
    expect(res.problems.join()).toMatch(/duplicate version 1/);
  });

  it('rejects a numbering that does not start at 0001', () => {
    const res = loadMigrations(folder({ '0002_b.sql': expand('SELECT 1;') }), OPTS);
    expect(res.problems.join()).toMatch(/expected version 1/);
  });

  it('rejects unexpected files', () => {
    const res = loadMigrations(
      folder({ '0001_a.sql': expand('SELECT 1;'), 'notes.txt': 'x' }),
      OPTS,
    );
    expect(res.problems.join()).toMatch(/notes\.txt/);
  });

  it('reports a missing folder', () => {
    expect(loadMigrations('/nonexistent/pbe', OPTS).problems.join()).toMatch(/not found/);
  });
});
