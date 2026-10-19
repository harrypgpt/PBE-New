import { ApiError } from '../api-client/client';

/**
 * Plain-language messages for sign-in errors. They never reveal whether an email exists, and
 * never show server text other than the API's own plain "detail" for policy messages.
 */
export function signInErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (error.kind === 'problem' && error.status === 401) {
      return error.problem?.detail ?? 'Sign-in failed.';
    }
    if (
      error.kind === 'problem' &&
      error.status === 400 &&
      error.problem?.code === 'VALIDATION_FAILED'
    ) {
      // Policy messages written by the API for people (e.g. "Use at least 15 characters.").
      return error.problem.detail ?? 'Please check the form.';
    }
    if (error.kind === 'problem' && error.status === 409) {
      return error.problem?.detail ?? 'This has already been done.';
    }
  }
  return 'The service could not complete the request. Please try again.';
}

export function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}
