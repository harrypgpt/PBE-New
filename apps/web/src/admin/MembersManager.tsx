'use client';

import {
  tenantDepartmentsRoute,
  tenantMemberAddRoute,
  tenantMemberDeactivateRoute,
  tenantMemberDepartmentsRoute,
  tenantMemberPasswordResetRoute,
  tenantMemberReactivateRoute,
  tenantMemberRolesRoute,
  tenantMembersRoute,
  tenantRolesRoute,
} from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, StatusLabel } from '../ui/feedback';
import { Button, CheckboxGroup, RequiredFieldsNote, TextInput } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, formatUtc, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

export interface MemberPermissions {
  readonly manage: boolean;
  readonly rolesRead: boolean;
  readonly rolesManage: boolean;
  readonly departmentsRead: boolean;
  readonly departmentsManage: boolean;
}

interface Member {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'active' | 'deactivated';
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
}
interface Named {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Organisation members (F-3, D-5): list, add, deactivate or reactivate, admin-initiated password
 * reset, roles and departments. Controls appear only with the matching permission (presentation
 * only, F-6); the API checks every action again. One-time links go only to the separate delivery
 * channel: administrators never see them (ADR-029).
 */
export function MembersManager({ can }: { readonly can: MemberPermissions }) {
  const { state, reload } = useLoad(async () => {
    const [members, roles, departments] = await Promise.all([
      callRoute(tenantMembersRoute),
      can.rolesRead ? callRoute(tenantRolesRoute) : null,
      can.departmentsRead ? callRoute(tenantDepartmentsRoute) : null,
    ]);
    return {
      members: members.data.members as readonly Member[],
      roles: (roles?.data.roles ?? []) as readonly Named[],
      departments: (departments?.data.departments ?? []) as readonly Named[],
    };
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (state.status === 'error') {
    return (
      <ErrorState title="Members could not be loaded" message={adminErrorMessage(state.error)} />
    );
  }
  const data = state.status === 'ready' ? state.data : null;
  const nameList = (ids: readonly string[], all: readonly Named[], noun: string) => {
    if (ids.length === 0) return <span className={styles.muted}>None</span>;
    if (all.length === 0) return `${ids.length} ${noun}${ids.length === 1 ? '' : 's'}`;
    return ids
      .map((id) => all.find((x) => x.id === id)?.name ?? `Unknown ${noun}`)
      .sort()
      .join(', ');
  };
  const selected = data?.members.find((m) => m.id === selectedId) ?? null;

  return (
    <>
      <OutcomeNotice outcome={outcome} />
      {can.manage ? (
        <AddMemberForm
          onDone={async (o) => {
            setOutcome(o);
            await reload();
          }}
        />
      ) : null}
      <DataTable
        id="members"
        caption="Members of this organisation"
        loading={data === null}
        emptyMessage="No members yet."
        rows={data?.members ?? []}
        rowKey={(m) => m.id}
        columns={[
          { key: 'name', header: 'Name', cell: (m) => m.displayName },
          { key: 'email', header: 'Email', cell: (m) => m.email },
          {
            key: 'status',
            header: 'Status',
            cell: (m) =>
              m.status === 'active' ? (
                <StatusLabel tone="success" text="Active" />
              ) : (
                <StatusLabel tone="neutral" text="Deactivated" />
              ),
          },
          {
            key: 'roles',
            header: 'Roles',
            cell: (m) => nameList(m.roleIds, data?.roles ?? [], 'role'),
          },
          {
            key: 'departments',
            header: 'Departments',
            cell: (m) => nameList(m.departmentIds, data?.departments ?? [], 'department'),
          },
          ...(can.manage || can.rolesManage || can.departmentsManage
            ? [
                {
                  key: 'actions',
                  header: 'Actions',
                  cell: (m: Member) => (
                    <Button variant="secondary" onClick={() => setSelectedId(m.id)}>
                      {`Manage ${m.displayName}`}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {selected && data ? (
        <MemberPanel
          key={selected.id}
          member={selected}
          roles={data.roles}
          departments={data.departments}
          can={can}
          onClose={() => setSelectedId(null)}
          onOutcome={async (o) => {
            setOutcome(o);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function AddMemberForm({ onDone }: { readonly onDone: (o: Outcome) => Promise<void> }) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('member-email') ?? '').trim();
    const displayName = String(data.get('member-name') ?? '').trim();
    const found: FieldError[] = [];
    if (!EMAIL.test(email))
      found.push({
        fieldId: 'member-email',
        message: 'Enter an email address, like name@example.com',
      });
    if (displayName === '' || displayName.length > 100)
      found.push({ fieldId: 'member-name', message: 'Enter a name of 1 to 100 characters' });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      const res = await callRoute(tenantMemberAddRoute, { body: { email, displayName } });
      form.reset();
      await onDone(
        success(
          'Member added',
          `${res.data.member.displayName} is now a member. If this is a new account, a one-time activation link was sent through the separate delivery channel; you never see it. Give them roles below.`,
        ),
      );
    } catch (error) {
      await onDone(failure('Member not added', error));
    } finally {
      setBusy(false);
    }
  }
  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <section className={styles.section} aria-labelledby="add-member-heading">
      <h2 id="add-member-heading">Add a member</h2>
      <form noValidate onSubmit={onSubmit} aria-labelledby="add-member-heading">
        <ErrorSummary errors={errors} />
        <RequiredFieldsNote />
        <TextInput
          id="member-email"
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="off"
          required
          maxLength={254}
          error={errorFor('member-email')}
        />
        <TextInput
          id="member-name"
          label="Name"
          required
          maxLength={100}
          hint="How the person is shown to others in this organisation."
          error={errorFor('member-name')}
        />
        <Button type="submit" disabled={busy}>
          Add member
        </Button>
      </form>
    </section>
  );
}

function MemberPanel({
  member,
  roles,
  departments,
  can,
  onClose,
  onOutcome,
}: {
  readonly member: Member;
  readonly roles: readonly Named[];
  readonly departments: readonly Named[];
  readonly can: MemberPermissions;
  readonly onClose: () => void;
  readonly onOutcome: (o: Outcome) => Promise<void>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => heading.current?.focus(), []);
  const params = { membershipId: member.id };

  async function act(title: string, run: () => Promise<Outcome>) {
    setBusy(true);
    try {
      await onOutcome(await run());
    } catch (error) {
      await onOutcome(failure(title, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="member-panel-heading">
      <h2 id="member-panel-heading" ref={heading} tabIndex={-1}>
        {`Manage ${member.displayName}`}
      </h2>
      <p className={styles.muted}>{member.email}</p>
      {can.manage ? (
        <div className={styles.actions}>
          {member.status === 'active' ? (
            <ConfirmButton
              label={`Deactivate ${member.displayName}`}
              question={`Deactivate ${member.displayName}? They lose access to this organisation at once. Their account and history are kept.`}
              confirmLabel="Yes, deactivate"
              disabled={busy}
              onConfirm={() =>
                act('Member not deactivated', async () => {
                  await callRoute(tenantMemberDeactivateRoute, { params });
                  return success(
                    'Member deactivated',
                    `${member.displayName} no longer has access.`,
                  );
                })
              }
            />
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                void act('Member not reactivated', async () => {
                  await callRoute(tenantMemberReactivateRoute, { params });
                  return success('Member reactivated', `${member.displayName} has access again.`);
                })
              }
            >
              {`Reactivate ${member.displayName}`}
            </Button>
          )}
          <ConfirmButton
            label={`Reset password for ${member.displayName}`}
            question={`Start a password reset for ${member.displayName}? All their sessions end now, and a one-time link is sent through the separate delivery channel.`}
            confirmLabel="Yes, start reset"
            disabled={busy || member.status !== 'active'}
            onConfirm={() =>
              act('Password reset not started', async () => {
                const res = await callRoute(tenantMemberPasswordResetRoute, { params });
                return success(
                  'Password reset started',
                  `A one-time link was sent through the separate delivery channel; you never see it. It expires ${formatUtc(res.data.expiresAt)}.`,
                );
              })
            }
          />
        </div>
      ) : null}
      {can.rolesManage && can.rolesRead ? (
        <AssignForm
          id="member-roles"
          legend="Roles"
          hint="Permissions come from roles. You can only give permissions you hold yourself."
          options={roles}
          selected={member.roleIds}
          submitLabel="Save roles"
          disabled={busy}
          onSave={(ids) =>
            act('Roles not saved', async () => {
              await callRoute(tenantMemberRolesRoute, { params, body: { roleIds: ids } });
              return success('Roles saved', `Roles of ${member.displayName} updated.`);
            })
          }
        />
      ) : null}
      {can.departmentsManage && can.departmentsRead ? (
        <AssignForm
          id="member-departments"
          legend="Departments"
          hint="Departments group people. Project visibility by department starts with projects."
          options={departments}
          selected={member.departmentIds}
          submitLabel="Save departments"
          disabled={busy}
          onSave={(ids) =>
            act('Departments not saved', async () => {
              await callRoute(tenantMemberDepartmentsRoute, {
                params,
                body: { departmentIds: ids },
              });
              return success('Departments saved', `Departments of ${member.displayName} updated.`);
            })
          }
        />
      ) : null}
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    </section>
  );
}

function AssignForm({
  id,
  legend,
  hint,
  options,
  selected,
  submitLabel,
  disabled,
  onSave,
}: {
  readonly id: string;
  readonly legend: string;
  readonly hint: string;
  readonly options: readonly Named[];
  readonly selected: readonly string[];
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly onSave: (ids: string[]) => Promise<void>;
}) {
  return (
    <form
      noValidate
      aria-label={legend}
      onSubmit={(event) => {
        event.preventDefault();
        const ids = new FormData(event.currentTarget).getAll(id).map(String);
        void onSave(ids);
      }}
    >
      <CheckboxGroup
        id={id}
        legend={legend}
        hint={hint}
        options={[...options]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((o) => ({
            value: o.id,
            label: o.name,
            ...(o.description ? { hint: o.description } : {}),
          }))}
        defaultValues={selected}
      />
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
    </form>
  );
}
