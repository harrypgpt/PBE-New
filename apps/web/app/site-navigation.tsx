'use client';

import { usePathname } from 'next/navigation';
import { NAVIGATION } from '../src/navigation';
import type { UiSession } from '../src/session/session';
import { Navigation } from '../src/ui/Navigation';

/** Connects the navigation component to the current address, so the current page is marked. */
export function SiteNavigation({ session }: { readonly session: UiSession | null }) {
  return <Navigation items={NAVIGATION} session={session} currentPath={usePathname()} />;
}
