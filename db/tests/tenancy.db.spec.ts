import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import {
  assertSafeRuntimeRole,
  createDatabase,
  TenantContextError,
  withTenantTransaction,
  type Database,
  type DatabaseConnection,
} from '../../apps/api/src/modules/db';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { assertTestSchema, dbConfig, ROOT, testSchemaSql, withClient } from './helpers';

/*
 * Stage 3 security tests (STAGE-03-PLAN.md §4.1 A–D). Everything runs against real PostgreSQL 18
 * in pbe_test, as the runtime role pbe_app, through the real data-access layer. Fixture tables are
 * built from db/templates/tenant-table.sql inside a temporary zz_test_* schema. Tenants and data
 * are fictional. Clean-up (afterAll) runs even when tests fail.
 */

const S = assertTestSchema(`zz_test_${randomBytes(5).toString('hex')}`);
const SLUG = `zz-test-${S.slice(8)}`;
const USER = randomUUID();
const T = { A: '', B: '' };
const PROJECTS: Record<'A' | 'B', string[]> = { A: [], B: [] };
let db: Database;

/** pbe_app's connection to pbe_test (dbConfig refuses any database not named *_test). */
function appConnection(): DatabaseConnection {
  const c = dbConfig('app');
  return {
    host: String(c.host),
    port: Number(c.port),
    database: String(c.database),
    user: String(c.user),
    password: String(c.password),
  };
}

const t = (name: string) => sql.raw(`${S}.${name}`);
const ctx = (tenant: 'A' | 'B') => ({ tenantId: T[tenant], userId: USER });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).name;
  }
};
const affected = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0n);

async function visible(tx: Kysely<unknown> | Database, table = 'project') {
  const r = await sql<{
    tenant_id: string;
    id: string;
  }>`SELECT tenant_id, id FROM ${t(table)}`.execute(tx);
  return r.rows;
}

/** Session state of every pooled connection, checked at the same moment (forces both connections). */
async function poolState(): Promise<
  Array<{ tenant: string | null; user: string | null; pid: number }>
> {
  const one = () =>
    db.transaction().execute(async (tx) => {
      const r = await sql<{ tenant: string | null; user: string | null; pid: number }>`
        SELECT current_setting('app.tenant_id', true) AS tenant,
               current_setting('app.user_id', true) AS user,
               pg_backend_pid() AS pid, pg_sleep(0.05)`.execute(tx);
      return r.rows[0]!;
    });
  return Promise.all([one(), one()]);
}
const empty = (v: string | null) => v === null || v === '';

