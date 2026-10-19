import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { NavItem } from '../../src/navigation';
import { IfPermitted } from '../../src/session/IfPermitted';
import type { UiSession } from '../../src/session/session';
import { DataTable } from '../../src/ui/DataTable';
import { ErrorState, LoadingState, Notice, StatusLabel } from '../../src/ui/feedback';
import { Navigation } from '../../src/ui/Navigation';
import { StepProgress, ValueProgress } from '../../src/ui/progress';
import { ShowcaseForm } from './showcase-form';

export const metadata: Metadata = { title: 'Component showcase' };

/**
 * Test-only page showing every Stage 5 component, for the accessibility and responsive browser
 * tests. It exists only when the server starts with PBE_WEB_SHOWCASE=1 (the E2E test servers);
 * otherwise it is "page not found".
 */
const DEMO_SESSION: UiSession = {
  user: { displayName: 'Demo user' },
  tenant: { name: 'Demo organisation' },
  permissions: ['project.read'],
};

const DEMO_NAV: readonly NavItem[] = [
  { kind: 'link', href: '/showcase', label: 'Showcase' },
  {
    kind: 'link',
    href: '/showcase#projects',
    label: 'Projects (needs project.read)',
    permission: 'project.read',
  },
  {
    kind: 'link',
    href: '/showcase#admin',
    label: 'Users (needs admin.users)',
    permission: 'admin.users',
  },
];

interface ComponentRow {
  readonly name: string;
  readonly purpose: string;
  readonly state: 'ready' | 'planned';
}

const ROWS: readonly ComponentRow[] = [
  {
    name: 'Form fields',
    purpose: 'Labelled inputs with required markers and messages',
    state: 'ready',
  },
  { name: 'Data table', purpose: 'Lists such as projects, users and audit events', state: 'ready' },
  { name: 'Filters and paging', purpose: 'Arrive with the first real data', state: 'planned' },
];

export default function ShowcasePage() {
  if (process.env.PBE_WEB_SHOWCASE !== '1') notFound();
  return (
    <>
      <h1>Component showcase</h1>
      <p>Every Stage 5 building block, with example content only. Nothing here is saved.</p>

      <h2>Forms</h2>
      <ShowcaseForm />

      <h2>Progress</h2>
      <StepProgress
        label="Example workflow progress"
        steps={['Project', 'Evidence', 'Review', 'Results']}
        current={1}
      />
      <ValueProgress id="showcase-progress" label="Example files checked" value={3} max={8} />

      <h2>Status labels</h2>
      <p>
        <StatusLabel tone="neutral" text="Draft" /> <StatusLabel tone="info" text="In review" />{' '}
        <StatusLabel tone="success" text="Approved" />{' '}
        <StatusLabel tone="warning" text="Needs attention" />{' '}
        <StatusLabel tone="error" text="Rejected" />
      </p>

      <h2>Feedback</h2>
      <Notice tone="success" title="Saved">
        <p>Example success message.</p>
      </Notice>
      <Notice tone="info" title="For information">
        <p>Example information message.</p>
      </Notice>
      <Notice tone="warning" title="Check before continuing">
        <p>Example warning message.</p>
      </Notice>
      <ErrorState
        title="Example error"
        message="Example plain-language error message."
        requestId="0b6b1f5e-2f4c-4c8e-9b7a-3d2e1f0a9c8b"
      />
      <LoadingState label="Example loading message…" />

      <h2>Tables</h2>
      <DataTable
        id="showcase-components"
        caption="Example components"
        columns={[
          { key: 'name', header: 'Component', cell: (r: ComponentRow) => r.name },
          { key: 'purpose', header: 'Purpose', cell: (r: ComponentRow) => r.purpose },
          {
            key: 'state',
            header: 'State',
            cell: (r: ComponentRow) => (
              <StatusLabel
                tone={r.state === 'ready' ? 'success' : 'neutral'}
                text={r.state === 'ready' ? 'Ready' : 'Planned'}
              />
            ),
          },
        ]}
        rows={ROWS}
        rowKey={(r) => r.name}
        emptyMessage="No components."
      />
      <DataTable
        id="showcase-empty"
        caption="Example empty list"
        columns={[{ key: 'name', header: 'Name', cell: (r: ComponentRow) => r.name }]}
        rows={[]}
        rowKey={(r) => r.name}
        emptyMessage="Nothing to show yet."
      />

      <h2>Permission-aware navigation (demo session, presentation only)</h2>
      <p>
        A demo session with the permission <code>project.read</code> only. Entries needing other
        permissions are hidden. Hiding is not authorisation: the API still refuses the action.
      </p>
      <Navigation items={DEMO_NAV} session={DEMO_SESSION} currentPath="/showcase" />
      <IfPermitted session={DEMO_SESSION} permission="project.read">
        <p id="projects">Shown: the demo session holds project.read.</p>
      </IfPermitted>
      <IfPermitted session={DEMO_SESSION} permission="admin.users">
        <p id="admin">This text must never appear for the demo session.</p>
      </IfPermitted>
    </>
  );
}
