import type { Metadata } from 'next';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { ProjectWizard } from '../../../src/projects/ProjectWizard';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Create a project' };

export default async function NewProjectPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Create a project</h1>
      {session.tenant && hasPermission(session, 'tenant.projects.create') ? (
        <ProjectWizard canChooseDepartments={hasPermission(session, 'tenant.departments.read')} />
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
