'use client';

import {
  platformTenantCreateRoute,
  platformTenantReactivateRoute,
  platformTenantsRoute,
  platformTenantSuspendRoute,
} from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, StatusLabel } from '../ui/feedback';
import { Button, RequiredFieldsNote, TextInput } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, formatUtc, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Organisation registry for the Super Admin (ADR-029): no customer data. Creating an organisation
 * names its FIRST Tenant Administrator (onboarding exception); afterwards only that
 * organisation's administrators manage its people.
 */
export function PlatformOrganisations({ canManage }: { readonly canManage: boolean }) {
  const { state, reload } = useLoad(
    async () => (await callRoute(platformTenantsRoute)).data.tenants,
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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

  if (state.status === 'error') {
    return (
      <ErrorState
        title="Organisations could not be loaded"
        message={adminErrorMessage(state.error)}
      />
    );
  }
  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <DataTable
        id="organisations"
        caption="All organisations"
        loading={state.status === 'loading'}
        emptyMessage="No organisations yet."
        rows={state.status === 'ready' ? state.data : []}
        rowKey={(t) => t.id}
        columns={[
          { key: 'name', header: 'Organisation', cell: (t) => t.displayName },
          { key: 'slug', header: 'Short name', cell: (t) => t.slug },
          {
            key: 'status',
            header: 'Status',
            cell: (t) =>
              t.status === 'active' ? (
                <StatusLabel tone="success" text="Active" />
              ) : (
                <StatusLabel tone="warning" text="Suspended" />
              ),
          },
          { key: 'created', header: 'Created', cell: (t) => formatUtc(t.createdAt) },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  header: 'Actions',
                  cell: (t: { id: string; displayName: string; status: string }) =>
                    t.status === 'active' ? (
                      <ConfirmButton
                        label={`Suspend ${t.displayName}`}
                        question={`Suspend ${t.displayName}? Its members lose access at their next request.`}
                        confirmLabel="Yes, suspend"
                        disabled={busy}
                        onConfirm={() =>
                          act('Organisation not suspended', async () => {
                            await callRoute(platformTenantSuspendRoute, {
                              params: { tenantId: t.id },
                            });
                            return success(
                              'Organisation suspended',
                              `${t.displayName} is suspended.`,
                            );
                          })
                        }
                      />
                    ) : (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act('Organisation not reactivated', async () => {
                            await callRoute(platformTenantReactivateRoute, {
                              params: { tenantId: t.id },
                            });
                            return success(
                              'Organisation reactivated',
                              `${t.displayName} is active again.`,
                            );
                          })
                        }
                      >
                        {`Reactivate ${t.displayName}`}
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      {canManage ? (
        <CreateOrganisationForm
          onDone={async (o) => {
            setOutcome(o);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function CreateOrganisationForm({ onDone }: { readonly onDone: (o: Outcome) => Promise<void> }) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const displayName = String(data.get('org-name') ?? '').trim();
    const slug = String(data.get('org-slug') ?? '').trim();
    const email = String(data.get('admin-email') ?? '').trim();
    const adminName = String(data.get('admin-name') ?? '').trim();
    const found: FieldError[] = [];
    if (displayName === '' || displayName.length > 200)
      found.push({ fieldId: 'org-name', message: 'Enter a name of 1 to 200 characters' });
    if (!SLUG.test(slug))
      found.push({
        fieldId: 'org-slug',
        message:
          'Use 2 to 63 lower-case letters, digits or hyphens, starting with a letter or digit',
      });
    if (!EMAIL.test(email))
      found.push({
        fieldId: 'admin-email',
        message: 'Enter an email address, like name@example.com',
      });
    if (adminName === '' || adminName.length > 100)
      found.push({ fieldId: 'admin-name', message: 'Enter a name of 1 to 100 characters' });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      await callRoute(platformTenantCreateRoute, {
        body: { slug, displayName, firstAdmin: { email, displayName: adminName } },
      });
      form.reset();
      await onDone(
        success(
          'Organisation created',
          `${displayName} was created. ${adminName} is its first Tenant Administrator; if this is a new account, a one-time activation link was sent through the separate delivery channel.`,
        ),
      );
    } catch (error) {
      await onDone(failure('Organisation not created', error));
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <section className={styles.section} aria-labelledby="create-org-heading">
      <h2 id="create-org-heading">Create an organisation</h2>
      <p>
        You name its first Tenant Administrator. After that, only the organisation&apos;s own
        administrators manage its members; you have no access to its data.
      </p>
      <form noValidate onSubmit={onSubmit} aria-labelledby="create-org-heading">
        <ErrorSummary errors={errors} />
        <RequiredFieldsNote />
        <TextInput
          id="org-name"
          label="Organisation name"
          required
          maxLength={200}
          error={errorFor('org-name')}
        />
        <TextInput
          id="org-slug"
          label="Short name"
          required
          maxLength={63}
          hint="Lower-case letters, digits and hyphens, for example acme-pharma. Cannot be changed later."
          error={errorFor('org-slug')}
        />
        <TextInput
          id="admin-email"
          label="First administrator's email address"
          type="email"
          inputMode="email"
          required
          maxLength={254}
          error={errorFor('admin-email')}
        />
        <TextInput
          id="admin-name"
          label="First administrator's name"
          required
          maxLength={100}
          error={errorFor('admin-name')}
        />
        <Button type="submit" disabled={busy}>
          Create organisation
        </Button>
      </form>
    </section>
  );
}
