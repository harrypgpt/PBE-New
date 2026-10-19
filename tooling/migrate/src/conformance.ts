import type pg from 'pg';

/**
 * RLS conformance check for tenant-owned tables (STAGE-03-PLAN.md §3.6, db/templates/tenant-table.sql).
 * Reads PostgreSQL's catalogue and reports every table in `schema` that breaks a rule.
 * An empty result means every table conforms (including when the schema has no tables).
 */

export const RUNTIME_ROLE = 'pbe_app';

export type ConformanceRule =
  | 'tenant_id_column'
  | 'rls_enabled'
  | 'rls_forced'
  | 'tenant_policy'
  | 'tenant_fk'
  | 'composite_fk'
  | 'runtime_not_owner'
  | 'no_truncate'
  | 'no_public_access';

export interface ConformanceViolation {
  table: string;
  rule: ConformanceRule;
  detail: string;
}

export async function checkTenantTables(
  client: pg.Client,
  schema: string,
): Promise<ConformanceViolation[]> {
  const tables = await client.query<{
    oid: number;
    table: string;
    rls: boolean;
    forced: boolean;
    owner: string;
    tenant_attnum: number | null;
    tenant_type: string | null;
    tenant_not_null: boolean | null;
    runtime_truncate: boolean;
    public_grants: number;
  }>(
    `SELECT c.oid, c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner,
            a.attnum AS tenant_attnum, pg_catalog.format_type(a.atttypid, a.atttypmod) AS tenant_type,
            a.attnotnull AS tenant_not_null,
            pg_catalog.has_table_privilege($2, c.oid, 'TRUNCATE') AS runtime_truncate,
            (SELECT count(*)::int FROM pg_catalog.aclexplode(c.relacl) x WHERE x.grantee = 0) AS public_grants
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attribute a
              ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [schema, RUNTIME_ROLE],
  );

  const violations: ConformanceViolation[] = [];
  const add = (table: string, rule: ConformanceRule, detail: string): void => {
    violations.push({ table: `${schema}.${table}`, rule, detail });
  };

  for (const t of tables.rows) {
    if (t.tenant_attnum === null) {
      add(t.table, 'tenant_id_column', 'no tenant_id column');
    } else if (t.tenant_type !== 'uuid' || !t.tenant_not_null) {
      add(
        t.table,
        'tenant_id_column',
        `tenant_id must be uuid NOT NULL (is ${t.tenant_type}${t.tenant_not_null ? ' NOT NULL' : ', nullable'})`,
      );
    }
    if (!t.rls) add(t.table, 'rls_enabled', 'row-level security is not enabled');
    if (!t.forced) add(t.table, 'rls_forced', 'row-level security is not forced');
    if (t.owner === RUNTIME_ROLE)
      add(t.table, 'runtime_not_owner', `${RUNTIME_ROLE} owns the table`);
    if (t.runtime_truncate) add(t.table, 'no_truncate', `${RUNTIME_ROLE} may TRUNCATE the table`);
    if (t.public_grants > 0) add(t.table, 'no_public_access', 'PUBLIC has privileges on the table');

    // A permissive FOR ALL policy for the runtime role, keyed on tenant_id and the context function
    // in both USING and WITH CHECK.
    const policies = await client.query<{ qual: string | null; check: string | null }>(
      `SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
              pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
         FROM pg_catalog.pg_policy p
        WHERE p.polrelid = $1 AND p.polcmd = '*' AND p.polpermissive
          AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $2) = ANY (p.polroles)`,
      [t.oid, RUNTIME_ROLE],
    );
    const keyed = (e: string | null): boolean =>
      e !== null && /\btenant_id\b/.test(e) && /current_tenant_id\(\)/.test(e);
    if (!policies.rows.some((p) => keyed(p.qual) && keyed(p.check))) {
      add(
        t.table,
        'tenant_policy',
        `no FOR ALL policy for ${RUNTIME_ROLE} with tenant_id = app.current_tenant_id() in USING and WITH CHECK`,
      );
    }

    // Foreign keys: one on (tenant_id) to platform.tenant; every FK to another tenant table must
    // include tenant_id on both sides, in the same position.
    const fks = await client.query<{
      name: string;
      target: string;
      conkey: number[];
      confkey: number[];
      target_tenant_attnum: number | null;
    }>(
      `SELECT con.conname AS name, con.confrelid::regclass::text AS target,
              con.conkey, con.confkey,
              (SELECT attnum FROM pg_catalog.pg_attribute
                WHERE attrelid = con.confrelid AND attname = 'tenant_id' AND NOT attisdropped) AS target_tenant_attnum
         FROM pg_catalog.pg_constraint con
        WHERE con.conrelid = $1 AND con.contype = 'f'`,
      [t.oid],
    );
    if (t.tenant_attnum !== null) {
      const toTenant = fks.rows.some(
        (f) =>
          f.target === 'platform.tenant' &&
          f.conkey.length === 1 &&
          f.conkey[0] === t.tenant_attnum,
      );
      if (!toTenant) add(t.table, 'tenant_fk', 'no foreign key (tenant_id) → platform.tenant (id)');
      for (const f of fks.rows) {
        if (f.target === 'platform.tenant' || f.target_tenant_attnum === null) continue;
        const pos = f.conkey.indexOf(t.tenant_attnum);
        if (pos === -1 || f.confkey[pos] !== f.target_tenant_attnum) {
          add(
            t.table,
            'composite_fk',
            `foreign key ${f.name} → ${f.target} does not include tenant_id on both sides`,
          );
        }
      }
    }
  }
  return violations;
}

/** The PBE schemas a complete backup must be able to read (STAGE-07A-BACKUP-REVIEW.md). */
export const BACKUP_SCHEMAS = ['app', 'platform', 'audit', 'training', 'pbe_meta'] as const;

/**
 * Every table, partitioned table and sequence in the PBE schemas must be readable by the backup
 * role, and every PBE schema usable by it; otherwise a backup could silently miss data. Returns
 * one line per problem (empty = conformant). Migrations that add a table must grant SELECT to the
 * backup role; this check fails the build when one is missed.
 */
export async function backupReadabilityViolations(
  client: pg.Client,
  role: string,
  schemas: readonly string[] = BACKUP_SCHEMAS,
): Promise<string[]> {
  const exists = await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) return [`role ${role} does not exist`];
  const res = await client.query<{ problem: string }>(
    `SELECT format('schema %s: no USAGE', n.nspname) AS problem
       FROM pg_catalog.pg_namespace n
      WHERE n.nspname = ANY($2) AND NOT pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
     UNION ALL
     SELECT format('%s.%s (%s): not readable', n.nspname, c.relname,
                   CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END)
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'S')
        AND NOT pg_catalog.has_table_privilege($1, c.oid, 'SELECT')
      ORDER BY 1`,
    [role, schemas],
  );
  return res.rows.map((r) => r.problem);
}

/**
 * Backup coverage (STAGE-07A-BACKUP-REVIEW.md §17): everything a complete backup must contain is
 * readable by the backup role, and nothing PBE-owned lies outside the backed-up and verified
 * schema list. Empty = conformant. Used by the migration runner (a migration that forgets the
 * backup grant is rolled back) and by the restore drill (refuses to run when not conformant).
 *  - every BACKUP_SCHEMAS schema, table and sequence readable (backupReadabilityViolations);
 *  - no schema owned by `ownerRole` outside BACKUP_SCHEMAS (it would be dumped but never
 *    compared). Temporary zz_test_* schemas created by the automated tests are ignored;
 *  - no large objects: PBE stores none, so any large object is unexpected data;
 *  - no default privileges (they would make the restore fail).
 */
export async function backupCoverageViolations(
  client: pg.Client,
  role: string,
  ownerRole: string | null = 'pbe_owner',
): Promise<string[]> {
  const problems = await backupReadabilityViolations(client, role);
  if (ownerRole !== null) {
    const unlisted = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_catalog.pg_namespace n
        WHERE pg_catalog.pg_get_userbyid(n.nspowner) = $1 AND NOT (n.nspname = ANY($2))
          AND n.nspname NOT LIKE 'zz\\_test\\_%' ORDER BY 1`,
      [ownerRole, BACKUP_SCHEMAS],
    );
    for (const r of unlisted.rows) {
      problems.push(`schema ${r.nspname}: owned by ${ownerRole} but not in BACKUP_SCHEMAS`);
    }
  }
  const lo = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_catalog.pg_largeobject_metadata',
  );
  if ((lo.rows[0]?.n ?? 0) > 0) problems.push(`${lo.rows[0]?.n} large object(s) present`);
  // Default privileges are not used by PBE (F-8): a backup would carry them and a restore by the
  // restore role could not recreate them. Any role (even pbe_backup, for itself) can define some.
  const defacl = await client.query<{ line: string }>(
    `SELECT format('default privileges defined for role %s', pg_catalog.pg_get_userbyid(defaclrole)) AS line
       FROM pg_catalog.pg_default_acl ORDER BY 1`,
  );
  for (const d of defacl.rows) problems.push(d.line);
  return problems;
}

