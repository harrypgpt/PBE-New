'use client';

import {
  platformBreakGlassEnterRoute,
  platformBreakGlassListRoute,
  platformBreakGlassRequestRoute,
  platformBreakGlassRevokeRoute,
  platformTenantsRoute,
} from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, StatusLabel, type Tone } from '../ui/feedback';
import { Button, RequiredFieldsNote, Select, TextArea } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, formatUtc, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

const TONE: Record<string, Tone> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'neutral',
  revoked: 'neutral',
  expired: 'neutral',
};
const TEXT: Record<string, string> = {
  requested: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Ended',
  expired: 'Expired',
};

/**
 * Break-glass for the Super Admin (ADR-028): ask an organisation for read-only access with a
 * written purpose; it must be approved by that organisation's administrator, lasts at most one
 * hour, is never renewed and every use is audited in both logs.
 */
export function PlatformBreakGlass({
  navigate = (url: string) => window.location.assign(url),
}: {
  readonly navigate?: (url: string) => void;
}) {
  const { state, reload } = useLoad(async () => {
    const [grants, tenants] = await Promise.all([
      callRoute(platformBreakGlassListRoute),
      callRoute(platformTenantsRoute),
    ]);
    return { grants: grants.data.grants, tenants: tenants.data.tenants };
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  async function act(title: string, run: () => Promise<Outcome>) {
    setBusy(true);
    try {
      setOutcome(await run());
      await reload();
    } catch (error) {
      setOutcome(failure(title, error));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const tenantId = String(data.get('bg-tenant') ?? '');
    const purpose = String(data.get('bg-purpose') ?? '').trim();
    const found: FieldError[] = [];
    if (tenantId === '') found.push({ fieldId: 'bg-tenant', message: 'Choose an organisation' });
    if (purpose.length < 10 || purpose.length > 1000)
      found.push({
        fieldId: 'bg-purpose',
        message: 'Describe the purpose in 10 to 1000 characters',
      });
    setErrors(found);
    if (found.length > 0) return;
    await act('Request not sent', async () => {
      await callRoute(platformBreakGlassRequestRoute, { body: { tenantId, purpose } });
      form.reset();
      return success(
        'Request sent',
        'An administrator of that organisation must approve it before you can use it.',
      );
    });
  }

  if (state.status === 'error') {
    return (
      <ErrorState
        title="Break-glass access could not be loaded"
        message={adminErrorMessage(state.error)}
      />
    );
  }
  const data = state.status === 'ready' ? state.data : null;
  const orgName = (id: string) => data?.tenants.find((t) => t.id === id)?.displayName ?? 'Unknown';
  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;

  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <DataTable
        id="my-break-glass"
        caption="Your break-glass requests"
        loading={data === null}
        emptyMessage="You have no requests."
        rows={data?.grants ?? []}
        rowKey={(g) => g.id}
        columns={[
          { key: 'org', header: 'Organisation', cell: (g) => orgName(g.tenantId) },
          { key: 'purpose', header: 'Stated purpose', cell: (g) => g.purpose },
          {
            key: 'status',
            header: 'Status',
            cell: (g) => (
              <StatusLabel tone={TONE[g.status] ?? 'neutral'} text={TEXT[g.status] ?? g.status} />
            ),
          },
          { key: 'expires', header: 'Access ends', cell: (g) => formatUtc(g.expiresAt) },
          {
            key: 'actions',
            header: 'Actions',
            cell: (g) =>
              g.status === 'approved' || g.status === 'requested' ? (
                <div className={styles.actions}>
                  {g.status === 'approved' ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void (async () => {
                          setBusy(true);
                          try {
                            await callRoute(platformBreakGlassEnterRoute, {
                              params: { grantId: g.id },
                            });
                            navigate('/organisation');
                          } catch (error) {
                            setOutcome(failure('Access not started', error));
                            setBusy(false);
                          }
                        })()
                      }
                    >
                      {`Start read-only access to ${orgName(g.tenantId)}`}
                    </Button>
                  ) : null}
                  <ConfirmButton
                    label={g.status === 'approved' ? 'End this access' : 'Withdraw request'}
                    question="End this request or access now? It cannot be resumed."
                    confirmLabel="Yes, end it"
                    disabled={busy}
                    onConfirm={() =>
                      act('Not ended', async () => {
                        await callRoute(platformBreakGlassRevokeRoute, {
                          params: { grantId: g.id },
                        });
                        return success('Ended', 'The request or access has ended.');
                      })
                    }
                  />
                </div>
              ) : (
                <span className={styles.muted}>None</span>
              ),
          },
        ]}
      />
      <section className={styles.section} aria-labelledby="bg-request-heading">
        <h2 id="bg-request-heading">Request read-only access</h2>
        <p>
          Use only in an emergency. The organisation&apos;s administrator sees your purpose and
          decides. Access is read-only, lasts at most one hour and every view is recorded.
        </p>
        <form noValidate onSubmit={onSubmit} aria-labelledby="bg-request-heading">
          <ErrorSummary errors={errors} />
          <RequiredFieldsNote />
          <Select
            id="bg-tenant"
            label="Organisation"
            required
            placeholder="Choose an organisation…"
            options={(data?.tenants ?? [])
              .filter((t) => t.status === 'active')
              .map((t) => ({ value: t.id, label: t.displayName }))}
            error={errorFor('bg-tenant')}
          />
          <TextArea
            id="bg-purpose"
            label="Purpose"
            required
            maxLength={1000}
            hint="Why you need access, specifically. At least 10 characters."
            error={errorFor('bg-purpose')}
          />
          <Button type="submit" disabled={busy}>
            Send request
          </Button>
        </form>
      </section>
    </>
  );
}
