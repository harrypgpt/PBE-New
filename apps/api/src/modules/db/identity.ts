import { sql } from 'kysely';
import type { Database } from './database';

/**
 * Identity data access (ADR-027). pbe_app has no table privileges on identity tables: every call
 * here goes through one reviewed SECURITY DEFINER function from migration 0003, and every call
 * acts on ONE key (an email, a session-token hash or a user id). There is deliberately no function
 * that lists users or returns more than one credential.
 */

export type SessionState = 'pending_mfa' | 'pending_enrolment' | 'active';
export type SessionEndReason =
  | 'logout'
  | 'expired_idle'
  | 'expired_absolute'
  | 'rotated'
  | 'password_changed'
  | 'password_reset'
  | 'user_deactivated'
  | 'mfa_reset'
  | 'policy_changed';

export interface LoginRecord {
  userId: string;
  status: 'active' | 'deactivated';
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  passwordHash: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'deactivated';
  mfaRequired: boolean;
  mfaEnrolled: boolean;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  state: SessionState;
  userStatus: 'active' | 'deactivated';
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  /** Set when the session was found but has just been ended (expired, user deactivated). */
  endedBecause: SessionEndReason | null;
}

export interface TotpRecord {
  secretCiphertext: Buffer;
  keyId: string;
  confirmed: boolean;
  lastUsedStep: string | null;
}

export interface SecurityEventInput {
  eventType: string;
  outcome: 'success' | 'failure' | 'info';
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  actor?: 'user' | 'operator' | 'system';
  clientAddress?: string | null;
  /** Small, non-secret facts only (e.g. { reason: 'expired_idle' }). */
  detail?: Record<string, string | number | boolean>;
}

const first = <T>(rows: T[]): T | undefined => rows[0];

