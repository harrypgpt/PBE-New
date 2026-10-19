import type { SignInNext } from '@pbe/contracts';
import { ProblemException } from '../../common/problem';
import {
  identity,
  type Database,
  type ResolvedSession,
  type SecurityEventInput,
  type SessionEndReason,
  type SessionState,
} from '../db';
import { createDummyHash, hashPassword, verifyPassword } from './password-hash';
import { Blocklist, passwordProblem } from './password-policy';
import {
  newRecoveryCodes,
  newSessionToken,
  recoveryCodeHash,
  SecretBox,
  sessionTokenHash,
  throttleKey,
} from './secrets';
import { enrolmentQrSvg, newTotpSecret, verifiedTimeStep } from './totp';

/**
 * Sign-in, sessions and MFA (ADR-026). Public errors never reveal whether an email exists.
 * Nothing secret (passwords, tokens, codes, MFA secrets, hashes) is logged or put in events.
 */

export interface AuthSettings {
  idleSeconds: number;
  absoluteSeconds: number;
  mfaKey: string;
}

export interface RequestContext {
  requestId: string | undefined;
  address: string | null;
  /** Session token from the request cookie, if any. */
  token: string | null;
}

/** A newly issued session: the controller sets the cookie. */
export interface Issued {
  token: string;
  next: SignInNext;
}

/** Pending sign-in sessions are short-lived (minutes), whatever the configured lifetime. */
const PENDING = { idleSeconds: 600, absoluteSeconds: 900 };

const POLICY = {
  // ADR-026: gradual back-off from the fifth failure (1, 2, 4 … up to 15 minutes).
  account: {
    mode: 'backoff',
    threshold: 5,
    windowSeconds: 86_400,
    baseSeconds: 60,
    maxSeconds: 900,
  },
  // Distributed guessing from one address: at most 20 failures per 10 minutes.
  address: { mode: 'window', threshold: 20, windowSeconds: 600, baseSeconds: 0, maxSeconds: 0 },
  // Second factor and password change: same back-off per user.
  user: { mode: 'backoff', threshold: 5, windowSeconds: 86_400, baseSeconds: 60, maxSeconds: 900 },
} as const;

const failed = () =>
  new ProblemException(401, 'AUTHENTICATION_FAILED', 'Sign-in failed', {
    detail: 'The email address or password is not correct.',
  });
const tooMany = () =>
  new ProblemException(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts', {
    detail: 'Please wait a few minutes and try again.',
  });
const signInRequired = () =>
  new ProblemException(401, 'AUTHENTICATION_REQUIRED', 'Sign-in required', {
    detail: 'Please sign in.',
  });

export class AuthService {
  private readonly box: SecretBox;

  private constructor(
    private readonly db: Database,
    private readonly settings: AuthSettings,
    private readonly blocklist: Blocklist,
    private readonly dummyHash: string,
  ) {
    this.box = new SecretBox(settings.mfaKey);
  }

  static async create(db: Database, settings: AuthSettings, blocklist = Blocklist.load()) {
    return new AuthService(db, settings, blocklist, await createDummyHash());
  }

  private event(ctx: RequestContext, e: SecurityEventInput): Promise<void> {
    return identity.recordSecurityEvent(this.db, {
      requestId: ctx.requestId ?? null,
      clientAddress: ctx.address,
      ...e,
    });
  }

  private async issue(userId: string, state: SessionState): Promise<string> {
    const token = newSessionToken();
    const lifetime =
      state === 'active'
        ? { idleSeconds: this.settings.idleSeconds, absoluteSeconds: this.settings.absoluteSeconds }
        : PENDING;
    await identity.sessionCreate(this.db, {
      userId,
      tokenHash: sessionTokenHash(token),
      state,
      ...lifetime,
    });
    return token;
  }

  /** Ends the presented session (if any) and issues a new one: no session fixation. */
  private async rotate(ctx: RequestContext, userId: string, state: SessionState): Promise<string> {
    if (ctx.token) await identity.sessionEnd(this.db, sessionTokenHash(ctx.token), 'rotated');
    return this.issue(userId, state);
  }

  private async guardThrottle(ctx: RequestContext, keys: Buffer[]): Promise<void> {
    const until = await identity.throttleBlockedUntil(this.db, keys);
    if (until) {
      await this.event(ctx, { eventType: 'sign_in_throttled', outcome: 'failure' });
      throw tooMany();
    }
  }

