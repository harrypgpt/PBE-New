import { z } from 'zod';
import { contractSchemas } from './registry';

/** Media type for error responses (RFC 9457; API_CONTRACT_STANDARDS §5). */
export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** Error codes are UPPER_SNAKE_CASE (API_CONTRACT_STANDARDS §3). */
export const ErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, 'Error codes must be UPPER_SNAKE_CASE.');

export const FieldErrorSchema = z.object({
  path: z.string().min(1),
  code: ErrorCodeSchema,
  message: z.string().min(1),
});

/** Standard error body for every non-2xx response. */
export const ProblemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string().min(1),
    status: z.int().min(400).max(599),
    code: ErrorCodeSchema,
    detail: z.string().optional(),
    requestId: z.string().min(1),
    errors: z.array(FieldErrorSchema).optional(),
  })
  .meta({
    description:
      'RFC 9457 problem details. Never contains scientific values, file contents or secrets.',
  })
  .register(contractSchemas, { id: 'ProblemDetails' });

export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