/**
 * Built-in functions that write data, write the WAL, read server files or change server state
 * WITHOUT any further permission check inside them: none may be executable by the backup role.
 * (Advisory locks, NOTIFY, set_config and signalling one's OWN sessions remain possible for every
 * login; they change no stored data.)
 */
export const DANGEROUS_BUILTINS = [
  'lo_create',
  'lo_creat',
  'lo_from_bytea',
  'lo_import',
  'lo_export',
  'pg_logical_emit_message',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_backup_start',
  'pg_backup_stop',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_stat_reset',
  'pg_stat_reset_shared',
  'pg_stat_reset_single_table_counters',
  'pg_stat_reset_slru',
  'pg_stat_reset_replication_slot',
  'pg_replication_origin_create',
  'pg_wal_replay_pause',
  'pg_wal_replay_resume',
  'pg_log_backend_memory_contexts',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_current_logfile',
] as const;

/**
 * Built-ins PostgreSQL lets PUBLIC execute but which check permission INSIDE: large-object writes
 * need UPDATE on (or ownership of) that object, replication-slot functions need the REPLICATION
 * attribute, collation import needs CREATE on the schema. Not counted as violations; the tests
 * prove each is refused for the backup role (backup-v2.throwaway.db.spec.ts).
 */
export const INTERNALLY_GUARDED_BUILTINS = [
  'lo_put',
  'lowrite',
  'lo_truncate',
  'lo_truncate64',
  'lo_unlink',
  'pg_create_physical_replication_slot',
  'pg_create_logical_replication_slot',
  'pg_copy_physical_replication_slot',
  'pg_copy_logical_replication_slot',
  'pg_drop_replication_slot',
  'pg_sync_replication_slots',
  'pg_import_system_collations',
] as const;

