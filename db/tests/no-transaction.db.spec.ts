import { migrate } from '../../tooling/migrate/src/runner';
import { exists, readSql, Scratch } from './helpers';

// Kept in one file (run sequentially) because the invalid-index guard looks at all user schemas
// of pbe_dev, including other tests' zz_test_* schemas.
const NO_TX = '-- pbe:phase expand\n-- pbe:no-transaction';

const scratches: Scratch[] = [];
afterAll(async () => {
  for (const s of scratches) await s.cleanup();
});
function scratch(): Scratch {
  const s = new Scratch();
  scratches.push(s);
  s.write(
    1,
    'create_table',
    "CREATE SCHEMA {s};\nCREATE TABLE {s}.item (id integer, label text);\nINSERT INTO {s}.item VALUES (1, 'a'), (2, 'a');",
  );
  return s;
}

async function indexValid(name: string): Promise<boolean | null> {
  const res = await readSql(
    `SELECT i.indisvalid AS v FROM pg_catalog.pg_index i WHERE i.indexrelid = pg_catalog.to_regclass($1)`,
    [name],
  );
  return res.rows[0]?.v ?? null;
}

describe('no-transaction migrations', () => {
  it('apply CREATE INDEX CONCURRENTLY and are recorded as non-transactional', async () => {
    const s = scratch();
    s.write(
      2,
      'label_index',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS item_label_idx ON {s}.item (label);',
      NO_TX,
    );
    const r = await migrate(s.options());
    expect(r.applied.map((a) => a.version)).toEqual([1, 2]);
    expect((await s.ledger()).map((l) => l.transactional)).toEqual([true, false]);
    expect(await indexValid(`${s.schema}.item_label_idx`)).toBe(true);
  });

  it('the same statement without the directive fails inside the transaction and is rolled back', async () => {
    const s = scratch();
    s.write(
      2,
      'label_index',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS item_label_idx ON {s}.item (label);',
    );
    const err = await migrate(s.options()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((err as { details: string[] }).details.join()).toMatch(/SQLSTATE 25001/);
    expect((await s.ledger()).map((l) => l.version)).toEqual([1]);
    expect(await exists(`${s.schema}.item_label_idx`)).toBe(false);
  });

  it('a failed concurrent index leaves an INVALID index; the runner refuses to record a re-run until it is repaired', async () => {
    const s = scratch();
    s.write(
      2,
      'unique_label',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS item_label_uq ON {s}.item (label);',
      NO_TX,
    );

    // 1. Duplicate labels make the build fail; PostgreSQL leaves an INVALID index behind.
    const first = await migrate(s.options()).catch((e: unknown) => e);
    expect(first).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((first as { details: string[] }).details.join()).toMatch(/SQLSTATE 23505/);
    expect(await indexValid(`${s.schema}.item_label_uq`)).toBe(false);
    expect((await s.ledger()).map((l) => l.version)).toEqual([1]);

    // 2. A plain re-run: IF NOT EXISTS skips the invalid index, but the runner refuses to record it.
    const second = await migrate(s.options()).catch((e: unknown) => e);
    expect(second).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((second as { details: string[] }).details.join()).toMatch(
      new RegExp(`invalid index: ${s.schema}\\.item_label_uq`),
    );
    expect((await s.ledger()).map((l) => l.version)).toEqual([1]);

    // 3. Documented recovery: drop the invalid index, fix the data, re-run.
    await s.sql(`DROP INDEX ${s.schema}.item_label_uq`);
    await s.sql(`UPDATE ${s.schema}.item SET label = 'b' WHERE id = 2`);
    const third = await migrate(s.options());
    expect(third.applied.map((a) => a.version)).toEqual([2]);
    expect(await indexValid(`${s.schema}.item_label_uq`)).toBe(true);
  });
});
