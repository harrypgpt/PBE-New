import { visibleNavItems, type NavItem } from '../navigation';
import type { UiSession } from '../session/session';
import { StatusLabel } from './feedback';
import styles from './shell.module.css';

/**
 * Main navigation. It shows only the entries the session may see (presentation only, F-6),
 * marks the current page, and renders planned areas as inert labels.
 */
export function Navigation({
  items,
  session,
  currentPath,
}: {
  readonly items: readonly NavItem[];
  readonly session: UiSession | null;
  readonly currentPath: string;
}) {
  return (
    <nav aria-label="Main" className={styles.nav}>
      <ul>
        {visibleNavItems(items, session).map((item) =>
          item.kind === 'link' ? (
            <li key={item.href}>
              <a href={item.href} aria-current={item.href === currentPath ? 'page' : undefined}>
                {item.label}
              </a>
            </li>
          ) : (
            <li key={item.label} className={styles.placeholder}>
              <span>{item.label}</span> <StatusLabel tone="neutral" text="Planned" />
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
