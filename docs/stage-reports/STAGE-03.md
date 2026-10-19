# Stage 03 — Data-access layer, tenant context and RLS harness: completion report

Date: 2026-10-17   Authorised by owner on: 2026-10-17   Agent/model: Claude Code (Claude Opus 5.5)

> **Status (2026-10-17): Stage 3 APPROVED — PASS by the product owner (see §13).** The results were produced and reported by the coding agent and have **not been independently verified**.

> **Evidence qualification.** Every result in this report comes from the coding agent's own runs on this Mac. Nothing here has been independently verified (R-006).

## 1. Implementation summary

PBE now has one doorway to the database for application code, and PostgreSQL itself hides each customer's rows from every other customer.

- **Migration `0002_tenancy_foundation.sql`** (additive) adds:
  - the tenant registry `platform.tenant`;
  - two context functions, `app.current_tenant_id()` and `app.current_user_id()`;
  - the runtime role's privileges;
  - row-level security on the registry: `pbe_app` may only *read its own* tenant row.
- **Data-access layer** in `apps/api/src/modules/db/`:
  - Kysely on a `pg` pool, connecting as `pbe_app`.
  - `withTenantTransaction`, the only place a tenant context is set (transaction-local).
  - `assertSafeRuntimeRole`, which refuses a superuser, a BYPASSRLS role, a member of another role, or an owner of objects.
  - Generated database types.
- **Architectural check:** an ESLint rule blocks `kysely` and `pg` imports, and any mention of `set_config`, `app.tenant_id` or `app.user_id`, anywhere in `apps/api` outside the db module.
- **In-house type generator:** `npm run db -- typegen` and `typegen --check`, now a `verify` step.
- **Tenant-table template** (`db/templates/tenant-table.sql`) and an **RLS conformance check** that enforces it.
- **Tests:** 87 new or extended tests, plus mutation checks. All database tests run on real PostgreSQL 18 (`pbe_test`), or, for the superuser and BYPASSRLS controls, on a private throw-away instance.

**Not done (excluded):** HTTP or NestJS, users or authentication, business tables, science, ML or AI, new roles or databases. No `kysely-codegen`, ORM, Prisma or Python.

## 2. Files created and changed

**Created:**

| File | Purpose |
|---|---|
| `db/migrations/0002_tenancy_foundation.sql` | Tenant registry, context functions, privileges, policy |
| `db/templates/tenant-table.sql` | Template for tenant-owned tables (not a migration) |
| `apps/api/src/modules/db/database.ts` | Kysely and pool gateway, connects as `pbe_app` |
| `apps/api/src/modules/db/tenant-context.ts` | `parseTenantContext`, `withTenantTransaction` |
| `apps/api/src/modules/db/runtime-role.ts` | `assertSafeRuntimeRole` |
| `apps/api/src/modules/db/index.ts` | Public interface of the layer |
| `apps/api/src/modules/db/database-types.ts` | **Generated** database types (do not edit) |
| `apps/api/tsconfig.jest.json`, `db/tests/tsconfig.jest.json` | Test-only transpilation of the ES-module `kysely` |
| `apps/api/test/tenant-context.spec.ts` | Unit tests (B4) |
| `tooling/migrate/src/typegen.ts` | Type generator |
| `tooling/migrate/src/conformance.ts` | RLS conformance check |
| `tooling/migrate/test/typegen.spec.ts` | Generator unit tests |
| `db/tests/tenancy.db.spec.ts` | §4.1 A, B, C and D tests |
| `db/tests/conformance.db.spec.ts` | T10 and T11 |
| `db/tests/typegen.db.spec.ts` | T12 on real metadata |

**Changed:**

