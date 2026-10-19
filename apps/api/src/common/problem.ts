import { problemType, type ErrorCode, type ProblemDetails } from '@pbe/contracts';

/** An error that becomes an RFC 9457 Problem Details response. `internal` is logged, never sent. */
export class ProblemException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly options: {
      detail?: string;
      errors?: Array<{ path: string; message: string }>;
      internal?: string;
    } = {},
  ) {
    super(title);
    this.name = 'ProblemException';
  }
}

/** Raised when a handler's result does not match its contract. Callers only see a generic 500. */
export class ResponseContractViolation extends Error {
  constructor(readonly issues: readonly string[]) {
    super('Response did not match its contract');
    this.name = 'ResponseContractViolation';
  }
}

export function problemBody(
  status: number,
  code: ErrorCode,
  title: string,
  requestId: string,
  extra: { detail?: string; errors?: Array<{ path: string; message: string }> } = {},
): ProblemDetails {
  return {
    type: problemType(code),
    title,
    status,
    code,
    requestId,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.errors && extra.errors.length > 0 ? { errors: extra.errors } : {}),
  };
}
