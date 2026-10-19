import type { Metadata } from 'next';
import { DepartmentsManager } from '../../../src/admin/DepartmentsManager';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Departments' };

export default async function DepartmentsPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Departments</h1>
      {hasPermission(session, 'tenant.departments.read') ? (
        <DepartmentsManager canManage={hasPermission(session, 'tenant.departments.manage')} />
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
