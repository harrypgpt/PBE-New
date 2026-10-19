import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { ProjectDetail } from '../../../src/projects/ProjectDetail';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Project' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  if (!session.tenant || !hasPermission(session, 'tenant.projects.read')) {
    return (
      <>
        <h1>Project</h1>
        <NoAccess session={session} scope="tenant" />
      </>
    );
  }
  return (
    <ProjectDetail
      projectId={projectId}
      justCreated={(await searchParams).created === '1'}
      can={{
        manage: hasPermission(session, 'tenant.projects.manage'),
        scenarios: hasPermission(session, 'tenant.scenarios.manage'),
        departments: hasPermission(session, 'tenant.departments.read'),
      }}
    />
  );
}
