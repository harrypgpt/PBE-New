import type { ReactNode } from 'react';
import type { UiSession } from '../session/session';
import { Notice } from './feedback';
import { LimitationStatement } from './LimitationStatement';
import styles from './shell.module.css';

/**
 * The page frame used by every page: skip link, header (with slots for the signed-in user and
 * active tenant from Stage 6–7), the permanent limitation statement, navigation and the main
 * content area. With no session (all of Stage 5) it shows a neutral, signed-out frame.
 */
export function AppShell({
  session,
  navigation,
  limitation,
  accountActions,
  children,
}: {
  readonly session: UiSession | null;
  readonly navigation: ReactNode;
  readonly limitation: string;
  /** Shown next to the signed-in user, e.g. the sign-out button. */
  readonly accountActions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <a href="#main" className={styles.skipLink}>
        Skip to main content
      </a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.productName}>PBE</span>
          <span className={styles.productTagline}>Predictive Bioequivalence Engine</span>
        </div>
        <div className={styles.context}>
          {session === null ? (
            <span>Not signed in</span>
          ) : (
            <>
              {session.tenant === null ? null : (
                <span className={styles.tenant}>Organisation: {session.tenant.name}</span>
              )}
              <span>{session.user.displayName}</span>
              {accountActions}
            </>
          )}
        </div>
      </header>
      <LimitationStatement text={limitation} />
      {session?.breakGlass ? (
        <div className={styles.breakGlass}>
          <Notice tone="warning" title="Break-glass access: read-only">
            <p>
              You are viewing this organisation&apos;s data under an approved emergency grant. Every
              view is recorded in its audit trail. Access ends at{' '}
              <time dateTime={session.breakGlass.expiresAt}>
                {new Date(session.breakGlass.expiresAt).toLocaleString('en-GB', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'UTC',
                })}{' '}
                UTC
              </time>
              .
            </p>
          </Notice>
        </div>
      ) : null}
      <div className={styles.layout}>
        <div className={styles.sidebar}>{navigation}</div>
        <main id="main" tabIndex={-1} className={styles.main}>
          {children}
        </main>
      </div>
      <footer className={styles.footer}>
        <p>PBE — decision support for pre-pivotal bioequivalence risk assessment.</p>
      </footer>
    </>
  );
}
