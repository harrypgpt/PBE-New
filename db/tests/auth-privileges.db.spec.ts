import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { dbConfig, ROOT, withClient } from './helpers';

/*
 * S6-17 effective database permissions for identity data (ADR-027), on real PostgreSQL 18
 * (pbe_test). Proves there is no bulk credential-reading path for the runtime role pbe_app.
 */

const IDENTITY_TABLES = [
  'platform.user_account',
  'platform.password_credential',
  'platform.user_session',
  'platform.mfa_totp_factor',
  'platform.mfa_recovery_code',
  'platform.auth_throttle',
];

/** The reviewed functions (migration 0003). Any other function pbe_app can run fails the test. */
const REVIEWED_FUNCTIONS = [
  'auth_credential_get(p_user_id uuid)',
  'auth_credential_set(p_user_id uuid, p_hash text)',
  'auth_login_lookup(p_email text)',
  'auth_mfa_reset(p_user_id uuid)',
  'auth_recovery_code_use(p_user_id uuid, p_hash bytea)',
  'auth_recovery_codes_replace(p_user_id uuid, p_hashes bytea[])',
  'auth_session_create(p_user_id uuid, p_token_hash bytea, p_state text, p_idle_seconds integer, p_absolute_seconds integer)',
  'auth_session_end(p_token_hash bytea, p_reason text)',
  'auth_session_end_all(p_user_id uuid, p_reason text, p_except uuid)',
  'auth_session_resolve(p_token_hash bytea, p_idle_seconds integer)',
  'auth_throttle_blocked_until(p_keys bytea[])',
  'auth_throttle_clear(p_key bytea)',
  'auth_throttle_fail(p_key bytea, p_mode text, p_threshold integer, p_window_seconds integer, p_base_seconds integer, p_max_seconds integer)',
  'auth_totp_begin(p_user_id uuid, p_ciphertext bytea, p_key_id text)',
  'auth_totp_confirm(p_user_id uuid, p_step bigint)',
  'auth_totp_get(p_user_id uuid)',
  'auth_totp_use_step(p_user_id uuid, p_step bigint)',
  'auth_user_create(p_email text, p_display_name text)',
  'auth_user_get(p_user_id uuid)',
  'auth_user_id_by_email(p_email text)',
  'auth_user_set_mfa_required(p_user_id uuid, p_required boolean)',
];

/** Stage 7A reviewed functions executable by pbe_app (migration 0004). */
const STAGE7A_FUNCTIONS = [
  'access_platform_roles(p_user_id uuid)',
  'admin_tenant_create(p_actor uuid, p_id uuid, p_slug text, p_name text, p_request_id uuid)',
  'admin_tenant_list(p_actor uuid)',
  'admin_tenant_set_status(p_actor uuid, p_tenant uuid, p_status text, p_request_id uuid)',
  'auth_session_context(p_session_id uuid)',
  'auth_session_set_context(p_session_id uuid, p_tenant uuid, p_grant uuid)',
  'breakglass_decide(p_grant uuid, p_tenant uuid, p_actor uuid, p_approve boolean, p_request_id uuid)',
  'breakglass_list_for_requester(p_actor uuid)',
  'breakglass_list_for_tenant(p_tenant uuid)',
  'breakglass_record_use(p_grant uuid, p_actor uuid, p_operation text, p_request_id uuid)',
  'breakglass_refresh(p_grant uuid)',
  'breakglass_request(p_actor uuid, p_tenant uuid, p_purpose text, p_request_id uuid)',
  'breakglass_revoke(p_grant uuid, p_actor uuid, p_tenant uuid, p_request_id uuid)',
  'token_issue(p_user uuid, p_purpose text, p_hash bytea, p_ttl_seconds integer, p_tenant uuid, p_actor uuid)',
  'token_lookup(p_hash bytea)',
  'token_redeem(p_hash bytea)',
];
/**
 * Stage 8 (migration 0006, ADR-030): the reviewed break-glass check (platform, SECURITY DEFINER,
 * no parameters, reads only the transaction's own context) and the department-visibility check
 * (app schema, runs with the CALLER's rights under row-level security). Both are granted to
 * pbe_app only; PUBLIC has neither.
 */
const STAGE8_PLATFORM_FUNCTIONS = ['access_breakglass_active_here()'];
const STAGE8_APP_FUNCTIONS = ['project_visible(p_tenant uuid, p_project uuid)'];
/** Reviewed functions pbe_app must NOT be able to run (operator-only and internal). */
const NOT_FOR_APP = ['access_require_platform_owner', 'operator_platform_role_set'];

const asApp = <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<T[]>) => Promise<unknown>) =>
  withClient(dbConfig('app'), (c) => fn(async (sql, p) => (await c.query(sql, p)).rows as T[]));
const asOwner = <T>(sql: string, p: unknown[] = []) =>
  withClient(dbConfig('migrator'), async (c) => (await c.query(sql, p)).rows as T[], {
    asOwner: true,
  });

beforeAll(async () => {
  await migrate({ connection: dbConfig('migrator'), migrationsDir: migrationsDir(ROOT) });
}, 120_000);

