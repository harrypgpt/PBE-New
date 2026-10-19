import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, createNonce } from './src/security/headers';

/**
 * Sets the per-request Content Security Policy nonce (Next.js applies it to its own scripts).
 * This file only sets headers. It is never a security boundary and makes no access decisions
 * (ADR-025): those stay in the API guard and PostgreSQL RLS. /api/v1 is forwarded to the API,
 * which sets its own headers.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = buildCsp(nonce, { development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!api/v1/).*)'],
};
