import { sql } from 'kysely';
import type { Tx } from './tenant-context';

/**
 * Projects and scenarios data access (Stage 8; migration 0006, ADR-030). Hand-written SQL: the
 * generated types are built from the base schema profile, which has no project tables. Every
 * function runs inside withTenantTransaction, so PostgreSQL row-level security limits it to the
 * transaction's organisation AND to projects the user may see (department visibility, D8-6):
 * a project from another organisation, or a hidden one, is simply not found.
 */

export interface ProjectRow {
  id: string;
  name: string;
  molecule: string;
  strengthValue: number;
  strengthUnit: string;
  dosageForm: string;
  route: string;
  releaseType: string;
  productFlags: string[];
  scopeStatus: 'supported' | 'unsupported';
  scopeReasons: string[];
  scopeVocabularyVersion: string;
  status: 'active' | 'archived';
  departmentIds: string[];
  scenarioCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScenarioRow {
  id: string;
  code: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectValues {
  name: string;
  molecule: string;
  strengthValue: number;
  strengthUnit: string;
  dosageForm: string;
  route: string;
  releaseType: string;
  productFlags: readonly string[];
  scopeStatus: 'supported' | 'unsupported';
  scopeReasons: readonly string[];
  scopeVocabularyVersion: string;
}

interface RawProject {
  id: string;
  name: string;
  molecule: string;
  strength_value: string;
  strength_unit: string;
  dosage_form: string;
  route: string;
  release_type: string;
  product_flags: string[];
  scope_status: 'supported' | 'unsupported';
  scope_reasons: string[];
  scope_vocabulary_version: string;
  status: 'active' | 'archived';
  department_ids: string[];
  scenario_count: number;
  created_at: Date;
  updated_at: Date;
}

const toProject = (r: RawProject): ProjectRow => ({
  id: r.id,
  name: r.name,
  molecule: r.molecule,
  strengthValue: Number(r.strength_value),
  strengthUnit: r.strength_unit,
  dosageForm: r.dosage_form,
  route: r.route,
  releaseType: r.release_type,
  productFlags: r.product_flags,
  scopeStatus: r.scope_status,
  scopeReasons: r.scope_reasons,
  scopeVocabularyVersion: r.scope_vocabulary_version,
  status: r.status,
  departmentIds: r.department_ids,
  scenarioCount: r.scenario_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT_PROJECT = sql`
  SELECT p.id, p.name, p.molecule, p.strength_value::text AS strength_value, p.strength_unit,
         p.dosage_form, p.route, p.release_type, p.product_flags, p.scope_status, p.scope_reasons,
         p.scope_vocabulary_version, p.status, p.created_at, p.updated_at,
         coalesce((SELECT array_agg(pd.department_id ORDER BY pd.department_id)
                     FROM app.project_department pd
                    WHERE pd.tenant_id = p.tenant_id AND pd.project_id = p.id), '{}') AS department_ids,
         (SELECT count(*)::int FROM app.scenario s
           WHERE s.tenant_id = p.tenant_id AND s.project_id = p.id) AS scenario_count
    FROM app.project p`;

interface RawScenario {
  id: string;
  code: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}
const toScenario = (r: RawScenario): ScenarioRow => ({
  id: r.id,
  code: r.code,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const projects = {
  /** Visible projects, active first, then by name. */
  async list(trx: Tx): Promise<ProjectRow[]> {
    const r = await sql<RawProject>`${SELECT_PROJECT}
      ORDER BY (p.status = 'archived'), lower(p.name), p.id`.execute(trx);
    return r.rows.map(toProject);
  },

  async get(trx: Tx, projectId: string): Promise<ProjectRow | null> {
    const r = await sql<RawProject>`${SELECT_PROJECT} WHERE p.id = ${projectId}`.execute(trx);
    return r.rows[0] ? toProject(r.rows[0]) : null;
  },

  /** Locks the (visible) project row for this transaction; null when not found. */
  async lock(trx: Tx, projectId: string): Promise<'active' | 'archived' | null> {
    const r = await sql<{ status: 'active' | 'archived' }>`
      SELECT status FROM app.project WHERE id = ${projectId} FOR UPDATE`.execute(trx);
    return r.rows[0]?.status ?? null;
  },

  async insert(trx: Tx, tenantId: string, membershipId: string, v: ProjectValues): Promise<string> {
    const r = await sql<{ id: string }>`
      INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form,
             route, release_type, product_flags, scope_status, scope_reasons,
             scope_vocabulary_version, created_by_membership)
      VALUES (${tenantId}, ${v.name}, ${v.molecule}, ${v.strengthValue}, ${v.strengthUnit},
              ${v.dosageForm}, ${v.route}, ${v.releaseType}, ${[...v.productFlags]}::text[],
              ${v.scopeStatus}, ${[...v.scopeReasons]}::text[], ${v.scopeVocabularyVersion},
              ${membershipId})
      RETURNING id`.execute(trx);
    return r.rows[0]!.id;
  },

  async update(trx: Tx, projectId: string, v: ProjectValues): Promise<boolean> {
    const r = await sql`
      UPDATE app.project
         SET name = ${v.name}, molecule = ${v.molecule}, strength_value = ${v.strengthValue},
             strength_unit = ${v.strengthUnit}, dosage_form = ${v.dosageForm}, route = ${v.route},
             release_type = ${v.releaseType}, product_flags = ${[...v.productFlags]}::text[],
             scope_status = ${v.scopeStatus}, scope_reasons = ${[...v.scopeReasons]}::text[],
             scope_vocabulary_version = ${v.scopeVocabularyVersion}, updated_at = now()
       WHERE id = ${projectId}`.execute(trx);
    return Number(r.numAffectedRows ?? 0) === 1;
  },

  async archive(trx: Tx, projectId: string): Promise<boolean> {
    const r = await sql`
      UPDATE app.project SET status = 'archived', updated_at = now()
       WHERE id = ${projectId} AND status = 'active'`.execute(trx);
    return Number(r.numAffectedRows ?? 0) === 1;
  },

  /** Replaces the project's departments (only rows that change are touched). */
  async setDepartments(
    trx: Tx,
    tenantId: string,
    projectId: string,
    departmentIds: readonly string[],
  ): Promise<void> {
    const ids = [...departmentIds];
    await sql`
      DELETE FROM app.project_department
       WHERE project_id = ${projectId} AND NOT (department_id = ANY(${ids}::uuid[]))`.execute(trx);
    await sql`
      INSERT INTO app.project_department (tenant_id, project_id, department_id)
      SELECT ${tenantId}, ${projectId}, d FROM unnest(${ids}::uuid[]) AS d
      ON CONFLICT DO NOTHING`.execute(trx);
  },

  /** Is the member in at least one of these departments? */
  async memberInAny(
    trx: Tx,
    membershipId: string,
    departmentIds: readonly string[],
  ): Promise<boolean> {
    const r = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM app.membership_department
                      WHERE membership_id = ${membershipId}
                        AND department_id = ANY(${[...departmentIds]}::uuid[])) AS ok`.execute(trx);
    return r.rows[0]?.ok === true;
  },

  async scenarios(trx: Tx, projectId: string): Promise<ScenarioRow[]> {
    const r = await sql<RawScenario>`
      SELECT id, code, description, created_at, updated_at FROM app.scenario
       WHERE project_id = ${projectId}
       ORDER BY length(code), code`.execute(trx);
    return r.rows.map(toScenario);
  },

  /**
   * Takes the project's next scenario number (D8-7). The UPDATE locks the project row, so
   * simultaneous requests are served one after the other and never get the same number; the
   * counter only grows, so a number is never reused.
   */
  async takeScenarioNumber(trx: Tx, projectId: string): Promise<number | null> {
    const r = await sql<{ n: number }>`
      UPDATE app.project SET next_scenario_number = next_scenario_number + 1
       WHERE id = ${projectId}
      RETURNING next_scenario_number - 1 AS n`.execute(trx);
    return r.rows[0] ? Number(r.rows[0].n) : null;
  },

  async insertScenario(
    trx: Tx,
    tenantId: string,
    projectId: string,
    membershipId: string,
    code: string,
    description: string,
  ): Promise<ScenarioRow> {
    const r = await sql<RawScenario>`
      INSERT INTO app.scenario (tenant_id, project_id, code, description, created_by_membership)
      VALUES (${tenantId}, ${projectId}, ${code}, ${description}, ${membershipId})
      RETURNING id, code, description, created_at, updated_at`.execute(trx);
    return toScenario(r.rows[0]!);
  },

  async getScenario(trx: Tx, projectId: string, scenarioId: string): Promise<ScenarioRow | null> {
    const r = await sql<RawScenario>`
      SELECT id, code, description, created_at, updated_at FROM app.scenario
       WHERE project_id = ${projectId} AND id = ${scenarioId}`.execute(trx);
    return r.rows[0] ? toScenario(r.rows[0]) : null;
  },

  async updateScenario(
    trx: Tx,
    projectId: string,
    scenarioId: string,
    description: string,
  ): Promise<ScenarioRow | null> {
    const r = await sql<RawScenario>`
      UPDATE app.scenario SET description = ${description}, updated_at = now()
       WHERE project_id = ${projectId} AND id = ${scenarioId}
      RETURNING id, code, description, created_at, updated_at`.execute(trx);
    return r.rows[0] ? toScenario(r.rows[0]) : null;
  },
};
