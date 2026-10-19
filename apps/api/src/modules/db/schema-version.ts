import { sql } from 'kysely';
import type { Database } from './database';

/**
 * Accepted migration ledgers (ADR-030). The database must match ONE of them exactly:
 *  - BASE_SCHEMA_VERSIONS (0001–0004): pbe_test and pbe_dev today;
 *  - PROJECTS_SCHEMA_VERSIONS (0001–0006): plus 0005 (backup read access) and 0006 (projects,
 *    Stage 8), applied to pbe_test and pbe_dev on 2026-10-18 (STAGE-08-INTEGRATION-PLAN.md).
 *    The projects module uses only hand-written SQL and is available only on this profile.
 * Both are written out explicitly, so regenerating the database types after 0006 reaches pbe_test
 * cannot silently change them. A test requires the generated SCHEMA_VERSIONS to equal one of them.
 */
export const BASE_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4];
export const PROJECTS_SCHEMA_VERSION = 6;
export const PROJECTS_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6];
export const SCHEMA_PROFILES: readonly (readonly number[])[] = [
  BASE_SCHEMA_VERSIONS,
  PROJECTS_SCHEMA_VERSIONS,
];

export class SchemaVersionMismatchError extends Error {
  constructor(
    readonly expected: readonly number[],
    readonly actual: readonly number[],
  ) {
    super(
      `Database migration ledger [${actual.join(', ')}] does not match the expected [${expected.join(', ')}].`,
    );
    this.name = 'SchemaVersionMismatchError';
  }
}

async function appliedVersions(db: Database): Promise<number[]> {
  const rows = await db
    .selectFrom('pbe_meta.schema_migration')
    .select('version')
    .orderBy('version')
    .execute();
  return rows.map((r) => r.version);
}

/** Start-up: the ledger must equal one accepted profile exactly; returns that profile. */
export async function resolveSchemaProfile(
  db: Database,
  profiles: readonly (readonly number[])[],
): Promise<readonly number[]> {
  const actual = await appliedVersions(db);
  const match = profiles.find((p) => p.join(',') === actual.join(','));
  if (!match) throw new SchemaVersionMismatchError(profiles[profiles.length - 1] ?? [], actual);
  return match;
}

/** Health check: the database must be at exactly the profile resolved at start-up. */
export async function assertSchemaVersions(
  db: Database,
  expected: readonly number[],
): Promise<void> {
  const actual = await appliedVersions(db);
  if (actual.join(',') !== expected.join(','))
    throw new SchemaVersionMismatchError(expected, actual);
}

export type HealthResult = { ok: true } | { ok: false; reason: string };

/** Health check: database reachable and ledger as expected. Never throws; the reason is for logs only. */
export async function checkDatabaseHealth(
  db: Database,
  expected: readonly number[],
): Promise<HealthResult> {
  try {
    await sql`SELECT 1`.execute(db);
    await assertSchemaVersions(db, expected);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}
