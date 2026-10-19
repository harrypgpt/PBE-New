import { render, screen, within } from '@testing-library/react';
import { PERMISSION_CODES, ROLE_TEMPLATES } from '@pbe/contracts';
import { LIMITATION_STATEMENT } from '../src/content/limitation';
import { NAVIGATION, visibleNavItems, type NavItem } from '../src/navigation';
import { IfPermitted } from '../src/session/IfPermitted';
import { hasPermission, type UiSession } from '../src/session/session';
import { AppShell } from '../src/ui/AppShell';
import { Navigation } from '../src/ui/Navigation';

const SESSION: UiSession = {
  user: { displayName: 'Test user' },
  tenant: { name: 'Tenant A' },
  permissions: ['project.read'],
};

const NAV: readonly NavItem[] = [
  { kind: 'link', href: '/', label: 'Home' },
  { kind: 'link', href: '/projects', label: 'Projects', permission: 'project.read' },
  { kind: 'link', href: '/admin/users', label: 'Users', permission: 'admin.users' },
  { kind: 'placeholder', label: 'Audit trail' },
];

function shell(session: UiSession | null) {
  return render(
    <AppShell
      session={session}
      navigation={<Navigation items={NAV} session={session} currentPath="/" />}
      limitation={LIMITATION_STATEMENT}
    >
      <h1>Page</h1>
    </AppShell>,
  );
}

describe('S5-1 app shell', () => {
  it('has a skip link to the main landmark, a header, navigation, main and footer', () => {
    shell(null);
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip.getAttribute('href')).toBe('#main');
    const main = screen.getByRole('main');
    expect(main.id).toBe('main');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    // Skip link comes first in reading and tab order.
    expect(document.body.querySelector('a')).toBe(skip);
  });

  it('shows a neutral signed-out frame without a session', () => {
    shell(null);
    expect(within(screen.getByRole('banner')).getByText('Not signed in')).toBeTruthy();
  });

  it('marks the current page in the navigation', () => {
    shell(null);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows placeholders as inert labels (no link)', () => {
    shell(null);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('Audit trail').closest('a')).toBeNull();
    expect(within(nav).getAllByText('Planned').length).toBeGreaterThan(0);
  });

  it('navigation: every declared permission is in the fixed catalogue; no role names anywhere (F-4)', () => {
    // Stage 7B added administration links; each must name a real catalogue permission.
    for (const item of NAVIGATION) {
      if (item.kind === 'link' && item.permission !== undefined) {
        expect(PERMISSION_CODES.has(item.permission)).toBe(true);
      }
    }
    const text = JSON.stringify(NAVIGATION).toLowerCase();
    for (const t of ROLE_TEMPLATES) {
      expect(text).not.toContain(t.key.toLowerCase());
      expect(text).not.toContain(t.name.toLowerCase());
    }
    expect(text).not.toMatch(/super ?admin/);
  });
});

describe('S5-18 permission-aware components (presentation only)', () => {
  it('with no session, every permission-declared entry and IfPermitted child is hidden', () => {
    shell(null);
    expect(screen.queryByRole('link', { name: 'Projects' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    render(
      <IfPermitted session={null} permission="project.read">
        <button type="button">Edit project</button>
      </IfPermitted>,
    );
    expect(screen.queryByRole('button', { name: 'Edit project' })).toBeNull();
  });

  it('with a session holding project.read, only matching entries show; tenant and user appear', () => {
    shell(SESSION);
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Organisation: Tenant A')).toBeTruthy();
    expect(within(banner).getByText('Test user')).toBeTruthy();
    render(
      <>
        <IfPermitted session={SESSION} permission="project.read">
          <button type="button">Open project</button>
        </IfPermitted>
        <IfPermitted session={SESSION} permission="project.delete">
          <button type="button">Delete project</button>
        </IfPermitted>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Open project' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
  });

  it('rejects malformed permission names (same format as the API contracts)', () => {
    expect(() => hasPermission(SESSION, 'PROJECT_READ')).toThrow(/area\.action/);
    expect(() =>
      visibleNavItems([{ kind: 'link', href: '/x', label: 'X', permission: 'bad' }], SESSION),
    ).toThrow(/area\.action/);
  });

  it('no session means no permission, whatever is asked', () => {
    expect(hasPermission(null, 'project.read')).toBe(false);
  });
});