| File | Change |
|---|---|
| `apps/api/package.json`, `package-lock.json` | `kysely` 0.29.6 and `pg` 8.23.1 (runtime); `@types/pg` 8.23.1 (dev) |
| `apps/api/jest.config.cjs`, `db/tests/jest.config.cjs`, `db/tests/tsconfig.json` | Kysely transform for tests; apps/api sources in the db test project |
| `jest.config.cjs` | `maxWorkers: 1`. Test files run one at a time, so the rebuild of `pbe_test` can never overlap the tenancy tests. |
| `eslint.config.mjs` | Gateway rules for `apps/api` |
| `tooling/tests/lint-boundaries.test.cjs` | 8 new gateway lint cases (T13) |
| `tooling/migrate/src/cli.ts`, `errors.ts` | `typegen` command; two error codes |
| `tooling/scripts/verify.cjs` | New step: database types up to date |
| `.prettierignore` | Generated types file excluded (its bytes are checked by `typegen --check`) |
| `db/tests/throwaway-server.db.spec.ts` | D3 and D4 controls; the "pbe_app owns a table" conformance rule |
| `db/schema-snapshot.txt` | Refreshed by `migrate`: 31 → 52 lines, additions only (§8) |
| `db/migrations/README.md` | Tenant-table rule and typegen reminder |
| `docs/architecture/RISK_REGISTER.md` | New risk R-007 |
| `docs/stage-plans/STAGE-03-PLAN.md` | Status; §4.1 tests; BYPASSRLS confirmed |

**Dependency added:** `kysely` 0.29.6. MIT licence, **no dependencies**, no install scripts, ES-module only (loaded natively by Node 24). Audit unchanged: 20 moderate, **0 high, 0 critical**. The dependency guard passes.

## 3. Migration 0002: SQL and actual result

Runner validation found no problems. A separate review found no `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `RENAME` or column change. SHA-256 is `5439b8638117ce5c9e1564e3288958e21de6bca37877f3b063d896ad86f0a842`.

```sql
-- pbe:phase expand
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $fn$;
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $fn$;
REVOKE ALL ON FUNCTION app.current_tenant_id(), app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO pbe_app;

