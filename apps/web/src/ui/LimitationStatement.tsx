import styles from './feedback.module.css';

/**
 * The scientific limitation statement (baseline B5-4). It cannot be empty, collapsed or hidden:
 * the only input is the text, and blank text is a programming error that fails loudly.
 */
export function LimitationStatement({ text }: { readonly text: string }) {
  const statement = typeof text === 'string' ? text.trim() : '';
  if (statement.length === 0) {
    throw new Error('LimitationStatement needs non-empty text (baseline B5-4).');
  }
  return (
    <div role="note" aria-label="Limitation statement" className={styles.limitation}>
      <strong className={styles.limitationLabel}>Limitations: </strong>
      {statement}
    </div>
  );
}
