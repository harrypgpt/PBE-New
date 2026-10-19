import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientConfig } from 'pg';
import { PERMISSIONS, permissionsForSchema, ROLE_TEMPLATES } from '@pbe/contracts';
import { backupCoverageViolations, checkTenantTables } from '../../tooling/migrate/src/conformance';
import { migrate } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ROOT, ThrowawayCluster, withClient } from './helpers';

/*
 * Migration 0006 (projects, scenarios, department visibility; STAGE-08-PLAN.md, ADR-030) on a
 * PRIVATE throw-away PostgreSQL 18 server only: real bootstrap, real migrations 0001–0004, the
 * proposed 0005 and 0006. pbe_test and pbe_dev are never touched. Data is fictional.
 */

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-0006-'));
const migrationsDir = path.join(tmp, 'migrations');
const DB = 'pbe_test';
const cfg = (user: string): ClientConfig => cluster.config(user, DB);
type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

const owner = (sql: string, params: unknown[] = []) =>
  withClient(cfg('pbe_migrator'), async (c) => (await c.query(sql, params)).rows as Row[], {
    asOwner: true,
  });

/** Runs `fn` as pbe_app in one transaction with an organisation and user context (as the API). */
async function asApp<R>(
  ctx: { tenant: string; user?: string },
  fn: (q: Query) => Promise<R>,
): Promise<R> {
  return withClient(cfg('pbe_app'), async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenant]);
      if (ctx.user) await c.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.user]);
      const result = await fn(
        async (sql, params = []) => (await c.query(sql, params)).rows as Row[],
      );
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

interface Person {
  user: string;
  membership: string;
}
interface Org {
  tenant: string;
  admin: Person;
}
const orgs: Org[] = [];
const id = (rows: Row[]) => String(rows[0]!.id);

async function person(tenant: string, label: string): Promise<Person> {
  const user = id(
    await owner(
      `INSERT INTO platform.user_account (email, display_name) VALUES ($1, 'Fictional Person') RETURNING id`,
      [`${label}@example.test`],
    ),
  );
  const membership = await asApp({ tenant }, async (q) =>
    id(
      await q(
        `INSERT INTO app.membership (tenant_id, user_id, email, display_name) VALUES (app.current_tenant_id(), $1, $2, 'Fictional Person') RETURNING id`,
        [user, `${label}@example.test`],
      ),
    ),
  );
  return { user, membership };
}

const PROJECT = `INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form, route,
  release_type, scope_status, scope_reasons, scope_vocabulary_version, created_by_membership)
  VALUES (app.current_tenant_id(), $1, 'Fictionalol', 50, 'mg', 'tablet', 'oral', 'immediate_release',
          $2, $3, 'draft-2026-10-18', $4) RETURNING id`;
const SCENARIO = `INSERT INTO app.scenario (tenant_id, project_id, code, created_by_membership)
  VALUES (app.current_tenant_id(), $1, $2, $3) RETURNING id`;

