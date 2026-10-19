import type { Metadata } from 'next';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { RolesManager } from '../../../src/admin/RolesManager';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Roles' };

export default async function RolesPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Roles</h1>
      {hasPermission(session, 'tenant.roles.read') ? (
        <RolesManager canManage={hasPermission(session, 'tenant.roles.manage')} />
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
