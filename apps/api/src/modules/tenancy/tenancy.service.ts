import { randomUUID } from 'node:crypto';
import {
  ADMINISTRATIVE_PERMISSIONS,
  DEFAULT_DEPARTMENTS,
  PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  ROLE_MANAGEMENT_PERMISSION,
  type PermissionDefinition,
  type SessionResponse,
} from '@pbe/contracts';
import { ProblemException } from '../../common/problem';
import { hashPassword } from '../auth/password-hash';
import { Blocklist, passwordProblem } from '../auth/password-policy';
import { newSessionToken, sessionTokenHash, sha256, throttleKey } from '../auth/secrets';
import {
  identity,
  tenancy,
  withTenantTransaction,
  type Database,
  type GrantRow,
  type MemberRow,
  type ResolvedSession,
  type RoleRow,
  type Tx,
} from '../db';
import type { RequestContext } from '../auth/auth.service';
import { platformPermissionsOf, type AccessContext } from './access';
import type { TokenDelivery } from './token-outbox';

/**
 * Stage 7A business rules (ADR-028, ADR-029). Every tenant change runs in ONE transaction under the
 * tenant's RLS context together with its audit row (atomic). Administrative changes in a tenant are
 * serialised by an advisory lock, so the lock-out rule cannot be bypassed by concurrent requests.
 */

export const TOKEN_TTL_SECONDS = 4 * 3600; // owner maximum: four hours

const conflict = (title: string, detail: string) =>
  new ProblemException(409, 'CONFLICT', title, { detail });
const notFound = () => new ProblemException(404, 'NOT_FOUND', 'Not found');
const invalid = (detail: string, path?: string) =>
  new ProblemException(400, 'VALIDATION_FAILED', 'Request not accepted', {
    detail,
    ...(path ? { errors: [{ path, message: detail }] } : {}),
  });
const denied = (detail: string) =>
  new ProblemException(403, 'ACCESS_DENIED', 'Access denied', { detail });

/** SHA-256 of a canonical JSON form: the audit trail stores digests, never raw data. */
export function digest(value: unknown): Buffer {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return sha256(JSON.stringify(canon(value)));
}

const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const grantDto = (g: GrantRow) => ({
  id: g.id,
  tenantId: g.tenantId,
  requestedBy: g.requestedBy,
  purpose: g.purpose,
  status: g.status,
  requestedAt: g.requestedAt.toISOString(),
  decidedAt: iso(g.decidedAt),
  expiresAt: iso(g.expiresAt),
});

export class TenancyService {
  constructor(
    private readonly db: Database,
    private readonly settings: { idleSeconds: number; absoluteSeconds: number },
    private readonly delivery: TokenDelivery,
    private readonly blocklist: Blocklist = Blocklist.load(),
    /** The catalogue seeded in the connected database (its schema profile; ADR-030). */
    private readonly catalogue: readonly PermissionDefinition[] = PERMISSIONS,
  ) {}

  private get tenantCatalogue(): readonly PermissionDefinition[] {
    return this.catalogue.filter((p) => p.scope === 'tenant');
  }

  // ------------------------------------------------------------------ helpers -----------------
  private memberTx<T>(access: AccessContext, work: (trx: Tx) => Promise<T>): Promise<T> {
    if (access.kind !== 'member') throw denied('Only members of the organisation can change it.');
    return withTenantTransaction(
      this.db,
      { tenantId: access.tenantId, userId: access.userId },
      work,
    );
  }

  private readTx<T>(access: AccessContext, work: (trx: Tx) => Promise<T>): Promise<T> {
    if (access.kind === 'platform') throw denied('No organisation selected.');
    return withTenantTransaction(
      this.db,
      { tenantId: access.tenantId, userId: access.userId },
      work,
      {
        readOnly: access.kind === 'break_glass',
      },
    );
  }

  private securityEvent(
    ctx: RequestContext,
    e: Parameters<typeof identity.recordSecurityEvent>[1],
  ): Promise<void> {
    return identity.recordSecurityEvent(this.db, {
      requestId: ctx.requestId ?? null,
      clientAddress: ctx.address,
      ...e,
    });
  }

