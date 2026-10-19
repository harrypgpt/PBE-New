import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../src/api-client/client';
import { ConfirmButton } from '../src/admin/ConfirmButton';
import { MembersManager, type MemberPermissions } from '../src/admin/MembersManager';
import { adminErrorMessage } from '../src/admin/messages';
import { NoAccess } from '../src/admin/NoAccess';
import { OrganisationSwitcher } from '../src/admin/OrganisationSwitcher';
import { SetPasswordForm, takeTokenFromLocation } from '../src/auth/SetPasswordForm';
import { NAVIGATION, visibleNavItems } from '../src/navigation';
import type { UiSession } from '../src/session/session';
import { AppShell } from '../src/ui/AppShell';

/* Stage 7B component tests. Data is fictional; fetch answers per URL. */

const REQUEST_ID = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
const ORG_A = '0199a1b2-0000-7000-8000-00000000000a';
const ORG_B = '0199a1b2-0000-7000-8000-00000000000b';
const M1 = '0199a1b2-0000-7000-8000-000000000101';
const U1 = '0199a1b2-0000-7000-8000-000000000201';
const R1 = '0199a1b2-0000-7000-8000-000000000301';
const R2 = '0199a1b2-0000-7000-8000-000000000302';
const D1 = '0199a1b2-0000-7000-8000-000000000401';

type Handler = (init: RequestInit) => { status: number; body: unknown };
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function routeFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET');
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${url}`];
    const { status, body } = handler
      ? handler(init)
      : { status: 404, body: problem(404, 'NOT_FOUND', 'Not found') };
    return {
      status,
      headers: { get: (h: string) => (h === 'x-request-id' ? REQUEST_ID : null) },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const problem = (status: number, code: string, detail: string) => ({
  type: `https://pbe.local/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: 'x',
  status,
  code,
  detail,
  requestId: REQUEST_ID,
});

const session = (permissions: string[], extra: Partial<UiSession> = {}): UiSession => ({
  user: { displayName: 'Fictional Admin' },
  tenant: { id: ORG_A, name: 'Fictional Org A' },
  permissions,
  ...extra,
});

describe('S7-B navigation (presentation only, F-6)', () => {
  const labels = (s: UiSession | null) =>
    visibleNavItems(NAVIGATION, s).map((i) => (i.kind === 'link' ? i.label : `(${i.label})`));

  it('signed out: no organisation or administration links', () => {
    const l = labels(null);
    for (const hidden of ['Organisation', 'Members', 'Roles', 'All organisations']) {
      expect(l).not.toContain(hidden);
    }
  });

  it('each administration link appears only with its own permission', () => {
    expect(labels(session([]))).toEqual(expect.arrayContaining(['Organisation']));
    expect(labels(session([]))).not.toContain('Members');
    expect(labels(session(['tenant.members.read']))).toContain('Members');
    expect(labels(session(['tenant.members.read']))).not.toContain('Roles');
    expect(labels(session(['platform.tenants.read']))).toContain('All organisations');
    expect(labels(session(['platform.tenants.read']))).not.toContain('Members');
    expect(labels(session(['platform.breakglass.request']))).toContain('Break-glass access');
  });
});

describe('S7-B plain-language errors', () => {
  const p = (status: number, detail: string) =>
    new ApiError('problem', status, REQUEST_ID, problem(status, 'X', detail) as never);

  it('uses the API detail written for people for 400, 403 and 409', () => {
    expect(adminErrorMessage(p(403, 'Choose an organisation first.'))).toBe(
      'Choose an organisation first.',
    );
    expect(adminErrorMessage(p(409, 'At least one active member must keep role management.'))).toBe(
      'At least one active member must keep role management.',
    );
  });

  it('never shows server text for 404, 401, network or unknown errors', () => {
    expect(adminErrorMessage(p(404, 'SELECT * FROM secret'))).not.toContain('SELECT');
    expect(adminErrorMessage(p(401, 'internal'))).toBe(
      'Your session has ended. Please sign in again.',
    );
    expect(adminErrorMessage(new ApiError('network', undefined, undefined))).toMatch(
      /could not be reached/,
    );
    expect(adminErrorMessage(new Error('boom: stack trace'))).not.toContain('boom');
  });
});

