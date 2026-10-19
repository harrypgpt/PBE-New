import { ApiError } from '../api-client/client';

/**
 * Plain-language messages for administration actions. They use only the API's "detail" text,
 * which the API writes for people (e.g. "Choose an organisation first." or the lock-out rule);
 * never raw server text, codes or internals.
 */
export function adminErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.kind === 'network') return 'The service could not be reached. Please try again.';
  if (error.kind === 'invalid-request') return 'Some information is missing or not valid.';
  if (error.kind !== 'problem') return 'The service could not complete the request.';
  const detail = error.problem?.detail;
  switch (error.status) {
    case 400:
      return detail ?? 'Please check the information and try again.';
    case 401:
      return 'Your session has ended. Please sign in again.';
    case 403:
      return detail ?? 'You do not have permission to do this.';
    case 404:
      return 'Not found in this organisation. It may have been removed or changed.';
    case 409:
      return detail ?? 'This conflicts with the current state. Refresh the page and try again.';
    case 429:
      return 'Too many attempts. Please wait a few minutes and try again.';
    default:
      return 'The service could not complete the request. Please try again.';
  }
}

export function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}

/** Feedback after an action: what happened, in plain language, with a support reference. */
export interface Outcome {
  readonly tone: 'success' | 'error';
  readonly title: string;
  readonly text: string;
  readonly requestId?: string | undefined;
}

export function failure(title: string, error: unknown): Outcome {
  return { tone: 'error', title, text: adminErrorMessage(error), requestId: requestIdOf(error) };
}

export function success(title: string, text: string): Outcome {
  return { tone: 'success', title, text };
}

/** Readable date and time in UTC (stated), so every reader sees the same value. */
export function formatUtc(iso: string | null): string {
  if (iso === null) return '—';
  return `${new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })} UTC`;
}
