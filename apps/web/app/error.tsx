'use client';

import { ErrorState } from '../src/ui/feedback';
import { Button } from '../src/ui/forms';

/**
 * Shown when a page fails unexpectedly. It never shows the error's message or stack: those can
 * contain technical detail. The plain-language text is fixed.
 */
export default function ErrorPage({
  reset,
}: {
  readonly error: Error;
  readonly reset: () => void;
}) {
  return (
    <>
      <h1>Something went wrong</h1>
      <ErrorState
        title="This page could not be shown"
        message="An unexpected problem occurred. Please try again. If it continues, contact your administrator."
      >
        <Button onClick={reset}>Try again</Button>
      </ErrorState>
    </>
  );
}