beforeAll(async () => {
  await migrate({ connection: dbConfig('migrator'), migrationsDir: migrationsDir(ROOT) });
  const template = fs.readFileSync(path.join(ROOT, 'db', 'templates', 'tenant-table.sql'), 'utf8');
  await testSchemaSql(S, `CREATE SCHEMA ${S}`);
  await testSchemaSql(S, `GRANT USAGE ON SCHEMA ${S} TO pbe_app`);
  await testSchemaSql(S, template.replaceAll('{schema}', S));
  for (const k of ['A', 'B'] as const) {
    const r = await testSchemaSql(
      S,
      `INSERT INTO platform.tenant (slug, display_name) VALUES ($1, $2) RETURNING id`,
      [`${SLUG}-${k.toLowerCase()}`, `Fictional Tenant ${k}`],
    );
    T[k] = r.rows[0].id;
  }
  db = createDatabase(appConnection(), { maxConnections: 2 });
  // Seed through the real gateway, as each tenant (RLS is forced, so this is the only way in).
  for (const [k, n] of [
    ['A', 3],
    ['B', 2],
  ] as const) {
    await withTenantTransaction(db, ctx(k), async (tx) => {
      for (let i = 0; i < n; i += 1) {
        const r = await sql<{ id: string }>`INSERT INTO ${t('project')} (tenant_id, name)
          VALUES (${T[k]}, ${`Fictional ${k} project ${i}`}) RETURNING id`.execute(tx);
        PROJECTS[k].push(r.rows[0]!.id);
        await sql`INSERT INTO ${t('scenario')} (tenant_id, project_id, code)
          VALUES (${T[k]}, ${r.rows[0]!.id}, ${`F00${i + 1}`})`.execute(tx);
      }
    });
  }
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await testSchemaSql(S, `DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await testSchemaSql(S, `DELETE FROM platform.tenant WHERE slug LIKE $1`, [`${SLUG}-%`]);
});

describe('A. transaction-scoped context, pool reuse, no leakage (pool of 2 connections)', () => {
  it('A1+A2: 60 transactions alternate tenants (30 sequential, 30 concurrent); each sees only its own rows; the same connections serve both tenants; no context survives', async () => {
    const pidsByTenant = new Map<number, Set<string>>();
    const checkedPids = new Set<number>();
    const run = async (k: 'A' | 'B') => {
      const r = await withTenantTransaction(db, ctx(k), async (tx) => {
        const rows = await visible(tx);
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
        return { rows, pid: pid.rows[0]!.pid };
      });
      expect(r.rows).toHaveLength(PROJECTS[k].length);
      expect(r.rows.every((row) => row.tenant_id === T[k])).toBe(true);
      if (!pidsByTenant.has(r.pid)) pidsByTenant.set(r.pid, new Set());
      pidsByTenant.get(r.pid)!.add(k);
    };
    for (let i = 0; i < 30; i += 1) {
      await run(i % 2 === 0 ? 'A' : 'B');
      if (i % 5 === 4) {
        for (const s of await poolState()) {
          expect(empty(s.tenant) && empty(s.user)).toBe(true);
          checkedPids.add(s.pid);
        }
      }
    }
    await Promise.all(Array.from({ length: 30 }, (_, i) => run(i % 2 === 0 ? 'A' : 'B')));
    for (const s of await poolState()) expect(empty(s.tenant) && empty(s.user)).toBe(true);

    expect(pidsByTenant.size).toBeLessThanOrEqual(2); // only two physical connections exist
    expect([...pidsByTenant.values()].some((set) => set.has('A') && set.has('B'))).toBe(true); // reused across tenants
    expect(checkedPids.size).toBe(2); // both connections were inspected after commits
  });

  it('A3: a query outside the helper on a pooled connection sees 0 tenant rows', async () => {
    await withTenantTransaction(db, ctx('A'), (tx) => visible(tx));
    for (let i = 0; i < 4; i += 1) expect(await visible(db)).toEqual([]);
  });

  it('A4: application error, SQL error and statement cancellation all roll back and leave no context', async () => {
    await expect(
      withTenantTransaction(db, ctx('A'), async () => {
        throw new Error('application failure');
      }),
    ).rejects.toThrow('application failure');
    expect(
      await code(withTenantTransaction(db, ctx('B'), (tx) => sql`SELECT 1 / 0`.execute(tx))),
    ).toBe('22012');
    expect(
      await code(
        withTenantTransaction(db, ctx('A'), async (tx) => {
          await sql`SET LOCAL statement_timeout = 100`.execute(tx);
          return sql`SELECT pg_sleep(2)`.execute(tx);
        }),
      ),
    ).toBe('57014'); // query_canceled
    // A row inserted before the failure must not persist.
    expect(
      await code(
        withTenantTransaction(db, ctx('A'), async (tx) => {
          await sql`INSERT INTO ${t('project')} (tenant_id, name) VALUES (${T.A}, 'rolled back')`.execute(
            tx,
          );
          throw new Error('cancel');
        }),
      ),
    ).toBe('Error');
    for (const s of await poolState()) expect(empty(s.tenant) && empty(s.user)).toBe(true);
    const names = await withTenantTransaction(db, ctx('A'), (tx) =>
      sql<{ name: string }>`SELECT name FROM ${t('project')}`.execute(tx),
    );
    expect(names.rows.map((r) => r.name)).not.toContain('rolled back');
  });
});

describe('B. fail closed when context is missing or invalid', () => {
  it('B1: no context — SELECT 0 rows, UPDATE/DELETE 0 rows, INSERT rejected', async () => {
    expect(await visible(db)).toEqual([]);
    expect(affected(await sql`UPDATE ${t('project')} SET name = 'x'`.execute(db))).toBe(0);
    expect(affected(await sql`DELETE FROM ${t('scenario')}`.execute(db))).toBe(0);
    expect(
      await code(
        sql`INSERT INTO ${t('project')} (tenant_id, name) VALUES (${T.A}, 'x')`.execute(db),
      ),
    ).toBe('42501');
  });

  it('B2: empty-string context behaves exactly like no context', async () => {
    const result = await db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.tenant_id', '', true)`.execute(tx);
      return {
        rows: await visible(tx),
        updated: affected(await sql`UPDATE ${t('project')} SET name = 'x'`.execute(tx)),
        deleted: affected(await sql`DELETE FROM ${t('scenario')}`.execute(tx)),
        insert: await code(
          sql`INSERT INTO ${t('project')} (tenant_id, name) VALUES (${T.A}, 'x')`.execute(tx),
        ),
      };
    });
    expect(result).toEqual({ rows: [], updated: 0, deleted: 0, insert: '42501' });
  });

  it('B3: a malformed context makes the query fail instead of returning data', async () => {
    const outcome = await code(
      db.transaction().execute(async (tx) => {
        await sql`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`.execute(tx);
        return visible(tx);
      }),
    );
    expect(outcome).toBe('22P02'); // invalid_text_representation
  });

  it('B4: invalid ids passed to the helper are rejected before any connection is taken', async () => {
    let acquired = 0;
    const probe = createDatabase(appConnection(), {
      maxConnections: 1,
      onConnectionAcquired: () => {
        acquired += 1;
      },
    });
    try {
      for (const bad of [
        { tenantId: 'not-a-uuid', userId: USER },
        { tenantId: '', userId: USER },
        { tenantId: T.A, userId: 'nobody' },
        { tenantId: T.A } as never,
        { tenantId: T.A, userId: USER, extra: 1 } as never,
      ]) {
        await expect(withTenantTransaction(probe, bad, async () => 1)).rejects.toThrow(
          TenantContextError,
        );
      }
      expect(acquired).toBe(0);
      await withTenantTransaction(probe, ctx('A'), async () => 1); // control: a valid call does connect
      expect(acquired).toBe(1);
    } finally {
      await probe.destroy();
    }
  });

  it('B5: a well-formed tenant id that does not exist sees nothing and cannot insert', async () => {
    const ghost = { tenantId: randomUUID(), userId: USER };
    const result = await code(
      withTenantTransaction(db, ghost, async (tx) => {
        expect(await visible(tx)).toEqual([]);
        return sql`INSERT INTO ${t('project')} (tenant_id, name) VALUES (${ghost.tenantId}, 'x')`.execute(
          tx,
        );
      }),
    );
    expect(result).toBe('23503'); // foreign key to platform.tenant
  });
});

