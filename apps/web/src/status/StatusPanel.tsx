'use client';

import { useCallback, useEffect, useState } from 'react';
import { checkHealth, type HealthResult } from '../api-client/health';
import { ErrorState, LoadingState, Notice, StatusLabel } from '../ui/feedback';
import { Button } from '../ui/forms';

type PanelState = { readonly kind: 'checking' } | ({ readonly kind: 'done' } & HealthResult);

/**
 * Asks the API, from the browser, whether the API and database are available. Shows only
 * "available" or "unavailable" and a support reference; never host names, versions or errors.
 */
export function StatusPanel({
  check = checkHealth,
}: {
  readonly check?: () => Promise<HealthResult>;
}) {
  const [state, setState] = useState<PanelState>({ kind: 'checking' });

  const run = useCallback(() => {
    let active = true;
    setState({ kind: 'checking' });
    check()
      .catch((): HealthResult => ({ available: false, requestId: undefined }))
      .then((result) => {
        if (active) setState({ kind: 'done', ...result });
      });
    return () => {
      active = false;
    };
  }, [check]);

  useEffect(() => run(), [run]);

  if (state.kind === 'checking') return <LoadingState label="Checking the API and database…" />;

  return (
    <div>
      <p>
        Current status:{' '}
        <StatusLabel
          tone={state.available ? 'success' : 'error'}
          text={state.available ? 'Available' : 'Unavailable'}
        />
      </p>
      {state.available ? (
        <Notice tone="success" title="API and database: available">
          {state.requestId === undefined ? null : (
            <p>
              Reference: <code>{state.requestId}</code>
            </p>
          )}
        </Notice>
      ) : (
        <ErrorState
          title="API and database: unavailable"
          message="The system status could not be confirmed. Please try again shortly. If the problem continues, contact your administrator."
          requestId={state.requestId}
        />
      )}
      <Button variant="secondary" onClick={() => run()}>
        Check again
      </Button>
    </div>
  );
}
