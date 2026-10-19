import { sql, type Transaction } from 'kysely';
import type { Database } from './database';
import type { DB } from './database-types';

/**
 * Tenant context (DATA_AND_DATABASE_DESIGN.md §4, STAGE-03-PLAN.md §3.4). The ONLY place where
 * app.tenant_id / app.user_id are set. They are set with set_config(..., true), i.e. local to the
 * transaction: PostgreSQL discards them at COMMIT or ROLLBACK, so a pooled connection can never
 * carry one tenant's context into another request. Row-level security policies read them through
 * app.current_tenant_id(); without a context, policies match no rows (fail closed).
 */

export interface TenantContext {
  tenantId: string;
  userId: string;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

// RFC 9562 UUID (versions 1–8, RFC variant). The nil UUID is not a valid tenant or user.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates a tenant context. Throws before anything reaches the database. */
export function parseTenantContext(input: unknown): TenantContext {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TenantContextError('Tenant context must be an object { tenantId, userId }.');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'tenantId' || keys[1] !== 'userId') {
    throw new TenantContextError(
      'Tenant context must have exactly the fields tenantId and userId.',
    );
  }
  const { tenantId, userId } = input as Record<string, unknown>;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new TenantContextError('tenantId must be a UUID.');
  }
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new TenantContextError('userId must be a UUID.');
  }
  return { tenantId: tenantId.toLowerCase(), userId: userId.toLowerCase() };
}

/**
 * Runs `work` in one transaction with the tenant context set. Any error rolls the transaction
 * back (and with it the context). Invalid context is rejected before a connection is taken.
 */
export async function withTenantTransaction<T>(
  db: Database,
  context: TenantContext,
  work: (trx: Transaction<DB>) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const ctx = parseTenantContext(context);
  // Read-only transactions (break-glass, ADR-028): PostgreSQL itself refuses any write.
  const builder = options.readOnly ? db.transaction().setAccessMode('read only') : db.transaction();
  return builder.execute(async (trx) => {
    await sql`SELECT pg_catalog.set_config('app.tenant_id', ${ctx.tenantId}, true),
                     pg_catalog.set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Runs `work` with ONLY the user context set (no tenant). Used to list the user's own memberships
 * before a tenant is chosen: the policies own_memberships_without_tenant and
 * member_tenants_without_tenant (migration 0004) apply only while no tenant context is set.
 */
export async function withUserTransaction<T>(
  db: Database,
  userId: string,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new TenantContextError('userId must be a UUID.');
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_catalog.set_config('app.user_id', ${userId.toLowerCase()}, true)`.execute(
      trx,
    );
    return work(trx);
  });
}

/** A transaction handle for repository functions (callers never import kysely). */
export type Tx = Transaction<DB>;
