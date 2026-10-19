import { createHash } from 'node:crypto';
import pg from 'pg';
import type { ClientConfig } from 'pg';
import { MigrationError, type MigrationErrorCode } from './errors';
import { backupCoverageViolations } from './conformance';
import { loadMigrations, type MigrationFile } from './migration-files';

/**
 * PBE SQL migration runner (ADR-004, ADR-018). Requirements:
 * docs/architecture/DATA_AND_DATABASE_DESIGN.md §7.3.
 */
export const RUNNER_VERSION = '1.0.0';
export const DEFAULT_LEDGER_SCHEMA = 'pbe_meta';
export const LEDGER_TABLE = 'schema_migration';
export const REQUIRED_SERVER_MAJOR = 18;

export interface RunnerOptions {
  connection: ClientConfig;
  migrationsDir: string;
  /** Schema holding the ledger table. Default "pbe_meta". Also scopes the advisory lock. */
  ledgerSchema?: string;
  /** Role to SET before creating objects so they are owned by it. Default "pbe_owner"; null = none. */
  ownerRole?: string | null;
  /** How long to wait for another runner to finish. Default 30 s. */
  lockTimeoutMs?: number;
  /** lock_timeout applied while each migration runs. Default 10 s. */
  statementLockTimeoutMs?: number;
  /** Contract-phase (destructive) migrations are refused unless this is true. */
  allowContract?: boolean;
  /**
   * Role that must be able to read everything a backup needs (STAGE-07A-BACKUP-REVIEW.md §17).
   * From BACKUP_COVERAGE_FROM_VERSION on, each migration must leave backupCoverageViolations
   * empty, or it is rolled back. Default: "pbe_backup" for the real ledger ("pbe_meta"), none for
   * other ledgers (test fixtures). null = no check.
   */
  backupRole?: string | null;
  log?: (line: string) => void;
}

/** Migration 0005 grants the backup role its read access; the coverage rule applies from there. */
export const BACKUP_COVERAGE_FROM_VERSION = 5;

export interface LedgerRow {
  version: number;
  name: string;
  checksum_sha256: string;
  phase: string;
  transactional: boolean;
  applied_at: Date;
  applied_by: string;
  execution_ms: number;
  runner_version: string;
}

export type EntryState = 'applied' | 'pending' | 'modified' | 'missing-file' | 'name-mismatch';

export interface StatusEntry {
  version: number;
  name: string;
  state: EntryState;
  phase?: string;
  checksum?: string;
  appliedAt?: Date;
}

export interface StatusReport {
  database: string;
  user: string;
  ledgerExists: boolean;
  entries: StatusEntry[];
  problems: string[];
  pending: number;
  ok: boolean;
}

export interface MigrateResult {
  database: string;
  applied: Array<{ version: number; fileName: string; executionMs: number }>;
  alreadyApplied: number;
}

export interface SessionFacts {
  serverVersionNum: number;
  isSuperuser: boolean;
  bypassRls: boolean;
  user: string;
  database: string;
}

interface LedgerProblem {
  code: MigrationErrorCode;
  message: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function assertIdentifier(value: string, what: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new MigrationError('CONFIG', `${what} "${value}" is not a plain lower-case identifier.`);
  }
}

