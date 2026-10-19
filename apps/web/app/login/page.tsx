import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../src/auth/LoginForm';
import { getServerSession } from '../../src/session/server-session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getServerSession()) redirect('/');
  return (
    <>
      <h1>Sign in</h1>
      <p>Accounts are created by your administrator. There is no self-registration.</p>
      <LoginForm />
    </>
  );
}