describe('S7-B shell and access notices', () => {
  it('shows a read-only break-glass warning on every page while it is in use', () => {
    render(
      <AppShell
        session={session([], { breakGlass: { expiresAt: '2026-10-18T10:00:00.000Z' } })}
        navigation={null}
        limitation="Limitation text"
      >
        <p>content</p>
      </AppShell>,
    );
    const warning = screen.getByRole('status', { name: '' });
    expect(within(warning).getByText('Break-glass access: read-only')).toBeTruthy();
    expect(warning.textContent).toContain('18 Oct 2026, 10:00 UTC');
  });

  it('without an active organisation, tenant pages ask to choose one first', () => {
    render(<NoAccess session={session([], { tenant: null })} scope="tenant" />);
    expect(screen.getByText('Choose an organisation first')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Organisation' }).getAttribute('href')).toBe(
      '/organisation',
    );
  });
});

describe('S7-B set your password (one-time link)', () => {
  const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);

  it('reads the token from the fragment and removes it from the address straight away', () => {
    const replaced: string[] = [];
    const got = takeTokenFromLocation(
      { hash: `#token=${TOKEN}`, pathname: '/account/set-password', search: '' },
      (u) => replaced.push(u),
    );
    expect(got).toBe(TOKEN);
    expect(replaced).toEqual(['/account/set-password']);
    expect(
      takeTokenFromLocation({ hash: '#token=short', pathname: '/x', search: '' }, () => undefined),
    ).toBeNull();
    expect(
      takeTokenFromLocation({ hash: '', pathname: '/x', search: '' }, () => undefined),
    ).toBeNull();
  });

  it('development mode (React Strict Mode runs start-up effects twice): a valid link still works', async () => {
    // Regression (Stage 8 acceptance, 2026-10-19): the second run found the address already
    // cleaned and replaced the token with "no token", so every link failed under `npm run dev`.
    window.history.replaceState(null, '', `/account/set-password#token=${TOKEN}`);
    render(
      <StrictMode>
        <SetPasswordForm />
      </StrictMode>,
    );
    expect(await screen.findByLabelText(/^New password/)).toBeTruthy();
    expect(screen.queryByText('This link cannot be used')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('without a valid link, explains it cannot be used', async () => {
    window.history.replaceState(null, '', '/account/set-password');
    render(<SetPasswordForm />);
    expect(await screen.findByText('This link cannot be used')).toBeTruthy();
  });

  it('checks the passwords, sends the token only in the body, and confirms', async () => {
    window.history.replaceState(null, '', `/account/set-password#token=${TOKEN}`);
    const calls = routeFetch({
      'POST /api/v1/account/token-password': () => ({
        status: 200,
        body: { status: 'password-set' },
      }),
    });
    render(<SetPasswordForm />);
    expect(window.location.hash).toBe('');
    const pw = 'correct horse battery staple fictional';
    fireEvent.change(await screen.findByLabelText(/^New password/), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText(/^Repeat the new password/), {
      target: { value: 'different' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('The passwords do not match', { selector: 'a' })).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/^Repeat the new password/), { target: { value: pw } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    });
    expect(await screen.findByText('Password set')).toBeTruthy();
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/v1/account/token-password',
        body: { token: TOKEN, newPassword: pw },
      },
    ]);
  });
});

describe('S7-B confirm button', () => {
  it('asks in the page, moves focus to the confirmation, and can be cancelled', async () => {
    const confirmed: string[] = [];
    render(
      <ConfirmButton
        label="Deactivate Fictional Member"
        question="Deactivate Fictional Member?"
        confirmLabel="Yes, deactivate"
        onConfirm={() => {
          confirmed.push('yes');
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Fictional Member' }));
    const yes = screen.getByRole('button', { name: 'Yes, deactivate' });
    await waitFor(() => expect(document.activeElement).toBe(yes));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Fictional Member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, deactivate' }));
    expect(confirmed).toEqual(['yes']);
  });
});

describe('S7-B organisation switcher', () => {
  it('lists memberships, marks the current one, and chooses another (then reloads)', async () => {
    const calls = routeFetch({
      'GET /api/v1/session/tenants': () => ({
        status: 200,
        body: {
          tenants: [
            { id: ORG_A, name: 'Fictional Org A', slug: 'org-a' },
            { id: ORG_B, name: 'Fictional Org B', slug: 'org-b' },
          ],
        },
      }),
      'POST /api/v1/session/tenant': () => ({
        status: 200,
        body: { activeTenant: { id: ORG_B, name: 'Fictional Org B', slug: 'org-b' } },
      }),
    });
    const went: string[] = [];
    render(
      <OrganisationSwitcher
        activeTenant={{ id: ORG_A, name: 'Fictional Org A' }}
        breakGlass={false}
        navigate={(u) => went.push(u)}
      />,
    );
    expect(await screen.findByText('Current')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Work in Fictional Org A' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Work in Fictional Org B' }));
    });
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      url: '/api/v1/session/tenant',
      body: { tenantId: ORG_B },
    });
    expect(went).toEqual(['/organisation']);
  });
});

