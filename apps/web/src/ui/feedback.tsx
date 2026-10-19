import type { ReactNode } from 'react';
import styles from './feedback.module.css';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

function requireText(value: string, component: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) throw new Error(`${component} needs visible text.`);
  return text;
}

/** A short status word. Always text plus colour, never colour alone (WCAG 1.4.1). */
export function StatusLabel({ tone, text }: { readonly tone: Tone; readonly text: string }) {
  return (
    <span className={`${styles.label} ${styles[tone]}`}>{requireText(text, 'StatusLabel')}</span>
  );
}

/**
 * Success, information, warning or error feedback. Errors interrupt assistive technology
 * (role="alert"); everything else is announced politely (role="status").
 */
export function Notice({
  tone,
  title,
  children,
}: {
  readonly tone: Exclude<Tone, 'neutral'>;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`${styles.notice} ${styles[tone]}`}
    >
      <p className={styles.noticeTitle}>{requireText(title, 'Notice')}</p>
      {children === undefined ? null : <div className={styles.noticeBody}>{children}</div>}
    </div>
  );
}

/** A real loading state: says what is being loaded; no fake progress. */
export function LoadingState({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-live="polite" className={styles.loading}>
      <span className={styles.spinner} aria-hidden="true" />
      {requireText(label, 'LoadingState')}
    </div>
  );
}

/**
 * A plain-language error with an optional request id for support. It never shows technical
 * detail (stack traces, SQL, host names): callers pass a message written for people.
 */
export function ErrorState({
  title,
  message,
  requestId,
  children,
}: {
  readonly title: string;
  readonly message: string;
  readonly requestId?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div role="alert" className={`${styles.notice} ${styles.error}`}>
      <p className={styles.noticeTitle}>{requireText(title, 'ErrorState')}</p>
      <p>{requireText(message, 'ErrorState')}</p>
      {requestId === undefined ? null : (
        <p className={styles.reference}>
          Reference for support: <code>{requestId}</code>
        </p>
      )}
      {children}
    </div>
  );
}
