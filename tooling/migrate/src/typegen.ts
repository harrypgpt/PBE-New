import type pg from 'pg';
import { MigrationError } from './errors';

/**
 * In-house generator of Kysely database types (ADR-021). Reads PostgreSQL's catalogue and maps
 * every column with an explicit table of supported types. Anything unsupported or ambiguous
 * stops generation with a list of the offending columns — it never falls back to `any`.
 * Output is deterministic: sorted, no timestamps.
 */

/** Schemas the API may use. "training" (no runtime access) and "public" (unused) are excluded. */
export const TYPEGEN_SCHEMAS: readonly string[] = ['app', 'audit', 'pbe_meta', 'platform'];

export interface ColumnMeta {
  schema: string;
  table: string;
  column: string;
  /** pg_attribute.attnum: the column's position in its table (output follows it). */
  position: number;
  /** pg_type.typname of the column type (for arrays: of the array type, e.g. "_text"). */
  typeName: string;
  /** pg_type.typtype: b base, e enum, d domain, c composite, r range, m multirange, p pseudo. */
  typeKind: string;
  /** For arrays: element type name and kind. */
  elementName: string | null;
  elementKind: string | null;
  /** For domains: base type name. */
  domainBaseName: string | null;
  notNull: boolean;
  hasDefault: boolean;
  /** pg_attribute.attidentity: '' none, 'a' always, 'd' by default. */
  identity: string;
  /** pg_attribute.attgenerated: '' none, 's' stored, 'v' virtual. */
  generated: string;
}

/** Scalar PostgreSQL types → TypeScript. Exact decimals and 64-bit integers stay strings. */
const SCALARS: Readonly<Record<string, string>> = {
  uuid: 'string',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  name: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'string',
  numeric: 'string',
  float4: 'number',
  float8: 'number',
  bool: 'boolean',
  timestamptz: 'Timestamp',
  timestamp: 'Timestamp',
  date: 'Timestamp',
  json: 'Json',
  jsonb: 'Json',
  bytea: 'Buffer',
  // pg returns inet values as text, e.g. "127.0.0.1" or "::1" (Stage 6 security events).
  inet: 'string',
};

export async function readColumnMetadata(
  client: pg.Client,
  schemas: readonly string[],
): Promise<{ columns: ColumnMeta[]; enums: Map<string, string[]> }> {
  const res = await client.query<{
    schema: string;
    table: string;
    column: string;
    position: number;
    type_name: string;
    type_kind: string;
    element_name: string | null;
    element_kind: string | null;
    domain_base_name: string | null;
    not_null: boolean;
    has_default: boolean;
    identity: string;
    generated: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, a.attnum::int AS position,
            t.typname AS type_name, t.typtype::text AS type_kind,
            et.typname AS element_name, et.typtype::text AS element_kind,
            bt.typname AS domain_base_name,
            a.attnotnull AS not_null, a.atthasdef AS has_default,
            a.attidentity::text AS identity, a.attgenerated::text AS generated
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_catalog.pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
       LEFT JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd'
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas],
  );
  const enumRes = await client.query<{ name: string; labels: string[] }>(
    `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      GROUP BY t.typname`,
  );
  return {
    columns: res.rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      column: r.column,
      position: r.position,
      typeName: r.type_name,
      typeKind: r.type_kind,
      elementName: r.element_name,
      elementKind: r.element_kind,
      domainBaseName: r.domain_base_name,
      notNull: r.not_null,
      hasDefault: r.has_default,
      identity: r.identity,
      generated: r.generated,
    })),
    enums: new Map(enumRes.rows.map((r) => [r.name, r.labels])),
  };
}

function scalar(name: string, kind: string, enums: Map<string, string[]>): string | null {
  if (kind === 'e') {
    const labels = enums.get(name);
    return labels && labels.length > 0 ? labels.map((l) => JSON.stringify(l)).join(' | ') : null;
  }
  if (kind !== 'b') return null;
  return SCALARS[name] ?? null;
}

