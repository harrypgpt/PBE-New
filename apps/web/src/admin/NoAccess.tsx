import type { UiSession } from '../session/session';
import { Notice } from '../ui/feedback';

/**
 * Shown instead of an administration page the session may not use. Presentation only (F-6): the
 * API refuses the underlying requests in any case.
 */
export function NoAccess({
  session,
  scope,
}: {
  readonly session: UiSession;
  readonly scope: 'tenant' | 'platform';
}) {
  if (scope === 'tenant' && session.tenant === null) {
    return (
      <Notice tone="info" title="Choose an organisation first">
        <p>
          This page belongs to an organisation. Go to <a href="/organisation">Organisation</a> and
          choose the one you want to work in.
        </p>
      </Notice>
    );
  }
  return (
    <Notice tone="info" title="You do not have access to this page">
      <p>
        Your roles do not include this. If you need it, ask an administrator of your
        {scope === 'tenant' ? ' organisation' : ' platform'}.
      </p>
    </Notice>
  );
}
