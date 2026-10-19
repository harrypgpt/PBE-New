import { PLATFORM_ROLE_PERMISSIONS, permissionScope, READ_ONLY_PERMISSIONS } from '@pbe/contracts';
import { ProblemException } from '../../common/problem';
import { tenancy, withTenantTransaction, type Database, type ResolvedSession } from '../db';

/**
 * Who may do what, decided on EVERY request from the database (Stage 7A; ADR-029):
 *  - platform permissions come only from platform roles (Super Admin = platform_owner);
 *  - tenant permissions come only from the member's roles in the session's ACTIVE tenant, and
 *    only while the tenant and the membership are active (revocation is immediate);
 *  - break-glass (ADR-028) gives a Super Admin read-only tenant permissions for one approved,
 *    unexpired grant, on GET routes only, and every use is audited.
 * Role names are never checked: only stable permission identifiers.
 */
export type AccessContext =
  | { kind: 'platform'; userId: string; permissions: ReadonlySet<string> }
  | {
      kind: 'member';
      userId: string;
      tenantId: string;
      membershipId: string;
      permissions: ReadonlySet<string>;
    }
  | {
      kind: 'break_glass';
      userId: string;
      tenantId: string;
      grantId: string;
      permissions: ReadonlySet<string>;
    };

const denied = (internal: string, detail?: string) =>
  new ProblemException(403, 'ACCESS_DENIED', 'Access denied', {
    internal,
    ...(detail ? { detail } : {}),
  });

export function platformPermissionsOf(roles: readonly string[]): Set<string> {
  return new Set(roles.flatMap((r) => PLATFORM_ROLE_PERMISSIONS[r] ?? []));
}

export async function resolveAccess(
  db: Database,
  session: ResolvedSession,
  permission: string,
  method: string,
  requestId: string | null,
): Promise<AccessContext> {
  const scope = permissionScope(permission);
  if (scope === 'platform') {
    const permissions = platformPermissionsOf(await tenancy.platformRoles(db, session.userId));
    // Platform roles always require MFA (SECURITY §3).
    if (!permissions.has(permission) || !session.mfaEnrolled) {
      throw denied(`platform permission ${permission} not held (or MFA not enrolled)`);
    }
    return { kind: 'platform', userId: session.userId, permissions };
  }
  if (scope !== 'tenant') throw denied(`unknown permission ${permission}`);

  const context = await tenancy.sessionContext(db, session.sessionId);
  if (context?.grantId) {
    const grant = await tenancy.breakGlassRefresh(db, context.grantId);
    if (!grant || grant.status !== 'approved' || grant.requestedBy !== session.userId) {
      await tenancy.sessionSetContext(db, session.sessionId, null, null);
      throw denied('break-glass grant no longer valid', 'Break-glass access has ended.');
    }
    if (method !== 'GET' || !READ_ONLY_PERMISSIONS.has(permission)) {
      throw denied('break-glass access is read-only', 'Break-glass access is read-only.');
    }
    if (!(await tenancy.breakGlassRecordUse(db, grant.id, session.userId, permission, requestId))) {
      throw denied('break-glass use not recorded');
    }
    return {
      kind: 'break_glass',
      userId: session.userId,
      tenantId: grant.tenantId,
      grantId: grant.id,
      permissions: new Set([...READ_ONLY_PERMISSIONS].filter((p) => p.startsWith('tenant.'))),
    };
  }
  if (!context?.tenantId) {
    throw denied('no active tenant', 'Choose an organisation first.');
  }
  const tenantId = context.tenantId;
  const member = await withTenantTransaction(
    db,
    { tenantId, userId: session.userId },
    async (trx) => {
      const tenant = await tenancy.currentTenant(trx);
      if (!tenant || tenant.status !== 'active')
        return { ok: false as const, why: 'tenant not active' };
      const m = await tenancy.membershipOf(trx, session.userId);
      if (!m || m.status !== 'active') return { ok: false as const, why: 'membership not active' };
      return {
        ok: true as const,
        membershipId: m.membershipId,
        permissions: new Set(m.permissions),
      };
    },
  );
  if (!member.ok) throw denied(member.why);
  if (!member.permissions.has(permission)) throw denied(`tenant permission ${permission} not held`);
  return {
    kind: 'member',
    userId: session.userId,
    tenantId,
    membershipId: member.membershipId,
    permissions: member.permissions,
  };
}
