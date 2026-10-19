/**
 * Authorisation definition (ADR-029; roadmap Stage 7 "authorisation matrix definition file").
 *  - PERMISSIONS: the FIXED catalogue of stable identifiers. The server checks only these;
 *    role names are never security controls. Mirrored in platform.permission (migration 0004,
 *    extended by 0006); a test fails if the database differs from permissionsForSchema(version).
 *  - ROLE_TEMPLATES: editable starting roles copied into each new organisation (least privilege).
 *  - PLATFORM_ROLE_PERMISSIONS: platform roles grant platform permissions only, never tenant ones.
 * The per-route matrix is derived from the route contracts (authorisationMatrix below).
 */

export interface PermissionDefinition {
  readonly code: string;
  readonly scope: 'tenant' | 'platform';
  /** May be used during read-only break-glass access (ADR-028). */
  readonly readOnly: boolean;
  readonly description: string;
  /** The migration that adds it to platform.permission (absent: 0004). */
  readonly since?: number;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  {
    code: 'tenant.members.read',
    scope: 'tenant',
    readOnly: true,
    description: "See the organisation's members, their roles and departments",
  },
  {
    code: 'tenant.members.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Add, deactivate and reactivate members; start password resets',
  },
  {
    code: 'tenant.roles.read',
    scope: 'tenant',
    readOnly: true,
    description: 'See roles and the permission catalogue',
  },
  {
    code: 'tenant.roles.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Create, change and delete roles; assign roles to members',
  },
  {
    code: 'tenant.departments.read',
    scope: 'tenant',
    readOnly: true,
    description: 'See departments',
  },
  {
    code: 'tenant.departments.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Create, change and delete departments; assign members to them',
  },
  {
    code: 'tenant.settings.read',
    scope: 'tenant',
    readOnly: true,
    description: 'See organisation settings',
  },
  {
    code: 'tenant.settings.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Change organisation settings (e.g. separation of duties)',
  },
  {
    code: 'tenant.breakglass.approve',
    scope: 'tenant',
    readOnly: false,
    description: 'Approve, reject or revoke Super Admin break-glass access',
  },
  {
    code: 'platform.tenants.read',
    scope: 'platform',
    readOnly: true,
    description: 'List organisations (registry only, no customer data)',
  },
  {
    code: 'platform.tenants.manage',
    scope: 'platform',
    readOnly: false,
    description:
      'Create, suspend and reactivate organisations; nominate the first Tenant Administrator',
  },
  {
    code: 'platform.breakglass.request',
    scope: 'platform',
    readOnly: false,
    description: 'Request, enter and revoke break-glass access',
  },
  // Stage 8 (D8-4, D8-6; migration 0006).
  {
    code: 'tenant.projects.read',
    scope: 'tenant',
    readOnly: true,
    description: 'See projects and their scenarios (within department visibility)',
    since: 6,
  },
  {
    code: 'tenant.allprojects.read',
    scope: 'tenant',
    readOnly: true,
    description: 'See all projects of the organisation, whatever their departments',
    since: 6,
  },
  {
    code: 'tenant.projects.create',
    scope: 'tenant',
    readOnly: false,
    description: 'Create projects',
    since: 6,
  },
  {
    code: 'tenant.projects.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Change and archive projects; set their departments',
    since: 6,
  },
  {
    code: 'tenant.scenarios.manage',
    scope: 'tenant',
    readOnly: false,
    description: 'Add and change scenarios',
    since: 6,
  },
];

/** The first migration version of the catalogue (0004). */
const BASE_VERSION = 4;
const sinceOf = (code: string): number =>
  PERMISSIONS.find((p) => p.code === code)?.since ?? BASE_VERSION;

/** The catalogue as seeded in a database at migration `version` (Stage 8 schema profiles, ADR-030). */
export const permissionsForSchema = (version: number): readonly PermissionDefinition[] =>
  PERMISSIONS.filter((p) => (p.since ?? BASE_VERSION) <= version);

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code));
export const TENANT_PERMISSIONS = PERMISSIONS.filter((p) => p.scope === 'tenant').map(
  (p) => p.code,
);
export const READ_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((p) => p.readOnly).map((p) => p.code),
);

/** Holding any of these makes MFA mandatory (SECURITY §3). */
export const ADMINISTRATIVE_PERMISSIONS: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((p) => p.scope === 'tenant' && !p.readOnly).map((p) => p.code),
);

/** The permission that must always have at least one active holder (lock-out protection). */
export const ROLE_MANAGEMENT_PERMISSION = 'tenant.roles.manage';

export interface RoleTemplate {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

/*
 * Stage 8 (D8-5): the Tenant Administrator keeps EVERY tenant permission (including the project
 * ones), because a member can only grant permissions they hold (no escalation); with "read" only,
 * no one in a new organisation could give project permissions to others. Reported in STAGE-08.md.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'tenant_administrator', name: 'Tenant Administrator', permissions: TENANT_PERMISSIONS },
  {
    key: 'project_lead',
    name: 'Project Lead',
    permissions: [
      'tenant.members.read',
      'tenant.departments.read',
      'tenant.projects.read',
      'tenant.projects.create',
      'tenant.projects.manage',
      'tenant.scenarios.manage',
    ],
  },
  {
    key: 'scientist',
    name: 'Scientist',
    permissions: ['tenant.projects.read', 'tenant.scenarios.manage'],
  },
  { key: 'qa_qc_reviewer', name: 'QA/QC Reviewer', permissions: ['tenant.projects.read'] },
  {
    key: 'scientific_reviewer',
    name: 'Scientific Reviewer',
    permissions: ['tenant.projects.read'],
  },
  { key: 'viewer', name: 'Viewer', permissions: ['tenant.projects.read'] },
];

/** The templates as seeded in a database at migration `version`. */
export const roleTemplatesForSchema = (version: number): readonly RoleTemplate[] =>
  ROLE_TEMPLATES.map((t) => ({
    ...t,
    permissions: t.permissions.filter((p) => sinceOf(p) <= version),
  }));

/** Default departments created with a tenant: templates only, editable (SECURITY §4, F-4). */
export const DEFAULT_DEPARTMENTS: readonly string[] = [
  'Project management',
  'Quality assurance',
  'R&D / formulation',
  'Quality control',
  'Scientific review',
  'Directors',
  'Administration',
];

/**
 * Platform roles (ADR-029). Only platform_owner (Super Admin) exists in Stage 7. Documented future
 * boundaries: platform_scientific_reviewer (method/ruleset/model approval, no tenant data) and
 * platform_support (registry metadata, no tenant data); neither is created yet.
 */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  platform_owner: PERMISSIONS.filter((p) => p.scope === 'platform').map((p) => p.code),
};

export const permissionScope = (code: string): 'tenant' | 'platform' | null =>
  PERMISSIONS.find((p) => p.code === code)?.scope ?? null;
