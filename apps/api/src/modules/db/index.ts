// Public interface of the data-access layer (ADR-021). Other modules import from here only.
export {
  createDatabase,
  runtimeConnectionFromEnv,
  type Database,
  type DatabaseConnection,
  type DatabaseOptions,
} from './database';
export type { DB } from './database-types';
export { assertSafeRuntimeRole, UnsafeRuntimeRoleError } from './runtime-role';
export {
  parseTenantContext,
  TenantContextError,
  withTenantTransaction,
  withUserTransaction,
  type TenantContext,
  type Tx,
} from './tenant-context';
export { createOperatorDatabase } from './database';
export * from './tenancy';
export { projects, type ProjectRow, type ProjectValues, type ScenarioRow } from './projects';
export { SCHEMA_VERSIONS } from './database-types';
export {
  assertSchemaVersions,
  BASE_SCHEMA_VERSIONS,
  checkDatabaseHealth,
  PROJECTS_SCHEMA_VERSION,
  PROJECTS_SCHEMA_VERSIONS,
  resolveSchemaProfile,
  SCHEMA_PROFILES,
  SchemaVersionMismatchError,
  type HealthResult,
} from './schema-version';
export {
  identity,
  type LoginRecord,
  type ResolvedSession,
  type SecurityEventInput,
  type SessionEndReason,
  type SessionState,
  type TotpRecord,
  type UserRecord,
} from './identity';
