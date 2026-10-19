import type { Metadata } from 'next';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { PlatformBreakGlass } from '../../../src/admin/PlatformBreakGlass';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Break-glass access' };

export default async function PlatformBreakGlassPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Break-glass access</h1>
      {hasPermission(session, 'platform.breakglass.request') ? (
        <PlatformBreakGlass />
      ) : (
        <NoAccess session={session} scope="platform" />
      )}
    </>
  );
}
