import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SignOutButton } from '../src/auth/SignOutButton';
import { LIMITATION_STATEMENT } from '../src/content/limitation';
import { getServerSession } from '../src/session/server-session';
import { AppShell } from '../src/ui/AppShell';
import { SiteNavigation } from './site-navigation';
import '../src/ui/tokens.css';
import '../src/ui/base.css';

export const metadata: Metadata = {
  title: { default: 'PBE', template: '%s · PBE' },
  description: 'Predictive Bioequivalence Engine',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Render on every request, so each response carries a fresh CSP nonce (ADR-025).
  await connection();
  // Presentation only: the API checks the session on every request (F-6).
  const session = await getServerSession();
  return (
    <html lang="en">
      <body>
        <AppShell
          session={session}
          navigation={<SiteNavigation session={session} />}
          limitation={LIMITATION_STATEMENT}
          accountActions={<SignOutButton />}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