CREATE TABLE platform.tenant (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON platform.tenant FROM PUBLIC;
GRANT SELECT ON platform.tenant TO pbe_app;
ALTER TABLE platform.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_read ON platform.tenant
  FOR SELECT TO pbe_app
  USING (id = app.current_tenant_id());
```

(Comments omitted here; the full file is in `db/migrations/`.)

| Database | Result |
|---|---|
| `pbe_test` | Applied by the tests from empty, and forward. |
| Throw-away server | Applied by the real runner as `pbe_migrator` (\[1, 2\]). |
| **`pbe_dev`** | A verified backup was taken first: `backups/pbe_dev-2026-10-17T09-50-02-063Z.dump`, sha256 `640e6457…ad43b`, decoded OK. Then `applied 0002_tenancy_foundation.sql (12 ms)`. A second run applied 0. |

## 4. Row-level security, role and permission SQL (actual catalogue state of `pbe_dev`)

**Policies (`pg_policies`):**

```
platform.tenant  tenant_self_read  PERMISSIVE  {pbe_app}  SELECT  USING (id = app.current_tenant_id())  WITH CHECK —
```

**`platform.tenant`:**
- RLS enabled, not forced (owner manages rows; plan §6.3). Owner `pbe_owner`.
- ACL `{pbe_owner=arwdDxtm/pbe_owner, pbe_app=r/pbe_owner}`.
- `pbe_app` privileges: SELECT **yes**; INSERT, UPDATE, DELETE and TRUNCATE **no**.

**Functions** `app.current_tenant_id` and `app.current_user_id`:
- owner `pbe_owner`;
- ACL `{pbe_owner=X/pbe_owner, pbe_app=X/pbe_owner}`, so PUBLIC is revoked;
- STABLE, not SECURITY DEFINER, with a fixed `search_path`.

**Tenant-table template:** every future table in `app` follows `db/templates/tenant-table.sql`:

```sql
ALTER TABLE {schema}.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE {schema}.project FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON {schema}.project
  FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON {schema}.project FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {schema}.project TO pbe_app;
-- plus: tenant_id uuid NOT NULL REFERENCES platform.tenant (id); PRIMARY KEY (tenant_id, id);
--       child FOREIGN KEY (tenant_id, project_id) REFERENCES {schema}.project (tenant_id, id)
```

**Tenant context**, set only in `withTenantTransaction`:

```sql
SELECT pg_catalog.set_config('app.tenant_id', $1, true), pg_catalog.set_config('app.user_id', $2, true)
```

**Roles (unchanged by Stage 3):**
- `pbe_app`: not superuser, no BYPASSRLS, no CREATEDB or CREATEROLE, member of no role, owns 0 objects.
- The conformance check on the real `app` schema of `pbe_dev` returns `[]`.

## 5. Commands executed and results (2026-10-17)

| # | Command | Result |
|---|---|---|
| 1 | Read-only precondition checks: working tree, ledgers, schemas, roles, memberships, `status` for dev and test, `drift` | `pbe_dev` and `pbe_test` both at 0001; no drift; roles as approved |
| 2 | `npm install --save-exact --workspace @pbe/api kysely@0.29.6 pg@8.23.1` and `@types/pg@8.23.1` | Installed. Guard PASS, `npm ls` OK, no install scripts, audit 0 high |
| 3 | Runner validation of 0002, plus grep for destructive SQL | No problems; none found |
| 4 | `npm run db -- migrate --db test` | Applied 0002 to `pbe_test` |
| 5 | `npm run db -- typegen`, then `typegen --check` | Written (14 columns), up to date |
| 6 | Type-check `apps/api`; build; load compiled CJS output | OK. Kysely loads via Node 24 `require(esm)` |
| 7 | `npx eslint .`; lint-boundary tests | Clean; 32/32 |
| 8 | API unit tests | 16/16 |
| 9 | Tenancy tests | 19/19 (first run) |
| 10 | Conformance tests | 12/12 |
| 11 | Throw-away server tests | 14/14 |
| 12 | Type generator tests | **First run: 27/30.** Two generator bugs found (§6). Fixed. **30/30.** |
| 13 | Full `npx jest --ci` (before migrating `pbe_dev`) | 317/319. The 2 failures are the read-only `pbe_dev` checks, expected because 0002 was not yet applied to `pbe_dev` |
| 14 | Mutation checks M1–M5 (§7) | Every mutation detected |
| 15 | `pbe_dev`: `status` → `backup` → `migrate` → `status` → `migrate` → `drift` | §3; no drift (52 entries) against snapshot and `pbe_test` |
| 16 | Snapshot comparison, 31 → 52 lines | 0 old lines removed or changed; 21 added |
| 17 | `npm run verify` | **13/13 PASS**, exit 0 |
| 18 | `npx jest --ci --json` | **319/319 passed, 0 failed, 0 skipped** |
| 19 | Catalogue read of policies, ACLs, functions and conformance on `pbe_dev` | §4 |
| 20 | Leftover check | Databases `pbe_dev`, `pbe_test`, `postgres` only; 0 `zz_*` schemas; 0 test tenants; no throw-away folders |
| 21 | Document checker; secret scan | §9 |

## 6. Test results

**Totals (final): 319 tests, 319 passed, 0 failed, 0 skipped** (22 suites). This is 87 more than the end of Stage 2 (232).

**Failures found during the stage, root cause, fix and rerun:**
1. **Type generator, column order not deterministic.** Columns kept their input order. Fix: sort by `pg_attribute.attnum`. Rerun 30/30.
2. **Type generator, enum labels arrived as raw text.** The driver does not decode `name[]` arrays. Fix: cast the labels to `text`. Rerun 30/30. The committed types file did not change (it has no enums yet).
3. **Two `pbe_dev` read-only checks failed** in the full run before `pbe_dev` was migrated. This is the intended order: `pbe_dev` is migrated last. They passed after step 15.

No test was skipped, mocked in place of a real-database test, or marked as passing without running.

### 6.1 Named tests from STAGE-03-PLAN.md §4.1 (all on real PostgreSQL 18)

| ID | Test (file) | Result |
|---|---|---|
| A1+A2 | 60 transactions alternating A and B (30 sequential, 30 concurrent) on a **2-connection pool**. Each sees only its own rows. ≤ 2 backend pids; one pid served **both** tenants. Both connections inspected after commits: `app.tenant_id` and `app.user_id` empty (`tenancy`) | ✓ |
| A3 | A query outside the helper on a pooled connection sees 0 tenant rows | ✓ |
| A4 | Application error, SQL error (`22012`) and **statement cancellation** (`57014`) all roll back; an insert before the failure is not kept; no context remains on either connection | ✓ |
| B1 | No context: SELECT 0; UPDATE and DELETE affect 0; INSERT `42501` | ✓ |
| B2 | Empty-string context: identical to no context | ✓ |
| B3 | Malformed context `'not-a-uuid'`: query **errors** (`22P02`); no data returned | ✓ |
| B4 | Invalid ids (non-UUID, empty, nil UUID, missing field, extra field, SQL fragment, number) rejected; **0 pool connections taken** (a valid call takes 1) (`tenancy` and `apps/api` unit tests) | ✓ |
| B5 | Unknown tenant UUID: 0 rows; INSERT `23503` | ✓ |
| C1 | SELECT of B's rows by id and by full scan: none returned | ✓ |
| C2 | INSERT with B's `tenant_id`: `42501` | ✓ |
| C3 | UPDATE of B's rows: 0 affected; B's data unchanged (checked as B) | ✓ |
| C4 | Moving an A row to B: `42501` | ✓ |
| C5 | DELETE of B's rows: 0 affected; B's rows remain | ✓ |
| C6 | Linking A's row to B's record: `23503` (composite foreign key) | ✓ |
| C7 | `platform.tenant`: own row only; none without context; INSERT, UPDATE and DELETE `42501` | ✓ |
| D1 | `pbe_app` owns 0 objects. Each of these is refused with `42501`: disabling or un-forcing RLS; dropping, altering or creating policies; changing the owner; `TRUNCATE` (both fixture tables and `platform.tenant`); replacing `app.current_tenant_id()`. `assertSafeRuntimeRole` passes | ✓ |
| D2 | Each of these is refused with `42501`: SET ROLE to `pbe_owner`, `pbe_migrator` or `pbe_restore_drill`; SET SESSION AUTHORIZATION; GRANT `pbe_owner` TO `pbe_app`; CREATE ROLE; ALTER ROLE `pbe_app` to BYPASSRLS, SUPERUSER or CREATEROLE. A self-grant of TRUNCATE has no effect (privilege still false); memberships 0 | ✓ |
| D3 | `pbe_app` is not a superuser (catalogue). **Control** (throw-away server, real migrations): a superuser sees **both** tenants' rows. The runner still refuses a superuser (Stage 2.1 test re-run) | ✓ |
| D4 | `pbe_app` has no BYPASSRLS. `SET row_security = off` as `pbe_app` gives an **error** (`42501`) instead of a bypass. **Control** (throw-away server): a BYPASSRLS role sees both tenants' rows, even with row security off | ✓ |
| D5 | Existing privilege checks re-run in `real-migrations`: no DDL anywhere, no `training` access, ledger read-only | ✓ |
| — | **LIMITATION R-007** (documented, `tenancy`): PostgreSQL lets `pbe_app` set `app.tenant_id` itself. The test proves this is real, so the report cannot overstate the guarantee | ✓ (records actual behaviour) |

### 6.2 The 16 plan test groups

| Group | Evidence | Result |
|---|---|---|
| T1 Migration 0002 from empty; idempotent; checksums | `real-migrations` (rebuild from empty), throw-away server, `pbe_dev` (§3) | ✓ |
| T2 No context → 0 rows | B1 | ✓ |
| T3 Cross-tenant read, update and delete | C1, C3, C5 | ✓ |
| T4 Cross-tenant insert | C2, C4 | ✓ |
| T5 Composite foreign key | C6 | ✓ |
| T6 Pool leak | A1–A3 | ✓ |
| T7 Context after error | A4 | ✓ |
| T8 Invalid ids | B4 | ✓ |
| T9 `platform.tenant` | C7 | ✓ |
| T10 Conformance: template and real `app` pass | `conformance` (2 tests) | ✓ |
| T11 Conformance: each rule rejects its fixture | 10 fixtures in `conformance`, plus "pbe_app owns the table" on the throw-away server | ✓ |
| T12 Type generator: mapping, determinism, real metadata, unknown types fail, `--check` | `typegen` unit (26) and db (4); `verify` step | ✓ |
| T13 Lint gateway rule | 8 cases in `lint-boundaries` | ✓ |
| T14 Mutation checks | §7 | ✓ |
| T15 Full `verify` | 13/13 | ✓ |
| T16 `pbe_dev` after migrate: status OK, no drift, old ledger row unchanged | §3, §8 | ✓ |

## 7. Mutation checks (T14)

Each check ran in a full copy of the project in a temporary folder, with one protection broken. Only the relevant database tests were run against `pbe_test`.

| Mutation | Result |
|---|---|
| M1 Template without `FORCE ROW LEVEL SECURITY` | **10/31 failed**: every conformance test, because the template no longer conforms and every fixture now also reports "not forced". Tenancy tests still pass: FORCE only matters for a table **owner**, and `pbe_app` never is one. This is why the conformance check is required. |
| M2 Template policy `USING (true) WITH CHECK (true)` | **20/31 failed** (A1, A3, B1–B3, B5, C1–C5, conformance) |
| M3 Helper sets context for the **session** instead of the transaction | **5/19 failed** (A1+A2, A3, A4, B1, C7): the leak is caught |
| M4 Context validation disabled | **1/19 failed** (B4) |
| M5 Conformance "forced" rule removed | **1/12 failed** ("rejects row-level security not forced") |

No test leftovers remained afterwards (0 `zz_test_*` schemas, 0 test tenants).

## 8. State of `pbe_dev`, `pbe_test` and migration history

**`pbe_dev`:**
- Ledger: `0001 schema_skeleton` unchanged (checksum `2ef0d494…7b27`, applied 2026-10-17T08:30:23Z), plus `0002 tenancy_foundation` (checksum `5439b863…f0a842`, applied 2026-10-17T09:50:02Z by `pbe_migrator`).
- Tables: `pbe_meta.schema_migration`, `platform.tenant` (**0 rows**; no data was added).
- `status`: OK, 0 pending. No drift.
- The snapshot changed only by additions: 21 lines for the tenant table, its constraints and indexes, the two functions and the policy. All 31 earlier lines are unchanged.

**`pbe_test`:** migrated to 0002 (rebuilt from empty by the tests). 0 test schemas or tenants left.

**Databases on the server:** `pbe_dev`, `pbe_test`, `postgres`. Nothing was created or dropped outside the tests' temporary objects.

## 9. Static, security and document checks

**`npm run verify`, 13/13 PASS:**
- toolchain, lockfile, dependency guard (no Python, Prisma, SQLite or `kysely-codegen`), secret scan;
- formatting, lint and module boundaries (including the gateway rule), type-check, build;
- migration integrity, tests (319/319), **database types up to date**;
- drift (`pbe_dev` against the snapshot and against `pbe_test`), audit (0 high or critical).

**Document checker:** 0 problems. All links and anchors resolve, 29 stages, 21 ADRs, and 7 approved decisions cross-checked (OD-01→ADR-013, OD-03→ADR-014, OD-04→ADR-015, OD-05→ADR-017, OD-06→ADR-018, OD-07→ADR-021, OD-25→ADR-016). **Secret scan:** clean.

## 10. Acceptance criteria (STAGE-03-PLAN.md §5)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | T1–T16 and every §4.1 test pass on PostgreSQL 18.6; counts reported; nothing skipped | §6, §7; 319/319, 0 skipped | **PASS** |
| 2 | Every T11 negative fixture demonstrably fails the conformance check | 10 fixtures plus the ownership rule; each reports exactly its rule | **PASS** |
| 3 | RLS policy SQL and migration 0002 quoted for review | §3, §4 | **PASS** |
| 4 | `pbe_dev` only migrated forward; no existing data or ledger row changed | §3, §8 (backup first; additions only) | **PASS** |
| 5 | No new high or critical audit finding; guard passes; only `kysely` added as a new package | §2, §9 | **PASS** |
| 6 | No HTTP or NestJS, users, business tables, science, ML or AI | §1, §2 | **PASS** |

**The owner's mandatory database protections:**

| Requirement | Result |
|---|---|
| Not a superuser | **PASS** (catalogue, `assertSafeRuntimeRole`, D3 control) |
| No BYPASSRLS | **PASS** (catalogue, D4: `row_security = off` errors; control) |
| Does not own protected tables; cannot disable or alter RLS | **PASS** (D1; ownership rule on the throw-away server) |
| Cannot truncate protected tables | **PASS** (D1, conformance `no_truncate`) |
| Cannot escalate, assume roles or grant itself privileges | **PASS** (D2) |
| Cannot modify tenant records | **PASS** (C7) |
| **Cannot bypass tenant policies by changing tenant context through an unapproved path** | **PARTIAL.** Enforced architecturally: one gateway, a lint rule that fails the build (tested), parameterised queries, transaction-local and validated context. **PostgreSQL itself cannot prevent** a session running as `pbe_app` from setting its own `app.tenant_id`; the test `LIMITATION R-007` proves this. Tracked as **R-007** with options for database-enforced alternatives; needs an owner decision. |

## 11. Remaining risks and limitations

1. **R-007 (new):** tenant context can be set by any code running as `pbe_app`. Database enforcement would need signed context or per-tenant roles. Owner decision by Stage 28.
2. **R-001 (unchanged, production-blocking):** `pbe_migrator` acts as `pbe_owner`, which owns the databases.
3. `platform.tenant` RLS is enabled but **not forced** (approved recommendation). The owner role can read and write all tenant rows. It is used only by migrations and future administrative tooling.
4. `kysely` is ES-module only. Tests transpile it with ts-jest (test-only configuration); production loads it natively through Node 24.
5. Test files now run one at a time (`maxWorkers: 1`). The full suite takes about 10 s.
6. Type generation covers `app`, `audit`, `pbe_meta` and `platform`. Unsupported PostgreSQL types (e.g. `interval`, `tsvector`, ranges, composites) stop generation until a mapping is added deliberately.
7. R-003, R-004, R-005 and R-006 are unchanged (lexical migration checks; audit acceptance; repository privacy; no independent verification).

## 12. Final recommendation

**PASS, with one item for the owner's decision.**
- All six acceptance criteria and every named §4.1 test pass on real PostgreSQL 18, with mutation evidence that the tests detect broken protections.
- The one requirement that PostgreSQL cannot enforce by itself (context set through an unapproved path) is met architecturally and recorded honestly as **R-007**, rather than claimed.

The final decision is the owner's. Stage 4 has not been started.


---

## 13. Owner verdict (added 2026-10-17; §1–§12 above are unchanged)

- **Verdict:** **PASS**, given by the product owner on 2026-10-17, based on the coding agent's reported results.
- **Results relied on (as reported by the coding agent):**
  - 319/319 tests passed, none skipped;
  - `npm run verify` 13/13;
  - tenant-isolation, connection-pool, fail-closed, role, privilege and RLS tests executed against PostgreSQL 18;
  - migration 0002 applied additively to `pbe_dev` after the tests and a verified backup;
  - no commit or push.
- **Evidence qualification:** **these results have not been independently verified.** They were produced and reported by the coding agent only (R-006).
- **R-007:** accepted **temporarily**, under the owner's mandatory conditions recorded in [RISK_REGISTER.md](../architecture/RISK_REGISTER.md#r-007--tenant-context-can-be-set-by-any-code-running-as-pbe_app). It is still open and production-blocking.
- **R-001:** still open and production-blocking (unchanged).
- **Next:** Stage 4 authorised by the owner, subject to the roadmap and its acceptance criteria. The preparation is in [STAGE-04-PLAN.md](../stage-plans/STAGE-04-PLAN.md).
