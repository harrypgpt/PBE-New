import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PasswordChangeForm } from '../../../src/auth/PasswordChangeForm';
import { getServerSession } from '../../../src/session/server-session';

export const metadata: Metadata = { title: 'Change password' };

export default async function PasswordPage() {
  if (!(await getServerSession())) redirect('/login');
  return (
    <>
      <h1>Change password</h1>
      <PasswordChangeForm />
    </>
  );
}