/** Advisory-lock key, derived from the ledger schema so separate ledgers never block each other. */
export function advisoryLockKey(ledgerSchema: string): string {
  return createHash('sha256')
    .update(`pbe-migrations:${ledgerSchema}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

/** Refuses unsupported servers and over-privileged sessions (least privilege, ADR-017). */
export function assertSafeSession(facts: SessionFacts): void {
  const major = Math.floor(facts.serverVersionNum / 10000);
  if (major !== REQUIRED_SERVER_MAJOR) {
    throw new MigrationError(
      'UNSUPPORTED_SERVER',
      `PostgreSQL ${REQUIRED_SERVER_MAJOR} is required (ADR-017); the server is major version ${major}.`,
    );
  }
  if (facts.isSuperuser) {
    throw new MigrationError(
      'UNSAFE_SESSION',
      `Refusing to run as superuser "${facts.user}". Connect as pbe_migrator.`,
    );
  }
  if (facts.bypassRls) {
    throw new MigrationError(
      'UNSAFE_SESSION',
      `Refusing to run as "${facts.user}", which has BYPASSRLS.`,
    );
  }
}

/** Compares the ledger with the files. Pure: used by both status and migrate. */
export function compareLedger(
  files: readonly MigrationFile[],
  ledger: readonly LedgerRow[],
): { entries: StatusEntry[]; problems: LedgerProblem[]; pending: MigrationFile[] } {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const entries: StatusEntry[] = [];
  const problems: LedgerProblem[] = [];
  const sorted = [...ledger].sort((a, b) => a.version - b.version);
  sorted.forEach((row, i) => {
    if (row.version !== i + 1) {
      problems.push({
        code: 'LEDGER_INCONSISTENT',
        message: `ledger has version ${row.version} where ${i + 1} was expected`,
      });
    }
    const file = byVersion.get(row.version);
    const base = {
      version: row.version,
      name: row.name,
      phase: row.phase,
      appliedAt: row.applied_at,
    };
    if (!file) {
      entries.push({ ...base, state: 'missing-file' });
      problems.push({
        code: 'MISSING_FILE',
        message: `applied migration ${row.version} (${row.name}) has no file; restore it from git history`,
      });
    } else if (file.name !== row.name) {
      entries.push({ ...base, state: 'name-mismatch' });
      problems.push({
        code: 'NAME_MISMATCH',
        message: `applied migration ${row.version} was "${row.name}" but the file is now ${file.fileName}`,
      });
    } else if (file.checksum !== row.checksum_sha256) {
      entries.push({ ...base, state: 'modified', checksum: file.checksum });
      problems.push({
        code: 'CHECKSUM_MISMATCH',
        message: `applied migration ${file.fileName} was modified (ledger ${row.checksum_sha256.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…); restore the original and put the change in a new file`,
      });
    } else {
      entries.push({ ...base, state: 'applied', checksum: file.checksum });
    }
  });
  const maxApplied = sorted.length ? Math.max(...sorted.map((r) => r.version)) : 0;
  const appliedVersions = new Set(sorted.map((r) => r.version));
  const pending: MigrationFile[] = [];
  for (const file of files) {
    if (file.version > maxApplied) {
      pending.push(file);
      entries.push({
        version: file.version,
        name: file.name,
        state: 'pending',
        phase: file.phase,
        checksum: file.checksum,
      });
    } else if (!appliedVersions.has(file.version)) {
      problems.push({
        code: 'LEDGER_INCONSISTENT',
        message: `${file.fileName} is numbered below the last applied migration but was never applied`,
      });
    }
  }
  const order: MigrationErrorCode[] = [
    'MISSING_FILE',
    'NAME_MISMATCH',
    'CHECKSUM_MISMATCH',
    'LEDGER_INCONSISTENT',
  ];
  problems.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  entries.sort((a, b) => a.version - b.version);
  return { entries, problems, pending };
}

function connect(options: RunnerOptions, purpose: string): pg.Client {
  const ledgerSchema = options.ledgerSchema ?? DEFAULT_LEDGER_SCHEMA;
  const client = new pg.Client({
    ...options.connection,
    application_name: `pbe-migrate:${purpose}:${ledgerSchema}`,
  });
  // A terminated backend emits 'error' on the client; the pending query rejects as well,
  // so swallow the event here to avoid crashing the process.
  client.on('error', () => undefined);
  return client;
}

async function readSessionFacts(client: pg.Client): Promise<SessionFacts> {
  const { rows } = await client.query<{
    v: number;
    rolsuper: boolean;
    rolbypassrls: boolean;
    su: string;
    db: string;
  }>(
    `SELECT current_setting('server_version_num')::int AS v, r.rolsuper, r.rolbypassrls,
            session_user AS su, current_database() AS db
       FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`,
  );
  const row = rows[0];
  if (!row) throw new MigrationError('UNSAFE_SESSION', 'Could not read the session role.');
  return {
    serverVersionNum: row.v,
    isSuperuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    user: row.su,
    database: row.db,
  };
}

function ledgerName(client: pg.Client, schema: string): string {
  return `${client.escapeIdentifier(schema)}.${client.escapeIdentifier(LEDGER_TABLE)}`;
}

async function ledgerExists(client: pg.Client, schema: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present',
    [`${schema}.${LEDGER_TABLE}`],
  );
  return rows[0]?.present === true;
}

async function readLedger(client: pg.Client, schema: string): Promise<LedgerRow[]> {
  const { rows } = await client.query<LedgerRow>(
    `SELECT version, name, checksum_sha256, phase, transactional, applied_at, applied_by,
            execution_ms, runner_version
       FROM ${ledgerName(client, schema)} ORDER BY version`,
  );
  return rows;
}

async function ensureLedger(client: pg.Client, schema: string): Promise<void> {
  const ledger = ledgerName(client, schema);
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${client.escapeIdentifier(schema)}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${ledger} (
        version         integer     PRIMARY KEY CHECK (version > 0),
        name            text        NOT NULL,
        checksum_sha256 text        NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        phase           text        NOT NULL CHECK (phase IN ('expand', 'migrate', 'contract')),
        transactional   boolean     NOT NULL,
        applied_at      timestamptz NOT NULL DEFAULT now(),
        applied_by      text        NOT NULL DEFAULT session_user,
        execution_ms    integer     NOT NULL CHECK (execution_ms >= 0),
        runner_version  text        NOT NULL
      )`);
    await client.query(
      `COMMENT ON TABLE ${ledger} IS 'PBE migration ledger. Written only by the migration runner (ADR-018).'`,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(client: pg.Client, key: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS locked',
      [key],
    );
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(
        'LOCK_TIMEOUT',
        `Another migration run holds the lock (waited ${timeoutMs} ms). Nothing was applied.`,
      );
    }
    await sleep(200);
  }
}

