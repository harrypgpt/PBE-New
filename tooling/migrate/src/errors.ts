export type MigrationErrorCode =
  | 'CONFIG'
  | 'INVALID_FILES'
  | 'CHECKSUM_MISMATCH'
  | 'MISSING_FILE'
  | 'NAME_MISMATCH'
  | 'LEDGER_INCONSISTENT'
  | 'LOCK_TIMEOUT'
  | 'CONTRACT_NOT_ALLOWED'
  | 'MIGRATION_FAILED'
  | 'UNSAFE_SESSION'
  | 'UNSUPPORTED_SERVER'
  | 'UNSAFE_TARGET'
  | 'TOOL_FAILED'
  | 'TYPEGEN_UNSUPPORTED'
  | 'TYPEGEN_STALE';

/** Every refusal or failure of the migration tooling carries a stable code and readable details. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly details: readonly string[];

  constructor(code: MigrationErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.details = details;
  }
}
