'use client';

import {
  DOSAGE_FORMS,
  PRODUCT_FLAGS,
  projectCreateRoute,
  projectScopeCheckRoute,
  ProjectWriteSchema,
  RELEASE_TYPES,
  ROUTES,
  STRENGTH_UNITS,
  tenantDepartmentsRoute,
  VOCABULARY_STATUS,
  type ProjectWrite,
  type ScopeResultDto,
} from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { adminErrorMessage, failure, type Outcome } from '../admin/messages';
import { OutcomeNotice } from '../admin/OutcomeNotice';
import { useLoad } from '../admin/useLoad';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { LoadingState } from '../ui/feedback';
import {
  Button,
  CheckboxGroup,
  NumberInput,
  RequiredFieldsNote,
  Select,
  TextInput,
} from '../ui/forms';
import { StepProgress } from '../ui/progress';
import adminStyles from '../admin/admin.module.css';
import {
  dosageFormLabel,
  formatStrength,
  options,
  productFlagLabel,
  releaseTypeLabel,
  routeLabel,
} from './labels';
import styles from './projects.module.css';
import { ScopeBadge } from './ScopeBadge';

const STEPS = ['Product details', 'Review and create'];

/** Field ids, and the message shown when the value is missing or not valid. */
const FIELDS = {
  name: ['project-name', 'Enter a project name of 1 to 200 characters'],
  molecule: ['project-molecule', 'Enter the molecule (1 to 200 characters)'],
  'strength.value': ['project-strength-value', 'Enter a strength greater than 0'],
  'strength.unit': ['project-strength-unit', 'Choose the strength unit'],
  dosageForm: ['project-dosage-form', 'Choose a dosage form'],
  route: ['project-route', 'Choose a route'],
  releaseType: ['project-release-type', 'Choose a release type'],
  productFlags: ['project-flags', 'Choose each characteristic at most once'],
  departmentIds: ['project-departments', 'Choose departments from the list'],
} as const;

interface Department {
  readonly id: string;
  readonly name: string;
}

function readForm(form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  const text = (k: string) => String(data.get(k) ?? '').trim();
  const strength = text('project-strength-value');
  return {
    name: text('project-name'),
    molecule: text('project-molecule'),
    strength: {
      value: strength === '' ? Number.NaN : Number(strength),
      unit: text('project-strength-unit'),
    },
    dosageForm: text('project-dosage-form'),
    route: text('project-route'),
    releaseType: text('project-release-type'),
    productFlags: data.getAll('project-flags').map(String),
    departmentIds: data.getAll('project-departments').map(String),
  };
}

/**
 * Project wizard (STAGE-08-PLAN.md §5): product details with a LIVE scope check by the API,
 * then review and create. Every term comes from the shared controlled vocabulary. An
 * unsupported product may still be recorded; it is marked and shows why (ADR-011).
 */
