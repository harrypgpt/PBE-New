import { sql } from 'kysely';
import type { Database } from './database';

export class UnsafeRuntimeRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRuntimeRoleError';
  }
}

/**
 * Start-up check: the application must connect as a role that row-level security applies to.
 * Refuses a superuser, a role with BYPASSRLS, a role that belongs to any other role, and a role
 * that owns any object in the database (owners could disable RLS). Stage 4 calls this at start-up.
 */
export async function assertSafeRuntimeRole(db: Database): Promise<void> {
  const { rows } = await sql<{
    role: string;
    superuser: boolean;
    bypassrls: boolean;
    memberships: number;
    owned: number;
  }>`SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
            (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships,
            (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
              + (SELECT count(*)::int FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
              + (SELECT count(*)::int FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid) AS owned
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`.execute(db);
  const r = rows[0];
  if (!r) throw new UnsafeRuntimeRoleError('Could not read the connected role.');
  const problems = [
    r.superuser && 'is a superuser',
    r.bypassrls && 'has BYPASSRLS',
    r.memberships > 0 && 'is a member of another role',
    r.owned > 0 && 'owns database objects',
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new UnsafeRuntimeRoleError(`Refusing to run as "${r.role}": it ${problems.join(', ')}.`);
  }
}
