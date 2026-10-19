'use client';

import {
  tenantDepartmentCreateRoute,
  tenantDepartmentDeleteRoute,
  tenantDepartmentsRoute,
  tenantDepartmentUpdateRoute,
} from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState } from '../ui/feedback';
import { Button, RequiredFieldsNote, TextArea, TextInput } from '../ui/forms';
import styles from './admin.module.css';
import { ConfirmButton } from './ConfirmButton';
import { adminErrorMessage, failure, success, type Outcome } from './messages';
import { OutcomeNotice } from './OutcomeNotice';
import { useLoad } from './useLoad';

interface Department {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
}

/**
 * Departments (F-4): editable per organisation; new organisations start from a default list
 * that is only a template. Department-based project visibility applies once projects exist.
 */
export function DepartmentsManager({ canManage }: { readonly canManage: boolean }) {
  const { state, reload } = useLoad(
    async () => (await callRoute(tenantDepartmentsRoute)).data.departments as readonly Department[],
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (state.status === 'error') {
    return (
      <ErrorState
        title="Departments could not be loaded"
        message={adminErrorMessage(state.error)}
      />
    );
  }
  const rows = state.status === 'ready' ? state.data : null;
  const editing = rows?.find((d) => d.id === editingId) ?? null;
  const done = async (o: Outcome) => {
    setOutcome(o);
    if (o.tone === 'success') setEditingId(null);
    await reload();
  };

  return (
    <>
      <OutcomeNotice outcome={outcome} />
      <DataTable
        id="departments"
        caption="Departments in this organisation"
        loading={rows === null}
        emptyMessage="No departments yet."
        rows={[...(rows ?? [])].sort((a, b) => a.name.localeCompare(b.name))}
        rowKey={(d) => d.id}
        columns={[
          { key: 'name', header: 'Department', cell: (d) => d.name },
          { key: 'description', header: 'Description', cell: (d) => d.description || '—' },
          { key: 'members', header: 'Members', cell: (d) => String(d.memberCount) },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  header: 'Actions',
                  cell: (d: Department) => (
                    <Button variant="secondary" onClick={() => setEditingId(d.id)}>
                      {`Edit ${d.name}`}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {canManage && editing ? (
        <DepartmentForm
          key={editing.id}
          department={editing}
          onCancel={() => setEditingId(null)}
          onDone={done}
        />
      ) : null}
      {canManage ? <DepartmentForm key="new" department={null} onDone={done} /> : null}
    </>
  );
}

function DepartmentForm({
  department,
  onCancel,
  onDone,
}: {
  readonly department: Department | null;
  readonly onCancel?: () => void;
  readonly onDone: (o: Outcome) => Promise<void>;
}) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const editing = department !== null;
  useEffect(() => {
    if (editing) heading.current?.focus();
  }, [editing]);
  const prefix = editing ? 'edit-department' : 'new-department';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get(`${prefix}-name`) ?? '').trim();
    const description = String(data.get(`${prefix}-description`) ?? '').trim();
    const found: FieldError[] = [];
    if (name === '' || name.length > 100)
      found.push({ fieldId: `${prefix}-name`, message: 'Enter a name of 1 to 100 characters' });
    if (description.length > 500)
      found.push({ fieldId: `${prefix}-description`, message: 'Use at most 500 characters' });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      if (department) {
        await callRoute(tenantDepartmentUpdateRoute, {
          params: { departmentId: department.id },
          body: { name, description },
        });
        await onDone(success('Department saved', `${name} was updated.`));
      } else {
        await callRoute(tenantDepartmentCreateRoute, { body: { name, description } });
        form.reset();
        await onDone(success('Department created', `${name} was added.`));
      }
    } catch (error) {
      await onDone(failure(department ? 'Department not saved' : 'Department not created', error));
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  const title = department ? `Edit ${department.name}` : 'Add a department';
  return (
    <section
      className={department ? styles.panel : styles.section}
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
          label="Department name"
          required
          maxLength={100}
          defaultValue={department?.name ?? ''}
          error={errorFor(`${prefix}-name`)}
        />
        <TextArea
          id={`${prefix}-description`}
          label="Description"
          maxLength={500}
          rows={3}
          defaultValue={department?.description ?? ''}
          error={errorFor(`${prefix}-description`)}
        />
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}>
            {department ? 'Save department' : 'Add department'}
          </Button>
          {department && onCancel ? (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
      {department ? (
        <div className={styles.section}>
          <ConfirmButton
            label={`Delete ${department.name}`}
            question={`Delete ${department.name}? ${department.memberCount} member(s) are removed from it.`}
            confirmLabel="Yes, delete department"
            disabled={busy}
            onConfirm={async () => {
              setBusy(true);
              try {
                await callRoute(tenantDepartmentDeleteRoute, {
                  params: { departmentId: department.id },
                });
                await onDone(success('Department deleted', `${department.name} was deleted.`));
              } catch (error) {
                await onDone(failure('Department not deleted', error));
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
