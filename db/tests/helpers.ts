import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { ClientConfig } from 'pg';
import {
  clientConfig,
  findRepoRoot,
  loadDbEnv,
  OWNER_ROLE,
  TEST_SCHEMA_PATTERN,
} from '../../tooling/migrate/src/config';
import { sha256Hex } from '../../tooling/migrate/src/migration-files';
import type { LedgerRow, RunnerOptions } from '../../tooling/migrate/src/runner';

/*
 * ADR-020: database tests run in pbe_test. Every connection helper here refuses any database
 * not named *_test. pbe_dev is only ever reached through devReadOnly(), which opens a
 * READ ONLY transaction, so no test can change development data.
 */

export const ROOT = findRepoRoot(__dirname);
export const ENV = loadDbEnv(ROOT);

/** Connection to the TEST database (pbe_test). */
export function dbConfig(role: 'migrator' | 'app'): ClientConfig {
  const config = clientConfig(ENV, 'test', role);
  if (!String(config.database).endsWith('_test')) {
    throw new Error(`Database tests only run against a *_test database, not "${config.database}".`);
  }
  return config;
}

export function assertTestSchema(name: string): string {
  if (!TEST_SCHEMA_PATTERN.test(name)) {
    throw new Error(
      `Refusing to touch schema "${name}": scratch tests may only use zz_test_* schemas.`,
    );
  }
  return name;
}