beforeAll(async () => {
  cluster = ThrowawayCluster.start();
  const run = cluster.psqlFile(
    path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'),
    bootstrapCredentials().env,
  );
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  fs.mkdirSync(migrationsDir);
  for (const f of fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql') && f < '0005')) {
    fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrationsDir, f));
  }
  fs.copyFileSync(
    path.join(ROOT, 'db', 'migrations', '0005_backup_read_access.sql'),
    path.join(migrationsDir, '0005_backup_read_access.sql'),
  );
  expect(
    (await migrate({ connection: cfg('pbe_migrator'), migrationsDir })).applied.map(
      (a) => a.version,
    ),
  ).toEqual([1, 2, 3, 4, 5]);
  // Organisations that EXIST before 0006, with template-linked roles (as created by Stage 7A).
  for (const slug of ['fictional-a', 'fictional-b']) {
    const tenant = id(
      await owner(`INSERT INTO platform.tenant (slug, display_name) VALUES ($1, $1) RETURNING id`, [
        slug,
      ]),
    );
    const admin = await person(tenant, `${slug}-admin`);
    await asApp({ tenant }, async (q) => {
      for (const t of ROLE_TEMPLATES) {
        await q(
          `INSERT INTO app.role (tenant_id, name, template_key) VALUES (app.current_tenant_id(), $1, $2)`,
          [t.name, t.key],
        );
      }
      // The administrator holds the Tenant Administrator role; 0006 must give it tenant.allprojects.read.
      await q(
        `INSERT INTO app.membership_role (tenant_id, membership_id, role_id)
         SELECT app.current_tenant_id(), $1, id FROM app.role WHERE template_key = 'tenant_administrator'`,
        [admin.membership],
      );
      // A custom role (no template): must not be touched by 0006.
      await q(
        `INSERT INTO app.role (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional custom role')`,
      );
      return null;
    });
    orgs.push({ tenant, admin });
  }
  fs.copyFileSync(
    path.join(ROOT, 'db', 'migrations', '0006_projects_scenarios.sql'),
    path.join(migrationsDir, '0006_projects_scenarios.sql'),
  );
  expect(
    (await migrate({ connection: cfg('pbe_migrator'), migrationsDir })).applied.map(
      (a) => a.version,
    ),
  ).toEqual([6]);
}, 180_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('S8-8 the tables follow the Stage 3 rules and the backup rule', () => {
  it('RLS conformance passes for every app table; the new tables are forced', async () => {
    expect(await withClient(cfg('pbe_migrator'), (c) => checkTenantTables(c, 'app'))).toEqual([]);
    const forced = await owner(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class
        WHERE oid IN ('app.project'::regclass, 'app.project_department'::regclass, 'app.scenario'::regclass) ORDER BY 1`,
    );
    expect(forced.every((r) => r.f === true)).toBe(true);
    // FORCE was lifted only inside 0006 for its seed statement and is back on.
    const roles = await owner(
      `SELECT bool_and(relforcerowsecurity) AS f FROM pg_class WHERE oid IN ('app.role'::regclass, 'app.role_permission'::regclass)`,
    );
    expect(roles[0]!.f).toBe(true);
  });

  it('the backup login can read everything; pbe_app may not delete projects or scenarios, nor truncate', async () => {
    expect(
      await withClient(cfg('pbe_migrator'), (c) => backupCoverageViolations(c, 'pbe_backup')),
    ).toEqual([]);
    const rows = await owner(
      `SELECT t, has_table_privilege('pbe_app', t, 'DELETE') AS del, has_table_privilege('pbe_app', t, 'TRUNCATE') AS trunc
         FROM unnest(ARRAY['app.project', 'app.scenario', 'app.project_department']) t ORDER BY 1`,
    );
    expect(rows).toEqual([
      { t: 'app.project', del: false, trunc: false },
      { t: 'app.project_department', del: true, trunc: false },
      { t: 'app.scenario', del: false, trunc: false },
    ]);
  });
});

describe('catalogue and templates (D8-4, D8-5): database equals code', () => {
  it('the permission catalogue in the database equals the code catalogue', async () => {
    const db = await owner(
      `SELECT code, scope, read_only, description FROM platform.permission ORDER BY code`,
    );
    expect(db).toEqual(
      [...permissionsForSchema(6)]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((p) => ({
          code: p.code,
          scope: p.scope,
          read_only: p.readOnly,
          description: p.description,
        })),
    );
    expect(permissionsForSchema(6)).toEqual(PERMISSIONS);
  });

  it('template permissions equal the code templates', async () => {
    const db = await owner(
      `SELECT template_key, array_agg(permission ORDER BY permission) AS p FROM platform.role_template_permission GROUP BY 1`,
    );
    const byKey = Object.fromEntries(db.map((r) => [r.template_key, r.p]));
    for (const t of ROLE_TEMPLATES) {
      expect([...((byKey[t.key] as string[] | undefined) ?? [])]).toEqual(
        [...t.permissions].sort(),
      );
    }
  });

  it('existing organisations: template-linked roles received the new permissions; custom roles did not', async () => {
    const [a] = orgs;
    const rows = await asApp({ tenant: a!.tenant }, (q) =>
      q(`SELECT r.name, coalesce(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS p
           FROM app.role r LEFT JOIN app.role_permission rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
          GROUP BY r.name ORDER BY r.name`),
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.p as string[]]));
    expect(byName['Project Lead']).toEqual([
      'tenant.projects.create',
      'tenant.projects.manage',
      'tenant.projects.read',
      'tenant.scenarios.manage',
    ]);
    expect(byName.Scientist).toEqual(['tenant.projects.read', 'tenant.scenarios.manage']);
    expect(byName.Viewer).toEqual(['tenant.projects.read']);
    expect(byName['Tenant Administrator']).toEqual(
      expect.arrayContaining(['tenant.allprojects.read', 'tenant.projects.manage']),
    );
    expect(byName['Fictional custom role']).toEqual([]);
  });
});

describe('Decision 2: the database naming rule for permission identifiers', () => {
  it('accepts tenant.allprojects.read (already seeded) and refuses the draft name tenant.projects.read_all', async () => {
    expect(
      await owner(`SELECT code FROM platform.permission WHERE code = 'tenant.allprojects.read'`),
    ).toHaveLength(1);
    await expect(
      owner(
        `INSERT INTO platform.permission (code, scope, read_only, description) VALUES ('tenant.projects.read_all', 'tenant', true, 'x')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('S8-4 cross-tenant isolation at database level', () => {
  let projectA = '';

  beforeAll(async () => {
    const [a] = orgs;
    projectA = await asApp({ tenant: a!.tenant, user: a!.admin.user }, async (q) => {
      const p = id(await q(PROJECT, ['Fictional project A', 'supported', [], a!.admin.membership]));
      await q(SCENARIO, [p, 'F001', a!.admin.membership]);
      return p;
    });
  });

  it('organisation B sees none of A’s projects, departments links or scenarios', async () => {
    const [, b] = orgs;
    const seen = await asApp({ tenant: b!.tenant, user: b!.admin.user }, async (q) => [
      ...(await q('SELECT id FROM app.project')),
      ...(await q('SELECT id FROM app.scenario')),
      ...(await q('SELECT project_id FROM app.project_department')),
    ]);
    expect(seen).toEqual([]);
  });

  it('organisation B cannot write rows for A, attach a scenario to A’s project, or change it', async () => {
    const [a, b] = orgs;
    await expect(
      asApp({ tenant: b!.tenant, user: b!.admin.user }, (q) =>
        q(
          `INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form, route, release_type, scope_status, scope_vocabulary_version, created_by_membership)
           VALUES ($1, 'x', 'x', 1, 'mg', 'tablet', 'oral', 'immediate_release', 'supported', 'v', $2)`,
          [a!.tenant, a!.admin.membership],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asApp({ tenant: b!.tenant, user: b!.admin.user }, (q) =>
        q(SCENARIO, [projectA, 'F009', b!.admin.membership]),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
    const updated = await asApp({ tenant: b!.tenant, user: b!.admin.user }, (q) =>
      q(`UPDATE app.project SET name = 'taken' WHERE id = $1 RETURNING id`, [projectA]),
    );
    expect(updated).toEqual([]);
  });

  it('without an organisation context nothing is visible', async () => {
    const rows = await withClient(
      cfg('pbe_app'),
      async (c) => (await c.query('SELECT id FROM app.project')).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('S8-6 department-based visibility (D8-6), enforced by PostgreSQL', () => {
  const people: Record<string, Person> = {};
  let restricted = '';
  let open = '';
  let superAdmin = '';

  beforeAll(async () => {
    const [a] = orgs;
    const t = a!.tenant;
    for (const label of ['in-dept', 'other-dept', 'oversight', 'no-dept'])
      people[label] = await person(t, `vis-${label}`);
    await asApp({ tenant: t, user: a!.admin.user }, async (q) => {
      const d1 = id(
        await q(
          `INSERT INTO app.department (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional D1') RETURNING id`,
        ),
      );
      const d2 = id(
        await q(
          `INSERT INTO app.department (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional D2') RETURNING id`,
        ),
      );
      await q(
        `INSERT INTO app.membership_department (tenant_id, membership_id, department_id) VALUES (app.current_tenant_id(), $1, $2)`,
        [people['in-dept']!.membership, d1],
      );
      await q(
        `INSERT INTO app.membership_department (tenant_id, membership_id, department_id) VALUES (app.current_tenant_id(), $1, $2)`,
        [people['other-dept']!.membership, d2],
      );
      const role = id(
        await q(
          `INSERT INTO app.role (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional oversight') RETURNING id`,
        ),
      );
      await q(
        `INSERT INTO app.role_permission (tenant_id, role_id, permission) VALUES (app.current_tenant_id(), $1, 'tenant.allprojects.read')`,
        [role],
      );
      await q(
        `INSERT INTO app.membership_role (tenant_id, membership_id, role_id) VALUES (app.current_tenant_id(), $1, $2)`,
        [people.oversight!.membership, role],
      );
      restricted = id(
        await q(PROJECT, ['Fictional D1 project', 'supported', [], a!.admin.membership]),
      );
      open = id(await q(PROJECT, ['Fictional open project', 'supported', [], a!.admin.membership]));
      await q(
        `INSERT INTO app.project_department (tenant_id, project_id, department_id) VALUES (app.current_tenant_id(), $1, $2)`,
        [restricted, d1],
      );
      await q(SCENARIO, [restricted, 'F001', a!.admin.membership]);
      return null;
    });
    superAdmin = id(
      await owner(
        `INSERT INTO platform.user_account (email, display_name) VALUES ('vis-sa@example.test', 'Fictional SA') RETURNING id`,
      ),
    );
  });

  const visible = async (user: string) => {
    const [a] = orgs;
    return asApp({ tenant: a!.tenant, user }, async (q) => ({
      projects: (
        await q(`SELECT name FROM app.project WHERE id = ANY($1) ORDER BY name`, [
          [restricted, open],
        ])
      ).map((r) => r.name),
      scenarios: (await q(`SELECT code FROM app.scenario WHERE project_id = $1`, [restricted]))
        .length,
    }));
  };

  it('a member of the project’s department sees it and its scenarios', async () => {
    expect(await visible(people['in-dept']!.user)).toEqual({
      projects: ['Fictional D1 project', 'Fictional open project'],
      scenarios: 1,
    });
  });

  it('a member of another department, or of none, sees only projects without departments', async () => {
    for (const label of ['other-dept', 'no-dept']) {
      expect(await visible(people[label]!.user)).toEqual({
        projects: ['Fictional open project'],
        scenarios: 0,
      });
    }
  });

  it('tenant.allprojects.read sees every project', async () => {
    expect((await visible(people.oversight!.user)).projects).toHaveLength(2);
  });

  it('a hidden project cannot be changed, nor get scenarios, by someone who cannot see it', async () => {
    const [a] = orgs;
    const ctx = { tenant: a!.tenant, user: people['other-dept']!.user };
    expect(
      await asApp(ctx, (q) =>
        q(`UPDATE app.project SET name = 'x' WHERE id = $1 RETURNING id`, [restricted]),
      ),
    ).toEqual([]);
    await expect(
      asApp(ctx, (q) => q(SCENARIO, [restricted, 'F777', people['other-dept']!.membership])),
    ).rejects.toThrow(/row-level security/);
  });

  it('break-glass: an APPROVED, unexpired grant sees everything; no grant or an expired grant does not', async () => {
    const [a] = orgs;
    expect((await visible(superAdmin)).projects).toEqual(['Fictional open project']); // no grant
    const [g] = await owner(
      `INSERT INTO platform.break_glass_grant (tenant_id, requested_by, purpose, status, decided_by, decided_at, expires_at)
       VALUES ($1, $2, 'Fictional support purpose text', 'approved', $3, now(), now() + interval '30 minutes') RETURNING id`,
      [a!.tenant, superAdmin, a!.admin.user],
    );
    expect((await visible(superAdmin)).projects).toHaveLength(2);
    await owner(
      `UPDATE platform.break_glass_grant SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [g!.id],
    );
    expect((await visible(superAdmin)).projects).toEqual(['Fictional open project']);
  });
});

describe('S8-3 scenario codes at database level (D8-7)', () => {
  it('a code is unique per project; the same code may exist in another project; the format is enforced', async () => {
    const [a] = orgs;
    const ctx = { tenant: a!.tenant, user: a!.admin.user };
    const [p1, p2] = await asApp(ctx, async (q) => [
      id(await q(PROJECT, ['Codes 1', 'supported', [], a!.admin.membership])),
      id(await q(PROJECT, ['Codes 2', 'supported', [], a!.admin.membership])),
    ]);
    await asApp(ctx, async (q) => {
      await q(SCENARIO, [p1, 'F001', a!.admin.membership]);
      await q(SCENARIO, [p2, 'F001', a!.admin.membership]);
      return null;
    });
    await expect(asApp(ctx, (q) => q(SCENARIO, [p1, 'F001', a!.admin.membership]))).rejects.toThrow(
      /scenario_code_unique_per_project/,
    );
    await expect(asApp(ctx, (q) => q(SCENARIO, [p1, 'X1', a!.admin.membership]))).rejects.toThrow(
      /check constraint/,
    );
  });

  it('simultaneous allocations from the project counter get different numbers (row lock)', async () => {
    const [a] = orgs;
    const ctx = { tenant: a!.tenant, user: a!.admin.user };
    const p = await asApp(ctx, async (q) =>
      id(await q(PROJECT, ['Concurrency', 'supported', [], a!.admin.membership])),
    );
    const take = () =>
      asApp(ctx, async (q) => {
        const [r] = await q(
          `UPDATE app.project SET next_scenario_number = next_scenario_number + 1 WHERE id = $1 RETURNING next_scenario_number - 1 AS n`,
          [p],
        );
        await q('SELECT pg_sleep(0.2)'); // hold the row lock while the others wait
        return Number(r!.n);
      });
    const numbers = await Promise.all([take(), take(), take(), take()]);
    expect([...numbers].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('S8 archive protection (D8-8), enforced by PostgreSQL', () => {
  it('an archived project, its departments and its scenarios can no longer change; it stays readable', async () => {
    const [a] = orgs;
    const ctx = { tenant: a!.tenant, user: a!.admin.user };
    const [p, dep] = await asApp(ctx, async (q) => {
      const project = id(await q(PROJECT, ['To archive', 'supported', [], a!.admin.membership]));
      await q(SCENARIO, [project, 'F001', a!.admin.membership]);
      const d = id(
        await q(
          `INSERT INTO app.department (tenant_id, name) VALUES (app.current_tenant_id(), 'Fictional archive dept') RETURNING id`,
        ),
      );
      await q(`UPDATE app.project SET status = 'archived' WHERE id = $1`, [project]);
      return [project, d];
    });
    const refused = /is archived and can no longer be changed/;
    await expect(
      asApp(ctx, (q) => q(`UPDATE app.project SET name = 'changed' WHERE id = $1`, [p])),
    ).rejects.toThrow(refused);
    await expect(
      asApp(ctx, (q) => q(`UPDATE app.project SET status = 'active' WHERE id = $1`, [p])),
    ).rejects.toThrow(refused);
    await expect(asApp(ctx, (q) => q(SCENARIO, [p, 'F002', a!.admin.membership]))).rejects.toThrow(
      refused,
    );
    await expect(
      asApp(ctx, (q) => q(`UPDATE app.scenario SET description = 'x' WHERE project_id = $1`, [p])),
    ).rejects.toThrow(refused);
    await expect(
      asApp(ctx, (q) =>
        q(
          `INSERT INTO app.project_department (tenant_id, project_id, department_id) VALUES (app.current_tenant_id(), $1, $2)`,
          [p, dep],
        ),
      ),
    ).rejects.toThrow(refused);
    const still = await asApp(ctx, (q) =>
      q(`SELECT name, status FROM app.project WHERE id = $1`, [p]),
    );
    expect(still).toEqual([{ name: 'To archive', status: 'archived' }]);
  });
});

describe('scope status is stored consistently (ADR-011)', () => {
  it('"unsupported" always has a reason; "supported" never has one; strength rules hold', async () => {
    const [a] = orgs;
    const ctx = { tenant: a!.tenant, user: a!.admin.user };
    await expect(
      asApp(ctx, (q) => q(PROJECT, ['No reason', 'unsupported', [], a!.admin.membership])),
    ).rejects.toThrow(/project_unsupported_has_reason/);
    await expect(
      asApp(ctx, (q) => q(PROJECT, ['Contradiction', 'supported', ['x'], a!.admin.membership])),
    ).rejects.toThrow(/project_supported_has_no_reason/);
    expect(
      await asApp(ctx, (q) =>
        q(PROJECT, [
          'Fictional nasal product',
          'unsupported',
          ['Nasal products are outside the supported scope.'],
          a!.admin.membership,
        ]),
      ),
    ).toHaveLength(1);
    await expect(
      asApp(ctx, (q) =>
        q(
          `INSERT INTO app.project (tenant_id, name, molecule, strength_value, strength_unit, dosage_form, route, release_type, scope_status, scope_vocabulary_version, created_by_membership)
           VALUES (app.current_tenant_id(), 'x', 'x', 0, 'mg', 'tablet', 'oral', 'immediate_release', 'supported', 'v', $1)`,
          [a!.admin.membership],
        ),
      ),
    ).rejects.toThrow(/project_strength_positive/);
  });
});
