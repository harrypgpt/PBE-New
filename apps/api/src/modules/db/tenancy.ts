import { sql } from 'kysely';
import type { Database } from './database';
import type { Tx } from './tenant-context';
import { withUserTransaction } from './tenant-context';

/**
 * Tenancy, roles, departments, break-glass and token data access (Stage 7A; ADR-027–ADR-029).
 * Functions taking `trx` run inside withTenantTransaction: PostgreSQL RLS limits every query to
 * the transaction's tenant, so a row id from another tenant simply is not found.
 * Functions taking `db` call one reviewed SECURITY DEFINER function each.
 */

export interface MemberRow {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  status: 'active' | 'deactivated';
  roleIds: string[];
  departmentIds: string[];
}

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  templateKey: string | null;
  permissions: string[];
  memberCount: number;
}

export interface DepartmentRow {
  id: string;
  name: string;
  description: string;
  memberCount: number;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
}

export interface GrantRow {
  id: string;
  tenantId: string;
  requestedBy: string;
  purpose: string;
  status: 'requested' | 'approved' | 'rejected' | 'revoked' | 'expired';
  requestedAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

export interface AuditInput {
  tenantId: string | null;
  actorUserId: string | null;
  actorKind: 'member' | 'platform' | 'break_glass' | 'operator' | 'self';
  action: string;
  targetType: string;
  targetId: string | null;
  beforeDigest?: Buffer | null;
  afterDigest?: Buffer | null;
  requestId?: string | null;
  detail?: Record<string, string | number | boolean | string[]>;
}

const asGrant = (r: {
  id: string;
  tenant_id: string;
  requested_by: string;
  purpose: string;
  status: GrantRow['status'];
  requested_at: Date;
  decided_at: Date | null;
  expires_at: Date | null;
}): GrantRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  requestedBy: r.requested_by,
  purpose: r.purpose,
  status: r.status,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at,
  expiresAt: r.expires_at,
});