function lineOf(sql: string, position: unknown): string {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 1) return '';
  return ` at line ${sql.slice(0, pos - 1).split('\n').length}`;
}

function failure(file: MigrationFile, err: unknown): MigrationError {
  const e = err as { code?: string; message?: string; position?: string };
  const where = lineOf(file.sql, e.position);
  const outcome = file.transactional
    ? 'was rolled back (no part of it was kept)'
    : 'was not recorded; it ran outside a transaction, so check for partial effects such as an INVALID index';
  return new MigrationError(
    'MIGRATION_FAILED',
    `Migration ${file.fileName} failed and ${outcome}. Later migrations were not attempted.`,
    err instanceof MigrationError
      ? [err.message, ...err.details]
      : [`SQLSTATE ${e.code ?? 'unknown'}${where}: ${e.message ?? String(err)}`],
  );
}

async function recordInLedger(
  client: pg.Client,
  schema: string,
  file: MigrationFile,
  ms: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${ledgerName(client, schema)}
       (version, name, checksum_sha256, phase, transactional, execution_ms, runner_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [file.version, file.name, file.checksum, file.phase, file.transactional, ms, RUNNER_VERSION],
  );
}

async function assertBackupCoverage(
  client: pg.Client,
  file: MigrationFile,
  backupRole: string | null,
  ownerRole: string | null,
): Promise<void> {
  if (backupRole === null || file.version < BACKUP_COVERAGE_FROM_VERSION) return;
  const problems = await backupCoverageViolations(client, backupRole, ownerRole);
  if (problems.length > 0) {
    throw new MigrationError(
      'MIGRATION_FAILED',
      `${file.fileName} leaves data the backup login (${backupRole}) cannot read or verify. Grant SELECT to ${backupRole} in the same migration.`,
      problems,
    );
  }
}

async function applyOne(
  client: pg.Client,
  schema: string,
  file: MigrationFile,
  lockTimeoutMs: number,
  backupRole: string | null,
  ownerRole: string | null,
): Promise<number> {
  const started = Date.now();
  if (file.transactional) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      // Objects must be schema-qualified; nothing resolves through a mutable search_path.
      await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
      await client.query(file.sql);
      await assertBackupCoverage(client, file, backupRole, ownerRole);
      const ms = Date.now() - started;
      await recordInLedger(client, schema, file, ms);
      await client.query('COMMIT');
      return ms;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure(file, err);
    }
  }
  await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  await client.query('SET search_path = pg_catalog, pg_temp');
  try {
    await client.query(file.sql);
  } catch (err) {
    throw failure(file, err);
  } finally {
    await client.query('RESET lock_timeout').catch(() => undefined);
    await client.query('RESET search_path').catch(() => undefined);
  }
  // A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind, and a re-run with
  // IF NOT EXISTS would silently skip it. Never record a no-transaction migration while any
  // invalid index exists.
  const invalid = await client.query<{ idx: string }>(
    `SELECT n.nspname || '.' || c.relname AS idx
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`,
  );
  if (invalid.rows.length > 0) {
    throw new MigrationError(
      'MIGRATION_FAILED',
      `Migration ${file.fileName} was not recorded: INVALID indexes exist. Drop them (DROP INDEX CONCURRENTLY), fix the cause and re-run.`,
      invalid.rows.map((r) => `invalid index: ${r.idx}`),
    );
  }
  await assertBackupCoverage(client, file, backupRole, ownerRole);
  const ms = Date.now() - started;
  await recordInLedger(client, schema, file, ms);
  return ms;
}

