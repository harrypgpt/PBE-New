'use client';

import {
  tenantBreakGlassDecisionRoute,
  tenantBreakGlassListRoute,
  tenantBreakGlassRevokeRoute,
  tenantSettingsRoute,
  tenantSettingsUpdateRoute,
} from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorState, LoadingState, StatusLabel, type Tone } from '../ui/feedback';
import { Button, Checkbox } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, formatUtc, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

/**
 * Organisation settings: separation of duties (S7-13: stored now, enforced when approvals exist)
 * and break-glass decisions (ADR-028: read-only, one organisation, at most one hour, no renewal).
 */
export function SettingsManager({
  canManage,
  canApproveBreakGlass,
}: {
  readonly canManage: boolean;
  readonly canApproveBreakGlass: boolean;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <SeparationOfDuties canManage={canManage} onOutcome={setOutcome} />
      {canApproveBreakGlass ? <BreakGlassApprovals onOutcome={setOutcome} /> : null}
    </>
  );
}

function SeparationOfDuties({
  canManage,
  onOutcome,
}: {
  readonly canManage: boolean;
  readonly onOutcome: (o: Outcome) => void;
}) {
  const { state, reload } = useLoad(async () => (await callRoute(tenantSettingsRoute)).data);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const allowed = new FormData(event.currentTarget).get('self-approval') === 'on';
    setBusy(true);
    try {
      await callRoute(tenantSettingsUpdateRoute, { body: { selfApprovalAllowed: allowed } });
      onOutcome(
        success(
          'Setting saved',
          allowed
            ? 'People may now approve their own work. This change was recorded in the audit trail.'
            : 'People may not approve their own work. This change was recorded in the audit trail.',
        ),
      );
      await reload();
    } catch (error) {
      onOutcome(failure('Setting not saved', error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="sod-heading">
      <h2 id="sod-heading">Separation of duties</h2>
      <p>
        By default nobody may approve their own work. The rule is applied when approvals arrive
        (datasets and results); it is stored and audited now.
      </p>
      {state.status === 'loading' ? <LoadingState label="Loading settings…" /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Settings could not be loaded" message={adminErrorMessage(state.error)} />
      ) : null}
      {state.status === 'ready' ? (
        canManage ? (
          <form noValidate onSubmit={onSubmit} aria-labelledby="sod-heading">
            <Checkbox
              key={String(state.data.selfApprovalAllowed)}
              id="self-approval"
              label="Allow people to approve their own work"
              hint="Not recommended. Leave unticked unless your quality procedures say otherwise."
              defaultChecked={state.data.selfApprovalAllowed}
            />
            <Button type="submit" disabled={busy}>
              Save setting
            </Button>
          </form>
        ) : (
          <p>
            Self-approval:{' '}
            <strong>{state.data.selfApprovalAllowed ? 'allowed' : 'not allowed'}</strong>
          </p>
        )
      ) : null}
    </section>
  );
}

const GRANT_TONE: Record<string, Tone> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'neutral',
  revoked: 'neutral',
  expired: 'neutral',
};
const GRANT_TEXT: Record<string, string> = {
  requested: 'Awaiting decision',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
  expired: 'Expired',
};

function BreakGlassApprovals({ onOutcome }: { readonly onOutcome: (o: Outcome) => void }) {
  const { state, reload } = useLoad(
    async () => (await callRoute(tenantBreakGlassListRoute)).data.grants,
  );
  const [busy, setBusy] = useState(false);

  async function act(title: string, run: () => Promise<Outcome>) {
    setBusy(true);
    try {
      onOutcome(await run());
      await reload();
    } catch (error) {
      onOutcome(failure(title, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="bg-heading">
      <h2 id="bg-heading">Break-glass requests</h2>
      <p>
        The platform owner has no access to your organisation&apos;s data. In an emergency they can
        ask for <strong>read-only</strong> access for a stated purpose. If you approve, access lasts
        at most one hour, is never renewed automatically, and every view is recorded. You can revoke
        it at any time.
      </p>
      {state.status === 'error' ? (
        <ErrorState title="Requests could not be loaded" message={adminErrorMessage(state.error)} />
      ) : (
        <DataTable
          id="break-glass"
          caption="Break-glass requests for this organisation"
          loading={state.status === 'loading'}
          emptyMessage="No requests."
          rows={state.status === 'ready' ? state.data : []}
          rowKey={(g) => g.id}
          columns={[
            { key: 'purpose', header: 'Stated purpose', cell: (g) => g.purpose },
            {
              key: 'status',
              header: 'Status',
              cell: (g) => (
                <StatusLabel
                  tone={GRANT_TONE[g.status] ?? 'neutral'}
                  text={GRANT_TEXT[g.status] ?? g.status}
                />
              ),
            },
            { key: 'requested', header: 'Requested', cell: (g) => formatUtc(g.requestedAt) },
            { key: 'expires', header: 'Access ends', cell: (g) => formatUtc(g.expiresAt) },
            {
              key: 'actions',
              header: 'Actions',
              cell: (g) =>
                g.status === 'requested' ? (
                  <div className={styles.actions}>
                    <ConfirmButton
                      label="Approve request"
                      question="Approve one hour of read-only access for this purpose?"
                      confirmLabel="Yes, approve"
                      disabled={busy}
                      onConfirm={() =>
                        act('Request not approved', async () => {
                          await callRoute(tenantBreakGlassDecisionRoute, {
                            params: { grantId: g.id },
                            body: { decision: 'approve' },
                          });
                          return success(
                            'Request approved',
                            'Read-only access for at most one hour.',
                          );
                        })
                      }
                    />
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act('Request not rejected', async () => {
                          await callRoute(tenantBreakGlassDecisionRoute, {
                            params: { grantId: g.id },
                            body: { decision: 'reject' },
                          });
                          return success('Request rejected', 'No access was given.');
                        })
                      }
                    >
                      Reject request
                    </Button>
                  </div>
                ) : g.status === 'approved' ? (
                  <ConfirmButton
                    label="Revoke access"
                    question="Revoke this access now?"
                    confirmLabel="Yes, revoke"
                    disabled={busy}
                    onConfirm={() =>
                      act('Access not revoked', async () => {
                        await callRoute(tenantBreakGlassRevokeRoute, { params: { grantId: g.id } });
                        return success('Access revoked', 'The access ended immediately.');
                      })
                    }
                  />
                ) : (
                  <span className={styles.muted}>None</span>
                ),
            },
          ]}
        />
      )}
    </section>
  );
}
