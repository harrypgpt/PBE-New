/**
 * Browser security baseline (STAGE-05-PLAN.md §3, ADR-025). The static headers are sent on every
 * web response by next.config.ts; the Content Security Policy carries a fresh nonce per request
 * and is set by proxy.ts. These headers protect the browser. They are NOT authorisation: access
 * decisions stay in the API guard and PostgreSQL RLS.
 */

export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** 128 random bits, base64-encoded. A new value for every request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Nonce-based policy: no 'unsafe-inline' anywhere. 'unsafe-eval' only under `next dev`, which
 * needs it for live reload; production builds never get it. 'strict-dynamic' is deliberately NOT
 * used: it would let any running script add further inline scripts (found by S5-10). Script files
 * must come from this origin ('self'); inline scripts need the nonce.
 * HSTS and upgrade-insecure-requests belong to the HTTPS deployment (Stage 29), not plain-http
 * localhost.
 */
export function buildCsp(nonce: string, options: { readonly development: boolean }): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw new Error('invalid CSP nonce');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${options.development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
