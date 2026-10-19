'use client';

import {
  projectArchiveRoute,
  projectGetRoute,
  scenarioCreateRoute,
  scenarioUpdateRoute,
  tenantDepartmentsRoute,
  type ProjectDetailDto,
  type ScenarioDto,
} from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import adminStyles from '../admin/admin.module.css';
import { ConfirmButton } from '../admin/ConfirmButton';
import { adminErrorMessage, failure, formatUtc, success, type Outcome } from '../admin/messages';
import { OutcomeNotice } from '../admin/OutcomeNotice';
import { useLoad } from '../admin/useLoad';
import { DataTable } from '../ui/DataTable';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, LoadingState, Notice } from '../ui/feedback';
import { Button, TextArea } from '../ui/forms';
import {
  dosageFormLabel,
  formatStrength,
  productFlagLabel,
  releaseTypeLabel,
  routeLabel,
} from './labels';
import styles from './projects.module.css';
import { ProjectStatus, ScopeBadge } from './ScopeBadge';

export interface ProjectAbilities {
  readonly manage: boolean;
  readonly scenarios: boolean;
  readonly departments: boolean;
}

/**
 * One project (STAGE-08-PLAN.md §5): details, scope with its reason, status, scenarios. Buttons
 * are shown only to people who may use them and only while the project is active; the API and
 * the database refuse the same actions in any case (F-6, D8-8).
 */
