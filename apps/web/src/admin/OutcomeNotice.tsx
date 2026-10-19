import { ErrorState, Notice } from '../ui/feedback';
import type { Outcome } from './messages';

/** Shows the result of the last action: success (polite) or error (alert, with reference). */
export function OutcomeNotice({ outcome }: { readonly outcome: Outcome | null }) {
  if (outcome === null) return null;
  return outcome.tone === 'success' ? (
    <Notice tone="success" title={outcome.title}>
      <p>{outcome.text}</p>
    </Notice>
  ) : (
    <ErrorState title={outcome.title} message={outcome.text} requestId={outcome.requestId} />
  );
}
