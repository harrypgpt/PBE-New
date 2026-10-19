import { z } from 'zod';
import { ProblemDetailsSchema } from './problem-details';
import { defineRoute } from './route';

/**
 * Sign-in, session and account contracts (Stage 6; ADR-026). Public errors never say whether an
 * email exists. MFA secrets appear only in the one enrolment response (never in URLs or errors),
 * and recovery codes only in the one confirmation response.
 */

/** Owner-approved password length (ADR-026), counted in Unicode code points after NFKC. */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const RECOVERY_CODE_COUNT = 10;

export const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+$/, 'Enter an email address');

/** Sign-in input is only bounded (to cap hashing cost); the policy applies when a password is set. */
const SuppliedPasswordSchema = z.string().min(1).max(1024);
/** A new password: the server checks the exact policy (length in code points, blocklist). */
export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(4 * PASSWORD_MAX_LENGTH);
export const TotpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const RecoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, 'Enter a recovery code');

/** What the sign-in flow needs next: finished, a TOTP code, or MFA enrolment. */
export const SignInNextSchema = z.enum(['done', 'mfa', 'enrol']);
export type SignInNext = z.infer<typeof SignInNextSchema>;

const problem = (description: string) => ({ description, schema: ProblemDetailsSchema });
const SIGN_IN_STEP_REASON =
  'Part of signing in: the handler requires the caller’s own pending sign-in session.';

export const LoginRequestSchema = z.strictObject({
  email: EmailSchema,
  password: SuppliedPasswordSchema,
});
export const SignInStepResponseSchema = z.strictObject({ next: SignInNextSchema });

export const loginRoute = defineRoute({
  operationId: 'postAuthLogin',
  method: 'POST',
  path: '/auth/login',
  summary: 'Sign in with email and password',
  access: { kind: 'public', reason: 'Sign-in entry point: there is no session yet by definition.' },
  request: { body: LoginRequestSchema },
  responses: {
    200: { description: 'Password accepted; see "next".', schema: SignInStepResponseSchema },
    400: problem('Malformed request.'),
    401: problem('Sign-in failed (the same answer for any wrong email or password).'),
    403: problem('Request not from the PBE web origin.'),
    429: problem('Too many attempts; try again later.'),
  },
});

export const MfaVerifyRequestSchema = z.union([
  z.strictObject({ code: TotpCodeSchema }),
  z.strictObject({ recoveryCode: RecoveryCodeSchema }),
]);

export const mfaVerifyRoute = defineRoute({
  operationId: 'postAuthMfaVerify',
  method: 'POST',
  path: '/auth/mfa/verify',
  summary: 'Second sign-in step: authenticator code or recovery code',
  access: { kind: 'public', reason: SIGN_IN_STEP_REASON },
  request: { body: MfaVerifyRequestSchema },
  responses: {
    200: { description: 'Signed in.', schema: SignInStepResponseSchema },
    400: problem('Malformed request.'),
    401: problem('Code not accepted, or no pending sign-in.'),
    403: problem('Request not from the PBE web origin.'),
    429: problem('Too many attempts; try again later.'),
  },
});

export const LogoutResponseSchema = z.strictObject({ status: z.literal('signed-out') });

export const logoutRoute = defineRoute({
  operationId: 'postAuthLogout',
  method: 'POST',
  path: '/auth/logout',
  summary: 'Sign out: ends the caller’s own session, if any',
  access: {
    kind: 'public',
    reason: 'Ends only the caller’s own session (pending or complete); harmless without one.',
  },
  request: {},
  responses: {
    200: { description: 'Signed out.', schema: LogoutResponseSchema },
    403: problem('Request not from the PBE web origin.'),
  },
});

export const SessionResponseSchema = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  mfa: z.strictObject({ enrolled: z.boolean(), required: z.boolean() }),
  /** The organisation the session works in (Stage 7), or null. */
  activeTenant: z.strictObject({ id: z.uuid(), name: z.string(), slug: z.string() }).nullable(),
  /** Read-only Super Admin access in progress (ADR-028), or null. */
  breakGlass: z.strictObject({ grantId: z.uuid(), expiresAt: z.iso.datetime() }).nullable(),
  platformRoles: z.array(z.string()),
  /** Effective permissions (active organisation and platform roles); presentation only (F-6). */
  permissions: z.array(z.string()),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const sessionRoute = defineRoute({
  operationId: 'getSession',
  method: 'GET',
  path: '/session',
  summary: 'The signed-in user (no tenant data)',
  access: { kind: 'authenticated' },
  request: {},
  responses: {
    200: { description: 'Current user.', schema: SessionResponseSchema },
    401: problem('Not signed in.'),
  },
});

export const PasswordChangeRequestSchema = z.strictObject({
  currentPassword: SuppliedPasswordSchema,
  newPassword: NewPasswordSchema,
});
export const PasswordChangeResponseSchema = z.strictObject({ status: z.literal('changed') });

export const accountPasswordRoute = defineRoute({
  operationId: 'postAccountPassword',
  method: 'POST',
  path: '/account/password',
  summary: 'Change your own password (ends your other sessions)',
  access: { kind: 'authenticated' },
  request: { body: PasswordChangeRequestSchema },
  responses: {
    200: { description: 'Password changed.', schema: PasswordChangeResponseSchema },
    400: problem('New password not accepted (policy), or malformed request.'),
    401: problem('Not signed in, or current password wrong.'),
    403: problem('Request not from the PBE web origin.'),
    429: problem('Too many attempts; try again later.'),
  },
});

export const MfaEnrolmentResponseSchema = z.strictObject({
  /** Base32 secret for manual entry. Shown once; never logged. */
  manualKey: z.string().regex(/^[A-Z2-7]{32}$/),
  /** SVG image of the otpauth:// QR code (no scripts). */
  qrSvg: z.string().startsWith('<svg'),
});

export const accountMfaEnrolRoute = defineRoute({
  operationId: 'postAccountMfaEnrolment',
  method: 'POST',
  path: '/account/mfa/enrolment',
  summary: 'Start authenticator-app enrolment (signed in, or required at sign-in)',
  access: { kind: 'public', reason: SIGN_IN_STEP_REASON + ' Or a complete session.' },
  request: {},
  responses: {
    200: {
      description: 'Scan or type the key, then confirm with a code.',
      schema: MfaEnrolmentResponseSchema,
    },
    401: problem('No suitable session.'),
    403: problem('Request not from the PBE web origin.'),
    409: problem('An authenticator app is already enrolled.'),
  },
});

export const MfaConfirmRequestSchema = z.strictObject({ code: TotpCodeSchema });
export const MfaConfirmResponseSchema = z.strictObject({
  /** Shown once. Each works once. Stored only as hashes. */
  recoveryCodes: z.array(RecoveryCodeSchema).length(RECOVERY_CODE_COUNT),
  next: SignInNextSchema,
});

export const accountMfaConfirmRoute = defineRoute({
  operationId: 'postAccountMfaConfirmation',
  method: 'POST',
  path: '/account/mfa/confirmation',
  summary: 'Confirm authenticator-app enrolment with a valid code',
  access: { kind: 'public', reason: SIGN_IN_STEP_REASON + ' Or a complete session.' },
  request: { body: MfaConfirmRequestSchema },
  responses: {
    200: { description: 'Enrolled; recovery codes shown once.', schema: MfaConfirmResponseSchema },
    400: problem('Malformed request.'),
    401: problem('Code not accepted, or no suitable session.'),
    403: problem('Request not from the PBE web origin.'),
    409: problem('No enrolment in progress, or already enrolled.'),
    429: problem('Too many attempts; try again later.'),
  },
});
