import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { DB } from './database-types';

/**
 * The single gateway to PostgreSQL for application code (ADR-021). Connects as the runtime role
 * (pbe_app). Only this module may import `kysely` or `pg` (enforced by ESLint).
 */

export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface DatabaseOptions {
  /** Maximum pooled connections (default 10). */
  maxConnections?: number;
  /** Server-side statement timeout in milliseconds (default 30 000). */
  statementTimeoutMs?: number;
  /** Optional Kysely query log (never log parameter values; they may contain confidential data). */
  log?: (event: LogEvent) => void;
  /** Called whenever a pooled connection is handed out (used by tests to prove no SQL was sent). */
  onConnectionAcquired?: () => void;
}

export type Database = Kysely<DB>;

export function createDatabase(
  connection: DatabaseConnection,
  options: DatabaseOptions = {},
): Database {
  const pool = new pg.Pool({
    ...connection,
    max: options.maxConnections ?? 10,
    application_name: 'pbe-api',
    statement_timeout: options.statementTimeoutMs ?? 30_000,
  });
  // An idle connection dropped by the server must not crash the process; the pool replaces it.
  pool.on('error', () => undefined);
  if (options.onConnectionAcquired) pool.on('acquire', options.onConnectionAcquired);
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    ...(options.log ? { log: options.log } : {}),
  });
}

/**
 * OPERATOR connection (Stage 7, ADR-029): the migration login acting as pbe_owner, for the few
 * operator-only functions (creating a Super Admin). Used ONLY by the local operator command; the
 * API never loads these credentials.
 */
export function createOperatorDatabase(
  env: Readonly<Record<string, string | undefined>>,
  database: string,
): Database {
  const password = env.PBE_PG_MIGRATOR_PASSWORD;
  if (!password) throw new Error('PBE_PG_MIGRATOR_PASSWORD is not set (run npm run db:bootstrap).');
  const pool = new pg.Pool({
    host: env.PBE_PG_HOST ?? 'localhost',
    port: Number(env.PBE_PG_PORT ?? 5432),
    database,
    user: env.PBE_PG_MIGRATOR_USER ?? 'pbe_migrator',
    password,
    max: 1,
    application_name: 'pbe-operator',
  });
  pool.on('error', () => undefined);
  pool.on('connect', (client) => {
    void client.query('SET ROLE pbe_owner');
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Reads the runtime connection from environment variables (PBE_PG_* as written by db:bootstrap). */
export function runtimeConnectionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  database: string = env.PBE_PG_DEV_DATABASE ?? 'pbe_dev',
): DatabaseConnection {
  const password = env.PBE_PG_APP_PASSWORD;
  if (!password) throw new Error('PBE_PG_APP_PASSWORD is not set (run npm run db:bootstrap).');
  return {
    host: env.PBE_PG_HOST ?? 'localhost',
    port: Number(env.PBE_PG_PORT ?? 5432),
    database,
    user: env.PBE_PG_APP_USER ?? 'pbe_app',
    password,
  };
}