  /** The presented session, checked. Ended sessions (expired, deactivated) are logged once. */
  async resolve(ctx: RequestContext): Promise<ResolvedSession | null> {
    if (!ctx.token) return null;
    const idle = this.settings.idleSeconds;
    const s = await identity.sessionResolve(this.db, sessionTokenHash(ctx.token), idle);
    if (!s) return null;
    if (s.endedBecause) {
      await this.event(ctx, {
        eventType: 'session_ended',
        outcome: 'info',
        userId: s.userId,
        sessionId: s.sessionId,
        detail: { reason: s.endedBecause },
      });
      return null;
    }
    return s;
  }

  async login(ctx: RequestContext, email: string, password: string): Promise<Issued> {
    const normalised = email.normalize('NFKC').trim().toLowerCase();
    const accountKey = throttleKey('account', normalised);
    const addressKey = throttleKey('address', ctx.address ?? 'unknown');
    await this.guardThrottle(ctx, [accountKey, addressKey]);

    const record = await identity.loginLookup(this.db, normalised);
    // Unknown emails still pay for one hash, so timing does not reveal which emails exist.
    const passwordOk = await verifyPassword(record?.passwordHash ?? this.dummyHash, password);
    if (!record || !passwordOk || record.status !== 'active') {
      await identity.throttleFail(this.db, accountKey, POLICY.account);
      await identity.throttleFail(this.db, addressKey, POLICY.address);
      await this.event(ctx, {
        eventType: 'login_failed',
        outcome: 'failure',
        userId: record?.userId ?? null,
        detail: {
          reason: !record ? 'unknown_account' : !passwordOk ? 'wrong_password' : 'inactive',
        },
      });
      throw failed();
    }
    await identity.throttleClear(this.db, accountKey);
    const state: SessionState = record.mfaEnrolled
      ? 'pending_mfa'
      : record.mfaRequired
        ? 'pending_enrolment'
        : 'active';
    const token = await this.rotate(ctx, record.userId, state);
    await this.event(ctx, {
      eventType: state === 'active' ? 'login_succeeded' : 'login_password_accepted',
      outcome: 'success',
      userId: record.userId,
      detail: { next: state },
    });
    return { token, next: state === 'active' ? 'done' : state === 'pending_mfa' ? 'mfa' : 'enrol' };
  }

  async verifyMfa(
    ctx: RequestContext,
    input: { code: string } | { recoveryCode: string },
  ): Promise<Issued> {
    const session = await this.resolve(ctx);
    if (!session || session.state !== 'pending_mfa') throw signInRequired();
    const key = throttleKey('user', session.userId);
    await this.guardThrottle(ctx, [key]);

    let ok = false;
    let method: 'totp' | 'recovery_code';
    if ('code' in input) {
      method = 'totp';
      const factor = await identity.totpGet(this.db, session.userId);
      if (factor?.confirmed) {
        const secret = this.box.open(session.userId, factor.secretCiphertext, factor.keyId);
        const step = verifiedTimeStep(secret, input.code);
        // A valid code is accepted once per time step (replay refused in the database).
        ok = step !== null && (await identity.totpUseStep(this.db, session.userId, step));
      }
    } else {
      method = 'recovery_code';
      ok = await identity.recoveryCodeUse(
        this.db,
        session.userId,
        recoveryCodeHash(input.recoveryCode),
      );
    }
    if (!ok) {
      await identity.throttleFail(this.db, key, POLICY.user);
      await this.event(ctx, {
        eventType: 'mfa_verification_failed',
        outcome: 'failure',
        userId: session.userId,
        sessionId: session.sessionId,
        detail: { method },
      });
      throw new ProblemException(401, 'AUTHENTICATION_FAILED', 'Code not accepted', {
        detail: 'The code is not correct or has already been used.',
      });
    }
    await identity.throttleClear(this.db, key);
    const token = await this.rotate(ctx, session.userId, 'active');
    await this.event(ctx, {
      eventType: method === 'totp' ? 'login_succeeded' : 'login_succeeded_recovery_code',
      outcome: 'success',
      userId: session.userId,
      detail: { method },
    });
    return { token, next: 'done' };
  }

  async logout(ctx: RequestContext): Promise<void> {
    if (!ctx.token) return;
    const ended = await identity.sessionEnd(this.db, sessionTokenHash(ctx.token), 'logout');
    if (ended) {
      await this.event(ctx, {
        eventType: 'logout',
        outcome: 'success',
        userId: ended.userId,
        sessionId: ended.sessionId,
      });
    }
  }