export const tenancy = {
  // ---------------------------------------------------------------- tenant-scoped (RLS) --------
  /** The tenant of the current context (platform.tenant self-read policy). */
  async currentTenant(trx: Tx): Promise<TenantRow | null> {
    const r = await trx
      .selectFrom('platform.tenant')
      .select(['id', 'slug', 'display_name', 'status', 'created_at'])
      .executeTakeFirst();
    return r
      ? {
          id: r.id,
          slug: r.slug,
          name: r.display_name,
          status: r.status as TenantRow['status'],
          createdAt: r.created_at,
        }
      : null;
  },

  /** The user's membership in the current tenant and its effective permissions. */
  async membershipOf(
    trx: Tx,
    userId: string,
  ): Promise<{ membershipId: string; status: string; permissions: string[] } | null> {
    const m = await trx
      .selectFrom('app.membership')
      .select(['id', 'status'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!m) return null;
    const perms = await trx
      .selectFrom('app.membership_role as mr')
      .innerJoin('app.role_permission as rp', (j) =>
        j.onRef('rp.tenant_id', '=', 'mr.tenant_id').onRef('rp.role_id', '=', 'mr.role_id'),
      )
      .select('rp.permission')
      .distinct()
      .where('mr.membership_id', '=', m.id)
      .execute();
    return {
      membershipId: m.id,
      status: m.status,
      permissions: perms.map((p) => p.permission).sort(),
    };
  },

  async listMembers(trx: Tx, onlyId?: string): Promise<MemberRow[]> {
    let q = trx
      .selectFrom('app.membership')
      .select(['id', 'user_id', 'email', 'display_name', 'status'])
      .orderBy('created_at')
      .orderBy('id');
    if (onlyId) q = q.where('id', '=', onlyId);
    const members = await q.execute();
    if (members.length === 0) return [];
    const ids = members.map((m) => m.id);
    const [roles, depts] = await Promise.all([
      trx
        .selectFrom('app.membership_role')
        .select(['membership_id', 'role_id'])
        .where('membership_id', 'in', ids)
        .execute(),
      trx
        .selectFrom('app.membership_department')
        .select(['membership_id', 'department_id'])
        .where('membership_id', 'in', ids)
        .execute(),
    ]);
    return members.map((m) => ({
      id: m.id,
      userId: m.user_id,
      email: m.email,
      displayName: m.display_name,
      status: m.status as MemberRow['status'],
      roleIds: roles
        .filter((r) => r.membership_id === m.id)
        .map((r) => r.role_id)
        .sort(),
      departmentIds: depts
        .filter((d) => d.membership_id === m.id)
        .map((d) => d.department_id)
        .sort(),
    }));
  },

  async getMember(trx: Tx, membershipId: string): Promise<MemberRow | null> {
    return (await tenancy.listMembers(trx, membershipId))[0] ?? null;
  },

  async findMembershipByUser(trx: Tx, userId: string): Promise<string | null> {
    const r = await trx
      .selectFrom('app.membership')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return r?.id ?? null;
  },

  async insertMembership(
    trx: Tx,
    m: { tenantId: string; userId: string; email: string; displayName: string },
  ): Promise<string> {
    const r = await trx
      .insertInto('app.membership')
      .values({
        tenant_id: m.tenantId,
        user_id: m.userId,
        email: m.email,
        display_name: m.displayName,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  },

  async setMembershipStatus(
    trx: Tx,
    membershipId: string,
    status: 'active' | 'deactivated',
  ): Promise<boolean> {
    const r = await trx
      .updateTable('app.membership')
      .set({ status, updated_at: new Date() })
      .where('id', '=', membershipId)
      .where('status', '<>', status)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async setMemberRoles(
    trx: Tx,
    tenantId: string,
    membershipId: string,
    roleIds: string[],
  ): Promise<void> {
    await trx.deleteFrom('app.membership_role').where('membership_id', '=', membershipId).execute();
    if (roleIds.length > 0) {
      await trx
        .insertInto('app.membership_role')
        .values(
          roleIds.map((role_id) => ({ tenant_id: tenantId, membership_id: membershipId, role_id })),
        )
        .execute();
    }
  },

  async setMemberDepartments(
    trx: Tx,
    tenantId: string,
    membershipId: string,
    departmentIds: string[],
  ): Promise<void> {
    await trx
      .deleteFrom('app.membership_department')
      .where('membership_id', '=', membershipId)
      .execute();
    if (departmentIds.length > 0) {
      await trx
        .insertInto('app.membership_department')
        .values(
          departmentIds.map((department_id) => ({
            tenant_id: tenantId,
            membership_id: membershipId,
            department_id,
          })),
        )
        .execute();
    }
  },

  async listRoles(trx: Tx, onlyId?: string): Promise<RoleRow[]> {
    let q = trx
      .selectFrom('app.role')
      .select(['id', 'name', 'description', 'template_key'])
      .orderBy('name');
    if (onlyId) q = q.where('id', '=', onlyId);
    const roles = await q.execute();
    if (roles.length === 0) return [];
    const ids = roles.map((r) => r.id);
    const [perms, counts] = await Promise.all([
      trx
        .selectFrom('app.role_permission')
        .select(['role_id', 'permission'])
        .where('role_id', 'in', ids)
        .execute(),
      trx
        .selectFrom('app.membership_role as mr')
        .innerJoin('app.membership as m', (j) =>
          j.onRef('m.tenant_id', '=', 'mr.tenant_id').onRef('m.id', '=', 'mr.membership_id'),
        )
        .select(['mr.role_id', sql<number>`count(*)::int`.as('n')])
        .where('mr.role_id', 'in', ids)
        .where('m.status', '=', 'active')
        .groupBy('mr.role_id')
        .execute(),
    ]);
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      templateKey: r.template_key,
      permissions: perms
        .filter((p) => p.role_id === r.id)
        .map((p) => p.permission)
        .sort(),
      memberCount: counts.find((c) => c.role_id === r.id)?.n ?? 0,
    }));
  },

  async getRole(trx: Tx, roleId: string): Promise<RoleRow | null> {
    return (await tenancy.listRoles(trx, roleId))[0] ?? null;
  },

  /** Union of the permissions of the given roles (of the current tenant only). */
  async permissionsOfRoles(
    trx: Tx,
    roleIds: string[],
  ): Promise<{ found: number; permissions: string[] }> {
    if (roleIds.length === 0) return { found: 0, permissions: [] };
    const roles = await trx
      .selectFrom('app.role')
      .select('id')
      .where('id', 'in', roleIds)
      .execute();
    const perms = await trx
      .selectFrom('app.role_permission')
      .select('permission')
      .distinct()
      .where('role_id', 'in', roleIds)
      .execute();
    return { found: roles.length, permissions: perms.map((p) => p.permission).sort() };
  },

  async createRole(
    trx: Tx,
    tenantId: string,
    r: { name: string; description: string; permissions: string[]; templateKey?: string | null },
  ): Promise<string> {
    const row = await trx
      .insertInto('app.role')
      .values({
        tenant_id: tenantId,
        name: r.name,
        description: r.description,
        template_key: r.templateKey ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (r.permissions.length > 0) {
      await trx
        .insertInto('app.role_permission')
        .values(
          r.permissions.map((permission) => ({ tenant_id: tenantId, role_id: row.id, permission })),
        )
        .execute();
    }
    return row.id;
  },

  async updateRole(
    trx: Tx,
    tenantId: string,
    roleId: string,
    r: { name: string; description: string; permissions: string[] },
  ): Promise<void> {
    await trx
      .updateTable('app.role')
      .set({ name: r.name, description: r.description, updated_at: new Date() })
      .where('id', '=', roleId)
      .execute();
    await trx.deleteFrom('app.role_permission').where('role_id', '=', roleId).execute();
    if (r.permissions.length > 0) {
      await trx
        .insertInto('app.role_permission')
        .values(
          r.permissions.map((permission) => ({ tenant_id: tenantId, role_id: roleId, permission })),
        )
        .execute();
    }
  },

  async deleteRole(trx: Tx, roleId: string): Promise<boolean> {
    const r = await trx.deleteFrom('app.role').where('id', '=', roleId).executeTakeFirst();
    return Number(r.numDeletedRows) === 1;
  },

  /** Active members holding a permission through any role (lock-out protection). */
  async activeHoldersOf(trx: Tx, permission: string): Promise<number> {
    const r = await trx
      .selectFrom('app.membership as m')
      .innerJoin('app.membership_role as mr', (j) =>
        j.onRef('mr.tenant_id', '=', 'm.tenant_id').onRef('mr.membership_id', '=', 'm.id'),
      )
      .innerJoin('app.role_permission as rp', (j) =>
        j.onRef('rp.tenant_id', '=', 'mr.tenant_id').onRef('rp.role_id', '=', 'mr.role_id'),
      )
      .select(sql<number>`count(DISTINCT m.id)::int`.as('n'))
      .where('m.status', '=', 'active')
      .where('rp.permission', '=', permission)
      .executeTakeFirstOrThrow();
    return r.n;
  },

  /** Users (active members) holding any of the permissions: they must use MFA. */
  async usersHoldingAny(trx: Tx, permissions: readonly string[]): Promise<string[]> {
    const r = await trx
      .selectFrom('app.membership as m')
      .innerJoin('app.membership_role as mr', (j) =>
        j.onRef('mr.tenant_id', '=', 'm.tenant_id').onRef('mr.membership_id', '=', 'm.id'),
      )
      .innerJoin('app.role_permission as rp', (j) =>
        j.onRef('rp.tenant_id', '=', 'mr.tenant_id').onRef('rp.role_id', '=', 'mr.role_id'),
      )
      .select('m.user_id')
      .distinct()
      .where('m.status', '=', 'active')
      .where('rp.permission', 'in', [...permissions])
      .execute();
    return r.map((x) => x.user_id);
  },

  /** Serialises administrative changes within one tenant (transaction-scoped advisory lock). */
  async lockTenantAdministration(trx: Tx, tenantId: string): Promise<void> {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`pbe-admin:${tenantId}`}, 0))`.execute(
      trx,
    );
  },

  async listDepartments(trx: Tx, onlyId?: string): Promise<DepartmentRow[]> {
    let q = trx
      .selectFrom('app.department as d')
      .leftJoin('app.membership_department as md', (j) =>
        j.onRef('md.tenant_id', '=', 'd.tenant_id').onRef('md.department_id', '=', 'd.id'),
      )
      .select([
        'd.id',
        'd.name',
        'd.description',
        sql<number>`count(md.membership_id)::int`.as('n'),
      ])
      .groupBy(['d.id', 'd.name', 'd.description'])
      .orderBy('d.name');
    if (onlyId) q = q.where('d.id', '=', onlyId);
    return (await q.execute()).map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      memberCount: d.n,
    }));
  },

  async departmentsExist(trx: Tx, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await trx.selectFrom('app.department').select('id').where('id', 'in', ids).execute())
      .length;
  },

  async createDepartment(
    trx: Tx,
    tenantId: string,
    d: { name: string; description: string },
  ): Promise<string> {
    const r = await trx
      .insertInto('app.department')
      .values({ tenant_id: tenantId, ...d })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  },

  async updateDepartment(
    trx: Tx,
    id: string,
    d: { name: string; description: string },
  ): Promise<boolean> {
    const r = await trx
      .updateTable('app.department')
      .set(d)
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  },

  async deleteDepartment(trx: Tx, id: string): Promise<boolean> {
    const r = await trx.deleteFrom('app.department').where('id', '=', id).executeTakeFirst();
    return Number(r.numDeletedRows) === 1;
  },

  async getSettings(trx: Tx): Promise<{ selfApprovalAllowed: boolean } | null> {
    const r = await trx
      .selectFrom('app.tenant_setting')
      .select('self_approval_allowed')
      .executeTakeFirst();
    return r ? { selfApprovalAllowed: r.self_approval_allowed } : null;
  },

  async updateSettings(trx: Tx, s: { selfApprovalAllowed: boolean }): Promise<void> {
    await trx
      .updateTable('app.tenant_setting')
      .set({ self_approval_allowed: s.selfApprovalAllowed, updated_at: new Date() })
      .execute();
  },

  /** New tenant: roles from the templates, default departments, settings. Returns role ids by key. */
  async initialiseTenant(
    trx: Tx,
    tenantId: string,
    departments: readonly string[],
  ): Promise<Record<string, string>> {
    const templates = await trx
      .selectFrom('platform.role_template')
      .select(['key', 'name', 'description'])
      .orderBy('position')
      .execute();
    const templatePerms = await trx
      .selectFrom('platform.role_template_permission')
      .select(['template_key', 'permission'])
      .execute();
    const ids: Record<string, string> = {};
    for (const t of templates) {
      ids[t.key] = await tenancy.createRole(trx, tenantId, {
        name: t.name,
        description: t.description,
        templateKey: t.key,
        permissions: templatePerms.filter((p) => p.template_key === t.key).map((p) => p.permission),
      });
    }
    for (const name of departments)
      await tenancy.createDepartment(trx, tenantId, { name, description: '' });
    await trx.insertInto('app.tenant_setting').values({ tenant_id: tenantId }).execute();
    return ids;
  },

  /** The fixed catalogue as stored (compared with the code catalogue by a test). */
  async permissionCatalogue(
    trx: Tx,
  ): Promise<Array<{ code: string; scope: string; readOnly: boolean; description: string }>> {
    const r = await trx
      .selectFrom('platform.permission')
      .select(['code', 'scope', 'read_only', 'description'])
      .orderBy('code')
      .execute();
    return r.map((p) => ({
      code: p.code,
      scope: p.scope,
      readOnly: p.read_only,
      description: p.description,
    }));
  },

  /** Appends to the business audit trail in the caller's transaction (atomic with the change). */
  async audit(trx: Tx, e: AuditInput): Promise<void> {
    await trx
      .insertInto('audit.audit_event')
      .values({
        tenant_id: e.tenantId,
        actor_user_id: e.actorUserId,
        actor_kind: e.actorKind,
        action: e.action,
        target_type: e.targetType,
        target_id: e.targetId,
        before_digest: e.beforeDigest ?? null,
        after_digest: e.afterDigest ?? null,
        request_id: e.requestId ?? null,
        detail: JSON.stringify(e.detail ?? {}),
      })
      .execute();
  },

  // ---------------------------------------------------------------- user context (no tenant) -----
  /** Active tenants the user is an active member of (own memberships only, ADR-027 pattern). */
  async memberTenants(db: Database, userId: string): Promise<TenantRow[]> {
    return withUserTransaction(db, userId, async (trx) => {
      const rows = await trx
        .selectFrom('platform.tenant')
        .select(['id', 'slug', 'display_name', 'status', 'created_at'])
        .where('status', '=', 'active')
        .orderBy('display_name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.display_name,
        status: 'active' as const,
        createdAt: r.created_at,
      }));
    });
  },

  // ---------------------------------------------------------------- reviewed functions ----------
  async platformRoles(db: Database, userId: string): Promise<string[]> {
    const { rows } = await sql<{
      role: string;
    }>`SELECT platform.access_platform_roles(${userId}::uuid) AS role`.execute(db);
    return rows.map((r) => r.role);
  },

  async sessionContext(
    db: Database,
    sessionId: string,
  ): Promise<{ tenantId: string | null; grantId: string | null } | null> {
    const { rows } = await sql<{
      active_tenant_id: string | null;
      break_glass_grant_id: string | null;
    }>`
      SELECT * FROM platform.auth_session_context(${sessionId}::uuid)`.execute(db);
    const r = rows[0];
    return r ? { tenantId: r.active_tenant_id, grantId: r.break_glass_grant_id } : null;
  },

  async sessionSetContext(
    db: Database,
    sessionId: string,
    tenantId: string | null,
    grantId: string | null,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.auth_session_set_context(${sessionId}::uuid, ${tenantId}::uuid, ${grantId}::uuid) AS ok`.execute(
      db,
    );
    return rows[0]?.ok === true;
  },

  async tenantList(db: Database, actor: string): Promise<TenantRow[]> {
    const { rows } = await sql<{
      id: string;
      slug: string;
      display_name: string;
      status: TenantRow['status'];
      created_at: Date;
    }>`
      SELECT * FROM platform.admin_tenant_list(${actor}::uuid)`.execute(db);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.display_name,
      status: r.status,
      createdAt: r.created_at,
    }));
  },

  /** Creates the tenant row inside the caller's transaction (the tenant is then initialised in it). */
  async tenantCreate(
    trx: Tx,
    actor: string,
    id: string,
    slug: string,
    name: string,
    requestId: string | null,
  ): Promise<void> {
    await sql`SELECT platform.admin_tenant_create(${actor}::uuid, ${id}::uuid, ${slug}, ${name}, ${requestId}::uuid)`.execute(
      trx,
    );
  },

  async tenantSetStatus(
    db: Database,
    actor: string,
    tenantId: string,
    status: 'active' | 'suspended',
    requestId: string | null,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.admin_tenant_set_status(${actor}::uuid, ${tenantId}::uuid, ${status}, ${requestId}::uuid) AS ok`.execute(
      db,
    );
    return rows[0]?.ok === true;
  },

  async breakGlassRequest(
    db: Database,
    actor: string,
    tenantId: string,
    purpose: string,
    requestId: string | null,
  ): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      SELECT platform.breakglass_request(${actor}::uuid, ${tenantId}::uuid, ${purpose}, ${requestId}::uuid) AS id`.execute(
      db,
    );
    return rows[0]?.id ?? null;
  },

  /** Current state of ONE grant; an approved grant past its expiry is marked expired (audited). */
  async breakGlassRefresh(db: Database, grantId: string): Promise<GrantRow | null> {
    const { rows } = await sql<
      Parameters<typeof asGrant>[0]
    >`SELECT * FROM platform.breakglass_refresh(${grantId}::uuid)`.execute(db);
    return rows[0] ? asGrant(rows[0]) : null;
  },

  async breakGlassForTenant(db: Database, tenantId: string): Promise<GrantRow[]> {
    const { rows } = await sql<
      Parameters<typeof asGrant>[0]
    >`SELECT * FROM platform.breakglass_list_for_tenant(${tenantId}::uuid)`.execute(db);
    return rows.map(asGrant);
  },

  async breakGlassForRequester(db: Database, actor: string): Promise<GrantRow[]> {
    const { rows } = await sql<
      Parameters<typeof asGrant>[0]
    >`SELECT * FROM platform.breakglass_list_for_requester(${actor}::uuid)`.execute(db);
    return rows.map(asGrant);
  },

  async breakGlassDecide(
    db: Database,
    grantId: string,
    tenantId: string,
    actor: string,
    approve: boolean,
    requestId: string | null,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.breakglass_decide(${grantId}::uuid, ${tenantId}::uuid, ${actor}::uuid, ${approve}, ${requestId}::uuid) AS ok`.execute(
      db,
    );
    return rows[0]?.ok === true;
  },

  async breakGlassRevoke(
    db: Database,
    grantId: string,
    actor: string,
    tenantId: string | null,
    requestId: string | null,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.breakglass_revoke(${grantId}::uuid, ${actor}::uuid, ${tenantId}::uuid, ${requestId}::uuid) AS ok`.execute(
      db,
    );
    return rows[0]?.ok === true;
  },

  async breakGlassRecordUse(
    db: Database,
    grantId: string,
    actor: string,
    operation: string,
    requestId: string | null,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.breakglass_record_use(${grantId}::uuid, ${actor}::uuid, ${operation}, ${requestId}::uuid) AS ok`.execute(
      db,
    );
    return rows[0]?.ok === true;
  },

  async tokenIssue(
    db: Database,
    t: {
      userId: string;
      purpose: 'activation' | 'password_reset';
      hash: Buffer;
      ttlSeconds: number;
      tenantId: string | null;
      actor: string | null;
    },
  ): Promise<Date> {
    const { rows } = await sql<{ expires: Date }>`
      SELECT platform.token_issue(${t.userId}::uuid, ${t.purpose}, ${t.hash}, ${t.ttlSeconds}::integer, ${t.tenantId}::uuid, ${t.actor}::uuid) AS expires`.execute(
      db,
    );
    return rows[0]!.expires;
  },

  async tokenLookup(
    db: Database,
    hash: Buffer,
  ): Promise<{ userId: string; purpose: string } | null> {
    const { rows } = await sql<{
      user_id: string;
      purpose: string;
    }>`SELECT * FROM platform.token_lookup(${hash})`.execute(db);
    const r = rows[0];
    return r ? { userId: r.user_id, purpose: r.purpose } : null;
  },

  async tokenRedeem(
    db: Database,
    hash: Buffer,
  ): Promise<{ userId: string; purpose: string; tenantId: string | null } | null> {
    const { rows } = await sql<{ user_id: string; purpose: string; tenant_id: string | null }>`
      SELECT * FROM platform.token_redeem(${hash})`.execute(db);
    const r = rows[0];
    return r ? { userId: r.user_id, purpose: r.purpose, tenantId: r.tenant_id } : null;
  },

  /** OPERATOR ONLY (owner connection): grant or revoke a platform role, audited in SQL. */
  async operatorSetPlatformRole(
    ownerDb: Database,
    userId: string,
    role: 'platform_owner',
    grant: boolean,
  ): Promise<boolean> {
    const { rows } = await sql<{ changed: boolean }>`
      SELECT platform.operator_platform_role_set(${userId}::uuid, ${role}, ${grant}) AS changed`.execute(
      ownerDb,
    );
    return rows[0]?.changed === true;
  },
};