  /** New session for the same user with a new context; the presented session ends (rotation). */
  async rotateWithContext(
    ctx: RequestContext,
    userId: string,
    tenantId: string | null,
    grantId: string | null,
  ): Promise<string> {
    const token = newSessionToken();
    const sessionId = await identity.sessionCreate(this.db, {
      userId,
      tokenHash: sessionTokenHash(token),
      state: 'active',
      idleSeconds: this.settings.idleSeconds,
      absoluteSeconds: this.settings.absoluteSeconds,
    });
    if (!(await tenancy.sessionSetContext(this.db, sessionId, tenantId, grantId))) {
      await identity.sessionEnd(this.db, sessionTokenHash(token), 'rotated');
      throw conflict('Not available', 'That access is no longer available.');
    }
    if (ctx.token) await identity.sessionEnd(this.db, sessionTokenHash(ctx.token), 'rotated');
    return token;
  }

  /** Lock-out protection: after the change, someone active must still be able to manage roles. */
  private async assertRoleManagerRemains(trx: Tx): Promise<void> {
    if ((await tenancy.activeHoldersOf(trx, ROLE_MANAGEMENT_PERMISSION)) === 0) {
      throw conflict(
        'Not allowed',
        'This would leave no one able to manage roles and permissions.',
      );
    }
  }

  /** No escalation: you can only grant permissions you hold yourself. */
  private assertWithinOwn(access: AccessContext, permissions: readonly string[]): void {
    const extra = permissions.filter((p) => !access.permissions.has(p));
    if (extra.length > 0) throw denied('You can only grant permissions you hold yourself.');
  }

  /** Administrative permissions require MFA: set the requirement; unenrolled users must sign in again. */
  private async requireMfaFor(ctx: RequestContext, userIds: readonly string[]): Promise<void> {
    for (const userId of new Set(userIds)) {
      const user = await identity.getUser(this.db, userId);
      if (!user || user.mfaRequired) continue;
      await identity.setMfaRequired(this.db, userId, true);
      const ended = user.mfaEnrolled
        ? 0
        : await identity.sessionEndAll(this.db, userId, 'policy_changed', null);
      await this.securityEvent(ctx, {
        eventType: 'mfa_requirement_changed',
        outcome: 'info',
        userId,
        detail: { required: true, sessionsEnded: ended },
      });
    }
  }

  private async issueToken(
    ctx: RequestContext,
    user: { id: string; email: string },
    purpose: 'activation' | 'password_reset',
    tenantId: string | null,
    actor: string | null,
  ): Promise<Date> {
    const token = randomBytesToken();
    const expiresAt = await tenancy.tokenIssue(this.db, {
      userId: user.id,
      purpose,
      hash: tokenHash(token),
      ttlSeconds: TOKEN_TTL_SECONDS,
      tenantId,
      actor,
    });
    await this.delivery.deliver({ to: user.email, purpose, token, expiresAt });
    await this.securityEvent(ctx, {
      eventType: `${purpose}_token_issued`,
      outcome: 'info',
      userId: user.id,
      detail: { byAdministrator: actor !== null },
    });
    return expiresAt;
  }

