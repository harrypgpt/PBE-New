import '../zod-config';
import { SessionResponseSchema } from '@pbe/contracts';
import { cookies } from 'next/headers';
import { apiOrigin } from '../config/api-origin';
import type { UiSession } from './session';

const SESSION_COOKIE = '__Host-pbe_session';

/**
 * The signed-in user for server-rendered pages (D-7), asked from the API with the browser's own
 * session cookie. Presentation only (F-6): the API decides every access on its own. Any failure
 * (no cookie, expired session, API unavailable, unexpected answer) means "not signed in".
 */
export async function getServerSession(): Promise<UiSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const res = await fetch(`${apiOrigin()}/api/v1/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return null;
    const parsed = SessionResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return {
      user: { displayName: parsed.data.user.displayName },
      tenant: parsed.data.activeTenant
        ? { id: parsed.data.activeTenant.id, name: parsed.data.activeTenant.name }
        : null,
      permissions: parsed.data.permissions,
      breakGlass: parsed.data.breakGlass ? { expiresAt: parsed.data.breakGlass.expiresAt } : null,
    };
  } catch {
    return null;
  }
}