  async changePassword(
    ctx: RequestContext,
    session: ResolvedSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<string> {
    const key = throttleKey('user', session.userId);
    await this.guardThrottle(ctx, [key]);
    const [hash, user] = await Promise.all([
      identity.credentialGet(this.db, session.userId),
      identity.getUser(this.db, session.userId),
    ]);
    if (!hash || !user || !(await verifyPassword(hash, currentPassword))) {
      await identity.throttleFail(this.db, key, POLICY.user);
      await this.event(ctx, {
        eventType: 'password_change_failed',
        outcome: 'failure',
        userId: session.userId,
        sessionId: session.sessionId,
        detail: { reason: 'wrong_current_password' },
      });
      throw new ProblemException(401, 'AUTHENTICATION_FAILED', 'Current password not correct', {
        detail: 'The current password is not correct.',
      });
    }
    const problem =
      passwordProblem(newPassword, { email: user.email }, this.blocklist) ??
      ((await verifyPassword(hash, newPassword))
        ? 'Choose a password you have not used here before.'
        : null);
    if (problem) {
      throw new ProblemException(400, 'VALIDATION_FAILED', 'Password not accepted', {
        detail: problem,
        errors: [{ path: 'body.newPassword', message: problem }],
      });
    }
    await identity.credentialSet(this.db, session.userId, await hashPassword(newPassword));
    await identity.throttleClear(this.db, key);
    // Every session of this user ends, including this one; the caller gets a fresh session.
    const ended = await identity.sessionEndAll(this.db, session.userId, 'password_changed', null);
    const token = await this.issue(session.userId, 'active');
    await this.event(ctx, {
      eventType: 'password_changed',
      outcome: 'success',
      userId: session.userId,
      detail: { sessionsEnded: ended },
    });
    return token;
  }

  /** A complete session, or a pending one that must enrol. */
  private async enrolmentSession(ctx: RequestContext): Promise<ResolvedSession> {
    const session = await this.resolve(ctx);
    if (!session || (session.state !== 'active' && session.state !== 'pending_enrolment')) {
      throw signInRequired();
    }
    return session;
  }

  async startEnrolment(ctx: RequestContext): Promise<{ manualKey: string; qrSvg: string }> {
    const session = await this.enrolmentSession(ctx);
    const user = await identity.getUser(this.db, session.userId);
    if (!user) throw signInRequired();
    const secret = newTotpSecret();
    const sealed = this.box.seal(session.userId, secret);
    if (
      user.mfaEnrolled ||
      !(await identity.totpBegin(this.db, session.userId, sealed, this.box.keyId))
    ) {
      throw new ProblemException(409, 'CONFLICT', 'Already enrolled', {
        detail: 'An authenticator app is already set up. Ask an administrator to reset it.',
      });
    }
    await this.event(ctx, {
      eventType: 'mfa_enrolment_started',
      outcome: 'info',
      userId: session.userId,
      sessionId: session.sessionId,
    });
    return { manualKey: secret, qrSvg: await enrolmentQrSvg(secret, user.email) };
  }

  async confirmEnrolment(
    ctx: RequestContext,
    code: string,
  ): Promise<{ token: string; recoveryCodes: string[] }> {
    const session = await this.enrolmentSession(ctx);
    const key = throttleKey('user', session.userId);
    await this.guardThrottle(ctx, [key]);
    const factor = await identity.totpGet(this.db, session.userId);
    if (!factor || factor.confirmed) {
      throw new ProblemException(409, 'CONFLICT', 'No enrolment in progress', {
        detail: 'Start the authenticator set-up first.',
      });
    }
    const secret = this.box.open(session.userId, factor.secretCiphertext, factor.keyId);
    const step = verifiedTimeStep(secret, code);
    // Enrolment is confirmed ONLY after a valid authenticator code (ADR-026).
    if (step === null || !(await identity.totpConfirm(this.db, session.userId, step))) {
      await identity.throttleFail(this.db, key, POLICY.user);
      await this.event(ctx, {
        eventType: 'mfa_enrolment_failed',
        outcome: 'failure',
        userId: session.userId,
        sessionId: session.sessionId,
      });
      throw new ProblemException(401, 'AUTHENTICATION_FAILED', 'Code not accepted', {
        detail: 'The code is not correct. Check the time on your phone and try again.',
      });
    }
    const recoveryCodes = newRecoveryCodes();
    await identity.recoveryCodesReplace(
      this.db,
      session.userId,
      recoveryCodes.map(recoveryCodeHash),
    );
    await identity.throttleClear(this.db, key);
    // Enrolling raises the account's assurance: rotate the session.
    const token = await this.rotate(ctx, session.userId, 'active');
    await this.event(ctx, {
      eventType: 'mfa_enrolled',
      outcome: 'success',
      userId: session.userId,
    });
    return { token, recoveryCodes };
  }

  /** Used by operator commands (no HTTP context). */
  static endReasonFor(command: 'reset-password' | 'reset-mfa' | 'require-mfa'): SessionEndReason {
    return command === 'reset-password'
      ? 'password_reset'
      : command === 'reset-mfa'
        ? 'mfa_reset'
        : 'policy_changed';
  }
}
