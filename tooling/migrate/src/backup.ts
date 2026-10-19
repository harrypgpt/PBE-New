import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { ClientConfig } from 'pg';
import { DISPOSABLE_DATABASE_PATTERN } from './config';
import { backupCoverageViolations } from './conformance';
import { MigrationError } from './errors';
import { diffFingerprints, schemaFingerprint, type FingerprintDiff } from './fingerprint';
import { sha256Hex } from './migration-files';
import { DEFAULT_LEDGER_SCHEMA, LEDGER_TABLE, migrate, status } from './runner';

/**
 * Backups and verified restores (DATA_AND_DATABASE_DESIGN.md §8, ADR-020).
 *
 *  backupDatabase   pg_dump, custom format (a consistent snapshot of the source)
 *  readArchive      decodes the whole archive with pg_restore (no database needed)
 *  restoreDrill     backup → verify archive → create a temporary pbe_restore_check_<hex>
 *                   database → pg_restore → compare schema, ledger, row counts and row
 *                   contents with the source → prove the copy is usable → drop ONLY that
 *                   temporary database.
 *
 * Passwords reach pg_dump/pg_restore through a temporary 0600 password file, never through
 * arguments or output. Only databases matching DISPOSABLE_DATABASE_PATTERN can be dropped.
 */

function toolPath(binDir: string, tool: string): string {
  const exe = path.join(binDir, tool);
  if (!fs.existsSync(exe)) {
    throw new MigrationError('CONFIG', `${tool} not found in ${binDir} (set PBE_PG_BIN).`);
  }
  return exe;
}

function check(run: ReturnType<typeof spawnSync>, tool: string): void {
  if (run.status !== 0) {
    throw new MigrationError('TOOL_FAILED', `${tool} failed (exit ${run.status}).`, [
      String(run.stderr || run.error?.message || '').trim(),
    ]);
  }
}