  // ------------------------------------------------------------------ session ------------------
  async sessionInfo(session: ResolvedSession): Promise<SessionResponse> {
    const user = await identity.getUser(this.db, session.userId);
    if (!user) throw new ProblemException(401, 'AUTHENTICATION_REQUIRED', 'Sign-in required');
    const roles = await tenancy.platformRoles(this.db, session.userId);
    const permissions = new Set(platformPermissionsOf(roles));
    const ctx = await tenancy.sessionContext(this.db, session.sessionId);
    let activeTenant: SessionResponse['activeTenant'] = null;
    let breakGlass: SessionResponse['breakGlass'] = null;
    if (ctx?.grantId) {
      const g = await tenancy.breakGlassRefresh(this.db, ctx.grantId);
      if (g && g.status === 'approved' && g.requestedBy === session.userId && g.expiresAt) {
        breakGlass = { grantId: g.id, expiresAt: g.expiresAt.toISOString() };
        for (const p of this.tenantCatalogue)
          if (READ_ONLY_PERMISSIONS.has(p.code)) permissions.add(p.code);
      }
    } else if (ctx?.tenantId) {
      const info = await withTenantTransaction(
        this.db,
        { tenantId: ctx.tenantId, userId: session.userId },
        async (trx) => ({
          tenant: await tenancy.currentTenant(trx),
          member: await tenancy.membershipOf(trx, session.userId),
        }),
      );
      if (info.tenant?.status === 'active' && info.member?.status === 'active') {
        activeTenant = { id: info.tenant.id, name: info.tenant.name, slug: info.tenant.slug };
        for (const p of info.member.permissions) permissions.add(p);
      }
    }
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      mfa: { enrolled: user.mfaEnrolled, required: user.mfaRequired },
      activeTenant,
      breakGlass,
      platformRoles: roles,
      permissions: [...permissions].sort(),
    };
  }

  async memberTenants(session: ResolvedSession) {
    const tenants = await tenancy.memberTenants(this.db, session.userId);
    return { tenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug })) };
  }

  async chooseTenant(ctx: RequestContext, session: ResolvedSession, tenantId: string) {
    const ok = await withTenantTransaction(
      this.db,
      { tenantId, userId: session.userId },
      async (trx) => {
        const tenant = await tenancy.currentTenant(trx);
        const member = await tenancy.membershipOf(trx, session.userId);
        return tenant?.status === 'active' && member?.status === 'active' ? tenant : null;
      },
    );
    // Not a member, suspended or unknown: the same answer (no tenant discovery).
    if (!ok) throw notFound();
    const token = await this.rotateWithContext(ctx, session.userId, tenantId, null);
    await this.securityEvent(ctx, {
      eventType: 'tenant_selected',
      outcome: 'success',
      userId: session.userId,
      detail: { tenant: tenantId },
    });
    return { token, activeTenant: { id: ok.id, name: ok.name, slug: ok.slug } };
  }

  async exitContext(ctx: RequestContext, session: ResolvedSession): Promise<string> {
    return this.rotateWithContext(ctx, session.userId, null, null);
  }

  // ------------------------------------------------------------------ members ------------------
  listMembers(access: AccessContext) {
    return this.readTx(access, async (trx) => ({ members: await tenancy.listMembers(trx) }));
  }

  async addMember(
    ctx: RequestContext,
    access: AccessContext,
    input: { email: string; displayName: string },
  ) {
    const email = input.email.trim();
    const result = await this.memberTx(access, async (trx) => {
      await tenancy.lockTenantAdministration(trx, access.kind === 'member' ? access.tenantId : '');
      let userId = await identity.userIdByEmail(trx, email);
      const newAccount = userId === null;
      if (userId === null) userId = await identity.createUser(trx, email, input.displayName);
      if (await tenancy.findMembershipByUser(trx, userId))
        throw conflict('Already a member', 'This person is already a member.');
      const id = await tenancy.insertMembership(trx, {
        tenantId: (access as { tenantId: string }).tenantId,
        userId,
        email,
        displayName: input.displayName,
      });
      const member = (await tenancy.getMember(trx, id))!;
      await tenancy.audit(trx, {
        tenantId: (access as { tenantId: string }).tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'member.added',
        targetType: 'membership',
        targetId: id,
        afterDigest: digest(member),
        requestId: ctx.requestId ?? null,
        detail: { newAccount },
      });
      return { member, newAccount };
    });
    // Activation link through the separate delivery channel; never in this response (ADR-029).
    if (result.newAccount) {
      await this.issueToken(
        ctx,
        { id: result.member.userId, email },
        'activation',
        (access as { tenantId: string }).tenantId,
        access.userId,
      );
    }
    return { member: result.member };
  }

  async setMemberStatus(
    ctx: RequestContext,
    access: AccessContext,
    membershipId: string,
    status: 'active' | 'deactivated',
  ) {
    const member = await this.memberTx(access, async (trx) => {
      const tenantId = (access as { tenantId: string }).tenantId;
      await tenancy.lockTenantAdministration(trx, tenantId);
      const before = await tenancy.getMember(trx, membershipId);
      if (!before) throw notFound();
      if (!(await tenancy.setMembershipStatus(trx, membershipId, status))) {
        throw conflict('No change', `The membership is already ${status}.`);
      }
      if (status === 'deactivated') await this.assertRoleManagerRemains(trx);
      const after = (await tenancy.getMember(trx, membershipId))!;
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: status === 'deactivated' ? 'member.deactivated' : 'member.reactivated',
        targetType: 'membership',
        targetId: membershipId,
        beforeDigest: digest(before),
        afterDigest: digest(after),
        requestId: ctx.requestId ?? null,
      });
      return after;
    });
    await this.securityEvent(ctx, {
      eventType: status === 'deactivated' ? 'membership_deactivated' : 'membership_reactivated',
      outcome: 'success',
      userId: member.userId,
      detail: { by: access.userId },
    });
    return { member };
  }

  async startPasswordReset(ctx: RequestContext, access: AccessContext, membershipId: string) {
    const tenantId = (access as { tenantId: string }).tenantId;
    const member = await this.memberTx(access, async (trx) => {
      const m = await tenancy.getMember(trx, membershipId);
      if (!m) throw notFound();
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'member.password_reset_started',
        targetType: 'membership',
        targetId: membershipId,
        requestId: ctx.requestId ?? null,
      });
      return m;
    });
    // D-5: the member's sessions end now; the link reaches them through the separate channel.
    const ended = await identity.sessionEndAll(this.db, member.userId, 'password_reset', null);
    await this.securityEvent(ctx, {
      eventType: 'password_reset_started',
      outcome: 'info',
      userId: member.userId,
      detail: { by: access.userId, sessionsEnded: ended },
    });
    const expiresAt = await this.issueToken(
      ctx,
      { id: member.userId, email: member.email },
      'password_reset',
      tenantId,
      access.userId,
    );
    return { status: 'sent' as const, expiresAt: expiresAt.toISOString() };
  }

  async setMemberRoles(
    ctx: RequestContext,
    access: AccessContext,
    membershipId: string,
    roleIds: string[],
  ) {
    const ids = [...new Set(roleIds)];
    const tenantId = (access as { tenantId: string }).tenantId;
    const { member, granted } = await this.memberTx(access, async (trx) => {
      await tenancy.lockTenantAdministration(trx, tenantId);
      const before = await tenancy.getMember(trx, membershipId);
      if (!before) throw notFound();
      const { found, permissions } = await tenancy.permissionsOfRoles(trx, ids);
      if (found !== ids.length)
        throw invalid('One or more roles do not exist in this organisation.', 'body.roleIds');
      this.assertWithinOwn(access, permissions);
      await tenancy.setMemberRoles(trx, tenantId, membershipId, ids);
      await this.assertRoleManagerRemains(trx);
      const after = (await tenancy.getMember(trx, membershipId))!;
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'member.roles_set',
        targetType: 'membership',
        targetId: membershipId,
        beforeDigest: digest(before.roleIds),
        afterDigest: digest(after.roleIds),
        requestId: ctx.requestId ?? null,
        detail: { roleIds: after.roleIds },
      });
      return { member: after, granted: permissions };
    });
    await this.securityEvent(ctx, {
      eventType: 'permissions_changed',
      outcome: 'success',
      userId: member.userId,
      detail: { by: access.userId, roles: member.roleIds.length },
    });
    if (granted.some((p) => ADMINISTRATIVE_PERMISSIONS.has(p)))
      await this.requireMfaFor(ctx, [member.userId]);
    return { member };
  }

  async setMemberDepartments(
    ctx: RequestContext,
    access: AccessContext,
    membershipId: string,
    departmentIds: string[],
  ) {
    const ids = [...new Set(departmentIds)];
    const tenantId = (access as { tenantId: string }).tenantId;
    const member = await this.memberTx(access, async (trx) => {
      const before = await tenancy.getMember(trx, membershipId);
      if (!before) throw notFound();
      if ((await tenancy.departmentsExist(trx, ids)) !== ids.length) {
        throw invalid(
          'One or more departments do not exist in this organisation.',
          'body.departmentIds',
        );
      }
      await tenancy.setMemberDepartments(trx, tenantId, membershipId, ids);
      const after = (await tenancy.getMember(trx, membershipId))!;
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'member.departments_set',
        targetType: 'membership',
        targetId: membershipId,
        beforeDigest: digest(before.departmentIds),
        afterDigest: digest(after.departmentIds),
        requestId: ctx.requestId ?? null,
      });
      return after;
    });
    return { member };
  }

  // ------------------------------------------------------------------ roles --------------------
  listRoles(access: AccessContext) {
    return this.readTx(access, async (trx) => ({ roles: await tenancy.listRoles(trx) }));
  }

  permissionCatalogue() {
    return {
      permissions: this.tenantCatalogue.map((p) => ({
        code: p.code,
        description: p.description,
        readOnly: p.readOnly,
      })),
    };
  }

  private validatePermissions(access: AccessContext, permissions: string[]): string[] {
    const unique = [...new Set(permissions)].sort();
    const unknown = unique.filter((p) => !this.tenantCatalogue.some((c) => c.code === p));
    if (unknown.length > 0)
      throw invalid('Unknown or non-organisation permission.', 'body.permissions');
    this.assertWithinOwn(access, unique);
    return unique;
  }

  async createRole(
    ctx: RequestContext,
    access: AccessContext,
    input: { name: string; description: string; permissions: string[] },
  ) {
    const permissions = this.validatePermissions(access, input.permissions);
    const tenantId = (access as { tenantId: string }).tenantId;
    try {
      const role = await this.memberTx(access, async (trx) => {
        const id = await tenancy.createRole(trx, tenantId, {
          name: input.name,
          description: input.description,
          permissions,
        });
        const created = (await tenancy.getRole(trx, id))!;
        await tenancy.audit(trx, {
          tenantId,
          actorUserId: access.userId,
          actorKind: 'member',
          action: 'role.created',
          targetType: 'role',
          targetId: id,
          afterDigest: digest(created),
          requestId: ctx.requestId ?? null,
          detail: { permissions },
        });
        return created;
      });
      await this.securityEvent(ctx, {
        eventType: 'role_created',
        outcome: 'success',
        userId: access.userId,
        detail: { role: role.id },
      });
      return { role };
    } catch (err) {
      if (pgCode(err) === '23505')
        throw conflict('Name already used', 'Another role already has this name.');
      throw err;
    }
  }

  async updateRole(
    ctx: RequestContext,
    access: AccessContext,
    roleId: string,
    input: { name: string; description: string; permissions: string[] },
  ) {
    const permissions = this.validatePermissions(access, input.permissions);
    const tenantId = (access as { tenantId: string }).tenantId;
    try {
      const { role, holders } = await this.memberTx(access, async (trx) => {
        await tenancy.lockTenantAdministration(trx, tenantId);
        const before = await tenancy.getRole(trx, roleId);
        if (!before) throw notFound();
        await tenancy.updateRole(trx, tenantId, roleId, {
          name: input.name,
          description: input.description,
          permissions,
        });
        await this.assertRoleManagerRemains(trx);
        const after = (await tenancy.getRole(trx, roleId))!;
        await tenancy.audit(trx, {
          tenantId,
          actorUserId: access.userId,
          actorKind: 'member',
          action: 'role.changed',
          targetType: 'role',
          targetId: roleId,
          beforeDigest: digest(before),
          afterDigest: digest(after),
          requestId: ctx.requestId ?? null,
          detail: { permissions },
        });
        const adminPerms = permissions.filter((p) => ADMINISTRATIVE_PERMISSIONS.has(p));
        return {
          role: after,
          holders: adminPerms.length > 0 ? await tenancy.usersHoldingAny(trx, adminPerms) : [],
        };
      });
      await this.securityEvent(ctx, {
        eventType: 'permissions_changed',
        outcome: 'success',
        userId: access.userId,
        detail: { role: roleId },
      });
      await this.requireMfaFor(ctx, holders);
      return { role };
    } catch (err) {
      if (pgCode(err) === '23505')
        throw conflict('Name already used', 'Another role already has this name.');
      throw err;
    }
  }

  async deleteRole(ctx: RequestContext, access: AccessContext, roleId: string) {
    const tenantId = (access as { tenantId: string }).tenantId;
    await this.memberTx(access, async (trx) => {
      await tenancy.lockTenantAdministration(trx, tenantId);
      const before = await tenancy.getRole(trx, roleId);
      if (!before || !(await tenancy.deleteRole(trx, roleId))) throw notFound();
      await this.assertRoleManagerRemains(trx);
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'role.deleted',
        targetType: 'role',
        targetId: roleId,
        beforeDigest: digest(before),
        requestId: ctx.requestId ?? null,
      });
    });
    await this.securityEvent(ctx, {
      eventType: 'permissions_changed',
      outcome: 'success',
      userId: access.userId,
      detail: { roleDeleted: roleId },
    });
    return { status: 'deleted' as const };
  }

  // ------------------------------------------------------------------ departments --------------
  listDepartments(access: AccessContext) {
    return this.readTx(access, async (trx) => ({
      departments: await tenancy.listDepartments(trx),
    }));
  }

  async saveDepartment(
    ctx: RequestContext,
    access: AccessContext,
    id: string | null,
    input: { name: string; description: string },
  ) {
    const tenantId = (access as { tenantId: string }).tenantId;
    try {
      const department = await this.memberTx(access, async (trx) => {
        let depId = id;
        const before = id ? (await tenancy.listDepartments(trx, id))[0] : undefined;
        if (id) {
          if (!before || !(await tenancy.updateDepartment(trx, id, input))) throw notFound();
        } else {
          depId = await tenancy.createDepartment(trx, tenantId, input);
        }
        const after = (await tenancy.listDepartments(trx, depId!))[0]!;
        await tenancy.audit(trx, {
          tenantId,
          actorUserId: access.userId,
          actorKind: 'member',
          action: id ? 'department.changed' : 'department.created',
          targetType: 'department',
          targetId: depId,
          beforeDigest: before ? digest(before) : null,
          afterDigest: digest(after),
          requestId: ctx.requestId ?? null,
        });
        return after;
      });
      return { department };
    } catch (err) {
      if (pgCode(err) === '23505')
        throw conflict('Name already used', 'Another department already has this name.');
      throw err;
    }
  }

  async deleteDepartment(ctx: RequestContext, access: AccessContext, id: string) {
    const tenantId = (access as { tenantId: string }).tenantId;
    await this.memberTx(access, async (trx) => {
      const before = (await tenancy.listDepartments(trx, id))[0];
      if (!before || !(await tenancy.deleteDepartment(trx, id))) throw notFound();
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'department.deleted',
        targetType: 'department',
        targetId: id,
        beforeDigest: digest(before),
        requestId: ctx.requestId ?? null,
      });
    });
    return { status: 'deleted' as const };
  }

  // ------------------------------------------------------------------ settings -----------------
  async getSettings(access: AccessContext) {
    const s = await this.readTx(access, (trx) => tenancy.getSettings(trx));
    if (!s) throw notFound();
    return s;
  }

  async updateSettings(
    ctx: RequestContext,
    access: AccessContext,
    input: { selfApprovalAllowed: boolean },
  ) {
    const tenantId = (access as { tenantId: string }).tenantId;
    return this.memberTx(access, async (trx) => {
      const before = await tenancy.getSettings(trx);
      if (!before) throw notFound();
      await tenancy.updateSettings(trx, input);
      await tenancy.audit(trx, {
        tenantId,
        actorUserId: access.userId,
        actorKind: 'member',
        action: 'settings.changed',
        targetType: 'tenant_setting',
        targetId: null,
        beforeDigest: digest(before),
        afterDigest: digest(input),
        requestId: ctx.requestId ?? null,
        detail: { selfApprovalAllowed: input.selfApprovalAllowed },
      });
      return { selfApprovalAllowed: input.selfApprovalAllowed };
    });
  }

  // ------------------------------------------------------------------ break-glass --------------
  async tenantGrants(access: AccessContext) {
    if (access.kind !== 'member') throw denied('Only members can review break-glass requests.');
    return { grants: (await tenancy.breakGlassForTenant(this.db, access.tenantId)).map(grantDto) };
  }

  async decideGrant(ctx: RequestContext, access: AccessContext, grantId: string, approve: boolean) {
    if (access.kind !== 'member') throw denied('Only members can decide break-glass requests.');
    const current = await tenancy.breakGlassRefresh(this.db, grantId);
    if (!current || current.tenantId !== access.tenantId) throw notFound();
    if (
      !(await tenancy.breakGlassDecide(
        this.db,
        grantId,
        access.tenantId,
        access.userId,
        approve,
        ctx.requestId ?? null,
      ))
    ) {
      throw conflict(
        'Not awaiting a decision',
        'This request has already been decided, or you made it yourself.',
      );
    }
    await this.securityEvent(ctx, {
      eventType: approve ? 'break_glass_approved' : 'break_glass_rejected',
      outcome: 'info',
      userId: current.requestedBy,
      detail: { by: access.userId, tenant: access.tenantId },
    });
    return { grant: grantDto((await tenancy.breakGlassRefresh(this.db, grantId))!) };
  }

  async revokeGrant(ctx: RequestContext, access: AccessContext, grantId: string) {
    const tenantScope = access.kind === 'member' ? access.tenantId : null;
    const current = await tenancy.breakGlassRefresh(this.db, grantId);
    if (
      !current ||
      (tenantScope ? current.tenantId !== tenantScope : current.requestedBy !== access.userId)
    )
      throw notFound();
    if (
      !(await tenancy.breakGlassRevoke(
        this.db,
        grantId,
        access.userId,
        tenantScope,
        ctx.requestId ?? null,
      ))
    ) {
      throw conflict('Not active', 'This break-glass request is no longer active.');
    }
    await this.securityEvent(ctx, {
      eventType: 'break_glass_revoked',
      outcome: 'info',
      userId: current.requestedBy,
      detail: { by: access.userId },
    });
    return { grant: grantDto((await tenancy.breakGlassRefresh(this.db, grantId))!) };
  }

  async requestGrant(
    ctx: RequestContext,
    access: AccessContext,
    tenantId: string,
    purpose: string,
  ) {
    const id = await tenancy.breakGlassRequest(
      this.db,
      access.userId,
      tenantId,
      purpose,
      ctx.requestId ?? null,
    );
    if (!id) throw notFound();
    await this.securityEvent(ctx, {
      eventType: 'break_glass_requested',
      outcome: 'info',
      userId: access.userId,
      detail: { tenant: tenantId },
    });
    return { grant: grantDto((await tenancy.breakGlassRefresh(this.db, id))!) };
  }

  async ownGrants(access: AccessContext) {
    return { grants: (await tenancy.breakGlassForRequester(this.db, access.userId)).map(grantDto) };
  }

  async enterGrant(ctx: RequestContext, session: ResolvedSession, grantId: string) {
    const grant = await tenancy.breakGlassRefresh(this.db, grantId);
    if (!grant || grant.requestedBy !== session.userId) throw notFound();
    if (grant.status !== 'approved')
      throw conflict(
        'Not available',
        'This request is not approved, or has expired or been revoked.',
      );
    const token = await this.rotateWithContext(ctx, session.userId, null, grantId);
    await tenancy.breakGlassRecordUse(
      this.db,
      grantId,
      session.userId,
      'enter',
      ctx.requestId ?? null,
    );
    return { token, grant: grantDto(grant) };
  }

  // ------------------------------------------------------------------ platform tenants ---------
  async listTenants(access: AccessContext) {
    const tenants = await tenancy.tenantList(this.db, access.userId);
    return { tenants: tenants.map(tenantDto) };
  }

  /** Creates the tenant, its roles, departments and settings, and the FIRST Tenant Administrator
   *  (onboarding exception, ADR-029), atomically. */
  async createTenant(
    ctx: RequestContext,
    access: AccessContext,
    input: {
      slug: string;
      displayName: string;
      firstAdmin: { email: string; displayName: string };
    },
  ) {
    const tenantId = randomUUID();
    const email = input.firstAdmin.email.trim();
    let created: { userId: string; newAccount: boolean };
    try {
      created = await withTenantTransaction(
        this.db,
        { tenantId, userId: access.userId },
        async (trx) => {
          await tenancy.tenantCreate(
            trx,
            access.userId,
            tenantId,
            input.slug,
            input.displayName,
            ctx.requestId ?? null,
          );
          const roleIds = await tenancy.initialiseTenant(trx, tenantId, DEFAULT_DEPARTMENTS);
          let userId = await identity.userIdByEmail(trx, email);
          const newAccount = userId === null;
          if (userId === null)
            userId = await identity.createUser(trx, email, input.firstAdmin.displayName);
          const membershipId = await tenancy.insertMembership(trx, {
            tenantId,
            userId,
            email,
            displayName: input.firstAdmin.displayName,
          });
          await tenancy.setMemberRoles(trx, tenantId, membershipId, [
            roleIds.tenant_administrator!,
          ]);
          await tenancy.audit(trx, {
            tenantId,
            actorUserId: access.userId,
            actorKind: 'platform',
            action: 'member.first_admin_nominated',
            targetType: 'membership',
            targetId: membershipId,
            requestId: ctx.requestId ?? null,
            detail: { onboardingException: true, newAccount },
          });
          return { userId, newAccount };
        },
      );
    } catch (err) {
      if (pgCode(err) === '23505')
        throw conflict('Slug already used', 'Another organisation already uses this short name.');
      throw err;
    }
    await this.requireMfaFor(ctx, [created.userId]);
    if (created.newAccount)
      await this.issueToken(
        ctx,
        { id: created.userId, email },
        'activation',
        tenantId,
        access.userId,
      );
    await this.securityEvent(ctx, {
      eventType: 'tenant_created',
      outcome: 'success',
      userId: access.userId,
      detail: { tenant: tenantId },
    });
    const tenant = (await tenancy.tenantList(this.db, access.userId)).find(
      (t) => t.id === tenantId,
    )!;
    return { tenant: tenantDto(tenant) };
  }

  async setTenantStatus(
    ctx: RequestContext,
    access: AccessContext,
    tenantId: string,
    status: 'active' | 'suspended',
  ) {
    const exists = (await tenancy.tenantList(this.db, access.userId)).find(
      (t) => t.id === tenantId,
    );
    if (!exists) throw notFound();
    if (
      !(await tenancy.tenantSetStatus(
        this.db,
        access.userId,
        tenantId,
        status,
        ctx.requestId ?? null,
      ))
    ) {
      throw conflict('No change', `The organisation is already ${status}.`);
    }
    await this.securityEvent(ctx, {
      eventType: status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated',
      outcome: 'info',
      userId: access.userId,
      detail: { tenant: tenantId },
    });
    const tenant = (await tenancy.tenantList(this.db, access.userId)).find(
      (t) => t.id === tenantId,
    )!;
    return { tenant: tenantDto(tenant) };
  }

  // ------------------------------------------------------------------ one-time tokens ----------
  async setPasswordWithToken(ctx: RequestContext, token: string, newPassword: string) {
    const addressKey = throttleKey('token-address', ctx.address ?? 'unknown');
    if (await identity.throttleBlockedUntil(this.db, [addressKey])) {
      throw new ProblemException(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts', {
        detail: 'Please wait and try again.',
      });
    }
    const hash = tokenHash(token);
    const found = await tenancy.tokenLookup(this.db, hash);
    const user = found ? await identity.getUser(this.db, found.userId) : null;
    if (!found || !user) {
      await identity.throttleFail(this.db, addressKey, {
        mode: 'window',
        threshold: 20,
        windowSeconds: 600,
        baseSeconds: 0,
        maxSeconds: 0,
      });
      throw invalid(
        'This link is invalid, has already been used or has expired. Ask your administrator for a new one.',
      );
    }
    // The password rules are checked BEFORE the token is used, so a refused password keeps it valid.
    const problem = passwordProblem(newPassword, { email: user.email }, this.blocklist);
    if (problem) throw invalid(problem, 'body.newPassword');
    const redeemed = await tenancy.tokenRedeem(this.db, hash);
    if (!redeemed || redeemed.userId !== user.id)
      throw invalid('This link is invalid, has already been used or has expired.');
    await identity.credentialSet(this.db, user.id, await hashPassword(newPassword));
    const ended = await identity.sessionEndAll(this.db, user.id, 'password_reset', null);
    await this.securityEvent(ctx, {
      eventType: 'password_set_with_token',
      outcome: 'success',
      userId: user.id,
      detail: { purpose: redeemed.purpose, sessionsEnded: ended },
    });
    return { status: 'password-set' as const };
  }
}

export const tenantDto = (t: {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
}) => ({
  id: t.id,
  slug: t.slug,
  displayName: t.name,
  status: t.status,
  createdAt: t.createdAt.toISOString(),
});

function randomBytesToken(): string {
  return newSessionToken(); // same generator: 256 random bits, base64url
}

export const tokenHash = (token: string): Buffer => sha256(`one-time:${token}`);

export type { MemberRow, RoleRow };