describe('C. cross-tenant denial (tenant A context)', () => {
  it('C1: SELECT of B rows — by id and by full scan — returns nothing of B', async () => {
    const rows = await withTenantTransaction(db, ctx('A'), async (tx) => ({
      byId: await sql`SELECT id FROM ${t('project')} WHERE id = ${PROJECTS.B[0]}`.execute(tx),
      scan: await visible(tx),
    }));
    expect(rows.byId.rows).toEqual([]);
    expect(rows.scan.every((r) => r.tenant_id === T.A)).toBe(true);
  });

  it('C2: INSERT with tenant_id = B is rejected', async () => {
    expect(
      await code(
        withTenantTransaction(db, ctx('A'), (tx) =>
          sql`INSERT INTO ${t('project')} (tenant_id, name) VALUES (${T.B}, 'intrusion')`.execute(
            tx,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it("C3: UPDATE of B rows affects 0 rows and B's data is unchanged", async () => {
    const n = await withTenantTransaction(db, ctx('A'), async (tx) =>
      affected(
        await sql`UPDATE ${t('project')} SET name = 'hijacked' WHERE tenant_id = ${T.B}`.execute(
          tx,
        ),
      ),
    );
    expect(n).toBe(0);
    const names = await withTenantTransaction(db, ctx('B'), (tx) =>
      sql<{ name: string }>`SELECT name FROM ${t('project')} ORDER BY name`.execute(tx),
    );
    expect(names.rows.map((r) => r.name)).toEqual([
      'Fictional B project 0',
      'Fictional B project 1',
    ]);
  });

  it('C4: moving an A row to tenant B (UPDATE tenant_id) is rejected', async () => {
    expect(
      await code(
        withTenantTransaction(db, ctx('A'), (tx) =>
          sql`UPDATE ${t('scenario')} SET tenant_id = ${T.B} WHERE project_id = ${PROJECTS.A[0]}`.execute(
            tx,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it("C5: DELETE of B rows affects 0 rows and B's rows remain", async () => {
    const n = await withTenantTransaction(db, ctx('A'), async (tx) =>
      affected(await sql`DELETE FROM ${t('scenario')} WHERE tenant_id = ${T.B}`.execute(tx)),
    );
    expect(n).toBe(0);
    const rows = await withTenantTransaction(db, ctx('B'), (tx) => visible(tx, 'scenario'));
    expect(rows).toHaveLength(2);
  });

  it("C6: linking an A row to B's record is rejected by the composite foreign key", async () => {
    expect(
      await code(
        withTenantTransaction(db, ctx('A'), (tx) =>
          sql`INSERT INTO ${t('scenario')} (tenant_id, project_id, code)
              VALUES (${T.A}, ${PROJECTS.B[0]}, 'F099')`.execute(tx),
        ),
      ),
    ).toBe('23503');
  });

  it('C7: platform.tenant — own row only; no create, update or delete', async () => {
    const own = await withTenantTransaction(db, ctx('A'), (tx) =>
      tx.selectFrom('platform.tenant').select(['id', 'slug']).execute(),
    );
    expect(own).toEqual([{ id: T.A, slug: `${SLUG}-a` }]);
    expect(await db.selectFrom('platform.tenant').selectAll().execute()).toEqual([]); // no context
    for (const attempt of [
      (tx: Kysely<never>) =>
        sql`INSERT INTO platform.tenant (slug, display_name) VALUES ('zz-x', 'x')`.execute(tx),
      (tx: Kysely<never>) =>
        sql`UPDATE platform.tenant SET display_name = 'x' WHERE id = ${T.A}`.execute(tx),
      (tx: Kysely<never>) => sql`DELETE FROM platform.tenant WHERE id = ${T.A}`.execute(tx),
    ]) {
      expect(await code(withTenantTransaction(db, ctx('A'), (tx) => attempt(tx as never)))).toBe(
        '42501',
      );
    }
  });
});

describe('D. real roles and privileges of pbe_app', () => {
  const asApp = (statement: string) => withClient(dbConfig('app'), (c) => c.query(statement));

  it('D1: owns nothing, so it cannot disable, un-force or alter RLS, change ownership or truncate', async () => {
    const owned = await withClient(dbConfig('migrator'), (c) =>
      c.query(`SELECT (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid)
                    + (SELECT count(*)::int FROM pg_namespace WHERE nspowner = r.oid)
                    + (SELECT count(*)::int FROM pg_proc WHERE proowner = r.oid)
                    + (SELECT count(*)::int FROM pg_database WHERE datdba = r.oid) AS n
                 FROM pg_roles r WHERE rolname = 'pbe_app'`),
    );
    expect(owned.rows[0].n).toBe(0);
    for (const statement of [
      `ALTER TABLE ${S}.project DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${S}.project NO FORCE ROW LEVEL SECURITY`,
      `DROP POLICY tenant_isolation ON ${S}.project`,
      `ALTER POLICY tenant_isolation ON ${S}.project USING (true)`,
      `CREATE POLICY open_door ON ${S}.project FOR ALL TO pbe_app USING (true)`,
      `ALTER TABLE ${S}.project OWNER TO pbe_app`,
      `TRUNCATE ${S}.project CASCADE`,
      `TRUNCATE ${S}.scenario`,
      'ALTER TABLE platform.tenant DISABLE ROW LEVEL SECURITY',
      'DROP POLICY tenant_self_read ON platform.tenant',
      'TRUNCATE platform.tenant CASCADE',
      'CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$',
    ]) {
      expect([statement, await code(asApp(statement))]).toEqual([statement, '42501']);
    }
    await expect(assertSafeRuntimeRole(db)).resolves.toBeUndefined();
  });

  it('D2: cannot escalate — no role switching, no self-grants, no role changes', async () => {
    for (const statement of [
      'SET ROLE pbe_owner',
      'SET ROLE pbe_migrator',
      'SET ROLE pbe_restore_drill',
      'SET SESSION AUTHORIZATION pbe_owner',
      'GRANT pbe_owner TO pbe_app',
      'CREATE ROLE zz_escalation',
      'ALTER ROLE pbe_app BYPASSRLS',
      'ALTER ROLE pbe_app SUPERUSER',
      'ALTER ROLE pbe_app CREATEROLE',
    ]) {
      expect([statement, await code(asApp(statement))]).toEqual([statement, '42501']);
    }
    // A self-grant of TRUNCATE is silently ineffective (PostgreSQL warns); prove nothing changed.
    await asApp(`GRANT TRUNCATE ON ${S}.project TO pbe_app`).catch(() => undefined);
    const after = await withClient(dbConfig('migrator'), (c) =>
      c.query(
        `SELECT has_table_privilege('pbe_app', $1, 'TRUNCATE') AS truncate,
                (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                  WHERE r.rolname = 'pbe_app') AS memberships`,
        [`${S}.project`],
      ),
    );
    expect(after.rows[0]).toEqual({ truncate: false, memberships: 0 });
  });

  it('D3+D4: not a superuser, no BYPASSRLS; switching row security off makes the query fail instead of bypassing', async () => {
    const attrs = await withClient(dbConfig('migrator'), (c) =>
      c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'pbe_app'`),
    );
    expect(attrs.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const outcome = await code(
      withTenantTransaction(db, ctx('A'), async (tx) => {
        await sql`SET LOCAL row_security = off`.execute(tx);
        return visible(tx);
      }),
    );
    expect(outcome).toBe('42501'); // "query would be affected by row-level security policy"
  });

  it('LIMITATION (documented, R-007): PostgreSQL lets the runtime role set app.tenant_id itself; only the gateway and lint rule stop application code from doing so', async () => {
    // This records real PostgreSQL behaviour so the report cannot overstate the guarantee:
    // custom settings cannot be restricted per role. Prevention is architectural (ADR-021).
    const rows = await db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.tenant_id', ${T.B}, true)`.execute(tx);
      return visible(tx);
    });
    expect(rows.every((r) => r.tenant_id === T.B)).toBe(true);
    expect(rows).toHaveLength(PROJECTS.B.length);
  });
});
