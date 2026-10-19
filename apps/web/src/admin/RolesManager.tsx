'use client';

import {
  tenantPermissionsRoute,
  tenantRoleCreateRoute,
  tenantRoleDeleteRoute,
  tenantRolesRoute,
  tenantRoleUpdateRoute,
} from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, StatusLabel } from '../ui/feedback';
import { Button, CheckboxGroup, RequiredFieldsNote, TextArea, TextInput } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly templateKey: string | null;
  readonly permissions: readonly string[];
  readonly memberCount: number;
}
interface CatalogueEntry {
  readonly code: string;
  readonly description: string;
  readonly readOnly: boolean;
}

/**
 * Configurable roles (F-4, ADR-029): a role is a named bundle of permissions from the fixed
 * catalogue. Template roles are only a starting point and can be renamed or changed; names
 * carry no power. The API refuses permissions the editor does not hold and any change that
 * would leave no one able to manage roles.
 */
export function RolesManager({ canManage }: { readonly canManage: boolean }) {
  const { state, reload } = useLoad(async () => {
    const [roles, catalogue] = await Promise.all([
      callRoute(tenantRolesRoute),
      callRoute(tenantPermissionsRoute),
    ]);
    return {
      roles: roles.data.roles as readonly Role[],
      catalogue: catalogue.data.permissions as readonly CatalogueEntry[],
    };
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (state.status === 'error') {
    return (
      <ErrorState title="Roles could not be loaded" message={adminErrorMessage(state.error)} />
    );
  }
  const data = state.status === 'ready' ? state.data : null;
  const describe = (code: string) =>
    data?.catalogue.find((c) => c.code === code)?.description ?? code;
  const editing = data?.roles.find((r) => r.id === editingId) ?? null;
  const done = async (o: Outcome) => {
    setOutcome(o);
    if (o.tone === 'success') setEditingId(null);
    await reload();
  };

  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <DataTable
        id="roles"
        caption="Roles in this organisation"
        loading={data === null}
        emptyMessage="No roles yet."
        rows={[...(data?.roles ?? [])].sort((a, b) => a.name.localeCompare(b.name))}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'name',
            header: 'Role',
            cell: (r) => (
              <>
                {r.name}{' '}
                {r.templateKey ? <StatusLabel tone="neutral" text="From template" /> : null}
              </>
            ),
          },
          { key: 'description', header: 'Description', cell: (r) => r.description || '—' },
          {
            key: 'permissions',
            header: 'Permissions',
            cell: (r) =>
              r.permissions.length === 0 ? (
                <span className={styles.muted}>None yet</span>
              ) : (
                <ul className={styles.list}>
                  {r.permissions.map((p) => (
                    <li key={p}>{describe(p)}</li>
                  ))}
                </ul>
              ),
          },
          { key: 'members', header: 'Members', cell: (r) => String(r.memberCount) },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  header: 'Actions',
                  cell: (r: Role) => (
                    <Button variant="secondary" onClick={() => setEditingId(r.id)}>
                      {`Edit ${r.name}`}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {canManage && editing && data ? (
        <RoleForm
          key={editing.id}
          mode="edit"
          role={editing}
          catalogue={data.catalogue}
          onCancel={() => setEditingId(null)}
          onDone={done}
        />
      ) : null}
      {canManage && data ? (
        <RoleForm key="new" mode="create" role={null} catalogue={data.catalogue} onDone={done} />
      ) : null}
    </>
  );
}

function RoleForm({
  mode,
  role,
  catalogue,
  onCancel,
  onDone,
}: {
  readonly mode: 'create' | 'edit';
  readonly role: Role | null;
  readonly catalogue: readonly CatalogueEntry[];
  readonly onCancel?: () => void;
  readonly onDone: (o: Outcome) => Promise<void>;
}) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (mode === 'edit') heading.current?.focus();
  }, [mode]);
  const prefix = mode === 'edit' ? 'edit-role' : 'new-role';
  const title = mode === 'edit' ? `Edit ${role?.name ?? 'role'}` : 'Create a role';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get(`${prefix}-name`) ?? '').trim();
    const description = String(data.get(`${prefix}-description`) ?? '').trim();
    const permissions = data.getAll(`${prefix}-permissions`).map(String);
    const found: FieldError[] = [];
    if (name === '' || name.length > 100)
      found.push({ fieldId: `${prefix}-name`, message: 'Enter a name of 1 to 100 characters' });
    if (description.length > 500)
      found.push({
        fieldId: `${prefix}-description`,
        message: 'Use at most 500 characters',
      });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      if (mode === 'edit' && role) {
        await callRoute(tenantRoleUpdateRoute, {
          params: { roleId: role.id },
          body: { name, description, permissions },
        });
        await onDone(success('Role saved', `${name} was updated. It applies at once.`));
      } else {
        await callRoute(tenantRoleCreateRoute, { body: { name, description, permissions } });
        form.reset();
        await onDone(success('Role created', `${name} can now be given to members.`));
      }
    } catch (error) {
      await onDone(failure(mode === 'edit' ? 'Role not saved' : 'Role not created', error));
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <section
      className={mode === 'edit' ? styles.panel : styles.section}
      aria-labelledby={`${prefix}-heading`}
    >
      <h2 id={`${prefix}-heading`} ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <form noValidate onSubmit={onSubmit} aria-labelledby={`${prefix}-heading`}>
        <ErrorSummary errors={errors} />
        <RequiredFieldsNote />
        <TextInput
          id={`${prefix}-name`}
          label="Role name"
          required
          maxLength={100}
          defaultValue={role?.name ?? ''}
          hint="Any name your organisation uses. The name itself gives no access."
          error={errorFor(`${prefix}-name`)}
        />
        <TextArea
          id={`${prefix}-description`}
          label="Description"
          maxLength={500}
          rows={3}
          defaultValue={role?.description ?? ''}
          error={errorFor(`${prefix}-description`)}
        />
        <CheckboxGroup
          id={`${prefix}-permissions`}
          legend="Permissions"
          hint="Only these permissions decide what members with this role can do. You can only give permissions you hold."
          options={catalogue.map((c) => ({
            value: c.code,
            label: c.description,
            hint: `${c.code}${c.readOnly ? ' · view only' : ''}`,
          }))}
          defaultValues={role?.permissions ?? []}
        />
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}>
            {mode === 'edit' ? 'Save role' : 'Create role'}
          </Button>
          {mode === 'edit' && onCancel ? (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
      {mode === 'edit' && role ? (
        <div className={styles.section}>
          <ConfirmButton
            label={`Delete ${role.name}`}
            question={`Delete ${role.name}? ${role.memberCount} member(s) lose its permissions at once.`}
            confirmLabel="Yes, delete role"
            disabled={busy}
            onConfirm={async () => {
              setBusy(true);
              try {
                await callRoute(tenantRoleDeleteRoute, { params: { roleId: role.id } });
                await onDone(success('Role deleted', `${role.name} was deleted.`));
              } catch (error) {
                await onDone(failure('Role not deleted', error));
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
