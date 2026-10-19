import { StatusLabel } from '../ui/feedback';
import styles from './projects.module.css';

/**
 * The scope result (ADR-011): always a word, never colour alone. An unsupported project always
 * shows why, so nobody mistakes a recorded project for a supported one.
 */
export function ScopeBadge({
  status,
  reasons,
  showReasons = true,
  awaitingReviewer = false,
}: {
  readonly status: 'supported' | 'unsupported';
  readonly reasons: readonly string[];
  readonly showReasons?: boolean;
  readonly awaitingReviewer?: boolean;
}) {
  return (
    <div className={styles.scope}>
      {status === 'supported' ? (
        <StatusLabel tone="success" text="Supported" />
      ) : (
        <StatusLabel tone="warning" text="Unsupported scope" />
      )}
      {status === 'unsupported' && showReasons ? (
        <ul className={styles.reasons} aria-label="Why this is outside the supported scope">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {status === 'unsupported' && showReasons && awaitingReviewer ? (
        <p className={styles.muted}>
          Some terms await a decision by the scientific reviewer; until then they are treated as
          unsupported.
        </p>
      ) : null}
    </div>
  );
}

/** Active or archived (archived projects are read-only, D8-8). */
export function ProjectStatus({ status }: { readonly status: 'active' | 'archived' }) {
  return status === 'active' ? (
    <StatusLabel tone="info" text="Active" />
  ) : (
    <StatusLabel tone="neutral" text="Archived (read-only)" />
  );
}