export function ProjectWizard({
  canChooseDepartments,
  onCreated = (id) => window.location.assign(`/projects/${id}?created=1`),
}: {
  readonly canChooseDepartments: boolean;
  /** Where to go after creation (default: the new project's page). */
  readonly onCreated?: (projectId: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProjectWrite | null>(null);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [scope, setScope] = useState<ScopeResultDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const latest = useRef(0);
  const departments = useLoad(async () =>
    canChooseDepartments
      ? ((await callRoute(tenantDepartmentsRoute)).data.departments as readonly Department[])
      : [],
  );

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  /** Asks the API whether the chosen terms are in scope; only the newest answer is shown. */
  async function checkScope(form: HTMLFormElement) {
    const v = readForm(form);
    const ticket = ++latest.current;
    if (!v.dosageForm || !v.route || !v.releaseType) {
      setScope(null);
      return;
    }
    setChecking(true);
    try {
      const r = await callRoute(projectScopeCheckRoute, {
        body: {
          dosageForm: v.dosageForm,
          route: v.route,
          releaseType: v.releaseType,
          productFlags: v.productFlags,
        },
      });
      if (ticket === latest.current) setScope(r.data);
    } catch {
      if (ticket === latest.current) setScope(null);
    } finally {
      if (ticket === latest.current) setChecking(false);
    }
  }

  function onContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ProjectWriteSchema.safeParse(readForm(event.currentTarget));
    if (!parsed.success) {
      const found = new Map<string, FieldError>();
      for (const issue of parsed.error.issues) {
        const key = issue.path.slice(0, 2).join('.');
        const field =
          FIELDS[key as keyof typeof FIELDS] ??
          FIELDS[String(issue.path[0]) as keyof typeof FIELDS];
        if (field && !found.has(field[0]))
          found.set(field[0], { fieldId: field[0], message: field[1] });
      }
      setErrors([...found.values()]);
      return;
    }
    setErrors([]);
    setDraft(parsed.data);
    setStep(1);
  }

  async function onCreate() {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await callRoute(projectCreateRoute, { body: draft });
      onCreated(r.data.project.id);
    } catch (error) {
      setOutcome(failure('Project not created', error));
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  const departmentList = departments.state.status === 'ready' ? departments.state.data : [];
  const scopePanel = (
    <section className={styles.live} aria-labelledby="scope-heading">
      <h2 id="scope-heading">Supported scope</h2>
      <div aria-live="polite">
        {checking ? (
          <LoadingState label="Checking the scope…" />
        ) : scope ? (
          <ScopeBadge
            status={scope.status}
            reasons={scope.reasons}
            awaitingReviewer={scope.awaitingReviewer}
          />
        ) : (
          <p className={styles.muted}>
            Choose a dosage form, route and release type to see whether the product is within the
            supported scope.
          </p>
        )}
      </div>
      {scope?.status === 'unsupported' ? (
        <p>
          You can still record this project. It will be marked as outside the supported scope, and
          assessments will not be run for it.
        </p>
      ) : null}
      {VOCABULARY_STATUS === 'draft-pending-reviewer-confirmation' ? (
        <p className={styles.muted}>
          The list of terms is a draft awaiting confirmation by the scientific reviewer.
        </p>
      ) : null}
    </section>
  );

  if (step === 1 && draft) {
    const names = draft.departmentIds.map(
      (id) => departmentList.find((d) => d.id === id)?.name ?? 'Unknown department',
    );
    return (
      <>
        <StepProgress label="Project creation steps" steps={STEPS} current={1} />
        <h2 ref={heading} tabIndex={-1}>
          Review and create
        </h2>
        <OutcomeNotice outcome={outcome} />
        <dl className={styles.details}>
          <dt>Project name</dt>
          <dd>{draft.name}</dd>
          <dt>Molecule</dt>
          <dd>{draft.molecule}</dd>
          <dt>Strength</dt>
          <dd>{formatStrength(draft.strength)}</dd>
          <dt>Dosage form</dt>
          <dd>{dosageFormLabel(draft.dosageForm)}</dd>
          <dt>Route</dt>
          <dd>{routeLabel(draft.route)}</dd>
          <dt>Release type</dt>
          <dd>{releaseTypeLabel(draft.releaseType)}</dd>
          <dt>Product characteristics</dt>
          <dd>
            {draft.productFlags.length
              ? draft.productFlags.map(productFlagLabel).join(', ')
              : 'None'}
          </dd>
          <dt>Visible to</dt>
          <dd>
            {names.length
              ? `Members of: ${names.join(', ')}`
              : 'Everyone in the organisation who can see projects'}
          </dd>
        </dl>
        {scopePanel}
        <div className={adminStyles.actions}>
          <Button onClick={() => void onCreate()} disabled={busy}>
            Create project
          </Button>
          <Button variant="secondary" onClick={() => setStep(0)} disabled={busy}>
            Back to details
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <StepProgress label="Project creation steps" steps={STEPS} current={0} />
      <h2 ref={heading} tabIndex={-1}>
        Product details
      </h2>
      <form
        noValidate
        onSubmit={onContinue}
        onChange={(e) => void checkScope(e.currentTarget)}
        aria-label="Product details"
      >
        <ErrorSummary errors={errors} />
        <RequiredFieldsNote />
        <TextInput
          id="project-name"
          label="Project name"
          required
          maxLength={200}
          hint="A name your colleagues will recognise, e.g. the product and purpose."
          defaultValue={draft?.name ?? ''}
          error={errorFor('project-name')}
        />
        <TextInput
          id="project-molecule"
          label="Molecule"
          required
          maxLength={200}
          defaultValue={draft?.molecule ?? ''}
          error={errorFor('project-molecule')}
        />
        <NumberInput
          id="project-strength-value"
          label="Strength"
          required
          min={0}
          step="any"
          {...(draft ? { defaultValue: draft.strength.value } : {})}
          error={errorFor('project-strength-value')}
        />
        <Select
          id="project-strength-unit"
          label="Strength unit"
          required
          options={STRENGTH_UNITS.map((u) => ({ value: u, label: u }))}
          defaultValue={draft?.strength.unit ?? 'mg'}
          error={errorFor('project-strength-unit')}
        />
        <Select
          id="project-dosage-form"
          label="Dosage form"
          required
          options={options(DOSAGE_FORMS)}
          defaultValue={draft?.dosageForm ?? ''}
          error={errorFor('project-dosage-form')}
        />
        <Select
          id="project-route"
          label="Route"
          required
          options={options(ROUTES)}
          defaultValue={draft?.route ?? ''}
          error={errorFor('project-route')}
        />
        <Select
          id="project-release-type"
          label="Release type"
          required
          options={options(RELEASE_TYPES)}
          defaultValue={draft?.releaseType ?? ''}
          error={errorFor('project-release-type')}
        />
        <CheckboxGroup
          id="project-flags"
          legend="Product characteristics"
          hint="Tick any that apply. Leave all unticked if none apply."
          options={options(PRODUCT_FLAGS)}
          defaultValues={draft?.productFlags ?? []}
          error={errorFor('project-flags')}
        />
        {canChooseDepartments ? (
          departments.state.status === 'error' ? (
            <p>{`Departments could not be loaded: ${adminErrorMessage(departments.state.error)}`}</p>
          ) : (
            <CheckboxGroup
              id="project-departments"
              legend="Who can see this project"
              hint="Leave all unticked so everyone in the organisation who can see projects sees it. If you tick departments, only their members (and people allowed to see all projects) will see it; you must belong to one of them."
              options={departmentList.map((d) => ({ value: d.id, label: d.name }))}
              defaultValues={draft?.departmentIds ?? []}
              error={errorFor('project-departments')}
            />
          )
        ) : null}
        {scopePanel}
        <div className={adminStyles.actions}>
          <Button type="submit">Continue to review</Button>
        </div>
      </form>
    </>
  );
}
