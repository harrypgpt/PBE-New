import { assertPermissionName, hasPermission, type UiSession } from './session/session';

/**
 * Navigation is data, not markup (baseline B5-3): later stages add entries with the permission
 * they need, and the menu adapts to the session. Placeholders are inert labels for areas that
 * arrive in later stages; they link nowhere and grant nothing, so they carry no permission yet.
 */
export type NavItem =
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly label: string;
      /** Omit only for pages anyone may open (e.g. home, system status). */
      readonly permission?: string;
      /** Show only when signed in, or only when signed out (presentation only, F-6). */
      readonly audience?: 'signed-in' | 'signed-out';
    }
  | { readonly kind: 'placeholder'; readonly label: string };

export const NAVIGATION: readonly NavItem[] = [
  { kind: 'link', href: '/', label: 'Home' },
  { kind: 'link', href: '/status', label: 'System status' },
  { kind: 'link', href: '/login', label: 'Sign in', audience: 'signed-out' },
  { kind: 'link', href: '/account', label: 'Account security', audience: 'signed-in' },
  { kind: 'link', href: '/organisation', label: 'Organisation', audience: 'signed-in' },
  // Projects (Stage 8): shown only with the matching permission.
  { kind: 'link', href: '/projects', label: 'Projects', permission: 'tenant.projects.read' },
  // Organisation administration (Stage 7B): shown only with the matching permission.
  { kind: 'link', href: '/admin/members', label: 'Members', permission: 'tenant.members.read' },
  { kind: 'link', href: '/admin/roles', label: 'Roles', permission: 'tenant.roles.read' },
  {
    kind: 'link',
    href: '/admin/departments',
    label: 'Departments',
    permission: 'tenant.departments.read',
  },
  {
    kind: 'link',
    href: '/admin/settings',
    label: 'Organisation settings',
    permission: 'tenant.settings.read',
  },
  // Platform administration (Super Admin): no customer data.
  {
    kind: 'link',
    href: '/platform/organisations',
    label: 'All organisations',
    permission: 'platform.tenants.read',
  },
  {
    kind: 'link',
    href: '/platform/break-glass',
    label: 'Break-glass access',
    permission: 'platform.breakglass.request',
  },

  { kind: 'placeholder', label: 'Evidence' },
  { kind: 'placeholder', label: 'Results' },
  { kind: 'placeholder', label: 'Audit trail' },
];

/** Entries the session may see. A link that declares a permission is hidden without it. */
export function visibleNavItems(
  items: readonly NavItem[],
  session: UiSession | null,
): readonly NavItem[] {
  return items.filter((item) => {
    if (item.kind === 'placeholder') return true;
    if (item.audience === 'signed-in' && session === null) return false;
    if (item.audience === 'signed-out' && session !== null) return false;
    if (item.permission === undefined) return true;
    assertPermissionName(item.permission);
    return hasPermission(session, item.permission);
  });
}