export const identity = {
  async createUser(db: Database, email: string, displayName: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      SELECT platform.auth_user_create(${email}, ${displayName}) AS id`.execute(db);
    return rows[0]!.id;
  },

  async userIdByEmail(db: Database, email: string): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      SELECT platform.auth_user_id_by_email(${email}) AS id`.execute(db);
    return rows[0]?.id ?? null;
  },

  async setMfaRequired(db: Database, userId: string, required: boolean): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean | null }>`
      SELECT platform.auth_user_set_mfa_required(${userId}::uuid, ${required}) AS ok`.execute(db);
    return rows[0]?.ok === true;
  },

  async getUser(db: Database, userId: string): Promise<UserRecord | null> {
    const { rows } = await sql<{
      id: string;
      email: string;
      display_name: string;
      status: UserRecord['status'];
      mfa_required: boolean;
      mfa_enrolled: boolean;
    }>`SELECT * FROM platform.auth_user_get(${userId}::uuid)`.execute(db);
    const r = first(rows);
    return r
      ? {
          id: r.id,
          email: r.email,
          displayName: r.display_name,
          status: r.status,
          mfaRequired: r.mfa_required,
          mfaEnrolled: r.mfa_enrolled,
        }
      : null;
  },

  async loginLookup(db: Database, email: string): Promise<LoginRecord | null> {
    const { rows } = await sql<{
      user_id: string;
      status: LoginRecord['status'];
      mfa_required: boolean;
      mfa_enrolled: boolean;
      password_hash: string;
    }>`SELECT * FROM platform.auth_login_lookup(${email})`.execute(db);
    const r = first(rows);
    return r
      ? {
          userId: r.user_id,
          status: r.status,
          mfaRequired: r.mfa_required,
          mfaEnrolled: r.mfa_enrolled,
          passwordHash: r.password_hash,
        }
      : null;
  },

  async credentialGet(db: Database, userId: string): Promise<string | null> {
    const { rows } = await sql<{ hash: string | null }>`
      SELECT platform.auth_credential_get(${userId}::uuid) AS hash`.execute(db);
    return rows[0]?.hash ?? null;
  },

  async credentialSet(db: Database, userId: string, hash: string): Promise<void> {
    await sql`SELECT platform.auth_credential_set(${userId}::uuid, ${hash})`.execute(db);
  },

  async sessionCreate(
    db: Database,
    input: {
      userId: string;
      tokenHash: Buffer;
      state: SessionState;
      idleSeconds: number;
      absoluteSeconds: number;
    },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      SELECT platform.auth_session_create(${input.userId}::uuid, ${input.tokenHash}, ${input.state},
        ${input.idleSeconds}::integer, ${input.absoluteSeconds}::integer) AS id`.execute(db);
    return rows[0]!.id;
  },

  async sessionResolve(
    db: Database,
    tokenHash: Buffer,
    idleSeconds: number,
  ): Promise<ResolvedSession | null> {
    const { rows } = await sql<{
      session_id: string;
      user_id: string;
      state: SessionState;
      user_status: ResolvedSession['userStatus'];
      mfa_required: boolean;
      mfa_enrolled: boolean;
      end_reason: SessionEndReason | null;
    }>`SELECT * FROM platform.auth_session_resolve(${tokenHash}, ${idleSeconds}::integer)`.execute(
      db,
    );
    const r = first(rows);
    return r
      ? {
          sessionId: r.session_id,
          userId: r.user_id,
          state: r.state,
          userStatus: r.user_status,
          mfaRequired: r.mfa_required,
          mfaEnrolled: r.mfa_enrolled,
          endedBecause: r.end_reason,
        }
      : null;
  },

  async sessionEnd(
    db: Database,
    tokenHash: Buffer,
    reason: SessionEndReason,
  ): Promise<{ sessionId: string; userId: string } | null> {
    const { rows } = await sql<{ session_id: string; user_id: string }>`
      SELECT * FROM platform.auth_session_end(${tokenHash}, ${reason})`.execute(db);
    const r = first(rows);
    return r ? { sessionId: r.session_id, userId: r.user_id } : null;
  },

  async sessionEndAll(
    db: Database,
    userId: string,
    reason: SessionEndReason,
    exceptSessionId: string | null,
  ): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT platform.auth_session_end_all(${userId}::uuid, ${reason}, ${exceptSessionId}::uuid) AS n`.execute(
      db,
    );
    return rows[0]?.n ?? 0;
  },

  async totpGet(db: Database, userId: string): Promise<TotpRecord | null> {
    const { rows } = await sql<{
      secret_ciphertext: Buffer;
      key_id: string;
      confirmed: boolean;
      last_used_step: string | null;
    }>`SELECT * FROM platform.auth_totp_get(${userId}::uuid)`.execute(db);
    const r = first(rows);
    return r
      ? {
          secretCiphertext: r.secret_ciphertext,
          keyId: r.key_id,
          confirmed: r.confirmed,
          lastUsedStep: r.last_used_step,
        }
      : null;
  },

  async totpBegin(
    db: Database,
    userId: string,
    ciphertext: Buffer,
    keyId: string,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT platform.auth_totp_begin(${userId}::uuid, ${ciphertext}, ${keyId}) AS ok`.execute(db);
    return rows[0]?.ok === true;
  },

  async totpConfirm(db: Database, userId: string, step: number): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean | null }>`
      SELECT platform.auth_totp_confirm(${userId}::uuid, ${step}::bigint) AS ok`.execute(db);
    return rows[0]?.ok === true;
  },

  /** True only if this time step is newer than any used before (replay protection). */
  async totpUseStep(db: Database, userId: string, step: number): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean | null }>`
      SELECT platform.auth_totp_use_step(${userId}::uuid, ${step}::bigint) AS ok`.execute(db);
    return rows[0]?.ok === true;
  },

  async recoveryCodesReplace(db: Database, userId: string, hashes: Buffer[]): Promise<void> {
    await sql`SELECT platform.auth_recovery_codes_replace(${userId}::uuid, ${hashes}::bytea[])`.execute(
      db,
    );
  },

  /** True only the first time an unused code is presented. */
  async recoveryCodeUse(db: Database, userId: string, hash: Buffer): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean | null }>`
      SELECT platform.auth_recovery_code_use(${userId}::uuid, ${hash}) AS ok`.execute(db);
    return rows[0]?.ok === true;
  },

  async mfaReset(db: Database, userId: string): Promise<void> {
    await sql`SELECT platform.auth_mfa_reset(${userId}::uuid)`.execute(db);
  },

  async throttleBlockedUntil(db: Database, keys: Buffer[]): Promise<Date | null> {
    const { rows } = await sql<{ until: Date | null }>`
      SELECT platform.auth_throttle_blocked_until(${keys}::bytea[]) AS until`.execute(db);
    return rows[0]?.until ?? null;
  },

  async throttleFail(
    db: Database,
    key: Buffer,
    policy: {
      mode: 'backoff' | 'window';
      threshold: number;
      windowSeconds: number;
      baseSeconds: number;
      maxSeconds: number;
    },
  ): Promise<Date | null> {
    const { rows } = await sql<{ until: Date | null }>`
      SELECT platform.auth_throttle_fail(${key}, ${policy.mode}, ${policy.threshold}::integer,
        ${policy.windowSeconds}::integer, ${policy.baseSeconds}::integer, ${policy.maxSeconds}::integer) AS until`.execute(
      db,
    );
    return rows[0]?.until ?? null;
  },

  async throttleClear(db: Database, key: Buffer): Promise<void> {
    await sql`SELECT platform.auth_throttle_clear(${key})`.execute(db);
  },

  /** Appends to the protected security-event log (INSERT-only for pbe_app). */
  async recordSecurityEvent(db: Database, e: SecurityEventInput): Promise<void> {
    await db
      .insertInto('audit.security_event')
      .values({
        event_type: e.eventType,
        outcome: e.outcome,
        user_id: e.userId ?? null,
        session_id: e.sessionId ?? null,
        request_id: e.requestId ?? null,
        actor: e.actor ?? 'user',
        client_address: e.clientAddress ?? null,
        detail: JSON.stringify(e.detail ?? {}),
      })
      .execute();
  },
};
