import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getServerSession } from '../../src/session/server-session';

export const metadata: Metadata = { title: 'Account security' };

export default async function AccountPage() {
  const session = await getServerSession();
  if (!session) redirect('/login');
  return (
    <>
      <h1>Account security</h1>
      <p>Signed in as {session.user.displayName}.</p>
      <ul>
        <li>
          <a href="/account/password">Change your password</a>
        </li>
        <li>
          <a href="/account/mfa">Set up an authenticator app</a>
        </li>
      </ul>
    </>
  );
}
