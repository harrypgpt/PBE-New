import '../zod-config';
import { PERMISSION_PATTERN } from '@pbe/contracts';

/**
 * The signed-in user's context as the UI sees it (baseline B5-3, D-7). The API supplies it from
 * Stage 6–7; in Stage 5 there is no sign-in, so it is always null. Permissions use the same
 * "area.action" names as the API route contracts. No role names are hard-coded here (F-4).
 *
 * PRESENTATION ONLY (F-6): hiding a link or button is a convenience, never authorisation. Every
 * protected action is still refused by the API guard and, for tenant data, by PostgreSQL RLS.
 */
export interface UiSession {
  readonly user: { readonly displayName: string };
  readonly tenant: { readonly id?: string; readonly name: string } | null;
  readonly permissions: readonly string[];
  /** Read-only emergency access by a Super Admin (ADR-028); shown as a warning on every page. */
  readonly breakGlass?: { readonly expiresAt: string } | null;
}

export function assertPermissionName(permission: string): void {
  if (!PERMISSION_PATTERN.test(permission)) {
    throw new Error(`Invalid permission name "${permission}": expected "area.action".`);
  }
}

/** True only when a session exists and lists the permission. No session means no permission. */
export function hasPermission(session: UiSession | null, permission: string): boolean {
  assertPermissionName(permission);
  return session !== null && session.permissions.includes(permission);
}