describe('S7-B members', () => {
  const member = {
    id: M1,
    userId: U1,
    email: 'member@example.test',
    displayName: 'Fictional Member',
    status: 'active',
    roleIds: [R1],
    departmentIds: [D1],
  };
  const routes = (): Record<string, Handler> => ({
    'GET /api/v1/tenant/members': () => ({ status: 200, body: { members: [member] } }),
    'GET /api/v1/tenant/roles': () => ({
      status: 200,
      body: {
        roles: [
          {
            id: R1,
            name: 'Viewer',
            description: '',
            templateKey: 'viewer',
            permissions: [],
            memberCount: 1,
          },
          {
            id: R2,
            name: 'Lab manager',
            description: 'Fictional',
            templateKey: null,
            permissions: ['tenant.members.read'],
            memberCount: 0,
          },
        ],
      },
    }),
    'GET /api/v1/tenant/departments': () => ({
      status: 200,
      body: { departments: [{ id: D1, name: 'Fictional QA', description: '', memberCount: 1 }] },
    }),
  });
  const all: MemberPermissions = {
    manage: true,
    rolesRead: true,
    rolesManage: true,
    departmentsRead: true,
    departmentsManage: true,
  };

  it('shows names of roles and departments; a reader sees no management controls', async () => {
    routeFetch(routes());
    render(
      <MembersManager
        can={{
          manage: false,
          rolesRead: true,
          rolesManage: false,
          departmentsRead: true,
          departmentsManage: false,
        }}
      />,
    );
    expect(await screen.findByText('Fictional Member')).toBeTruthy();
    expect(screen.getByText('Viewer')).toBeTruthy();
    expect(screen.getByText('Fictional QA')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add a member' })).toBeNull();
  });

  it('adds a member and says the activation link went to the separate channel (never shown)', async () => {
    const calls = routeFetch({
      ...routes(),
      'POST /api/v1/tenant/members': () => ({
        status: 201,
        body: { member: { ...member, displayName: 'New Person' } },
      }),
    });
    render(<MembersManager can={all} />);
    await screen.findByText('Fictional Member');
    fireEvent.change(screen.getByLabelText(/^Email address/), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New Person' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    });
    expect(await screen.findByText('Member added')).toBeTruthy();
    expect(screen.getByText(/separate delivery channel; you never see it/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      email: 'new@example.test',
      displayName: 'New Person',
    });
  });

  it('manages one member: roles are saved as ids; the lock-out refusal is shown in plain words', async () => {
    const calls = routeFetch({
      ...routes(),
      [`PUT /api/v1/tenant/members/${M1}/roles`]: () => ({
        status: 409,
        body: problem(409, 'CONFLICT', 'At least one active member must keep role management.'),
      }),
    });
    render(<MembersManager can={all} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Fictional Member' }));
    const panel = screen.getByRole('region', { name: 'Manage Fictional Member' });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe('Manage Fictional Member'),
    );
    fireEvent.click(within(panel).getByLabelText('Lab manager'));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Save roles' }));
    });
    expect(await screen.findByText('Roles not saved')).toBeTruthy();
    expect(screen.getByText('At least one active member must keep role management.')).toBeTruthy();
    const sent = calls.find((c) => c.method === 'PUT')?.body as { roleIds: string[] };
    expect([...sent.roleIds].sort()).toEqual([R1, R2].sort());
  });
});
