import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Privileges are compared as EFFECTIVE privileges: an empty ACL (meaning "the default") is
 * replaced by PostgreSQL's acldefault(), so "{owner=UC/owner}" and "default" compare equal while
 * any real difference in who may do what is still reported. Column ACLs have no default form and
 * are compared as stored.
 *
 * Catalogue fingerprint of the given schemas: one sorted text line per object, covering
 * ownership, privileges, columns, constraints, indexes, triggers, RLS settings and policies,
 * functions, views, types and sequences. Two databases built from the same migrations have
 * identical fingerprints; anything changed outside the migrations shows up as a difference.
 *
 * `rename` maps schema names to placeholders so differently-named schemas can be compared.
 */
export async function schemaFingerprint(
  client: pg.Client,
  schemas: readonly string[],
  rename: Readonly<Record<string, string>> = {},
): Promise<string[]> {
  const q = async (sql: string): Promise<string[][]> => {
    const res = await client.query({ text: sql, values: [schemas], rowMode: 'array' });
    return (res.rows as unknown[][]).map((r) => r.map((v) => (v === null ? '∅' : String(v))));
  };
  const lines: string[] = [];
  const add = (kind: string, rows: string[][]): void => {
    for (const r of rows) lines.push(`${kind} ${r.join(' | ')}`);
  };

  add(
    'schema',
    await q(`SELECT n.nspname, pg_catalog.pg_get_userbyid(n.nspowner),
             coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))::text
      FROM pg_catalog.pg_namespace n WHERE n.nspname = ANY($1)`),
  );
  add(
    'relation',
    await q(`SELECT n.nspname, c.relname, c.relkind::text, pg_catalog.pg_get_userbyid(c.relowner),
             c.relrowsecurity, c.relforcerowsecurity,
             coalesce(c.relacl, pg_catalog.acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))::text
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`),
  );
  add(
    'column',
    await q(`SELECT n.nspname, c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
             a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attidentity::text,
             a.attgenerated::text, a.attacl::text
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`),
  );
  add(
    'constraint',
    await q(`SELECT n.nspname, c.relname, con.conname, pg_catalog.pg_get_constraintdef(con.oid)
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1)`),
  );
  add(
    'index',
    await q(`SELECT n.nspname, ic.relname, pg_catalog.pg_get_indexdef(i.indexrelid), i.indisvalid
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = ANY($1)`),
  );
  add(
    'trigger',
    await q(`SELECT n.nspname, c.relname, t.tgname, pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled::text
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND NOT t.tgisinternal`),
  );
  add(
    'policy',
    await q(`SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
      FROM pg_catalog.pg_policies WHERE schemaname = ANY($1)`),
  );
  add(
    'view',
    await q(`SELECT n.nspname, c.relname, pg_catalog.pg_get_viewdef(c.oid)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm')`),
  );
  add(
    'enum',
    await q(`SELECT n.nspname, t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1) GROUP BY n.nspname, t.typname`),
  );
  add(
    'domain',
    await q(`SELECT n.nspname, t.typname, pg_catalog.format_type(t.typbasetype, t.typtypmod), t.typnotnull
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1) AND t.typtype = 'd'`),
  );
  add(
    'sequence',
    await q(`SELECT schemaname, sequencename, data_type::text, start_value, increment_by,
             min_value, max_value, cycle
      FROM pg_catalog.pg_sequences WHERE schemaname = ANY($1)`),
  );
  add(
    'default-acl',
    await q(`SELECT pg_catalog.pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype::text, d.defaclacl::text
      FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = ANY($1)`),
  );
  // Function bodies can be long: compare a hash of the full definition.
  for (const [schema, name, args, owner, acl, def] of await q(`SELECT n.nspname, p.proname,
             pg_catalog.pg_get_function_identity_arguments(p.oid), pg_catalog.pg_get_userbyid(p.proowner),
             coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))::text, pg_catalog.pg_get_functiondef(p.oid)
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')`)) {
    const normalised = applyRename(def ?? '', rename);
    lines.push(
      `function ${[schema, name, args, owner, acl].join(' | ')} | ${createHash('sha256').update(normalised).digest('hex')}`,
    );
  }

  return [...new Set(lines.map((l) => applyRename(l, rename)))].sort();
}

function applyRename(text: string, rename: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [from, to] of Object.entries(rename)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return out;
}

export interface FingerprintDiff {
  equal: boolean;
  onlyInFirst: string[];
  onlyInSecond: string[];
}

export function diffFingerprints(
  first: readonly string[],
  second: readonly string[],
): FingerprintDiff {
  const a = new Set(first);
  const b = new Set(second);
  const onlyInFirst = first.filter((l) => !b.has(l));
  const onlyInSecond = second.filter((l) => !a.has(l));
  return {
    equal: onlyInFirst.length === 0 && onlyInSecond.length === 0,
    onlyInFirst,
    onlyInSecond,
  };
}

/**
 * The snapshot file holds one fingerprint entry per line. Some entries span several lines (for
 * example a policy expression), so backslashes and line breaks are escaped when writing and the
 * live fingerprint is escaped the same way before comparing.
 */
export function snapshotLines(entries: readonly string[]): string[] {
  return entries.map((e) => e.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n'));
}
