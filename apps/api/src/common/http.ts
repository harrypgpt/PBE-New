import { randomUUID } from 'node:crypto';
import { isRequestId, REQUEST_ID_HEADER } from '@pbe/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonLogger } from './logger';
import type { ResolvedSession } from '../modules/db';
import type { AccessContext } from '../modules/tenancy/access';

/**
 * The parts of Express's request/response that PBE uses, declared on Node's own HTTP types
 * (no extra type package; ADR-022 keeps dependencies minimal).
 */
export interface PbeRequest extends IncomingMessage {
  path: string;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  requestId?: string;
  pbeValidated?: { params: unknown; query: unknown; body: unknown };
  /** Set by the access guard on "authenticated" routes (a complete session). */
  pbeSession?: ResolvedSession;
  /** Set by the access guard on "permission" routes (Stage 7A). */
  pbeAccess?: AccessContext;
}
export interface PbeResponse extends ServerResponse {
  status(code: number): PbeResponse;
  send(body: string): PbeResponse;
}
type NextFunction = (error?: unknown) => void;

/**
 * Request ids (S4-6): accept a caller's X-Request-Id only if it is a UUID, otherwise create one.
 * Also sets basic security headers and writes one redacted access-log line per request —
 * method, path WITHOUT query string, status, duration. Bodies and headers are never logged.
 */
export function requestPipeline(logger: JsonLogger) {
  return (req: PbeRequest, res: PbeResponse, next: NextFunction): void => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = isRequestId(incoming) ? incoming.toLowerCase() : randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.event('info', 'request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}
