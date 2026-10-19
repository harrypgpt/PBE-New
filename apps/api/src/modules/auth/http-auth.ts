import { isIP } from 'node:net';
import type { PbeRequest, PbeResponse } from '../../common/http';
import { isSessionTokenFormat } from './secrets';

/**
 * Session cookie and request checks (ADR-026).
 * Cookie: __Host- prefix (Secure, Path=/, no Domain), HttpOnly, SameSite=Strict. It has no
 * Max-Age: the server enforces idle and absolute expiry. Browsers accept Secure cookies on
 * http://localhost, so development uses the production flags.
 */
export const SESSION_COOKIE = '__Host-pbe_session';
const COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${COOKIE_FLAGS}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`;
}

export function setSessionCookie(res: PbeResponse, value: string): void {
  res.setHeader('Set-Cookie', value);
}

/** The session token from the Cookie header, if present and well-formed (else null). */
export function sessionTokenFrom(req: PbeRequest): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return isSessionTokenFormat(value) ? value : null;
  }
  return null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normaliseAddress(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(v) ? v : null;
}

/**
 * The client's address for throttling and security events. Only a loopback peer (the PBE web
 * server's /api/v1 forwarding) is trusted to report the original client in X-Forwarded-For; the
 * right-most entry is the one that proxy added.
 */
export function clientAddress(req: PbeRequest): string | null {
  const peer = normaliseAddress(req.socket.remoteAddress);
  const forwarded = req.headers['x-forwarded-for'];
  if (peer && LOOPBACK.has(peer) && typeof forwarded === 'string' && forwarded.length > 0) {
    const last = forwarded.split(',').pop();
    return normaliseAddress(last) ?? peer;
  }
  return peer;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for state-changing requests: the browser's Origin must be a PBE web origin, a
 * Sec-Fetch-Site header (when sent) must say same-origin, and a body must be JSON. Together with
 * the SameSite=Strict cookie and closed CORS, a cross-site page cannot make such a request.
 * Returns the reason for refusal, or null.
 */
export function crossSiteRefusal(
  req: PbeRequest,
  allowedOrigins: readonly string[],
): string | null {
  if (!UNSAFE.has(req.method ?? '')) return null;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return 'origin not allowed';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'cross-site fetch';
  const type = req.headers['content-type'];
  if (type !== undefined && !/^application\/json(\s*;|$)/i.test(type)) return 'non-JSON body';
  return null;
}
