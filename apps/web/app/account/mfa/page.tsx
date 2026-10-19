import type { Metadata } from 'next';
import { MfaEnrolment } from '../../../src/auth/MfaEnrolment';

export const metadata: Metadata = { title: 'Authenticator app' };

/**
 * Reachable during sign-in when an authenticator is required but not yet set up, so this page
 * does not require a complete session; the API checks the session on every request.
 */
export default function MfaEnrolmentPage() {
  return (
    <>
      <h1>Authenticator app</h1>
      <MfaEnrolment />
    </>
  );
}
