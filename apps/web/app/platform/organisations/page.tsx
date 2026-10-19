import type { Metadata } from 'next';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { PlatformOrganisations } from '../../../src/admin/PlatformOrganisations';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'All organisations' };

export default async function PlatformOrganisationsPage() {
  const session = await requireSession();
  return (
    <>
      <h1>All organisations</h1>
      {hasPermission(session, 'platform.tenants.read') ? (
        <PlatformOrganisations canManage={hasPermission(session, 'platform.tenants.manage')} />
      ) : (
        <NoAccess session={session} scope="platform" />
      )}
    </>
  );
}