export async function withClient<T>(
  config: ClientConfig,
  fn: (client: pg.Client) => Promise<T>,
  options: { asOwner?: boolean } = {},
): Promise<T> {
  const client = new pg.Client(config);
  client.on('error', () => undefined);
  await client.connect();
  try {
    if (options.asOwner) await client.query(`SET ROLE ${OWNER_ROLE}`);
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The backup login (pbe_backup: read-only, BYPASSRLS), connected to pbe_test. */
export function backupConfig(): ClientConfig {
  const config = clientConfig(ENV, 'test', 'backup');
  if (!String(config.database).endsWith('_test')) {
    throw new Error(`Backup tests only connect to a *_test database, not "${config.database}".`);
  }
  return config;
}

/** The test-only restore role (pbe_restore_drill), connected to pbe_test. */
export function restoreConfig(): ClientConfig {
  const config = clientConfig(ENV, 'test', 'restore');
  if (!String(config.database).endsWith('_test')) {
    throw new Error(`Restore tests only connect to a *_test database, not "${config.database}".`);
  }
  return config;
}

/** Reads pbe_dev inside a READ ONLY transaction (any write would fail). */
export function devReadOnly<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(clientConfig(ENV, 'dev', 'migrator'), async (c) => {
    await c.query('BEGIN READ ONLY');
    try {
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/** Queries in pbe_test. */
export function readSql(sql: string, values: unknown[] = []): Promise<pg.QueryResult> {
  return withClient(dbConfig('migrator'), (c) => c.query(sql, values));
}

/** Writes in pbe_test as pbe_owner. */
export function ownerSql(sql: string, values: unknown[] = []): Promise<pg.QueryResult> {
  return withClient(dbConfig('migrator'), (c) => c.query(sql, values), { asOwner: true });
}

/** Writes as pbe_owner, limited to one zz_test_* schema in pbe_test. */
export function testSchemaSql(
  schema: string,
  sql: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  assertTestSchema(schema);
  return ownerSql(sql, values);
}

export async function exists(regclass: string): Promise<boolean> {
  const res = await readSql('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS e', [regclass]);
  return res.rows[0].e === true;
}

export async function schemaExists(name: string): Promise<boolean> {
  const res = await readSql('SELECT pg_catalog.to_regnamespace($1) IS NOT NULL AS e', [name]);
  return res.rows[0].e === true;
}

export async function databaseExists(name: string): Promise<boolean> {
  const res = await readSql(
    'SELECT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = $1) AS e',
    [name],
  );
  return res.rows[0].e === true;
}

/**
 * An isolated migration set-up inside pbe_test: its own objects schema, its own ledger schema
 * (and therefore its own advisory lock) and its own temporary migrations folder.
 */
export class Scratch {
  readonly schema = assertTestSchema(`zz_test_${randomBytes(5).toString('hex')}`);
  readonly ledgerSchema = assertTestSchema(`${this.schema}_meta`);
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-scratch-'));

  fileName(version: number, name: string): string {
    return `${String(version).padStart(4, '0')}_${name}.sql`;
  }

  /** Writes a migration; `{s}` in the body is replaced by this scratch's schema name. */
  write(version: number, name: string, body: string, header = '-- pbe:phase expand'): string {
    const file = path.join(this.dir, this.fileName(version, name));
    fs.writeFileSync(file, `${header}\n${body.replaceAll('{s}', this.schema)}\n`);
    return file;
  }

  read(version: number, name: string): string {
    return fs.readFileSync(path.join(this.dir, this.fileName(version, name)), 'utf8');
  }

  checksum(version: number, name: string): string {
    return sha256Hex(fs.readFileSync(path.join(this.dir, this.fileName(version, name))));
  }

  options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
    return {
      connection: dbConfig('migrator'),
      migrationsDir: this.dir,
      ledgerSchema: this.ledgerSchema,
      lockTimeoutMs: 15_000,
      ...overrides,
    };
  }

  /** Runs SQL as pbe_owner (simulated manual repairs). */
  sql(sql: string, values: unknown[] = []): Promise<pg.QueryResult> {
    return testSchemaSql(this.schema, sql, values);
  }

  async ledger(): Promise<LedgerRow[]> {
    if (!(await exists(`${this.ledgerSchema}.schema_migration`))) return [];
    const res = await readSql(
      `SELECT * FROM ${this.ledgerSchema}.schema_migration ORDER BY version`,
    );
    return res.rows as LedgerRow[];
  }

  async cleanup(): Promise<void> {
    await withClient(
      dbConfig('migrator'),
      async (c) => {
        for (const s of [this.schema, this.ledgerSchema]) {
          await c.query(`DROP SCHEMA IF EXISTS ${c.escapeIdentifier(assertTestSchema(s))} CASCADE`);
        }
      },
      { asOwner: true },
    );
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A private, throw-away PostgreSQL 18 instance (initdb in a temporary folder, Unix socket only,
 * no TCP). The current OS user's role in it is a superuser. Used ONLY for tests that need a
 * superuser or must run destructive scripts; it never touches the real local server.
 */
export class ThrowawayCluster {
  readonly admin = 'throwaway_admin';
  private constructor(
    readonly dir: string,
    readonly port: number,
  ) {}

  /**
   * `tcp`: also listen on 127.0.0.1 and ::1 (only this computer), to test real TCP connections and
   * passwords. `settings`: extra server settings, e.g. "log_statement=all".
   */
  static start(options: { tcp?: boolean; settings?: readonly string[] } = {}): ThrowawayCluster {
    const bin = ENV.binDir;
    const listen = options.tcp ? '127.0.0.1,::1' : '';
    const extra = (options.settings ?? []).map((s) => ` -c ${s}`).join('');
    const dir = fs.mkdtempSync('/tmp/pbe-pg-');
    const init = spawnSync(
      path.join(bin, 'initdb'),
      [
        '-D',
        path.join(dir, 'data'),
        '-U',
        'throwaway_admin',
        '--auth=trust',
        '-E',
        'UTF8',
        '--no-instructions',
      ],
      { encoding: 'utf8' },
    );
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = 55000 + Math.floor(Math.random() * 4000);
      const run = spawnSync(
        path.join(bin, 'pg_ctl'),
        [
          '-D',
          path.join(dir, 'data'),
          '-o',
          `-c listen_addresses='${listen}' -c unix_socket_directories='${dir}' -p ${port} -c fsync=off${extra}`,
          '-l',
          path.join(dir, 'server.log'),
          '-w',
          'start',
        ],
        { encoding: 'utf8' },
      );
      if (run.status === 0) return new ThrowawayCluster(dir, port);
    }
    throw new Error(
      `could not start throw-away PostgreSQL: ${fs.readFileSync(path.join(dir, 'server.log'), 'utf8')}`,
    );
  }

  config(user: string, database = 'postgres'): ClientConfig {
    return { host: this.dir, port: this.port, user, database };
  }

  /** Replaces pg_hba.conf with `lines` and reloads the configuration (no restart). */
  async setHba(lines: readonly string[]): Promise<void> {
    fs.writeFileSync(path.join(this.dir, 'data', 'pg_hba.conf'), `${lines.join('\n')}\n`);
    const r = await this.sql('SELECT pg_catalog.pg_reload_conf() AS ok');
    if (r.rows[0]?.ok !== true) throw new Error('pg_reload_conf failed');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  serverLog(): string {
    return fs.readFileSync(path.join(this.dir, 'server.log'), 'utf8');
  }

  sql(sql: string, values: unknown[] = [], database = 'postgres'): Promise<pg.QueryResult> {
    return withClient(this.config(this.admin, database), (c) => c.query(sql, values));
  }

  /** Runs a SQL file with psql as the throw-away superuser. */
  psqlFile(
    file: string,
    env: Record<string, string> = {},
  ): { status: number | null; output: string } {
    const run = spawnSync(
      path.join(ENV.binDir, 'psql'),
      [
        '-h',
        this.dir,
        '-p',
        String(this.port),
        '-U',
        this.admin,
        '-d',
        'postgres',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        file,
      ],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  stop(): void {
    spawnSync(path.join(ENV.binDir, 'pg_ctl'), [
      '-D',
      path.join(this.dir, 'data'),
      '-m',
      'immediate',
      '-w',
      'stop',
    ]);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

type ScramLib = {
  scramSha256Verifier(password: string): string;
  randomPassword(): string;
  parseScramVerifier(v: string): { iterations: number } | null;
  verifierMatchesPassword(password: string, verifier: string): boolean;
};
// The bootstrap's own SCRAM code (plain CommonJS, tooling/scripts/lib/scram.cjs).
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const scram = require(path.join(ROOT, 'tooling', 'scripts', 'lib', 'scram.cjs')) as ScramLib;

/** Fresh random passwords and their verifiers, in the variables bootstrap-local.sql reads. */
export function bootstrapCredentials(): {
  env: Record<string, string>;
  passwords: Record<'migrator' | 'app' | 'restore' | 'backup', string>;
} {
  const passwords = {
    migrator: scram.randomPassword(),
    app: scram.randomPassword(),
    restore: scram.randomPassword(),
    backup: scram.randomPassword(),
  };
  return {
    passwords,
    env: {
      PBE_MIGRATOR_VERIFIER: scram.scramSha256Verifier(passwords.migrator),
      PBE_APP_VERIFIER: scram.scramSha256Verifier(passwords.app),
      PBE_RESTORE_VERIFIER: scram.scramSha256Verifier(passwords.restore),
      PBE_BACKUP_VERIFIER: scram.scramSha256Verifier(passwords.backup),
    },
  };
}
