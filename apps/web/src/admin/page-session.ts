import { redirect } from 'next/navigation';
import { getServerSession } from '../session/server-session';
import type { UiSession } from '../session/session';

/** The signed-in session for an administration page; signed-out visitors go to sign-in. */
export async function requireSession(): Promise<UiSession> {
  const session = await getServerSession();
  if (!session) redirect('/login');
  return session;
}
