import type { Metadata } from 'next';
import { NoAccess } from '../../../src/admin/NoAccess';
import { requireSession } from '../../../src/admin/page-session';
import { SettingsManager } from '../../../src/admin/SettingsManager';
import { hasPermission } from '../../../src/session/session';

export const metadata: Metadata = { title: 'Organisation settings' };

export default async function SettingsPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Organisation settings</h1>
      {hasPermission(session, 'tenant.settings.read') ? (
        <SettingsManager
          canManage={hasPermission(session, 'tenant.settings.manage')}
          canApproveBreakGlass={hasPermission(session, 'tenant.breakglass.approve')}
        />
      ) : (
        <NoAccess session={session} scope="tenant" />
      )}
    </>
  );
}