export function ProjectDetail({
  projectId,
  can,
  justCreated = false,
}: {
  readonly projectId: string;
  readonly can: ProjectAbilities;
  readonly justCreated?: boolean;
}) {
  const { state, reload } = useLoad(
    async () =>
      (await callRoute(projectGetRoute, { params: { projectId } })).data
        .project as ProjectDetailDto,
  );
  const departments = useLoad(async () =>
    can.departments
      ? ((await callRoute(tenantDepartmentsRoute)).data.departments as ReadonlyArray<{
          id: string;
          name: string;
        }>)
      : [],
  );
  const [outcome, setOutcome] = useState<Outcome | null>(
    justCreated ? success('Project created', 'The project was saved.') : null,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'error') {
    return (
      <ErrorState
        title="The project could not be loaded"
        message={adminErrorMessage(state.error)}
      />
    );
  }
  if (state.status === 'loading') return <LoadingState label="Loading the project…" />;
  const p = state.data;
  const active = p.status === 'active';
  const done = async (o: Outcome) => {
    setOutcome(o);
    if (o.tone === 'success') setEditing(null);
    await reload();
  };
  const deptNames =
    departments.state.status === 'ready'
      ? p.departmentIds.map(
          (id) =>
            (departments.state.status === 'ready' &&
              departments.state.data.find((d) => d.id === id)?.name) ||
            'Unknown department',
        )
      : null;
  const editingScenario = p.scenarios.find((s) => s.id === editing) ?? null;

  return (
    <>
      <h1>{p.name}</h1>
      <OutcomeNotice outcome={outcome} />
      {!active ? (
        <Notice tone="info" title="This project is archived">
          <p>It stays visible for reference and can no longer be changed.</p>
        </Notice>
      ) : null}
      <section className={adminStyles.section} aria-labelledby="details-heading">
        <h2 id="details-heading">Details</h2>
        <dl className={styles.details}>
          <dt>Status</dt>
          <dd>
            <ProjectStatus status={p.status} />
          </dd>
          <dt>Scope</dt>
          <dd>
            <ScopeBadge status={p.scope.status} reasons={p.scope.reasons} />
          </dd>
          <dt>Molecule</dt>
          <dd>{p.molecule}</dd>
          <dt>Strength</dt>
          <dd>{formatStrength(p.strength)}</dd>
          <dt>Dosage form</dt>
          <dd>{dosageFormLabel(p.dosageForm)}</dd>
          <dt>Route</dt>
          <dd>{routeLabel(p.route)}</dd>
          <dt>Release type</dt>
          <dd>{releaseTypeLabel(p.releaseType)}</dd>
          <dt>Product characteristics</dt>
          <dd>
            {p.productFlags.length ? p.productFlags.map(productFlagLabel).join(', ') : 'None'}
          </dd>
          <dt>Visible to</dt>
          <dd>
            {p.departmentIds.length === 0
              ? 'Everyone in the organisation who can see projects'
              : deptNames
                ? `Members of: ${deptNames.join(', ')}`
                : `Members of ${p.departmentIds.length} department(s)`}
          </dd>
          <dt>Last changed</dt>
          <dd>{formatUtc(p.updatedAt)}</dd>
        </dl>
      </section>

      <section className={adminStyles.section} aria-labelledby="scenarios-heading">
        <h2 id="scenarios-heading">Scenarios</h2>
        <p>
          Each scenario gets a code (F001, F002 …) that is never reused. Evidence is added to
          scenarios in a later release.
        </p>
        <DataTable<ScenarioDto>
          id="scenarios"
          caption={`Scenarios of ${p.name}`}
          emptyMessage="No scenarios yet."
          rows={p.scenarios}
          rowKey={(s) => s.id}
          columns={[
            { key: 'code', header: 'Code', cell: (s) => s.code },
            { key: 'description', header: 'Description', cell: (s) => s.description || '—' },
            { key: 'updated', header: 'Last changed', cell: (s) => formatUtc(s.updatedAt) },
            ...(can.scenarios && active
              ? [
                  {
                    key: 'actions',
                    header: 'Actions',
                    cell: (s: ScenarioDto) => (
                      <Button variant="secondary" onClick={() => setEditing(s.id)}>
                        {`Edit ${s.code}`}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {can.scenarios && active && editingScenario ? (
          <ScenarioForm
            key={editingScenario.id}
            projectId={p.id}
            scenario={editingScenario}
            onCancel={() => setEditing(null)}
            onDone={done}
          />
        ) : null}
        {can.scenarios && active ? (
          <ScenarioForm key="new" projectId={p.id} scenario={null} onDone={done} />
        ) : null}
      </section>

      {can.manage && active ? (
        <section className={adminStyles.section} aria-labelledby="archive-heading">
          <h2 id="archive-heading">Archive</h2>
          <p>
            Archiving keeps the project and its scenarios for reference. Nobody can change them
            afterwards, and this cannot be undone.
          </p>
          <ConfirmButton
            label={`Archive ${p.name}`}
            question={`Archive ${p.name}? It becomes read-only for everyone.`}
            confirmLabel="Yes, archive project"
            disabled={busy}
            onConfirm={async () => {
              setBusy(true);
              try {
                await callRoute(projectArchiveRoute, { params: { projectId: p.id } });
                await done(success('Project archived', `${p.name} is now read-only.`));
              } catch (error) {
                await done(failure('Project not archived', error));
              } finally {
                setBusy(false);
              }
            }}
          />
        </section>
      ) : null}
    </>
  );
}

function ScenarioForm({
  projectId,
  scenario,
  onCancel,
  onDone,
}: {
  readonly projectId: string;
  readonly scenario: ScenarioDto | null;
  readonly onCancel?: () => void;
  readonly onDone: (o: Outcome) => Promise<void>;
}) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const editing = scenario !== null;
  useEffect(() => {
    if (editing) heading.current?.focus();
  }, [editing]);
  const prefix = editing ? 'edit-scenario' : 'new-scenario';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const description = String(new FormData(form).get(`${prefix}-description`) ?? '').trim();
    if (description.length > 500) {
      setErrors([{ fieldId: `${prefix}-description`, message: 'Use at most 500 characters' }]);
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      if (scenario) {
        await callRoute(scenarioUpdateRoute, {
          params: { projectId, scenarioId: scenario.id },
          body: { description },
        });
        await onDone(success('Scenario saved', `${scenario.code} was updated.`));
      } else {
        const r = await callRoute(scenarioCreateRoute, {
          params: { projectId },
          body: { description },
        });
        form.reset();
        await onDone(success('Scenario added', `${r.data.scenario.code} was added.`));
      }
    } catch (error) {
      await onDone(failure(scenario ? 'Scenario not saved' : 'Scenario not added', error));
    } finally {
      setBusy(false);
    }
  }

  const title = scenario ? `Edit ${scenario.code}` : 'Add a scenario';
  return (
    <section
      className={scenario ? adminStyles.panel : adminStyles.section}
      aria-labelledby={`${prefix}-heading`}
    >
      <h3 id={`${prefix}-heading`} ref={heading} tabIndex={-1}>
        {title}
      </h3>
      <form noValidate onSubmit={onSubmit} aria-labelledby={`${prefix}-heading`}>
        <ErrorSummary errors={errors} />
        <TextArea
          id={`${prefix}-description`}
          label="Description"
          {...(scenario ? {} : { hint: 'Optional. The code is given automatically.' })}
          maxLength={500}
          rows={3}
          defaultValue={scenario?.description ?? ''}
          error={errors.find((e) => e.fieldId === `${prefix}-description`)?.message}
        />
        <div className={adminStyles.actions}>
          <Button type="submit" disabled={busy}>
            {scenario ? 'Save scenario' : 'Add scenario'}
          </Button>
          {scenario && onCancel ? (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
