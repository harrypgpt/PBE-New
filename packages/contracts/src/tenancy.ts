import { z } from 'zod';
import { EmailSchema, NewPasswordSchema } from './auth';
import { ProblemDetailsSchema } from './problem-details';
import { defineRoute, type RouteContract } from './route';

/**
 * Stage 7A contracts: active tenant, organisation administration, platform administration,
 * break-glass and one-time-token password setting (ADR-028, ADR-029).
 * Tenant routes act on the session's ACTIVE tenant only: no tenant id is ever taken from the
 * request, so a caller cannot point a request at another organisation.
 */

const problem = (description: string) => ({ description, schema: ProblemDetailsSchema });
const STD = {
  400: problem('Malformed request or rule not met.'),
  401: problem('Not signed in.'),
  403: problem('Permission or origin check failed.'),
  404: problem('Not found in this organisation.'),
} as const;

const Id = z.uuid();
const Name = z.string().trim().min(1).max(100);
const Description = z.string().trim().max(500);
const Permission = z.string().regex(/^[a-z]+(\.[a-z]+)+$/);
const idParam = (name: string) => z.strictObject({ [name]: Id });

export const TenantRefSchema = z.strictObject({ id: Id, name: z.string(), slug: z.string() });

// --- Session: choose the active organisation --------------------------------------------------
export const sessionTenantsRoute = defineRoute({
  operationId: 'getSessionTenants',
  method: 'GET',
  path: '/session/tenants',
  summary: 'Organisations the signed-in user is an active member of',
  access: { kind: 'authenticated' },
  request: {},
  responses: {
    200: {
      description: 'Memberships.',
      schema: z.strictObject({ tenants: z.array(TenantRefSchema) }),
    },
    401: STD[401],
  },
});

export const sessionTenantRoute = defineRoute({
  operationId: 'postSessionTenant',
  method: 'POST',
  path: '/session/tenant',
  summary: 'Choose the active organisation (rotates the session)',
  access: { kind: 'authenticated' },
  request: { body: z.strictObject({ tenantId: Id }) },
  responses: {
    200: {
      description: 'Active organisation set.',
      schema: z.strictObject({ activeTenant: TenantRefSchema }),
    },
    ...STD,
  },
});

// --- Members -----------------------------------------------------------------------------------
export const MemberSchema = z.strictObject({
  id: Id,
  userId: Id,
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'deactivated']),
  roleIds: z.array(Id),
  departmentIds: z.array(Id),
});

export const tenantMembersRoute = defineRoute({
  operationId: 'getTenantMembers',
  method: 'GET',
  path: '/tenant/members',
  summary: 'Members of the active organisation',
  access: { kind: 'permission', permission: 'tenant.members.read' },
  request: {},
  responses: {
    200: { description: 'Members.', schema: z.strictObject({ members: z.array(MemberSchema) }) },
    ...STD,
  },
});

export const tenantMemberAddRoute = defineRoute({
  operationId: 'postTenantMember',
  method: 'POST',
  path: '/tenant/members',
  summary:
    'Add a member (a new account receives an activation link through the separate delivery channel)',
  access: { kind: 'permission', permission: 'tenant.members.manage' },
  request: { body: z.strictObject({ email: EmailSchema, displayName: Name }) },
  responses: {
    201: {
      description: 'Member added. No token is ever returned.',
      schema: z.strictObject({ member: MemberSchema }),
    },
    ...STD,
    409: problem('Already a member.'),
  },
});

const memberAction = (operationId: string, segment: string, summary: string, permission: string) =>
  defineRoute({
    operationId,
    method: 'POST',
    path: `/tenant/members/:membershipId/${segment}`,
    summary,
    access: { kind: 'permission', permission },
    request: { params: idParam('membershipId') },
    responses: {
      200: { description: 'Done.', schema: z.strictObject({ member: MemberSchema }) },
      ...STD,
      409: problem('Not allowed in the current state.'),
    },
  });

export const tenantMemberDeactivateRoute = memberAction(
  'postTenantMemberDeactivation',
  'deactivation',
  'Deactivate a membership (access ends at the next request)',
  'tenant.members.manage',
);
export const tenantMemberReactivateRoute = memberAction(
  'postTenantMemberReactivation',
  'reactivation',
  'Reactivate a membership',
  'tenant.members.manage',
);

