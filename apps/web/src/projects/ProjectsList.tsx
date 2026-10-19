'use client';

import { projectsListRoute, type ProjectDto } from '@pbe/contracts';
import { callRoute } from '../api-client/client';
import { adminErrorMessage, formatUtc } from '../admin/messages';
import { useLoad } from '../admin/useLoad';
import { DataTable } from '../ui/DataTable';
import { ErrorState } from '../ui/feedback';
import { dosageFormLabel, formatStrength } from './labels';
import { ProjectStatus, ScopeBadge } from './ScopeBadge';

/**
 * Projects the signed-in member may see (department visibility is decided by the database,
 * D8-6). `limit` shows only the most recently changed ones (dashboard).
 */
export function ProjectsList({
  caption,
  limit,
}: {
  readonly caption: string;
  readonly limit?: number;
}) {
  const { state } = useLoad(
    async () => (await callRoute(projectsListRoute)).data.projects as readonly ProjectDto[],
  );
  if (state.status === 'error') {
    return (
      <ErrorState title="Projects could not be loaded" message={adminErrorMessage(state.error)} />
    );
  }
  let rows = state.status === 'ready' ? [...state.data] : null;
  if (rows && limit !== undefined) {
    rows = rows
      .filter((p) => p.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
  return (
    <DataTable
      id={limit === undefined ? 'projects' : 'recent-projects'}
      caption={caption}
      loading={rows === null}
      emptyMessage="No projects yet."
      rows={rows ?? []}
      rowKey={(p) => p.id}
      columns={[
        {
          key: 'name',
          header: 'Project',
          cell: (p) => <a href={`/projects/${p.id}`}>{p.name}</a>,
        },
        {
          key: 'product',
          header: 'Product',
          cell: (p) =>
            `${p.molecule} ${formatStrength(p.strength)} ${dosageFormLabel(p.dosageForm).toLowerCase()}`,
        },
        {
          key: 'scope',
          header: 'Scope',
          cell: (p) => (
            <ScopeBadge status={p.scope.status} reasons={p.scope.reasons} showReasons={false} />
          ),
        },
        { key: 'status', header: 'Status', cell: (p) => <ProjectStatus status={p.status} /> },
        { key: 'scenarios', header: 'Scenarios', cell: (p) => String(p.scenarioCount) },
        { key: 'updated', header: 'Last changed', cell: (p) => formatUtc(p.updatedAt) },
      ]}
    />
  );
}
