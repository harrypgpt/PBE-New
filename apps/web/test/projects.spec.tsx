import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectDetailDto } from '@pbe/contracts';
import { NAVIGATION, visibleNavItems } from '../src/navigation';
import { Dashboard } from '../src/projects/Dashboard';
import { ProjectDetail } from '../src/projects/ProjectDetail';
import { ProjectWizard } from '../src/projects/ProjectWizard';
import { ScopeBadge } from '../src/projects/ScopeBadge';
import type { UiSession } from '../src/session/session';

/* Stage 8 component tests (S8-9 / S8-10 at component level). Data is fictional; fetch answers per URL. */

const REQUEST_ID = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
const ORG_A = '0199a1b2-0000-7000-8000-00000000000a';
const P1 = '0199a1b2-0000-7000-8000-000000000501';
const S1 = '0199a1b2-0000-7000-8000-000000000601';
const D1 = '0199a1b2-0000-7000-8000-000000000401';
const NOW = '2026-10-18T10:00:00.000Z';

type Handler = (body: unknown) => { status: number; body: unknown };
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function routeFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET');
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, url, body });
    const handler = routes[`${method} ${url}`];
    const r = handler
      ? handler(body)
      : {
          status: 404,
          body: {
            type: 'https://pbe.local/problems/not-found',
            title: 'Not found',
            status: 404,
            code: 'NOT_FOUND',
            requestId: REQUEST_ID,
          },
        };
    return {
      status: r.status,
      headers: { get: (h: string) => (h === 'x-request-id' ? REQUEST_ID : null) },
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const session = (permissions: string[], extra: Partial<UiSession> = {}): UiSession => ({
  user: { displayName: 'Fictional Lead' },
  tenant: { id: ORG_A, name: 'Fictional Org A' },
  permissions,
  ...extra,
});

const project = (over: Partial<ProjectDetailDto> = {}): ProjectDetailDto => ({
  id: P1,
  name: 'Fictional IR tablet',
  molecule: 'Fictionalol',
  strength: { value: 50, unit: 'mg' },
  dosageForm: 'tablet',
  route: 'oral',
  releaseType: 'immediate_release',
  productFlags: [],
  scope: { status: 'supported', reasons: [], vocabularyVersion: 'draft-2026-10-18' },
  status: 'active',
  departmentIds: [],
  scenarioCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  scenarios: [
    { id: S1, code: 'F001', description: 'Fictional reference', createdAt: NOW, updatedAt: NOW },
  ],
  ...over,
});
const summary = (p: ProjectDetailDto): Omit<ProjectDetailDto, 'scenarios'> => {
  const copy: Partial<ProjectDetailDto> = { ...p };
  delete copy.scenarios;
  return copy as Omit<ProjectDetailDto, 'scenarios'>;
};

describe('S8 navigation (presentation only, F-6)', () => {
  const labels = (s: UiSession | null) =>
    visibleNavItems(NAVIGATION, s).flatMap((i) => (i.kind === 'link' ? [i.label] : []));

  it('the Projects link appears only with tenant.projects.read', () => {
    expect(labels(null)).not.toContain('Projects');
    expect(labels(session([]))).not.toContain('Projects');
    expect(labels(session(['tenant.projects.read']))).toContain('Projects');
  });
});

describe('S8 scope badge (ADR-011): a word, never colour alone; the reason is always shown', () => {
  it('supported', () => {
    render(<ScopeBadge status="supported" reasons={[]} />);
    expect(screen.getByText('Supported')).toBeTruthy();
  });

  it('unsupported, with every reason and the reviewer note', () => {
    render(
      <ScopeBadge
        status="unsupported"
        reasons={[
          'Nasal products are outside the supported scope.',
          'Chewable tablet is in scope only if …',
        ]}
        awaitingReviewer
      />,
    );
    expect(screen.getByText('Unsupported scope')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Why this is outside the supported scope' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/await a decision by the scientific reviewer/)).toBeTruthy();
  });
});

describe('S8 dashboard', () => {
  it('without an organisation: asks to choose one; shows no projects', () => {
    routeFetch({});
    render(<Dashboard session={session(['tenant.projects.read'], { tenant: null })} />);
    expect(screen.getByText('Choose an organisation')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your projects' })).toBeNull();
  });

  it('identity, organisation, projects with scope, honest placeholders, and quick actions by permission', async () => {
    routeFetch({
      'GET /api/v1/projects': () => ({
        status: 200,
        body: {
          projects: [
            summary(project()),
            summary(
              project({
                id: '0199a1b2-0000-7000-8000-000000000502',
                name: 'Fictional nasal',
                route: 'nasal',
                scope: {
                  status: 'unsupported',
                  reasons: ['Nasal products are outside the supported scope.'],
                  vocabularyVersion: 'v',
                },
              }),
            ),
          ],
        },
      }),
    });
    render(<Dashboard session={session(['tenant.projects.read', 'tenant.projects.create'])} />);
    expect(screen.getByText('Welcome, Fictional Lead.')).toBeTruthy();
    expect(screen.getByText(/You are working in Fictional Org A/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create a project' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Recently changed active projects' });
    await waitFor(() =>
      expect(within(table).getByRole('link', { name: 'Fictional IR tablet' })).toBeTruthy(),
    );
    expect(within(table).getByText('Supported')).toBeTruthy();
    expect(within(table).getByText('Unsupported scope')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pending tasks' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent runs' })).toBeTruthy();
  });

  it('a reader without create permission sees no "Create a project"', () => {
    routeFetch({ 'GET /api/v1/projects': () => ({ status: 200, body: { projects: [] } }) });
    render(<Dashboard session={session(['tenant.projects.read'])} />);
    expect(screen.queryByRole('link', { name: 'Create a project' })).toBeNull();
  });
});

describe('S8 project wizard', () => {
  const choose = (label: RegExp, value: string) => {
    const el = screen.getByLabelText(label);
    fireEvent.change(el, { target: { value } });
  };

  it('an empty form lists every problem; nothing is sent', async () => {
    const calls = routeFetch({});
    render(<ProjectWizard canChooseDepartments={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    const summaryBox = await screen.findByRole('alert');
    for (const msg of [
      'Enter a project name',
      'Enter the molecule',
      'Enter a strength',
      'Choose a dosage form',
      'Choose a route',
      'Choose a release type',
    ]) {
      expect(within(summaryBox).getByText(new RegExp(msg))).toBeTruthy();
    }
    expect(calls.filter((c) => c.url === '/api/v1/projects')).toEqual([]);
  });

  it('the live scope check asks the API and shows "Unsupported scope" with the reason', async () => {
    const calls = routeFetch({
      'POST /api/v1/projects/scope-check': () => ({
        status: 200,
        body: {
          status: 'unsupported',
          reasons: ['Nasal products are outside the supported scope.'],
          awaitingReviewer: false,
          vocabularyVersion: 'draft-2026-10-18',
        },
      }),
    });
    render(<ProjectWizard canChooseDepartments={false} />);
    choose(/^Dosage form/, 'tablet');
    choose(/^Route/, 'nasal');
    choose(/^Release type/, 'immediate_release');
    expect(await screen.findByText('Nasal products are outside the supported scope.')).toBeTruthy();
    expect(screen.getByText('Unsupported scope')).toBeTruthy();
    expect(screen.getByText(/You can still record this project/)).toBeTruthy();
    expect(calls.at(-1)?.body).toEqual({
      dosageForm: 'tablet',
      route: 'nasal',
      releaseType: 'immediate_release',
      productFlags: [],
    });
  });

  it('review, then create: the request carries the product terms only (never a scope status)', async () => {
    const calls = routeFetch({
      'GET /api/v1/tenant/departments': () => ({
        status: 200,
        body: { departments: [{ id: D1, name: 'Fictional R&D', description: '', memberCount: 1 }] },
      }),
      'POST /api/v1/projects/scope-check': () => ({
        status: 200,
        body: {
          status: 'supported',
          reasons: [],
          awaitingReviewer: false,
          vocabularyVersion: 'draft-2026-10-18',
        },
      }),
      'POST /api/v1/projects': () => ({ status: 201, body: { project: project() } }),
    });
    const created = jest.fn();
    render(<ProjectWizard canChooseDepartments onCreated={created} />);
    fireEvent.change(screen.getByLabelText(/^Project name/), {
      target: { value: 'Fictional IR tablet' },
    });
    fireEvent.change(screen.getByLabelText(/^Molecule/), { target: { value: 'Fictionalol' } });
    fireEvent.change(screen.getByLabelText(/^Strength \*/), { target: { value: '50' } });
    choose(/^Dosage form/, 'tablet');
    choose(/^Route/, 'oral');
    choose(/^Release type/, 'immediate_release');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Fictional R&D' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    expect(await screen.findByRole('heading', { name: 'Review and create' })).toBeTruthy();
    expect(screen.getByText('Members of: Fictional R&D')).toBeTruthy();
    expect(screen.getByText('50 mg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(P1));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/projects')?.body).toEqual({
      name: 'Fictional IR tablet',
      molecule: 'Fictionalol',
      strength: { value: 50, unit: 'mg' },
      dosageForm: 'tablet',
      route: 'oral',
      releaseType: 'immediate_release',
      productFlags: [],
      departmentIds: [D1],
    });
  });
});

describe('S8 project page', () => {
  const all = { manage: true, scenarios: true, departments: false };

  it('active: scope, scenarios, add scenario, archive (each by permission)', async () => {
    const calls = routeFetch({
      [`GET /api/v1/projects/${P1}`]: () => ({ status: 200, body: { project: project() } }),
      [`POST /api/v1/projects/${P1}/scenarios`]: () => ({
        status: 201,
        body: {
          scenario: {
            id: '0199a1b2-0000-7000-8000-000000000602',
            code: 'F002',
            description: '',
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    });
    render(<ProjectDetail projectId={P1} can={all} />);
    expect(await screen.findByRole('heading', { name: 'Fictional IR tablet' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Scenarios of Fictional IR tablet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive Fictional IR tablet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add scenario' }));
    expect(await screen.findByText('F002 was added.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ description: '' });
  });

  it('without permissions: no change buttons', async () => {
    routeFetch({
      [`GET /api/v1/projects/${P1}`]: () => ({ status: 200, body: { project: project() } }),
    });
    render(
      <ProjectDetail
        projectId={P1}
        can={{ manage: false, scenarios: false, departments: false }}
      />,
    );
    await screen.findByRole('heading', { name: 'Fictional IR tablet' });
    expect(screen.queryByRole('button', { name: 'Add scenario' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit F001' })).toBeNull();
  });

  it('archived: read-only notice; no change buttons even with permissions', async () => {
    routeFetch({
      [`GET /api/v1/projects/${P1}`]: () => ({
        status: 200,
        body: { project: project({ status: 'archived' }) },
      }),
    });
    render(<ProjectDetail projectId={P1} can={all} />);
    expect(await screen.findByText('This project is archived')).toBeTruthy();
    expect(screen.getByText('Archived (read-only)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add scenario' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
  });

  it('a project that is not visible (404) shows a plain message', async () => {
    routeFetch({});
    render(<ProjectDetail projectId={P1} can={all} />);
    expect(await screen.findByText('The project could not be loaded')).toBeTruthy();
    expect(screen.getByText(/Not found in this organisation/)).toBeTruthy();
  });
});
