import type { Metadata } from 'next';
import { NoAccess } from '../../src/admin/NoAccess';
import { requireSession } from '../../src/admin/page-session';
import { ProjectsList } from '../../src/projects/ProjectsList';
import { hasPermission } from '../../src/session/session';

export const metadata: Metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Projects</h1>
      {session.tenant && hasPermission(session, 'tenant.projects.read') ? (
        <>
          {hasPermission(session, 'tenant.projects.create') ? (
            <p>
              <a href="/projects/new">Create a project</a>
            </p>
          ) : null}
          <ProjectsList caption="Projects you can see in this organisation" />
        </>
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
