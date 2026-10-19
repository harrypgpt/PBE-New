import type { Metadata } from 'next';
import { MembersManager } from '../../../src/admin/MembersManager';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage() {
  const session = await requireSession();
  const can = (p: string) => hasPermission(session, p);
  return (
    <>
      <h1>Members</h1>
      {can('tenant.members.read') ? (
        <MembersManager
          can={{
            manage: can('tenant.members.manage'),
            rolesRead: can('tenant.roles.read'),
            rolesManage: can('tenant.roles.manage'),
            departmentsRead: can('tenant.departments.read'),
            departmentsManage: can('tenant.departments.manage'),
          }}
        />
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