export const tenantMemberPasswordResetRoute = defineRoute({
  operationId: 'postTenantMemberPasswordReset',
  method: 'POST',
  path: '/tenant/members/:membershipId/password-reset',
  summary:
    'Start a password reset: ends the member’s sessions and sends a one-time link through the separate delivery channel',
  access: { kind: 'permission', permission: 'tenant.members.manage' },
  request: { params: idParam('membershipId') },
  responses: {
    200: {
      description: 'Reset started. The token is never returned.',
      schema: z.strictObject({ status: z.literal('sent'), expiresAt: z.iso.datetime() }),
    },
    ...STD,
  },
});

export const tenantMemberRolesRoute = defineRoute({
  operationId: 'putTenantMemberRoles',
  method: 'PUT',
  path: '/tenant/members/:membershipId/roles',
  summary: 'Set a member’s roles (you can only grant permissions you hold)',
  access: { kind: 'permission', permission: 'tenant.roles.manage' },
  request: {
    params: idParam('membershipId'),
    body: z.strictObject({ roleIds: z.array(Id).max(50) }),
  },
  responses: {
    200: { description: 'Roles set.', schema: z.strictObject({ member: MemberSchema }) },
    ...STD,
    409: problem('Would leave no one able to manage roles.'),
  },
});

export const tenantMemberDepartmentsRoute = defineRoute({
  operationId: 'putTenantMemberDepartments',
  method: 'PUT',
  path: '/tenant/members/:membershipId/departments',
  summary: 'Set a member’s departments',
  access: { kind: 'permission', permission: 'tenant.departments.manage' },
  request: {
    params: idParam('membershipId'),
    body: z.strictObject({ departmentIds: z.array(Id).max(50) }),
  },
  responses: {
    200: { description: 'Departments set.', schema: z.strictObject({ member: MemberSchema }) },
    ...STD,
  },
});

// --- Roles and permissions ----------------------------------------------------------------------
export const RoleSchema = z.strictObject({
  id: Id,
  name: z.string(),
  description: z.string(),
  templateKey: z.string().nullable(),
  permissions: z.array(Permission),
  memberCount: z.number().int().min(0),
});
const RoleInput = z.strictObject({
  name: Name,
  description: Description.default(''),
  permissions: z.array(Permission).max(100),
});

export const tenantRolesRoute = defineRoute({
  operationId: 'getTenantRoles',
  method: 'GET',
  path: '/tenant/roles',
  summary: 'Roles of the active organisation',
  access: { kind: 'permission', permission: 'tenant.roles.read' },
  request: {},
  responses: {
    200: { description: 'Roles.', schema: z.strictObject({ roles: z.array(RoleSchema) }) },
    ...STD,
  },
});

export const tenantPermissionsRoute = defineRoute({
  operationId: 'getTenantPermissions',
  method: 'GET',
  path: '/tenant/permissions',
  summary: 'The fixed tenant permission catalogue',
  access: { kind: 'permission', permission: 'tenant.roles.read' },
  request: {},
  responses: {
    200: {
      description: 'Catalogue.',
      schema: z.strictObject({
        permissions: z.array(
          z.strictObject({ code: Permission, description: z.string(), readOnly: z.boolean() }),
        ),
      }),
    },
    ...STD,
  },
});

export const tenantRoleCreateRoute = defineRoute({
  operationId: 'postTenantRole',
  method: 'POST',
  path: '/tenant/roles',
  summary: 'Create a role (only with permissions you hold)',
  access: { kind: 'permission', permission: 'tenant.roles.manage' },
  request: { body: RoleInput },
  responses: {
    201: { description: 'Created.', schema: z.strictObject({ role: RoleSchema }) },
    ...STD,
    409: problem('Name already used.'),
  },
});

export const tenantRoleUpdateRoute = defineRoute({
  operationId: 'putTenantRole',
  method: 'PUT',
  path: '/tenant/roles/:roleId',
  summary: 'Change a role (only with permissions you hold)',
  access: { kind: 'permission', permission: 'tenant.roles.manage' },
  request: { params: idParam('roleId'), body: RoleInput },
  responses: {
    200: { description: 'Changed.', schema: z.strictObject({ role: RoleSchema }) },
    ...STD,
    409: problem('Name used, or would leave no one able to manage roles.'),
  },
});

