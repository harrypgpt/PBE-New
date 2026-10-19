/**
 * Where this web server reaches the API (ADR-025). Used by the /api/v1 forwarding (fixed at
 * build time) and by server-side session look-ups (read at run time). Local origin only.
 */
export function apiOrigin(value: string | undefined = process.env.PBE_WEB_API_ORIGIN): string {
  const url = new URL(value ?? 'http://127.0.0.1:3001');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PBE_WEB_API_ORIGIN must be an http(s) origin');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PBE_WEB_API_ORIGIN must be an origin only (scheme, host, port)');
  }
  return url.origin;
}
