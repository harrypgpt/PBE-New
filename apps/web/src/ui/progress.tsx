import styles from './progress.module.css';
import a11y from './a11y.module.css';

/**
 * Step progress for guided workflows: which step is done, current and still to come. The
 * current step is announced with aria-current="step".
 */
export function StepProgress({
  label,
  steps,
  current,
}: {
  readonly label: string;
  readonly steps: readonly string[];
  /** Zero-based index of the current step. */
  readonly current: number;
}) {
  if (steps.length === 0) throw new Error('StepProgress needs at least one step.');
  if (!Number.isInteger(current) || current < 0 || current >= steps.length) {
    throw new Error('StepProgress: current step is out of range.');
  }
  return (
    <nav aria-label={label} className={styles.steps}>
      <ol>
        {steps.map((step, index) => {
          const state = index < current ? 'completed' : index === current ? 'current' : 'upcoming';
          return (
            <li
              key={step}
              className={styles[state]}
              aria-current={index === current ? 'step' : undefined}
            >
              <span className={styles.marker} aria-hidden="true">
                {index < current ? '✓' : index + 1}
              </span>
              {step}
              <span className={a11y.visuallyHidden}>
                {state === 'completed'
                  ? ' (completed)'
                  : state === 'current'
                    ? ' (current step)'
                    : ' (not started)'}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Measured progress (a real value out of a real total). Never used for "fake" spinners: an
 * unknown duration uses LoadingState instead.
 */
export function ValueProgress({
  id,
  label,
  value,
  max,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
}) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0 || value > max) {
    throw new Error('ValueProgress needs 0 ≤ value ≤ max and max > 0.');
  }
  return (
    <div className={styles.value}>
      <label htmlFor={id}>{label}</label>
      <progress id={id} value={value} max={max}>
        {value} of {max}
      </progress>
      <span className={styles.valueText}>
        {value} of {max}
      </span>
    </div>
  );
}
