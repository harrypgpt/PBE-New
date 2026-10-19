import type { ReactNode } from 'react';
import { hasPermission, type UiSession } from './session';

/**
 * Shows its children only when the session holds the permission. Presentation only (F-6): the
 * API refuses the action regardless of what the UI shows.
 */
export function IfPermitted({
  session,
  permission,
  children,
}: {
  readonly session: UiSession | null;
  readonly permission: string;
  readonly children: ReactNode;
}): ReactNode {
  return hasPermission(session, permission) ? children : null;
}
