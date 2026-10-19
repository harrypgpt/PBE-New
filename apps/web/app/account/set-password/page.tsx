import type { Metadata } from 'next';
import { SetPasswordForm } from '../../../src/auth/SetPasswordForm';

export const metadata: Metadata = { title: 'Set your password' };

/** Public: reached from a one-time activation or reset link (the link itself is the credential). */
export default function SetPasswordPage() {
  return (
    <>
      <h1>Set your password</h1>
      <SetPasswordForm />
    </>
  );
}
