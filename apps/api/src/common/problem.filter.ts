import { randomUUID } from 'node:crypto';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { PROBLEM_CONTENT_TYPE, ProblemDetailsSchema, type ErrorCode } from '@pbe/contracts';
import type { PbeRequest, PbeResponse } from './http';
import type { JsonLogger } from './logger';
import { problemBody, ProblemException, ResponseContractViolation } from './problem';

/**
 * The ONE place errors become HTTP responses (API_CONTRACT_STANDARDS.md §3). Callers get Problem
 * Details only; stack traces, SQL, driver messages and internal reasons go to the (redacted) log.
 */
const BODY_PARSER_TYPES = new Set([
  'entity.too.large',
  'entity.parse.failed',
  'entity.verify.failed',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'parameters.too.many',
]);

function isBodyParserError(e: unknown): e is { type: string; status: number } {
  if (typeof e !== 'object' || e === null) return false;
  const { type, status } = e as { type?: unknown; status?: unknown };
  return (
    typeof type === 'string' &&
    BODY_PARSER_TYPES.has(type) &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<PbeRequest>();
    const res = http.getResponse<PbeResponse>();
    const requestId = req.requestId ?? randomUUID();

    let status = 500;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let title = 'Internal server error';
    let extra: { detail?: string; errors?: Array<{ path: string; message: string }> } = {};

    if (exception instanceof ProblemException) {
      ({ status, code, title } = exception);
      extra = {
        ...(exception.options.detail ? { detail: exception.options.detail } : {}),
        ...(exception.options.errors ? { errors: exception.options.errors } : {}),
      };
      if (exception.options.internal) {
        this.logger.event(status >= 500 ? 'error' : 'warn', 'problem', {
          requestId,
          code,
          reason: exception.options.internal,
        });
      }
    } else if (exception instanceof ResponseContractViolation) {
      this.logger.event('error', 'response_contract_violation', {
        requestId,
        issues: exception.issues,
      });
    } else if (isBodyParserError(exception)) {
      // Express body-parser errors (documented "type" values) are client errors, not crashes.
      if (exception.type === 'entity.too.large') {
        status = 413;
        code = 'PAYLOAD_TOO_LARGE';
        title = 'Request body too large';
      } else {
        status = 400;
        code = 'MALFORMED_REQUEST';
        title = 'Malformed request';
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      if (status === 404) {
        code = 'NOT_FOUND';
        title = 'Not found';
      } else if (status === 413) {
        code = 'PAYLOAD_TOO_LARGE';
        title = 'Request body too large';
      } else if (status === 403) {
        code = 'ACCESS_DENIED';
        title = 'Access denied';
      } else if (status >= 400 && status < 500) {
        status = 400;
        code = 'MALFORMED_REQUEST';
        title = 'Malformed request';
      } else {
        status = 500;
        this.logger.event('error', 'unhandled_http_exception', { requestId, error: exception });
      }
    } else {
      this.logger.event('error', 'unhandled_exception', {
        requestId,
        error:
          exception instanceof Error
            ? { name: exception.name, message: exception.message }
            : String(exception),
      });
    }

    const body = ProblemDetailsSchema.parse(problemBody(status, code, title, requestId, extra));
    if (res.headersSent) return;
    res.status(status).setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    res.send(JSON.stringify(body));
  }
}
