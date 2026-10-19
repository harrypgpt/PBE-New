import type {
  ProjectDetailDto,
  ProjectDto,
  ProjectWrite,
  ScenarioDto,
  ScopeResultDto,
} from '@pbe/contracts';
import { ProblemException } from '../../common/problem';
import type { RequestContext } from '../auth/auth.service';
import {
  projects,
  tenancy,
  withTenantTransaction,
  type Database,
  type ProjectRow,
  type ProjectValues,
  type ScenarioRow,
  type Tx,
} from '../db';
import type { AccessContext } from '../tenancy/access';
import { digest } from '../tenancy/tenancy.service';
import { formatScenarioCode } from './scenario-code';
import { checkScope, type ScopeInput } from './scope';

/**
 * Stage 8 business rules (STAGE-08-PLAN.md D8-3 to D8-8; ADR-030):
 *  - the scope status is computed HERE from the controlled vocabulary on every create and change,
 *    and stored with the vocabulary version; an unsupported product is recorded and marked;
 *  - department visibility (D8-6) is enforced by PostgreSQL; the API adds one rule: whoever sets
 *    a project's departments must stay able to see it (member of one of them, or
 *    tenant.allprojects.read), so nobody hides a project from themselves by mistake;
 *  - scenario codes come from the project's counter under a row lock (D8-7);
 *  - an archived project is read-only (D8-8), checked under the row lock and again by a trigger;
 *  - every change writes its audit row in the SAME transaction; a refused change writes none.
 */

export const ALL_PROJECTS_PERMISSION = 'tenant.allprojects.read';

const notFound = () => new ProblemException(404, 'NOT_FOUND', 'Not found');
const unavailable = () =>
  new ProblemException(404, 'NOT_FOUND', 'Not available', {
    detail: 'Projects are not available on this database yet.',
    internal: 'projects schema (migration 0006) not applied',
  });
const archived = () =>
  new ProblemException(409, 'CONFLICT', 'Project archived', {
    detail: 'This project is archived and can no longer be changed.',
  });
const invalid = (detail: string, path: string) =>
  new ProblemException(400, 'VALIDATION_FAILED', 'Request not accepted', {
    detail,
    errors: [{ path, message: detail }],
  });
const denied = (detail: string) =>
  new ProblemException(403, 'ACCESS_DENIED', 'Access denied', { detail });

/** The archive trigger of migration 0006 (defence in depth behind the check under the lock). */
const isArchivedRefusal = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { hint?: unknown }).hint === 'pbe:project_archived';

const iso = (d: Date) => d.toISOString();