/** TypeScript type of one column, or null if the PostgreSQL type is not supported. */
export function columnType(col: ColumnMeta, enums: Map<string, string[]>): string | null {
  let base: string | null;
  if (col.elementName !== null) {
    const el = scalar(col.elementName, col.elementKind ?? '', enums);
    base = el === null ? null : el.includes('|') ? `(${el})[]` : `${el}[]`;
  } else if (col.typeKind === 'd') {
    base = col.domainBaseName === null ? null : scalar(col.domainBaseName, 'b', enums);
  } else {
    base = scalar(col.typeName, col.typeKind, enums);
  }
  if (base === null) return null;
  const valueType = col.notNull ? base : `${base} | null`;
  // Kysely does not unwrap a ColumnType nested inside Generated<…>, so a timestamp with a default
  // gets an explicit ColumnType (select Date; insert optional; update allowed). Stage 7A finding.
  if (base === 'Timestamp') {
    const sel = col.notNull ? 'Date' : 'Date | null';
    const write = col.notNull ? 'Date | string' : 'Date | string | null';
    if (col.identity === 'a' || col.generated !== '') return `ColumnType<${sel}, never, never>`;
    if (col.hasDefault) return `ColumnType<${sel}, ${write} | undefined, ${write}>`;
  }
  if (col.identity === 'a' || col.generated !== '') return `GeneratedAlways<${valueType}>`;
  if (col.hasDefault || col.identity === 'd') return `Generated<${valueType}>`;
  return valueType;
}

function pascal(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}

/** Pure, deterministic rendering of the TypeScript module. Throws on unsupported columns. */
export function renderTypes(
  columns: readonly ColumnMeta[],
  enums: Map<string, string[]>,
  source: { versions: readonly number[]; schemas: readonly string[] },
): string {
  const unsupported: string[] = [];
  const tables = new Map<string, { iface: string; lines: string[] }>();
  // Tables in name order, columns in table position order: independent of input order.
  const sorted = [...columns].sort(
    (a, b) =>
      `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`) || a.position - b.position,
  );
  for (const col of sorted) {
    const key = `${col.schema}.${col.table}`;
    if (!tables.has(key)) {
      tables.set(key, { iface: `${pascal(col.schema)}${pascal(col.table)}`, lines: [] });
    }
    const type = columnType(col, enums);
    if (type === null) {
      unsupported.push(
        `${key}.${col.column}: ${col.typeKind === 'd' ? `domain over ${col.domainBaseName}` : col.elementName ? `${col.elementName}[]` : col.typeName}`,
      );
      continue;
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(col.column)) {
      unsupported.push(`${key}.${col.column}: column name must be a plain lower-case identifier`);
      continue;
    }
    tables.get(key)!.lines.push(`  ${col.column}: ${type};`);
  }
  const names = [...tables.values()].map((t) => t.iface);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) unsupported.push(`two tables map to the same interface name ${duplicate}`);
  if (unsupported.length > 0) {
    throw new MigrationError(
      'TYPEGEN_UNSUPPORTED',
      'Database type generation stopped: unsupported or ambiguous PostgreSQL metadata. Add an explicit mapping or change the column type.',
      unsupported,
    );
  }

  const out: string[] = [
    '// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run db -- typegen',
    `// Source: pbe_test with migrations ${source.versions.map((v) => String(v).padStart(4, '0')).join(', ') || '(none)'}; schemas ${source.schemas.join(', ')}.`,
    '// Mapping: numeric and bigint → string (exact), timestamptz/timestamp/date → Date, jsonb → Json, bytea → Buffer.',
    "import type { ColumnType, Generated, GeneratedAlways } from 'kysely';",
    '',
    'export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };',
    'export type Timestamp = ColumnType<Date, Date | string, Date | string>;',
  ];
  // Keep the imports used even when no column needs them (stable output, no unused-type lint).
  out.push('export type { Generated, GeneratedAlways };');
  for (const [, t] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push('', `export interface ${t.iface} {`, ...t.lines, '}');
  }
  out.push(
    '',
    '/** Migration versions these types were generated from. The API refuses to start if the ledger differs. */',
    `export const SCHEMA_VERSIONS: readonly number[] = [${source.versions.join(', ')}];`,
  );
  out.push('', 'export interface DB {');
  for (const [key, t] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`  '${key}': ${t.iface};`);
  }
  out.push('}', '');
  return out.join('\n');
}
