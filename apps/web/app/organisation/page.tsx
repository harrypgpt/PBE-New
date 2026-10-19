import type { Metadata } from 'next';
import { OrganisationSwitcher } from '../../src/admin/OrganisationSwitcher';
import { requireSession } from '../../src/admin/page-session';

export const metadata: Metadata = { title: 'Organisation' };

export default async function OrganisationPage() {
  const session = await requireSession();
  return (
    <>
      <h1>Organisation</h1>
      <p>
        You work in one organisation at a time. Everything you see and do applies to the
        organisation chosen here.
      </p>
      <OrganisationSwitcher
        activeTenant={session.tenant}
        breakGlass={Boolean(session.breakGlass)}
      />
    </>
  );
}