/**
 * Least-privilege audit of the backup role in the CURRENT database plus cluster-wide facts
 * (STAGE-07A-BACKUP-REVIEW.md §17). Returns one line per problem; empty = conformant.
 * `connectable` lists every database that accepts connections and whose ACL lets the role connect
 * (template0 accepts none). PostgreSQL's default lets
 * everyone connect to "postgres" and "template1"; pg_hba.conf is what blocks those).
 */
export async function backupPrivilegeAudit(
  client: pg.Client,
  role: string,
): Promise<{ violations: string[]; connectable: string[] }> {
  const v: string[] = [];
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [role]) =>
    (await client.query<T>(sql, params)).rows;

  const [r] = await q<Record<string, boolean | number>>(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolbypassrls,
            rolcanlogin, rolconnlimit FROM pg_catalog.pg_roles WHERE rolname = $1`,
  );
  if (!r) return { violations: [`role ${role} does not exist`], connectable: [] };
  for (const [attr, want] of Object.entries({
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolinherit: false,
    rolbypassrls: true,
    rolcanlogin: true,
  })) {
    if (r[attr] !== want)
      v.push(`attribute ${attr} is ${String(r[attr])}, expected ${String(want)}`);
  }
  for (const o of await q<{ rolname: string }>(
    `SELECT rolname FROM pg_catalog.pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolname <> $1 ORDER BY 1`,
  )) {
    v.push(`another non-superuser role has BYPASSRLS: ${o.rolname}`);
  }
  for (const m of await q<{ line: string }>(
    `SELECT format('membership: %s is a member of %s', pg_catalog.pg_get_userbyid(m.member),
                   pg_catalog.pg_get_userbyid(m.roleid)) AS line
       FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.rolname = $1
      WHERE m.member = r.oid OR m.roleid = r.oid ORDER BY 1`,
  )) {
    v.push(m.line);
  }
  const [ro] = await q<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
                     WHERE r.rolname = $1 AND s.setdatabase = 0
                       AND 'default_transaction_read_only=on' = ANY (s.setconfig)) AS ok`,
  );
  if (!ro?.ok) v.push('role setting default_transaction_read_only=on is missing');
  // A role may change its OWN session defaults (PostgreSQL allows it): anything besides the
  // read-only default is unexpected and reported.
  for (const st of await q<{ line: string }>(
    `SELECT format('role setting %s%s', c.setting,
                   CASE WHEN s.setdatabase = 0 THEN '' ELSE ' (database ' || d.datname || ')' END) AS line
       FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
       LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
       CROSS JOIN unnest(s.setconfig) c(setting)
      WHERE r.rolname = $1 AND NOT (s.setdatabase = 0 AND c.setting = 'default_transaction_read_only=on')
      ORDER BY 1`,
  )) {
    v.push(st.line);
  }
  for (const o of await q<{ line: string }>(
    `SELECT format('owns %s %s', d.classid::regclass, d.objid) AS line
       FROM pg_catalog.pg_shdepend d JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid
      WHERE r.rolname = $1 AND d.deptype = 'o'
        AND d.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
     UNION ALL
     SELECT format('owns database %s', datname) FROM pg_catalog.pg_database
      WHERE pg_catalog.pg_get_userbyid(datdba) = $1`,
  )) {
    v.push(o.line);
  }
  for (const d of await q<{ p: string }>(
    `SELECT p FROM unnest(ARRAY['CREATE', 'TEMPORARY']) p
      WHERE pg_catalog.has_database_privilege($1, current_database(), p)`,
  )) {
    v.push(`database ${d.p} privilege in the current database`);
  }
  const systemSchemas = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                         AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;
  for (const s of await q<{ line: string }>(
    `SELECT format('schema %s: %s', n.nspname, p) AS line
       FROM pg_catalog.pg_namespace n CROSS JOIN unnest(ARRAY['CREATE', 'USAGE']) p
      WHERE pg_catalog.has_schema_privilege($1, n.oid, p)
        AND (p = 'CREATE' OR (${systemSchemas} AND n.nspname <> 'public' AND NOT (n.nspname = ANY($2))))
      ORDER BY 1`,
    [role, BACKUP_SCHEMAS],
  )) {
    v.push(s.line);
  }
  for (const t of await q<{ line: string }>(
    `SELECT format('%s.%s: %s', n.nspname, c.relname, p) AS line
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND pg_catalog.has_table_privilege($1, c.oid, p)
        -- UPDATE on pg_settings is the same as SET (this session only; PostgreSQL's own checks apply)
        AND c.oid <> 'pg_catalog.pg_settings'::regclass
     UNION ALL
     SELECT format('%s.%s: column %s', n.nspname, c.relname, p)
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']) p
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND pg_catalog.has_any_column_privilege($1, c.oid, p)
        AND NOT pg_catalog.has_table_privilege($1, c.oid, p)
     UNION ALL
     SELECT format('%s.%s (sequence): %s', n.nspname, c.relname, p)
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE', 'UPDATE']) p
      WHERE c.relkind = 'S' AND pg_catalog.has_sequence_privilege($1, c.oid, p)
     UNION ALL
     SELECT format('%s.%s: SELECT outside the PBE schemas', n.nspname, c.relname)
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${systemSchemas}
        AND NOT (n.nspname = ANY($2)) AND pg_catalog.has_table_privilege($1, c.oid, 'SELECT')
     UNION ALL
     SELECT format('%s.%s: view runs with its owner''s rights (not security_invoker)', n.nspname, c.relname)
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND n.nspname = ANY($2)
        AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
        AND pg_catalog.has_table_privilege($1, c.oid, 'SELECT')
      ORDER BY 1`,
    [role, BACKUP_SCHEMAS],
  )) {
    v.push(t.line);
  }
  for (const f of await q<{ line: string }>(
    `SELECT format('function %s: EXECUTE%s', p.oid::regprocedure, CASE WHEN p.prosecdef THEN ' (SECURITY DEFINER)' ELSE '' END) AS line
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE ${systemSchemas} AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
     UNION ALL
     SELECT format('built-in function %s: EXECUTE', p.oid::regprocedure)
       FROM pg_catalog.pg_proc p
      WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($2)
        AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
      ORDER BY 1`,
    [role, DANGEROUS_BUILTINS],
  )) {
    v.push(f.line);
  }
  for (const x of await q<{ line: string }>(
    `SELECT format('foreign server %s: USAGE', srvname) AS line FROM pg_catalog.pg_foreign_server
      WHERE pg_catalog.has_server_privilege($1, oid, 'USAGE')
     UNION ALL
     SELECT format('foreign-data wrapper %s: USAGE', fdwname) FROM pg_catalog.pg_foreign_data_wrapper
      WHERE pg_catalog.has_foreign_data_wrapper_privilege($1, oid, 'USAGE')
     UNION ALL
     SELECT format('tablespace %s: CREATE', spcname) FROM pg_catalog.pg_tablespace
      WHERE spcname NOT IN ('pg_default', 'pg_global') AND pg_catalog.has_tablespace_privilege($1, oid, 'CREATE')
     UNION ALL
     SELECT format('parameter %s: %s', a.parname, p) FROM pg_catalog.pg_parameter_acl a
      CROSS JOIN unnest(ARRAY['SET', 'ALTER SYSTEM']) p
      WHERE pg_catalog.has_parameter_privilege($1, a.parname, p)
        AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(a.paracl) e
                     WHERE e.grantee IN (0, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)))
     UNION ALL
     SELECT format('large object %s: UPDATE', oid) FROM pg_catalog.pg_largeobject_metadata
      WHERE pg_catalog.has_largeobject_privilege($1, oid, 'UPDATE')
      ORDER BY 1`,
  )) {
    v.push(x.line);
  }
  const connectable = (
    await q<{ datname: string }>(
      `SELECT datname FROM pg_catalog.pg_database
        WHERE datallowconn AND pg_catalog.has_database_privilege($1, oid, 'CONNECT') ORDER BY 1`,
    )
  ).map((d) => d.datname);
  return { violations: v, connectable };
}