export const tenantRoleDeleteRoute = defineRoute({
  operationId: 'deleteTenantRole',
  method: 'DELETE',
  path: '/tenant/roles/:roleId',
  summary: 'Delete a role',
  access: { kind: 'permission', permission: 'tenant.roles.manage' },
  request: { params: idParam('roleId') },
  responses: {
    200: { description: 'Deleted.', schema: z.strictObject({ status: z.literal('deleted') }) },
    ...STD,
    409: problem('Would leave no one able to manage roles.'),
  },
});

// --- Departments --------------------------------------------------------------------------------
export const DepartmentSchema = z.strictObject({
  id: Id,
  name: z.string(),
  description: z.string(),
  memberCount: z.number().int().min(0),
});
const DepartmentInput = z.strictObject({ name: Name, description: Description.default('') });

export const tenantDepartmentsRoute = defineRoute({
  operationId: 'getTenantDepartments',
  method: 'GET',
  path: '/tenant/departments',
  summary: 'Departments of the active organisation',
  access: { kind: 'permission', permission: 'tenant.departments.read' },
  request: {},
  responses: {
    200: {
      description: 'Departments.',
      schema: z.strictObject({ departments: z.array(DepartmentSchema) }),
    },
    ...STD,
  },
});

export const tenantDepartmentCreateRoute = defineRoute({
  operationId: 'postTenantDepartment',
  method: 'POST',
  path: '/tenant/departments',
  summary: 'Create a department',
  access: { kind: 'permission', permission: 'tenant.departments.manage' },
  request: { body: DepartmentInput },
  responses: {
    201: { description: 'Created.', schema: z.strictObject({ department: DepartmentSchema }) },
    ...STD,
    409: problem('Name already used.'),
  },
});

export const tenantDepartmentUpdateRoute = defineRoute({
  operationId: 'putTenantDepartment',
  method: 'PUT',
  path: '/tenant/departments/:departmentId',
  summary: 'Change a department',
  access: { kind: 'permission', permission: 'tenant.departments.manage' },
  request: { params: idParam('departmentId'), body: DepartmentInput },
  responses: {
    200: { description: 'Changed.', schema: z.strictObject({ department: DepartmentSchema }) },
    ...STD,
    409: problem('Name already used.'),
  },
});

export const tenantDepartmentDeleteRoute = defineRoute({
  operationId: 'deleteTenantDepartment',
  method: 'DELETE',
  path: '/tenant/departments/:departmentId',
  summary: 'Delete a department',
  access: { kind: 'permission', permission: 'tenant.departments.manage' },
  request: { params: idParam('departmentId') },
  responses: {
    200: { description: 'Deleted.', schema: z.strictObject({ status: z.literal('deleted') }) },
    ...STD,
  },
});

// --- Settings -----------------------------------------------------------------------------------
export const TenantSettingsSchema = z.strictObject({ selfApprovalAllowed: z.boolean() });

export const tenantSettingsRoute = defineRoute({
  operationId: 'getTenantSettings',
  method: 'GET',
  path: '/tenant/settings',
  summary: 'Organisation settings (separation of duties)',
  access: { kind: 'permission', permission: 'tenant.settings.read' },
  request: {},
  responses: { 200: { description: 'Settings.', schema: TenantSettingsSchema }, ...STD },
});

export const tenantSettingsUpdateRoute = defineRoute({
  operationId: 'putTenantSettings',
  method: 'PUT',
  path: '/tenant/settings',
  summary: 'Change organisation settings',
  access: { kind: 'permission', permission: 'tenant.settings.manage' },
  request: { body: TenantSettingsSchema },
  responses: { 200: { description: 'Changed.', schema: TenantSettingsSchema }, ...STD },
});

