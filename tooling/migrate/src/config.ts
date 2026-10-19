import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { ClientConfig } from 'pg';
import { MigrationError } from './errors';

/** Schemas that belong to PBE (DATA_AND_DATABASE_DESIGN.md §2) plus "public", watched for stray objects. */
export const PBE_SCHEMAS: readonly string[] = [
  'pbe_meta',
  'app',
  'platform',
  'training',
  'audit',
  'public',
];
export const OWNER_ROLE = 'pbe_owner';
/**
 * ADR-020: the ONLY role that may create databases. A test-only login, not a member of pbe_owner,
 * so PostgreSQL itself prevents it from dropping or reading pbe_dev and pbe_test: it can drop
 * only the temporary databases it owns.
 */
export const RESTORE_ROLE = 'pbe_restore_drill';

/**
 * ADR-020: pbe_dev (development) and pbe_test (automated tests) are separate databases.
 * Inside pbe_test, scratch tests use their own schemas matching this pattern.
 */
export const TEST_SCHEMA_PATTERN = /^zz_test_[0-9a-f]{10}(_meta)?$/;

/**
 * ADR-020: backup-restore verification uses a temporary database created and dropped by the
 * restore drill itself. Only names matching this pattern can ever be dropped by PBE tooling.
 */
export const DISPOSABLE_DATABASE_PATTERN = /^pbe_restore_check_[0-9a-f]{10}$/;

export type DatabaseKind = 'dev' | 'test';
/**
 * `backup`: the dedicated read-only backup login (pbe_backup, STAGE-07A-BACKUP-REVIEW.md), the only
 * PBE role with BYPASSRLS. Optional until the bootstrap has created it.
 */
export type LoginRole = 'migrator' | 'app' | 'restore' | 'backup';

export interface DbEnv {
  host: string;
  port: number;
  databases: Record<DatabaseKind, string>;
  users: Record<LoginRole, string>;
  passwords: Record<LoginRole, string | undefined>;
  binDir: string;
}

/** Walks up from this file to the monorepo root (the package.json that declares workspaces). */
export function findRepoRoot(start: string = __dirname): string {
  let dir = start;
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && 'workspaces' in JSON.parse(fs.readFileSync(manifest, 'utf8')))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new MigrationError('CONFIG', 'Could not find the repository root.');
    dir = parent;
  }
}

export function migrationsDir(rootDir: string): string {
  return path.join(rootDir, 'db', 'migrations');
}

/** Committed fingerprint of the expected schema, used by the drift check. */
export function snapshotFile(rootDir: string): string {
  return path.join(rootDir, 'db', 'schema-snapshot.txt');
}

/**
 * Reads database settings from the git-ignored .env file, overridden by real environment
 * variables. The file is parsed directly (not loaded into process.env), so this also works in
 * sandboxes such as Jest that give code its own copy of process.env.
 * Passwords are never printed by any PBE tool.
 */
export function loadDbEnv(rootDir: string = findRepoRoot()): DbEnv {
  const envFile = path.join(rootDir, '.env');
  const fromFile = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const e: Record<string, string | undefined> = { ...fromFile, ...process.env };
  return {
    host: e.PBE_PG_HOST ?? 'localhost',
    port: Number(e.PBE_PG_PORT ?? 5432),
    databases: {
      dev: e.PBE_PG_DEV_DATABASE ?? 'pbe_dev',
      test: e.PBE_PG_TEST_DATABASE ?? 'pbe_test',
    },
    users: {
      migrator: e.PBE_PG_MIGRATOR_USER ?? 'pbe_migrator',
      app: e.PBE_PG_APP_USER ?? 'pbe_app',
      restore: e.PBE_PG_RESTORE_USER ?? 'pbe_restore_drill',
      backup: e.PBE_PG_BACKUP_USER ?? 'pbe_backup',
    },
    passwords: {
      migrator: e.PBE_PG_MIGRATOR_PASSWORD,
      app: e.PBE_PG_APP_PASSWORD,
      restore: e.PBE_PG_RESTORE_PASSWORD,
      backup: e.PBE_PG_BACKUP_PASSWORD,
    },
    binDir: e.PBE_PG_BIN ?? '/Library/PostgreSQL/18/bin',
  };
}

export function clientConfig(env: DbEnv, database: DatabaseKind, role: LoginRole): ClientConfig {
  const password = env.passwords[role];
  if (!password) {
    throw new MigrationError(
      'CONFIG',
      `No password configured for ${env.users[role]}. Run "npm run db:bootstrap" (see db/bootstrap/README.md).`,
    );
  }
  return {
    host: env.host,
    port: env.port,
    database: env.databases[database],
    user: env.users[role],
    password,
  };
}

/** Human-readable connection target without the password. */
export function describeTarget(config: ClientConfig): string {
  return `${config.user}@${config.host}:${config.port}/${config.database}`;
}