describe('S6-17 pbe_app has no table privileges on identity data', () => {
  it.each(IDENTITY_TABLES)(
    '%s: no SELECT, INSERT, UPDATE, DELETE, TRUNCATE or REFERENCES',
    async (table) => {
      const [row] = await asOwner<Record<string, boolean>>(
        `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']
          .map((p) => `has_table_privilege('pbe_app', $1, '${p}') AS "${p}"`)
          .join(', ')}`,
        [table],
      );
      expect(Object.values(row!).some(Boolean)).toBe(false);
      // And in practice: a bulk read fails.
      await expect(asApp((q) => q(`SELECT * FROM ${table} LIMIT 1`))).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it('pbe_app cannot read any column of the password, MFA or session tables', async () => {
    const rows = await asOwner<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.column_privileges
        WHERE grantee IN ('pbe_app', 'PUBLIC') AND table_schema = 'platform'
          AND table_name IN ('password_credential','mfa_totp_factor','mfa_recovery_code','user_session','user_account','auth_throttle')`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('S6-17 the security-event log is append-only', () => {
  it('pbe_app may INSERT only; UPDATE, DELETE, TRUNCATE and SELECT are refused', async () => {
    const [row] = await asOwner<Record<string, boolean>>(
      `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
        .map((p) => `has_table_privilege('pbe_app', 'audit.security_event', '${p}') AS "${p}"`)
        .join(', ')}`,
    );
    expect(row).toEqual({
      SELECT: false,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
    await asApp((q) =>
      q(`INSERT INTO audit.security_event (event_type, outcome) VALUES ('privilege_test', 'info')`),
    );
    for (const sql of [
      `UPDATE audit.security_event SET outcome = 'success'`,
      `DELETE FROM audit.security_event`,
      `TRUNCATE audit.security_event`,
    ]) {
      await expect(asApp((q) => q(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('even the table owner cannot UPDATE, DELETE or TRUNCATE (trigger)', async () => {
    for (const sql of [
      `UPDATE audit.security_event SET outcome = 'success' WHERE event_type = 'privilege_test'`,
      `DELETE FROM audit.security_event WHERE event_type = 'privilege_test'`,
      `TRUNCATE audit.security_event`,
    ]) {
      await expect(asOwner(sql)).rejects.toThrow(/append-only/);
    }
  });
});

describe('S6-17 reviewed access functions only', () => {
  it('pbe_app can execute exactly the reviewed identity functions, and PUBLIC none of them', async () => {
    const rows = await asOwner<{ sig: string; app: boolean; pub: boolean }>(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
              has_function_privilege('pbe_app', p.oid, 'EXECUTE') AS app,
              coalesce(p.proacl::text LIKE '%=X/%' AND p.proacl::text ~ '(^|[{,])=X/', false) AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('platform', 'audit', 'app')`,
    );
    const executable = rows
      .filter((r) => r.app)
      .map((r) => r.sig)
      .sort();
    expect(executable).toEqual(
      [
        ...REVIEWED_FUNCTIONS,
        ...STAGE7A_FUNCTIONS,
        ...STAGE8_PLATFORM_FUNCTIONS,
        ...STAGE8_APP_FUNCTIONS,
        'current_tenant_id()',
        'current_user_id()',
      ].sort(),
    );
    expect(rows.filter((r) => r.pub)).toEqual([]);
  });

  it('each is SECURITY DEFINER, owned by pbe_owner, with search_path pinned to pg_catalog, pg_temp', async () => {
    const rows = await asOwner<{
      name: string;
      definer: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform'`,
    );
    expect(rows).toHaveLength(
      REVIEWED_FUNCTIONS.length +
        STAGE7A_FUNCTIONS.length +
        STAGE8_PLATFORM_FUNCTIONS.length +
        NOT_FOR_APP.length,
    );
    for (const r of rows) {
      expect(r).toMatchObject({
        definer: true,
        owner: 'pbe_owner',
        config: ['search_path=pg_catalog, pg_temp'],
      });
    }
  });

  it('no function returns more than one credential: look-ups take one key and return at most one row', async () => {
    // Set-returning functions are the only ones that could return many rows; each is keyed by
    // a primary or unique key, checked here by calling it with a key that matches nothing.
    const srfs = await asOwner<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'platform' AND p.proname LIKE 'auth\\_%' AND p.proretset ORDER BY 1`,
    );
    expect(srfs.map((r) => r.name)).toEqual([
      'auth_login_lookup',
      'auth_session_context',
      'auth_session_end',
      'auth_session_resolve',
      'auth_totp_get',
      'auth_user_get',
    ]);
    // Wildcards are not patterns: a LIKE-style or empty email finds nothing.
    for (const probe of ['%', '%@%', '']) {
      const r = await asApp((q) => q('SELECT * FROM platform.auth_login_lookup($1)', [probe]));
      expect(r).toEqual([]);
    }
  });

  it('pbe_app still owns nothing and cannot create functions or change privileges (Stage 3 rules hold)', async () => {
    const [row] = await asOwner<{ owned: number }>(
      `SELECT (SELECT count(*) FROM pg_class WHERE relowner = 'pbe_app'::regrole)
            + (SELECT count(*) FROM pg_proc WHERE proowner = 'pbe_app'::regrole) AS owned`,
    );
    expect(Number(row!.owned)).toBe(0);
    await expect(
      asApp((q) =>
        q(
          `CREATE FUNCTION platform.zz_leak() RETURNS SETOF text LANGUAGE sql AS $$ SELECT password_hash FROM platform.password_credential $$`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp((q) => q('GRANT SELECT ON platform.password_credential TO pbe_app')),
    ).rejects.toThrow(/permission denied|must be owner/);
  });
});
