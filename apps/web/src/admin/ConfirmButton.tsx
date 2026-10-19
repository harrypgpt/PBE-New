'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/forms';
import styles from './admin.module.css';

/**
 * A two-step button for actions that take effect at once (deactivate, delete, suspend, revoke).
 * The first press asks "are you sure" next to the button, in the page, so keyboard and screen
 * reader users get the same question (no browser pop-up). Focus moves to the confirmation.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  /** Accessible name of the first button, e.g. "Deactivate Jane Doe". */
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) confirmRef.current?.querySelector('button')?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <Button variant="secondary" onClick={() => setAsking(true)} disabled={disabled ?? false}>
        {label}
      </Button>
    );
  }
  return (
    <div ref={confirmRef} className={styles.confirm} role="group" aria-label={question}>
      <p className={styles.confirmQuestion}>{question}</p>
      <div className={styles.actions}>
        <Button
          onClick={() => {
            setAsking(false);
            void onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
