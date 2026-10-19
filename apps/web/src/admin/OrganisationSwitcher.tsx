'use client';

import { sessionContextExitRoute, sessionTenantRoute, sessionTenantsRoute } from '@pbe/contracts';
import { useState } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorState, LoadingState, StatusLabel } from '../ui/feedback';
import { Button } from '../ui/forms';
import styles from './admin.module.css';
import { failure, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

/**
 * Choose the organisation to work in (D-7, S7-4). Choosing or leaving gives the browser a NEW
 * session (the API rotates it), then the page reloads so every screen shows the new context.
 */
export function OrganisationSwitcher({
  activeTenant,
  breakGlass,
  navigate = (url: string) => window.location.assign(url),
}: {
  readonly activeTenant: { readonly id?: string; readonly name: string } | null;
  readonly breakGlass: boolean;
  readonly navigate?: (url: string) => void;
}) {
  const { state } = useLoad(async () => (await callRoute(sessionTenantsRoute)).data.tenants);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(tenantId: string, name: string) {
    setBusy(true);
    setOutcome(null);
    try {
      await callRoute(sessionTenantRoute, { body: { tenantId } });
      navigate('/organisation');
    } catch (error) {
      setOutcome(failure(`Could not switch to ${name}`, error));
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    setOutcome(null);
    try {
      await callRoute(sessionContextExitRoute);
      navigate('/organisation');
    } catch (error) {
      setOutcome(failure('Could not leave', error));
      setBusy(false);
    }
  }

  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <section className={styles.section} aria-labelledby="current-heading">
        <h2 id="current-heading">Current organisation</h2>
        {breakGlass ? (
          <p>
            You are using read-only break-glass access to <strong>{activeTenant?.name}</strong>.
          </p>
        ) : activeTenant === null ? (
          <p>You are not working in an organisation at the moment.</p>
        ) : (
          <p>
            You are working in <strong>{activeTenant.name}</strong>.
          </p>
        )}
        {activeTenant !== null || breakGlass ? (
          <Button variant="secondary" onClick={() => void leave()} disabled={busy}>
            {breakGlass ? 'End break-glass access' : 'Leave this organisation'}
          </Button>
        ) : null}
      </section>
      <section className={styles.section} aria-labelledby="memberships-heading">
        <h2 id="memberships-heading">Your organisations</h2>
        {state.status === 'loading' ? <LoadingState label="Loading your organisations…" /> : null}
        {state.status === 'error' ? (
          <ErrorState
            title="Your organisations could not be loaded"
            message="Please try again in a moment."
          />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <p>
            You are not a member of any organisation yet. An administrator of an organisation can
            add you.
          </p>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className={styles.list}>
            {state.data.map((t) => {
              const current = !breakGlass && t.id === activeTenant?.id;
              return (
                <li key={t.id} className={styles.actions}>
                  <span>{t.name}</span>
                  {current ? (
                    <StatusLabel tone="success" text="Current" />
                  ) : (
                    <Button onClick={() => void choose(t.id, t.name)} disabled={busy}>
                      {`Work in ${t.name}`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </>
  );
}