export const scenarioDto = (s: ScenarioRow): ScenarioDto => ({
  id: s.id,
  code: s.code,
  description: s.description,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

export const projectDto = (p: ProjectRow): ProjectDto => ({
  id: p.id,
  name: p.name,
  molecule: p.molecule,
  strength: { value: p.strengthValue, unit: p.strengthUnit },
  dosageForm: p.dosageForm,
  route: p.route,
  releaseType: p.releaseType,
  productFlags: p.productFlags,
  scope: {
    status: p.scopeStatus,
    reasons: p.scopeReasons,
    vocabularyVersion: p.scopeVocabularyVersion,
  },
  status: p.status,
  departmentIds: p.departmentIds,
  scenarioCount: p.scenarioCount,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

const scopeInput = (w: ProjectWrite): ScopeInput => ({
  dosageForm: w.dosageForm,
  route: w.route,
  releaseType: w.releaseType,
  productFlags: w.productFlags,
});

function values(w: ProjectWrite): ProjectValues {
  const scope = checkScope(scopeInput(w));
  return {
    name: w.name,
    molecule: w.molecule,
    strengthValue: w.strength.value,
    strengthUnit: w.strength.unit,
    dosageForm: w.dosageForm,
    route: w.route,
    releaseType: w.releaseType,
    productFlags: [...new Set(w.productFlags)],
    scopeStatus: scope.status,
    scopeReasons: [...scope.reasons],
    scopeVocabularyVersion: scope.vocabularyVersion,
  };
}

type Member = Extract<AccessContext, { kind: 'member' }>;

export class ProjectsService {
  constructor(
    private readonly db: Database,
    /** True when the database is at the projects schema profile (migration 0006). */
    private readonly available: boolean,
  ) {}

  private readTx<T>(access: AccessContext, work: (trx: Tx) => Promise<T>): Promise<T> {
    if (!this.available) throw unavailable();
    if (access.kind === 'platform') throw denied('No organisation selected.');
    return withTenantTransaction(
      this.db,
      { tenantId: access.tenantId, userId: access.userId },
      work,
      { readOnly: access.kind === 'break_glass' },
    );
  }

  private async writeTx<T>(
    access: AccessContext,
    work: (trx: Tx, member: Member) => Promise<T>,
  ): Promise<T> {
    if (!this.available) throw unavailable();
    if (access.kind !== 'member') throw denied('Only members of the organisation can change it.');
    try {
      return await withTenantTransaction(
        this.db,
        { tenantId: access.tenantId, userId: access.userId },
        (trx) => work(trx, access),
      );
    } catch (err) {
      if (isArchivedRefusal(err)) throw archived();
      throw err;
    }
  }

  /** Departments must exist; the person setting them must remain able to see the project. */
  private async checkDepartments(trx: Tx, member: Member, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    if ((await tenancy.departmentsExist(trx, [...ids])) !== ids.length) {
      throw invalid(
        'One or more departments do not exist in this organisation.',
        'body.departmentIds',
      );
    }
    if (
      !member.permissions.has(ALL_PROJECTS_PERMISSION) &&
      !(await projects.memberInAny(trx, member.membershipId, ids))
    ) {
      throw invalid(
        'Choose at least one department you belong to; otherwise you could no longer see this project.',
        'body.departmentIds',
      );
    }
  }

  private async detail(trx: Tx, projectId: string): Promise<ProjectDetailDto> {
    const p = await projects.get(trx, projectId);
    if (!p) throw notFound();
    return {
      ...projectDto(p),
      scenarios: (await projects.scenarios(trx, projectId)).map(scenarioDto),
    };
  }

  private audit(
    trx: Tx,
    ctx: RequestContext,
    member: Member,
    e: {
      action: string;
      targetType: 'project' | 'scenario';
      targetId: string;
      before?: unknown;
      after?: unknown;
      detail?: Record<string, string | number | boolean | string[]>;
    },
  ): Promise<void> {
    return tenancy.audit(trx, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      actorKind: 'member',
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      beforeDigest: e.before === undefined ? null : digest(e.before),
      afterDigest: e.after === undefined ? null : digest(e.after),
      requestId: ctx.requestId ?? null,
      ...(e.detail ? { detail: e.detail } : {}),
    });
  }

  // ------------------------------------------------------------------ reads ---------------------
  checkScope(input: ScopeInput): ScopeResultDto {
    const r = checkScope(input);
    return { ...r, reasons: [...r.reasons] };
  }

  list(access: AccessContext) {
    return this.readTx(access, async (trx) => ({
      projects: (await projects.list(trx)).map(projectDto),
    }));
  }

  get(access: AccessContext, projectId: string) {
    return this.readTx(access, async (trx) => ({ project: await this.detail(trx, projectId) }));
  }

  // ------------------------------------------------------------------ projects ------------------
  async create(ctx: RequestContext, access: AccessContext, input: ProjectWrite) {
    const v = values(input);
    const project = await this.writeTx(access, async (trx, member) => {
      await this.checkDepartments(trx, member, input.departmentIds);
      const id = await projects.insert(trx, member.tenantId, member.membershipId, v);
      await projects.setDepartments(trx, member.tenantId, id, input.departmentIds);
      const created = await this.detail(trx, id);
      await this.audit(trx, ctx, member, {
        action: 'project.created',
        targetType: 'project',
        targetId: id,
        after: created,
        detail: { scope: v.scopeStatus, departments: input.departmentIds.length },
      });
      return created;
    });
    return { project };
  }

  async update(ctx: RequestContext, access: AccessContext, projectId: string, input: ProjectWrite) {
    const v = values(input);
    const project = await this.writeTx(access, async (trx, member) => {
      const status = await projects.lock(trx, projectId);
      if (!status) throw notFound();
      if (status === 'archived') throw archived();
      await this.checkDepartments(trx, member, input.departmentIds);
      const before = await this.detail(trx, projectId);
      if (!(await projects.update(trx, projectId, v))) throw notFound();
      await projects.setDepartments(trx, member.tenantId, projectId, input.departmentIds);
      const after = await this.detail(trx, projectId);
      await this.audit(trx, ctx, member, {
        action: 'project.changed',
        targetType: 'project',
        targetId: projectId,
        before,
        after,
        detail: { scope: v.scopeStatus, departments: input.departmentIds.length },
      });
      return after;
    });
    return { project };
  }

  async archive(ctx: RequestContext, access: AccessContext, projectId: string) {
    const project = await this.writeTx(access, async (trx, member) => {
      const status = await projects.lock(trx, projectId);
      if (!status) throw notFound();
      if (status === 'archived') throw archived();
      const before = await this.detail(trx, projectId);
      if (!(await projects.archive(trx, projectId))) throw notFound();
      const after = await this.detail(trx, projectId);
      await this.audit(trx, ctx, member, {
        action: 'project.archived',
        targetType: 'project',
        targetId: projectId,
        before,
        after,
      });
      return after;
    });
    return { project };
  }

  // ------------------------------------------------------------------ scenarios -----------------
  async addScenario(
    ctx: RequestContext,
    access: AccessContext,
    projectId: string,
    input: { description: string },
  ) {
    const scenario = await this.writeTx(access, async (trx, member) => {
      const status = await projects.lock(trx, projectId);
      if (!status) throw notFound();
      if (status === 'archived') throw archived();
      const n = await projects.takeScenarioNumber(trx, projectId);
      if (n === null) throw notFound();
      const created = await projects.insertScenario(
        trx,
        member.tenantId,
        projectId,
        member.membershipId,
        formatScenarioCode(n),
        input.description,
      );
      await this.audit(trx, ctx, member, {
        action: 'scenario.created',
        targetType: 'scenario',
        targetId: created.id,
        after: scenarioDto(created),
        detail: { project: projectId, code: created.code },
      });
      return created;
    });
    return { scenario: scenarioDto(scenario) };
  }

  async updateScenario(
    ctx: RequestContext,
    access: AccessContext,
    projectId: string,
    scenarioId: string,
    input: { description: string },
  ) {
    const scenario = await this.writeTx(access, async (trx, member) => {
      const status = await projects.lock(trx, projectId);
      if (!status) throw notFound();
      if (status === 'archived') throw archived();
      const before = await projects.getScenario(trx, projectId, scenarioId);
      if (!before) throw notFound();
      const after = await projects.updateScenario(trx, projectId, scenarioId, input.description);
      if (!after) throw notFound();
      await this.audit(trx, ctx, member, {
        action: 'scenario.changed',
        targetType: 'scenario',
        targetId: scenarioId,
        before: scenarioDto(before),
        after: scenarioDto(after),
        detail: { project: projectId, code: after.code },
      });
      return after;
    });
    return { scenario: scenarioDto(scenario) };
  }
}