// --- Break-glass (ADR-028) ----------------------------------------------------------------------
export const BreakGlassGrantSchema = z.strictObject({
  id: Id,
  tenantId: Id,
  requestedBy: Id,
  purpose: z.string(),
  status: z.enum(['requested', 'approved', 'rejected', 'revoked', 'expired']),
  requestedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export const tenantBreakGlassListRoute = defineRoute({
  operationId: 'getTenantBreakGlass',
  method: 'GET',
  path: '/tenant/break-glass',
  summary: 'Break-glass requests for the active organisation',
  access: { kind: 'permission', permission: 'tenant.breakglass.approve' },
  request: {},
  responses: {
    200: {
      description: 'Requests.',
      schema: z.strictObject({ grants: z.array(BreakGlassGrantSchema) }),
    },
    ...STD,
  },
});

export const tenantBreakGlassDecisionRoute = defineRoute({
  operationId: 'postTenantBreakGlassDecision',
  method: 'POST',
  path: '/tenant/break-glass/:grantId/decision',
  summary: 'Approve (one hour, read-only) or reject a break-glass request',
  access: { kind: 'permission', permission: 'tenant.breakglass.approve' },
  request: {
    params: idParam('grantId'),
    body: z.strictObject({ decision: z.enum(['approve', 'reject']) }),
  },
  responses: {
    200: { description: 'Decided.', schema: z.strictObject({ grant: BreakGlassGrantSchema }) },
    ...STD,
    409: problem('Not awaiting a decision.'),
  },
});

export const tenantBreakGlassRevokeRoute = defineRoute({
  operationId: 'postTenantBreakGlassRevocation',
  method: 'POST',
  path: '/tenant/break-glass/:grantId/revocation',
  summary: 'Revoke break-glass access to the active organisation',
  access: { kind: 'permission', permission: 'tenant.breakglass.approve' },
  request: { params: idParam('grantId') },
  responses: {
    200: { description: 'Revoked.', schema: z.strictObject({ grant: BreakGlassGrantSchema }) },
    ...STD,
    409: problem('Not active.'),
  },
});

// --- Platform (Super Admin) ---------------------------------------------------------------------
export const PlatformTenantSchema = z.strictObject({
  id: Id,
  slug: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAt: z.iso.datetime(),
});

export const platformTenantsRoute = defineRoute({
  operationId: 'getPlatformTenants',
  method: 'GET',
  path: '/platform/tenants',
  summary: 'Organisation registry (no customer data)',
  access: { kind: 'permission', permission: 'platform.tenants.read' },
  request: {},
  responses: {
    200: {
      description: 'Organisations.',
      schema: z.strictObject({ tenants: z.array(PlatformTenantSchema) }),
    },
    ...STD,
  },
});

export const platformTenantCreateRoute = defineRoute({
  operationId: 'postPlatformTenant',
  method: 'POST',
  path: '/platform/tenants',
  summary:
    'Create an organisation and nominate its first Tenant Administrator (onboarding exception, ADR-029)',
  access: { kind: 'permission', permission: 'platform.tenants.manage' },
  request: {
    body: z.strictObject({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      displayName: z.string().trim().min(1).max(200),
      firstAdmin: z.strictObject({ email: EmailSchema, displayName: Name }),
    }),
  },
  responses: {
    201: { description: 'Created.', schema: z.strictObject({ tenant: PlatformTenantSchema }) },
    ...STD,
    409: problem('Slug already used.'),
  },
});

const tenantStatusRoute = (operationId: string, segment: string, summary: string) =>
  defineRoute({
    operationId,
    method: 'POST',
    path: `/platform/tenants/:tenantId/${segment}`,
    summary,
    access: { kind: 'permission', permission: 'platform.tenants.manage' },
    request: { params: idParam('tenantId') },
    responses: {
      200: { description: 'Done.', schema: z.strictObject({ tenant: PlatformTenantSchema }) },
      ...STD,
      409: problem('Already in that state.'),
    },
  });

export const platformTenantSuspendRoute = tenantStatusRoute(
  'postPlatformTenantSuspension',
  'suspension',
  'Suspend an organisation (its members lose access at the next request)',
);
export const platformTenantReactivateRoute = tenantStatusRoute(
  'postPlatformTenantReactivation',
  'reactivation',
  'Reactivate an organisation',
);

export const platformBreakGlassRequestRoute = defineRoute({
  operationId: 'postPlatformBreakGlass',
  method: 'POST',
  path: '/platform/break-glass',
  summary: 'Request read-only access to one organisation for a stated purpose',
  access: { kind: 'permission', permission: 'platform.breakglass.request' },
  request: { body: z.strictObject({ tenantId: Id, purpose: z.string().trim().min(10).max(1000) }) },
  responses: {
    201: { description: 'Requested.', schema: z.strictObject({ grant: BreakGlassGrantSchema }) },
    ...STD,
  },
});

export const platformBreakGlassListRoute = defineRoute({
  operationId: 'getPlatformBreakGlass',
  method: 'GET',
  path: '/platform/break-glass',
  summary: 'Your break-glass requests',
  access: { kind: 'permission', permission: 'platform.breakglass.request' },
  request: {},
  responses: {
    200: {
      description: 'Requests.',
      schema: z.strictObject({ grants: z.array(BreakGlassGrantSchema) }),
    },
    ...STD,
  },
});

export const platformBreakGlassEnterRoute = defineRoute({
  operationId: 'postPlatformBreakGlassEntry',
  method: 'POST',
  path: '/platform/break-glass/:grantId/entry',
  summary: 'Use an approved grant: read-only access to that organisation until it expires',
  access: { kind: 'permission', permission: 'platform.breakglass.request' },
  request: { params: idParam('grantId') },
  responses: {
    200: { description: 'Entered.', schema: z.strictObject({ grant: BreakGlassGrantSchema }) },
    ...STD,
    409: problem('Not approved, expired or revoked.'),
  },
});

export const platformBreakGlassRevokeRoute = defineRoute({
  operationId: 'postPlatformBreakGlassRevocation',
  method: 'POST',
  path: '/platform/break-glass/:grantId/revocation',
  summary: 'End your own break-glass request or access',
  access: { kind: 'permission', permission: 'platform.breakglass.request' },
  request: { params: idParam('grantId') },
  responses: {
    200: { description: 'Revoked.', schema: z.strictObject({ grant: BreakGlassGrantSchema }) },
    ...STD,
    409: problem('Not active.'),
  },
});

export const sessionContextExitRoute = defineRoute({
  operationId: 'postSessionContextExit',
  method: 'POST',
  path: '/session/context/exit',
  summary: 'Leave the active organisation or break-glass access (rotates the session)',
  access: { kind: 'authenticated' },
  request: {},
  responses: {
    200: { description: 'Left.', schema: z.strictObject({ status: z.literal('left') }) },
    401: STD[401],
    403: STD[403],
  },
});

// --- One-time tokens (activation and reset, ADR-029) ---------------------------------------------
export const tokenPasswordRoute = defineRoute({
  operationId: 'postAccountTokenPassword',
  method: 'POST',
  path: '/account/token-password',
  summary: 'Set your own password with a one-time activation or reset token',
  access: {
    kind: 'public',
    reason: 'The one-time token itself is the credential; the user has no password or session yet.',
  },
  request: {
    body: z.strictObject({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      newPassword: NewPasswordSchema,
    }),
  },
  responses: {
    200: {
      description: 'Password set; sign in with it.',
      schema: z.strictObject({ status: z.literal('password-set') }),
    },
    400: problem('Password not accepted, or token invalid, used or expired.'),
    403: STD[403],
    429: problem('Too many attempts.'),
  },
});

export const TENANCY_ROUTES: readonly RouteContract[] = [
  sessionTenantsRoute,
  sessionTenantRoute,
  sessionContextExitRoute,
  tenantMembersRoute,
  tenantMemberAddRoute,
  tenantMemberDeactivateRoute,
  tenantMemberReactivateRoute,
  tenantMemberPasswordResetRoute,
  tenantMemberRolesRoute,
  tenantMemberDepartmentsRoute,
  tenantRolesRoute,
  tenantPermissionsRoute,
  tenantRoleCreateRoute,
  tenantRoleUpdateRoute,
  tenantRoleDeleteRoute,
  tenantDepartmentsRoute,
  tenantDepartmentCreateRoute,
  tenantDepartmentUpdateRoute,
  tenantDepartmentDeleteRoute,
  tenantSettingsRoute,
  tenantSettingsUpdateRoute,
  tenantBreakGlassListRoute,
  tenantBreakGlassDecisionRoute,
  tenantBreakGlassRevokeRoute,
  platformTenantsRoute,
  platformTenantCreateRoute,
  platformTenantSuspendRoute,
  platformTenantReactivateRoute,
  platformBreakGlassRequestRoute,
  platformBreakGlassListRoute,
  platformBreakGlassEnterRoute,
  platformBreakGlassRevokeRoute,
  tokenPasswordRoute,
];
