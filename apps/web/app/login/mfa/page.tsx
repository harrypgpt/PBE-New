import type { Metadata } from 'next';
import { MfaVerifyForm } from '../../../src/auth/MfaVerifyForm';

export const metadata: Metadata = { title: 'Verify sign-in' };

export default function MfaPage() {
  return (
    <>
      <h1>Verify sign-in</h1>
      <p>Enter the code from your authenticator app to finish signing in.</p>
      <MfaVerifyForm />
    </>
  );
}
