'use client';

import { useEffect, useId, useRef } from 'react';
import styles from './feedback.module.css';

export interface FieldError {
  readonly fieldId: string;
  readonly message: string;
}

/**
 * Lists every validation problem at the top of a form, takes focus when it appears, and links
 * each message to its field, so keyboard and screen-reader users find the problems at once.
 */
export function ErrorSummary({
  errors,
  title = 'There is a problem',
}: {
  readonly errors: readonly FieldError[];
  readonly title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [errors]);
  if (errors.length === 0) return null;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`${styles.notice} ${styles.error}`}
    >
      <p id={titleId} className={styles.noticeTitle}>
        {title}
      </p>
      <ul>
        {errors.map((e) => (
          <li key={e.fieldId}>
            <a href={`#${e.fieldId}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