/** Read-only report of applied, pending and problem migrations. Never creates the ledger. */
export async function status(options: RunnerOptions): Promise<StatusReport> {
  const schema = options.ledgerSchema ?? DEFAULT_LEDGER_SCHEMA;
  assertIdentifier(schema, 'Ledger schema');
  const loaded = loadMigrations(options.migrationsDir, { ledgerSchema: schema });
  const client = connect(options, 'status');
  await client.connect();
  try {
    const facts = await readSessionFacts(client);
    assertSafeSession(facts);
    const exists = await ledgerExists(client, schema);
    const ledger = exists ? await readLedger(client, schema) : [];
    const cmp = compareLedger(loaded.files, ledger);
    const problems = [...loaded.problems, ...cmp.problems.map((p) => p.message)];
    return {
      database: facts.database,
      user: facts.user,
      ledgerExists: exists,
      entries: cmp.entries,
      problems,
      pending: cmp.pending.length,
      ok: problems.length === 0,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Applies all pending migrations in order, one transaction per file, under an advisory lock. */
export async function migrate(options: RunnerOptions): Promise<MigrateResult> {
  const schema = options.ledgerSchema ?? DEFAULT_LEDGER_SCHEMA;
  assertIdentifier(schema, 'Ledger schema');
  const ownerRole = options.ownerRole === undefined ? 'pbe_owner' : options.ownerRole;
  if (ownerRole !== null) assertIdentifier(ownerRole, 'Owner role');
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  const statementLockTimeoutMs = Math.trunc(options.statementLockTimeoutMs ?? 10_000);
  const log = options.log ?? (() => undefined);
  const backupRole =
    options.backupRole !== undefined
      ? options.backupRole
      : schema === DEFAULT_LEDGER_SCHEMA
        ? 'pbe_backup'
        : null;

  // 1. Validate every file before touching the database.
  const loaded = loadMigrations(options.migrationsDir, { ledgerSchema: schema });
  if (loaded.problems.length > 0) {
    throw new MigrationError(
      'INVALID_FILES',
      'Migration files failed validation. Nothing was applied.',
      loaded.problems,
    );
  }

  const client = connect(options, 'migrate');
  await client.connect();
  try {
    // 2. Refuse unsafe sessions and unsupported servers.
    const facts = await readSessionFacts(client);
    assertSafeSession(facts);
    if (ownerRole !== null) await client.query(`SET ROLE ${client.escapeIdentifier(ownerRole)}`);

    // 3. Only one runner at a time per ledger.
    const key = advisoryLockKey(schema);
    await acquireLock(client, key, lockTimeoutMs);
    try {
      // 4. Ledger and integrity checks (all before applying anything).
      await ensureLedger(client, schema);
      const ledger = await readLedger(client, schema);
      const cmp = compareLedger(loaded.files, ledger);
      const firstProblem = cmp.problems[0];
      if (firstProblem) {
        throw new MigrationError(
          firstProblem.code,
          'The migration ledger does not match the migration files. Nothing was applied.',
          cmp.problems.map((p) => p.message),
        );
      }
      const contract = cmp.pending.filter((f) => f.phase === 'contract');
      if (contract.length > 0 && !options.allowContract) {
        throw new MigrationError(
          'CONTRACT_NOT_ALLOWED',
          'Pending contract-phase (destructive) migrations need --allow-contract after a verified backup. Nothing was applied.',
          contract.map((f) => f.fileName),
        );
      }

      // 5. Apply in order; stop at the first failure.
      const applied: MigrateResult['applied'] = [];
      for (const file of cmp.pending) {
        const executionMs = await applyOne(
          client,
          schema,
          file,
          statementLockTimeoutMs,
          backupRole,
          ownerRole,
        );
        applied.push({ version: file.version, fileName: file.fileName, executionMs });
        log(`applied ${file.fileName} (${executionMs} ms)`);
      }
      return { database: facts.database, applied, alreadyApplied: ledger.length };
    } finally {
      await client
        .query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [key])
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
