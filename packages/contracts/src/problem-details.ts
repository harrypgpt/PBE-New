import { z } from 'zod';

/**
 * RFC 9457 "Problem Details" — the ONE error shape of the PBE API (API_CONTRACT_STANDARDS.md §3).
 * Error bodies never contain stack traces, SQL, driver messages or other tenants' identifiers.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_FAILED',
  'TOO_MANY_ATTEMPTS',
  'CONFLICT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ProblemFieldErrorSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});

export const ProblemDetailsSchema = z.strictObject({
  type: z.string().regex(/^https:\/\/pbe\.local\/problems\/[a-z-]+$/),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.enum(ERROR_CODES),
  detail: z.string().optional(),
  requestId: z.uuid(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Stable problem type URI for a code, e.g. VALIDATION_FAILED → https://pbe.local/problems/validation-failed */
export function problemType(code: ErrorCode): string {
  return `https://pbe.local/problems/${code.toLowerCase().replace(/_/g, '-')}`;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
