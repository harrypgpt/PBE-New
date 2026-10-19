import { MigrationError } from '../src/errors';
import { columnType, renderTypes, type ColumnMeta } from '../src/typegen';

const col = (over: Partial<ColumnMeta>): ColumnMeta => ({
  schema: 'app',
  table: 'sample',
  column: 'value',
  position: 1,
  typeName: 'text',
  typeKind: 'b',
  elementName: null,
  elementKind: null,
  domainBaseName: null,
  notNull: true,
  hasDefault: false,
  identity: '',
  generated: '',
  ...over,
});
const enums = new Map([['study_design', ['crossover', 'parallel']]]);
const SOURCE = { versions: [1, 2], schemas: ['app'] };

describe('columnType — explicit PostgreSQL → TypeScript mapping', () => {
  it.each([
    ['uuid', 'string'],
    ['inet', 'string'],
    ['text', 'string'],
    ['varchar', 'string'],
    ['int2', 'number'],
    ['int4', 'number'],
    ['int8', 'string'],
    ['numeric', 'string'],
    ['float8', 'number'],
    ['bool', 'boolean'],
    ['timestamptz', 'Timestamp'],
    ['date', 'Timestamp'],
    ['jsonb', 'Json'],
    ['bytea', 'Buffer'],
  ])('%s → %s', (typeName, expected) => {
    expect(columnType(col({ typeName }), enums)).toBe(expected);
  });

  it('exact decimals and 64-bit integers are never mapped to a lossy number', () => {
    expect(columnType(col({ typeName: 'numeric' }), enums)).toBe('string');
    expect(columnType(col({ typeName: 'int8' }), enums)).toBe('string');
  });

  it('a timestamp with a default gets an explicit ColumnType (Kysely does not unwrap Generated<Timestamp>)', () => {
    expect(columnType(col({ typeName: 'timestamptz', hasDefault: true }), enums)).toBe(
      'ColumnType<Date, Date | string | undefined, Date | string>',
    );
    expect(
      columnType(col({ typeName: 'timestamptz', hasDefault: true, notNull: false }), enums),
    ).toBe('ColumnType<Date | null, Date | string | null | undefined, Date | string | null>');
    expect(columnType(col({ typeName: 'timestamptz' }), enums)).toBe('Timestamp');
  });

  it('nullable, default, identity and generated columns', () => {
    expect(columnType(col({ notNull: false }), enums)).toBe('string | null');
    expect(columnType(col({ hasDefault: true }), enums)).toBe('Generated<string>');
    expect(columnType(col({ identity: 'd', typeName: 'int8' }), enums)).toBe('Generated<string>');
    expect(columnType(col({ identity: 'a', typeName: 'int8' }), enums)).toBe(
      'GeneratedAlways<string>',
    );
    expect(columnType(col({ generated: 's', notNull: false }), enums)).toBe(
      'GeneratedAlways<string | null>',
    );
  });

  it('enums, arrays and domains', () => {
    expect(columnType(col({ typeName: 'study_design', typeKind: 'e' }), enums)).toBe(
      '"crossover" | "parallel"',
    );
    expect(
      columnType(col({ typeName: '_text', elementName: 'text', elementKind: 'b' }), enums),
    ).toBe('string[]');
    expect(
      columnType(
        col({ typeName: '_study_design', elementName: 'study_design', elementKind: 'e' }),
        enums,
      ),
    ).toBe('("crossover" | "parallel")[]');
    expect(
      columnType(col({ typeName: 'percent', typeKind: 'd', domainBaseName: 'numeric' }), enums),
    ).toBe('string');
  });

  it.each([
    ['interval', 'b'],
    ['tsvector', 'b'],
    ['cidr', 'b'],
    ['tstzrange', 'r'],
    ['some_composite', 'c'],
    ['unknown_enum', 'e'],
  ])('unsupported %s → null (never a silent any)', (typeName, typeKind) => {
    expect(columnType(col({ typeName, typeKind }), enums)).toBeNull();
  });
});

describe('renderTypes', () => {
  const columns = [
    col({ schema: 'platform', table: 'tenant', column: 'id', typeName: 'uuid', hasDefault: true }),
    col({ schema: 'app', table: 'project', column: 'tenant_id', typeName: 'uuid', position: 1 }),
    col({ schema: 'app', table: 'project', column: 'name', typeName: 'text', position: 2 }),
    col({
      schema: 'app',
      table: 'project',
      column: 'amount',
      typeName: 'numeric',
      notNull: false,
      position: 3,
    }),
  ];

  it('is deterministic and independent of input order', () => {
    const a = renderTypes(columns, enums, SOURCE);
    const b = renderTypes([...columns].reverse(), enums, SOURCE);
    expect(a).toBe(b);
    expect(a).toBe(renderTypes(columns, enums, SOURCE));
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps in the output
  });

  it('renders schema-qualified tables and interfaces', () => {
    const out = renderTypes(columns, enums, SOURCE);
    expect(out).toContain("  'app.project': AppProject;");
    expect(out).toContain("  'platform.tenant': PlatformTenant;");
    expect(out).toContain('  amount: string | null;');
    expect(out).toContain('// Source: pbe_test with migrations 0001, 0002; schemas app.');
  });

  it('stops with every unsupported column listed', () => {
    let err: unknown;
    try {
      renderTypes(
        [
          ...columns,
          col({ table: 'project', column: 'duration', typeName: 'interval', position: 4 }),
          col({ table: 'project', column: 'search', typeName: 'tsvector', position: 5 }),
        ],
        enums,
        SOURCE,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe('TYPEGEN_UNSUPPORTED');
    expect((err as MigrationError).details).toEqual([
      'app.project.duration: interval',
      'app.project.search: tsvector',
    ]);
  });

  it('rejects ambiguous names (two tables mapping to one interface; non-identifier columns)', () => {
    expect(() =>
      renderTypes(
        [
          col({ schema: 'app', table: 'a_b', column: 'x' }),
          col({ schema: 'app_a', table: 'b', column: 'x' }),
        ],
        enums,
        SOURCE,
      ),
    ).toThrow(/unsupported or ambiguous/);
    expect(() => renderTypes([col({ column: 'Weird Name' })], enums, SOURCE)).toThrow(
      MigrationError,
    );
  });
});
