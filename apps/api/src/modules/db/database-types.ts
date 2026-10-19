// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run db -- typegen
// Source: pbe_test with migrations 0001, 0002, 0003, 0004, 0005, 0006; schemas app, audit, pbe_meta, platform.
// Mapping: numeric and bigint → string (exact), timestamptz/timestamp/date → Date, jsonb → Json, bytea → Buffer.
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type { Generated, GeneratedAlways };

export interface AppDepartment {
  tenant_id: string;
  id: Generated<string>;
  name: string;
  description: Generated<string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AppMembership {
  tenant_id: string;
  id: Generated<string>;
  user_id: string;
  email: string;
  display_name: string;
  status: Generated<string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AppMembershipDepartment {
  tenant_id: string;
  membership_id: string;
  department_id: string;
}

export interface AppMembershipRole {
  tenant_id: string;
  membership_id: string;
  role_id: string;
}

export interface AppProject {
  tenant_id: string;
  id: Generated<string>;
  name: string;
  molecule: string;
  strength_value: string;
  strength_unit: string;
  dosage_form: string;
  route: string;
  release_type: string;
  product_flags: Generated<string[]>;
  scope_status: string;
  scope_reasons: Generated<string[]>;
  scope_vocabulary_version: string;
  status: Generated<string>;
  next_scenario_number: Generated<number>;
  created_by_membership: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AppProjectDepartment {
  tenant_id: string;
  project_id: string;
  department_id: string;
}

export interface AppRole {
  tenant_id: string;
  id: Generated<string>;
  name: string;
  description: Generated<string>;
  template_key: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AppRolePermission {
  tenant_id: string;
  role_id: string;
  permission: string;
}

export interface AppScenario {
  tenant_id: string;
  id: Generated<string>;
  project_id: string;
  code: string;
  description: Generated<string>;
  created_by_membership: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AppTenantSetting {
  tenant_id: string;
  id: Generated<string>;
  self_approval_allowed: Generated<boolean>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AuditAuditEvent {
  id: Generated<string>;
  occurred_at: ColumnType<Date, Date | string | undefined, Date | string>;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  target_type: string;
  target_id: string | null;
  before_digest: Buffer | null;
  after_digest: Buffer | null;
  request_id: string | null;
  detail: Generated<Json>;
}

export interface AuditSecurityEvent {
  id: Generated<string>;
  occurred_at: ColumnType<Date, Date | string | undefined, Date | string>;
  event_type: string;
  outcome: string;
  user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  actor: Generated<string>;
  client_address: string | null;
  detail: Generated<Json>;
}

export interface PbeMetaSchemaMigration {
  version: number;
  name: string;
  checksum_sha256: string;
  phase: string;
  transactional: boolean;
  applied_at: ColumnType<Date, Date | string | undefined, Date | string>;
  applied_by: Generated<string>;
  execution_ms: number;
  runner_version: string;
}

export interface PlatformAuthThrottle {
  throttle_key: Buffer;
  failures: Generated<number>;
  window_started_at: ColumnType<Date, Date | string | undefined, Date | string>;
  blocked_until: Timestamp | null;
}

export interface PlatformBreakGlassGrant {
  id: Generated<string>;
  tenant_id: string;
  requested_by: string;
  purpose: string;
  status: Generated<string>;
  requested_at: ColumnType<Date, Date | string | undefined, Date | string>;
  decided_by: string | null;
  decided_at: Timestamp | null;
  expires_at: Timestamp | null;
  ended_at: Timestamp | null;
}

export interface PlatformMfaRecoveryCode {
  user_id: string;
  code_hash: Buffer;
  used_at: Timestamp | null;
}

export interface PlatformMfaTotpFactor {
  user_id: string;
  secret_ciphertext: Buffer;
  key_id: string;
  confirmed_at: Timestamp | null;
  last_used_step: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PlatformPasswordCredential {
  user_id: string;
  password_hash: string;
  changed_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PlatformPermission {
  code: string;
  scope: string;
  read_only: boolean;
  description: string;
}

export interface PlatformPlatformRoleAssignment {
  user_id: string;
  role: string;
  granted_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PlatformRoleTemplate {
  key: string;
  name: string;
  description: string;
  position: number;
}

export interface PlatformRoleTemplatePermission {
  template_key: string;
  permission: string;
}

export interface PlatformTenant {
  id: Generated<string>;
  slug: string;
  display_name: string;
  status: Generated<string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PlatformUserAccount {
  id: Generated<string>;
  email: string;
  email_normalized: GeneratedAlways<string | null>;
  display_name: string;
  status: Generated<string>;
  mfa_required: Generated<boolean>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PlatformUserSession {
  id: Generated<string>;
  token_hash: Buffer;
  user_id: string;
  state: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  ended_at: Timestamp | null;
  end_reason: string | null;
  active_tenant_id: string | null;
  break_glass_grant_id: string | null;
}

export interface PlatformUserToken {
  id: Generated<string>;
  user_id: string;
  purpose: string;
  token_hash: Buffer;
  tenant_id: string | null;
  created_by: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

/** Migration versions these types were generated from. The API refuses to start if the ledger differs. */
export const SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6];

export interface DB {
  'app.department': AppDepartment;
  'app.membership': AppMembership;
  'app.membership_department': AppMembershipDepartment;
  'app.membership_role': AppMembershipRole;
  'app.project': AppProject;
  'app.project_department': AppProjectDepartment;
  'app.role': AppRole;
  'app.role_permission': AppRolePermission;
  'app.scenario': AppScenario;
  'app.tenant_setting': AppTenantSetting;
  'audit.audit_event': AuditAuditEvent;
  'audit.security_event': AuditSecurityEvent;
  'pbe_meta.schema_migration': PbeMetaSchemaMigration;
  'platform.auth_throttle': PlatformAuthThrottle;
  'platform.break_glass_grant': PlatformBreakGlassGrant;
  'platform.mfa_recovery_code': PlatformMfaRecoveryCode;
  'platform.mfa_totp_factor': PlatformMfaTotpFactor;
  'platform.password_credential': PlatformPasswordCredential;
  'platform.permission': PlatformPermission;
  'platform.platform_role_assignment': PlatformPlatformRoleAssignment;
  'platform.role_template': PlatformRoleTemplate;
  'platform.role_template_permission': PlatformRoleTemplatePermission;
  'platform.tenant': PlatformTenant;
  'platform.user_account': PlatformUserAccount;
  'platform.user_session': PlatformUserSession;
  'platform.user_token': PlatformUserToken;
}