/** Runs a PostgreSQL client tool against `conn`, passing the password via a temporary file. */
function runWithConnection(binDir: string, tool: string, conn: ClientConfig, args: string[]): void {
  const exe = toolPath(binDir, tool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-pgpass-'));
  const passFile = path.join(dir, 'pgpass');
  const esc = (v: unknown): string => String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  fs.writeFileSync(
    passFile,
    `${esc(conn.host)}:${esc(conn.port)}:${esc(conn.database)}:${esc(conn.user)}:${esc(conn.password)}\n`,
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSFILE: passFile };
  delete env.PGPASSWORD;
  // With a password, accept ONLY SCRAM-SHA-256: libpq then refuses a server that asks for the
  // password in clear text or as MD5, before anything is sent (PostgreSQL 16+ require_auth).
  if (conn.password !== undefined) env.PGREQUIREAUTH = 'scram-sha-256';
  else delete env.PGREQUIREAUTH;
  try {
    const run = spawnSync(
      exe,
      [
        '--no-password',
        '-h',
        String(conn.host),
        '-p',
        String(conn.port),
        '-U',
        String(conn.user),
        ...args,
      ],
      { encoding: 'utf8', env },
    );
    check(run, tool);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withClient<T>(
  conn: ClientConfig,
  fn: (c: pg.Client) => Promise<T>,
  ownerRole?: string,
): Promise<T> {
  const client = new pg.Client({ ...conn, application_name: 'pbe-backup' });
  client.on('error', () => undefined);
  await client.connect();
  try {
    if (ownerRole) await client.query(`SET ROLE ${client.escapeIdentifier(ownerRole)}`);
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Backup and archive inspection

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
}

/** Backups contain everything (hashes, encrypted MFA secrets, personal data): owner-only access. */
export const BACKUP_DIR_MODE = 0o700;
export const BACKUP_FILE_MODE = 0o600;

/**
 * pg_dump in custom format. pg_dump reads inside one transaction, so the archive is a
 * consistent snapshot. `excludeSchemas` takes pg_dump patterns (e.g. "zz_test_*").
 *
 * `dumpRole`: null when `conn` is the dedicated backup login (pbe_backup, BYPASSRLS, reads as
 * itself); otherwise the role pg_dump switches to (legacy: pbe_migrator → pbe_owner). Without a
 * bypass, tables with FORCED row-level security make pg_dump FAIL — never a silently empty copy.
 *
 * Safety (STAGE-07A-BACKUP-REVIEW.md F-5, F-6):
 *  - the folder is made owner-only (0700) and the file is created owner-only (0600) BEFORE
 *    pg_dump writes to it, so no other local account can read it at any moment;
 *  - pg_dump writes to a temporary "*.partial-<hex>" name; the archive is then decoded in full;
 *    only then is it renamed to the final name. On any failure the partial file is removed, so
 *    an incomplete backup can never appear under a completed name;
 *  - an existing file is never overwritten.
 */
export function backupDatabase(
  binDir: string,
  conn: ClientConfig,
  outFile: string,
  dumpRole: string | null,
  excludeSchemas: readonly string[] = [],
): BackupResult {
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
  fs.chmodSync(dir, BACKUP_DIR_MODE);
  if (fs.existsSync(outFile)) {
    throw new MigrationError(
      'UNSAFE_TARGET',
      `Refusing to overwrite an existing backup: ${outFile}`,
    );
  }
  const partial = `${outFile}.partial-${randomBytes(4).toString('hex')}`;
  // Created empty and owner-only first; pg_dump then writes into it (mode is kept).
  fs.closeSync(fs.openSync(partial, 'wx', BACKUP_FILE_MODE));
  try {
    runWithConnection(binDir, 'pg_dump', conn, [
      '--format=custom',
      ...(dumpRole ? [`--role=${dumpRole}`] : []),
      ...excludeSchemas.map((s) => `--exclude-schema=${s}`),
      '--file',
      partial,
      '--dbname',
      String(conn.database),
    ]);
    readArchive(binDir, partial); // must decode completely before it may be called a backup
    if (fs.existsSync(outFile)) {
      throw new MigrationError(
        'UNSAFE_TARGET',
        `Refusing to overwrite an existing backup: ${outFile}`,
      );
    }
    fs.renameSync(partial, outFile);
    fs.chmodSync(outFile, BACKUP_FILE_MODE);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  const content = fs.readFileSync(outFile);
  return { file: outFile, bytes: content.length, sha256: sha256Hex(content) };
}

export interface ArchiveContents {
  schemas: Set<string>;
  /** "schema.table" → number of data rows in the archive. */
  rows: Map<string, number>;
  /** Ledger rows as "version|name|checksum". */
  ledger: string[];
  tocEntries: number;
}

/** Decodes a custom-format archive with pg_restore (no database connection needed). */
export function readArchive(binDir: string, file: string): ArchiveContents {
  const exe = toolPath(binDir, 'pg_restore');
  const list = spawnSync(exe, ['--list', file], { encoding: 'utf8' });
  check(list, 'pg_restore --list');
  const tocLines = list.stdout.split('\n').filter((l) => /^\d+;/.test(l));
  const schemas = new Set<string>();
  for (const l of tocLines) {
    const m = /^\d+; \d+ \d+ SCHEMA - (\S+) /.exec(l);
    if (m?.[1]) schemas.add(m[1]);
  }
  // Convert the whole archive to SQL text: this reads and decompresses every byte of data.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-archive-'));
  const script = path.join(dir, 'restore.sql');
  try {
    check(spawnSync(exe, ['--file', script, file], { encoding: 'utf8' }), 'pg_restore --file');
    const rows = new Map<string, number>();
    const ledger: string[] = [];
    let current: { table: string; columns: string[] } | null = null;
    for (const line of fs.readFileSync(script, 'utf8').split('\n')) {
      if (current) {
        if (line === '\\.') {
          current = null;
          continue;
        }
        rows.set(current.table, (rows.get(current.table) ?? 0) + 1);
        if (current.table === `${DEFAULT_LEDGER_SCHEMA}.${LEDGER_TABLE}`) {
          const values = line.split('\t');
          const columns = current.columns;
          const col = (name: string): string => values[columns.indexOf(name)] ?? '';
          ledger.push(`${col('version')}|${col('name')}|${col('checksum_sha256')}`);
        }
        continue;
      }
      const copy = /^COPY ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) \((.*)\) FROM stdin;$/.exec(line);
      if (copy) {
        current = {
          table: `${copy[1]}.${copy[2]}`,
          columns: (copy[3] ?? '').split(', ').map((c) => c.replace(/"/g, '')),
        };
        rows.set(current.table, rows.get(current.table) ?? 0);
      }
    }
    return { schemas, rows, ledger, tocEntries: tocLines.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Database comparison

interface DatabaseState {
  fingerprint: string[];
  ledger: string[];
  /** "schema.table" → { rows, md5 of all row contents in a fixed order } */
  tables: Map<string, { rows: number; md5: string }>;
}

/**
 * Row count and content checksum of every table in `schemas`, read so that row-level security can
 * NEVER silently hide rows (STAGE-07A-BACKUP-REVIEW.md F-4):
 *  - always with `row_security = off`: if any policy would still filter the reading role,
 *    PostgreSQL raises an error instead of returning fewer (or zero) rows;
 *  - `ownerOfCopy`: the reader owns the tables (the restore role in its temporary copy). Inside a
 *    transaction that is ALWAYS rolled back, FORCE ROW LEVEL SECURITY is switched off on the
 *    forced tables so the owner sees every row; the copy itself is left exactly as it was.
 *  - otherwise the reader must bypass row-level security (the backup login) or the read fails.
 */
export async function readTableContents(
  c: pg.Client,
  schemas: readonly string[],
  options: { ownerOfCopy: boolean },
): Promise<Map<string, { rows: number; md5: string }>> {
  const tables = new Map<string, { rows: number; md5: string }>();
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL row_security = off');
    const list = await c.query<{ nspname: string; relname: string; forced: boolean }>(
      `SELECT n.nspname, c.relname, c.relforcerowsecurity AS forced FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
      [schemas],
    );
    for (const r of list.rows) {
      const qualified = `${c.escapeIdentifier(r.nspname)}.${c.escapeIdentifier(r.relname)}`;
      if (options.ownerOfCopy && r.forced) {
        await c.query(`ALTER TABLE ${qualified} NO FORCE ROW LEVEL SECURITY`);
      }
      const res = await c.query<{ n: string; h: string | null }>(
        `SELECT count(*) AS n, md5(string_agg(t::text, E'\\n' ORDER BY t::text)) AS h FROM ${qualified} t`,
      );
      tables.set(`${r.nspname}.${r.relname}`, {
        rows: Number(res.rows[0]?.n ?? 0),
        md5: res.rows[0]?.h ?? 'empty',
      });
    }
  } finally {
    await c.query('ROLLBACK'); // also undoes any NO FORCE on the copy
  }
  return tables;
}

async function readState(
  conn: ClientConfig,
  schemas: readonly string[],
  rename: Readonly<Record<string, string>>,
  ownerOfCopy: boolean,
): Promise<DatabaseState> {
  return withClient(conn, async (c) => {
    const fingerprint = await schemaFingerprint(c, schemas, rename);
    let ledger: string[] = [];
    const present = await c.query<{ p: boolean }>(
      'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS p',
      [`${DEFAULT_LEDGER_SCHEMA}.${LEDGER_TABLE}`],
    );
    if (present.rows[0]?.p) {
      const res = await c.query<{ v: number; name: string; ck: string; at: Date }>(
        `SELECT version AS v, name, checksum_sha256 AS ck, applied_at AS at
           FROM ${DEFAULT_LEDGER_SCHEMA}.${LEDGER_TABLE} ORDER BY version`,
      );
      ledger = res.rows.map((r) => `${r.v}|${r.name}|${r.ck}|${r.at.toISOString()}`);
    }
    const tables = await readTableContents(c, schemas, { ownerOfCopy });
    return { fingerprint, ledger, tables };
  });
}

export interface ComparisonReport {
  ok: boolean;
  fingerprint: FingerprintDiff;
  fingerprintEntries: number;
  ledger: { equal: boolean; source: number; target: number };
  tables: Array<{
    table: string;
    sourceRows: number;
    targetRows: number | null;
    contentEqual: boolean;
  }>;
}

/**
 * Same schema, same ledger rows, same row count and same row contents in every table.
 * `targetRename` maps role names in the target's catalogue before comparing (a restored copy
 * is owned by the restore role instead of pbe_owner; nothing else is renamed).
 */
export async function compareDatabases(
  source: ClientConfig,
  target: ClientConfig,
  schemas: readonly string[],
  targetRename: Readonly<Record<string, string>> = {},
  options: { targetIsOwnedCopy?: boolean } = {},
): Promise<ComparisonReport> {
  // Source: read as itself with row_security off (the backup login bypasses RLS; any other role
  // gets an error on forced tables). Target: the restore role's own temporary copy.
  const [src, dst] = await Promise.all([
    readState(source, schemas, {}, false),
    readState(target, schemas, targetRename, options.targetIsOwnedCopy ?? true),
  ]);
  const fingerprint = diffFingerprints(src.fingerprint, dst.fingerprint);
  const ledgerEqual = src.ledger.join('\n') === dst.ledger.join('\n');
  const names = [...new Set([...src.tables.keys(), ...dst.tables.keys()])].sort();
  const tables = names.map((table) => {
    const a = src.tables.get(table);
    const b = dst.tables.get(table);
    return {
      table,
      sourceRows: a?.rows ?? 0,
      targetRows: b?.rows ?? null,
      contentEqual: !!a && !!b && a.rows === b.rows && a.md5 === b.md5,
    };
  });
  return {
    ok: fingerprint.equal && ledgerEqual && tables.every((t) => t.contentEqual),
    fingerprint,
    fingerprintEntries: src.fingerprint.length,
    ledger: { equal: ledgerEqual, source: src.ledger.length, target: dst.ledger.length },
    tables,
  };
}

// ---------------------------------------------------------------------------------------------
// Temporary databases (ADR-020)
//
// Created, restored into and dropped ONLY as the dedicated restore role (pbe_restore_drill).
// That role is not a member of pbe_owner, so PostgreSQL itself stops it from dropping or reading
// pbe_dev and pbe_test; it can drop only databases it owns. The name check below is a second,
// independent safeguard.

export function assertDisposable(name: string): void {
  if (!DISPOSABLE_DATABASE_PATTERN.test(name)) {
    throw new MigrationError(
      'UNSAFE_TARGET',
      `Refusing to create or drop "${name}": only temporary pbe_restore_check_<10 hex> databases are allowed.`,
    );
  }
}

/** Creates a new, empty temporary database owned by the restore role, with no PUBLIC access. */
export async function createDisposableDatabase(restore: ClientConfig): Promise<string> {
  const name = `pbe_restore_check_${randomBytes(5).toString('hex')}`;
  assertDisposable(name);
  await withClient(restore, async (c) => {
    await c.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
    await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  });
  return name;
}

/** Drops a temporary database owned by the restore role. Refuses any other name or owner. */
export async function dropDisposableDatabase(restore: ClientConfig, name: string): Promise<void> {
  assertDisposable(name);
  await withClient(restore, async (c) => {
    const owner = await c.query<{ o: string; me: string }>(
      'SELECT pg_catalog.pg_get_userbyid(datdba) AS o, current_user AS me FROM pg_catalog.pg_database WHERE datname = $1',
      [name],
    );
    const row = owner.rows[0];
    if (!row) return;
    if (row.o !== row.me) {
      throw new MigrationError(
        'UNSAFE_TARGET',
        `Refusing to drop "${name}": not owned by ${row.me}.`,
      );
    }
    await c.query(`DROP DATABASE ${name}`);
  });
}

/**
 * pg_restore of `file` into an existing, empty temporary database, as the restore role.
 * --no-owner: objects are owned by the restore role (it cannot act as pbe_owner).
 */
export function restoreInto(binDir: string, target: ClientConfig, file: string): void {
  assertDisposable(String(target.database));
  runWithConnection(binDir, 'pg_restore', target, [
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--dbname',
    String(target.database),
    file,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Comparing two backup files (no access to the source databases needed)

export interface BackupFilesComparison {
  ok: boolean;
  /** Ledger versions found in each file. */
  ledger: { first: number[]; second: number[] };
  tables: Array<{
    table: string;
    firstRows: number | null;
    secondRows: number | null;
    contentEqual: boolean;
  }>;
}

/**
 * Restores two backup files into two temporary databases (as the restore role, as in the drill),
 * then compares the DATA of every table in `schemas`, except the migration ledger, which is
 * reported separately. Tables present in only one file count as a difference unless they are
 * listed in `onlyInSecond` (tables the second file is EXPECTED to add, e.g. by a migration).
 * Both temporary databases are always dropped. Used to prove that a backup taken after a
 * grants-only migration holds exactly the same data as the backup taken before it.
 */
export async function compareBackupFiles(options: {
  binDir: string;
  restore: ClientConfig;
  first: string;
  second: string;
  schemas: readonly string[];
  onlyInSecond?: readonly string[];
}): Promise<BackupFilesComparison> {
  const ledgerTable = `${DEFAULT_LEDGER_SCHEMA}.${LEDGER_TABLE}`;
  const names: string[] = [];
  try {
    const read = async (file: string) => {
      const name = await createDisposableDatabase(options.restore);
      names.push(name);
      const target: ClientConfig = { ...options.restore, database: name };
      restoreInto(options.binDir, target, file);
      return withClient(target, async (c) => {
        const tables = await readTableContents(c, options.schemas, { ownerOfCopy: true });
        const present = await c.query<{ p: boolean }>(
          'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS p',
          [ledgerTable],
        );
        const ledger = present.rows[0]?.p
          ? (
              await c.query<{ v: number }>(`SELECT version AS v FROM ${ledgerTable} ORDER BY 1`)
            ).rows.map((r) => r.v)
          : [];
        return { tables, ledger };
      });
    };
    const a = await read(options.first);
    const b = await read(options.second);
    const expectedNew = new Set(options.onlyInSecond ?? []);
    const all = [...new Set([...a.tables.keys(), ...b.tables.keys()])]
      .filter((t) => t !== ledgerTable)
      .sort();
    const tables = all.map((table) => {
      const x = a.tables.get(table);
      const y = b.tables.get(table);
      const contentEqual =
        x && y ? x.rows === y.rows && x.md5 === y.md5 : !x && !!y && expectedNew.has(table);
      return {
        table,
        firstRows: x?.rows ?? null,
        secondRows: y?.rows ?? null,
        contentEqual,
      };
    });
    return {
      ok: tables.every((t) => t.contentEqual),
      ledger: { first: a.ledger, second: b.ledger },
      tables,
    };
  } finally {
    for (const n of names) await dropDisposableDatabase(options.restore, n);
  }
}

// ---------------------------------------------------------------------------------------------
// Restore drill

export interface RestoreDrillReport {
  ok: boolean;
  source: string;
  backup: BackupResult;
  archive: { tocEntries: number; schemas: string[]; ledgerRows: number };
  restoredInto: string;
  comparison: ComparisonReport;
  usable: { statusOk: boolean; pending: number; migrateApplied: number; writeReadOk: boolean };
  /** True if the temporary database was dropped; false if kept for diagnosis. */
  cleanedUp: boolean;
}

export async function restoreDrill(options: {
  binDir: string;
  /** Source database: the backup login (pbe_backup) or, legacy, pbe_migrator (read-only use). */
  source: ClientConfig;
  /** pg_dump --role: null for the backup login; legacy: the owner role. */
  dumpRole: string | null;
  /** The restore role's connection (to pbe_test); used to create, restore into and drop. */
  restore: ClientConfig;
  ownerRole: string;
  migrationsDir: string;
  schemas: readonly string[];
  backupFile: string;
  excludeSchemas?: readonly string[];
  /** Keep the temporary database when verification fails (default true). */
  keepOnFailure?: boolean;
  /**
   * The backup login: before anything is backed up, every required table must be readable by it
   * and no PBE-owned schema may lie outside `schemas` (backupCoverageViolations). Omit only for
   * the legacy path and test fixtures.
   */
  coverageRole?: string;
  log?: (line: string) => void;
}): Promise<RestoreDrillReport> {
  const log = options.log ?? (() => undefined);
  const keepOnFailure = options.keepOnFailure ?? true;

  // 0. Coverage: refuse a drill whose backup could miss or not verify some PBE data.
  if (options.coverageRole !== undefined) {
    const role = options.coverageRole;
    const problems = await withClient(options.source, (c) =>
      backupCoverageViolations(c, role, options.ownerRole),
    );
    if (problems.length > 0) {
      throw new MigrationError(
        'UNSAFE_TARGET',
        `Backup coverage check failed: ${role} cannot read or verify everything. Nothing was backed up.`,
        problems,
      );
    }
  }

  // 1. Consistent backup of the source.
  const backup = backupDatabase(
    options.binDir,
    options.source,
    options.backupFile,
    options.dumpRole,
    options.excludeSchemas ?? [],
  );
  log(`backup: ${backup.file} (${backup.bytes} bytes, sha256 ${backup.sha256})`);

  // 2. Verify the artifact (decodes every byte).
  const archive = readArchive(options.binDir, backup.file);
  log(`archive: ${archive.tocEntries} TOC entries, ${archive.ledger.length} ledger rows`);

  // 3. Restore into a brand-new temporary database (as the restore role).
  const name = await createDisposableDatabase(options.restore);
  const target: ClientConfig = { ...options.restore, database: name };
  log(`created temporary database ${name}`);
  let ok = false;
  let cleanedUp = false;
  let report: Omit<RestoreDrillReport, 'cleanedUp'>;
  try {
    restoreInto(options.binDir, target, backup.file);
    log('pg_restore completed');

    // 4. Same schema, ledger, row counts and row contents as the source.
    const comparison = await compareDatabases(options.source, target, options.schemas, {
      [String(options.restore.user)]: options.ownerRole,
    });
    log(`comparison: ${comparison.ok ? 'identical' : 'DIFFERENT'}`);

    // 5. Usable: the runner accepts it, nothing is pending, and it accepts a write
    //    (inside a transaction that is rolled back, so the copy stays identical).
    const runnerOptions = {
      connection: target,
      migrationsDir: options.migrationsDir,
      ownerRole: null,
    };
    const st = await status(runnerOptions);
    const mig = await migrate(runnerOptions);
    const writeReadOk = await withClient(target, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('CREATE TABLE pbe_meta.zz_restore_probe (id integer)');
        await c.query('INSERT INTO pbe_meta.zz_restore_probe VALUES (42)');
        const r = await c.query<{ id: number }>('SELECT id FROM pbe_meta.zz_restore_probe');
        return r.rows[0]?.id === 42;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const usable = {
      statusOk: st.ok,
      pending: st.pending,
      migrateApplied: mig.applied.length,
      writeReadOk,
    };
    ok =
      comparison.ok &&
      usable.statusOk &&
      usable.pending === 0 &&
      usable.migrateApplied === 0 &&
      usable.writeReadOk;
    report = {
      ok,
      source: String(options.source.database),
      backup,
      archive: {
        tocEntries: archive.tocEntries,
        schemas: [...archive.schemas].sort(),
        ledgerRows: archive.ledger.length,
      },
      restoredInto: name,
      comparison,
      usable,
    };
  } finally {
    // 6. Clean up only the database this drill created (kept on failure for diagnosis).
    if (ok || !keepOnFailure) {
      await dropDisposableDatabase(options.restore, name);
      cleanedUp = true;
      log(`dropped temporary database ${name}`);
    } else {
      log(`verification failed: temporary database ${name} KEPT for diagnosis`);
    }
  }
  return { ...report, cleanedUp };
}
