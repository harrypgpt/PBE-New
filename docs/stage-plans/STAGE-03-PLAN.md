# Stage 3 Plan — Data-access layer, tenant context and RLS harness

Status: **Approved and authorised by the owner on 2026-10-17**, with the three recommendations in §6 and the explicit test requirements added in §4.1. The cut-off item was confirmed by the owner as **BYPASSRLS** (2026-10-17). **Implemented 2026-10-17. Results: [STAGE-03.md](../stage-reports/STAGE-03.md).**
Source: [IMPLEMENTATION_ROADMAP.md, Stage 3](../IMPLEMENTATION_ROADMAP.md#stage-3--data-access-layer-tenant-context-and-rls-harness),
refined with ADR-020 (database layout) and ADR-021 (Kysely). Places where this plan departs from
the original roadmap text are marked **[deviation]**, with the reason.

## 1. Objective (plain language)

Build the one safe doorway through which application code reads and writes the database.
Every request will run "as" exactly one customer (tenant), and the database itself will hide
other customers' rows (PostgreSQL row-level security, RLS). Stage 3 also adds automatic checks
that fail if any future table forgets these protections. No screens, logins or business data yet.

## 2. Prerequisites

| Item | Status |
|---|---|
| Stage 2 PASS | Approved 2026-10-17 (STAGE-02.md §15) |
| OD-07 → ADR-021 (Kysely, generated types) | Approved 2026-10-17 |
| ADR-020 databases (`pbe_dev`, `pbe_test`, temporary restore databases) | In place; bootstrap done |
| Owner approval of this plan's three recommendations (§6) | **Needed** (part of the Stage 3 prompt) |
| Administrator password | **Not needed.** Stage 3 creates no roles or databases. Migration 0002 runs as `pbe_migrator`. |

## 3. Scope

### 3.1 Dependency (one)
- `kysely` 0.29.6 (MIT, no dependencies, no install scripts, no audit findings) in `apps/api`.
- `pg` and `@types/pg` declared in `apps/api` too, at the versions already in the lockfile.
- **No `kysely-codegen`** (3 high-severity audit findings; ADR-021). No ORM, Prisma, Drizzle or Python.

### 3.2 Migration `0002_tenancy_foundation.sql` (phase: expand)
- `platform.tenant`: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `slug` (unique, pattern-checked), `display_name`, `status` (`active` / `suspended`), `created_at`.
- `app.current_tenant_id()` and `app.current_user_id()`: small `STABLE` SQL functions that read the transaction-local settings `app.tenant_id` and `app.user_id`. They return NULL when unset, so no rows match.
- RLS on `platform.tenant`:
  - enabled;
  - policy: `pbe_app` may **SELECT only its own tenant row**;
  - no INSERT, UPDATE or DELETE for `pbe_app`. Tenants are created by administrative tooling in Stage 7.
- Grants: `pbe_app` gets `SELECT` on `platform.tenant` and `EXECUTE` on the two functions.
- Applied to `pbe_test` by the tests (rebuilt from empty) and to **`pbe_dev`** by `npm run db -- migrate`. Additive only: nothing is dropped or changed. The schema snapshot is refreshed.

### 3.3 Tenant-table template (documentation and test fixture, not a real table) **[deviation]**
- The roadmap mentions "one minimal tenant-owned test table pattern".
- **Recommendation:** do **not** add a dummy table to the real migrations, because it would live in `pbe_dev` permanently. Instead:
  - document the exact template in `db/migrations/README.md`;
  - build test tables from it inside temporary `zz_test_*` schemas in `pbe_test`.
- The template:
  - `tenant_id uuid NOT NULL REFERENCES platform.tenant (id)`;
  - `PRIMARY KEY (tenant_id, id)`;
  - children reference `(tenant_id, parent_id) → parent (tenant_id, id)`, so cross-tenant links are impossible;
  - `ENABLE` **and** `FORCE ROW LEVEL SECURITY`;
  - policy `tenant_isolation FOR ALL TO pbe_app USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())`;
  - explicit grants to `pbe_app`.

### 3.4 Data-access layer: `apps/api/src/modules/db/` (plain TypeScript; NestJS arrives in Stage 4)
- `database-types.ts`: **generated**, committed, never edited by hand.
- `pool.ts`: one Kysely instance on a `pg` pool, connecting as **`pbe_app`** (never `pbe_migrator`). Settings come from `.env`.
- `tenant-context.ts`: `withTenantTransaction(db, { tenantId, userId }, fn)`.
  - Validates both values as UUIDs.
  - Opens a transaction and sets `app.tenant_id` and `app.user_id` with `set_config(…, true)`. That makes them transaction-local; they disappear at commit or rollback, so pooled connections can never carry another tenant's context.
- **Lint rule:** inside `apps/api`, only `src/modules/db/**` may import `kysely` or `pg`, and `set_config` may not appear elsewhere. That stops other code bypassing the helper.

### 3.5 Type generator: `tooling/migrate/src/typegen.ts`
- Command: `npm run db -- typegen` (write) or `typegen --check` (fail if out of date; added to `verify`).
- Reads `pbe_test` after a fresh migration, covering the schemas `app`, `platform`, `audit` and `pbe_meta` (not `training`, which has no runtime access). Output is deterministic.
- Explicit type mapping:

  | PostgreSQL | TypeScript |
  |---|---|
  | `uuid`, `text` | `string` |
  | `integer` | `number` |
  | `bigint`, **`numeric`** | **`string`** (exact; never a lossy float) |
  | `boolean` | `boolean` |
  | `timestamptz`, `date` | `Date` |
  | `jsonb` | JSON value type |
  | `bytea` | `Buffer` |
  | arrays, enums | typed arrays, label unions |
  | columns with defaults | `Generated<…>` |
  | unknown types | fail generation (no silent `any`) |

### 3.6 Conformance check: `db/tests/rls-conformance`
A catalogue query that fails if any table in schema `app`:
- lacks `tenant_id uuid NOT NULL`;
- lacks RLS **enabled and forced**;
- has no policy for `pbe_app`;
- has a foreign key to another tenant table that does not include `tenant_id`.

It runs against the real `app` schema, which has no tables yet, so it passes trivially there. It is proven meaningful by fixtures (§4).

## 4. Test plan (all on real PostgreSQL 18 in `pbe_test`; `pbe_dev` only read)

| # | Test | Expected |
|---|---|---|
| T1 | Migration 0002 applies from empty; idempotent; ledger checksums | Pass |
| T2 | `pbe_app` with **no** tenant context reads a template table | 0 rows |
| T3 | Tenant A context: read, update, delete tenant B rows | 0 rows affected / visible |
| T4 | Tenant A context: insert a row with B's `tenant_id` | Rejected (`42501`, WITH CHECK) |
| T5 | Child row referencing a parent of another tenant | Rejected (`23503`, composite FK) |
| T6 | Context leak: many concurrent transactions for A and B on a small pool; then check reused connections | Each sees only its tenant; after commit or rollback, `current_setting('app.tenant_id', true)` is empty |
| T7 | Context after an error inside the transaction | Rolled back; no context remains |
| T8 | Invalid tenant or user id passed to the helper | Rejected before any SQL |
| T9 | `platform.tenant` as `pbe_app` | Only the own row with context; none without; insert, update and delete refused |
| T10 | Conformance: compliant template fixture | Passes |
| T11 | Conformance negative fixtures, one per rule: no `tenant_id`; RLS off; RLS not forced; no policy; FK without `tenant_id` | **Each one fails the check** (evidence quoted) |
| T12 | Type generator: unit mapping tests; generated file compiles; `--check` detects a stale file; unknown type fails | Pass |
| T13 | Lint rule: `kysely` or `pg` import outside `modules/db`, and `set_config` outside it | Lint fails (bad fixtures); passes on real code |
| T14 | Mutation checks in a scratch copy: remove `FORCE`, remove the policy, switch the helper to session-level `set_config` | The right tests fail |
| T15 | Full `npm run verify` (now including `typegen --check`) | 13/13 |
| T16 | `pbe_dev` after `migrate`: status OK, drift none, existing ledger row unchanged | Pass |

The data used is fictional only (OD-12(a) not resolved).

### 4.1 Explicit test requirements added at authorisation (owner, 2026-10-17)

The owner required these to be tested explicitly. Each is a named test that must pass on real PostgreSQL 18 (`pbe_test`) and is listed in STAGE-03.md.

**A. Transaction-scoped tenant context with connection-pool reuse and no leakage** (extends T6 and T7)
- A1. A pool of **2** connections runs **50+** transactions, alternating tenants A and B, sequentially and concurrently. Every transaction sees only its own tenant's rows.
- A2. The same physical connection (same `pg_backend_pid()`) is proven to be reused across tenants. After each commit **and** each rollback, `current_setting('app.tenant_id', true)` and `current_setting('app.user_id', true)` are empty on that connection.
- A3. A query run on a pooled connection **outside** the helper, after a tenant transaction, sees 0 tenant rows.
- A4. An error thrown inside the helper rolls back, and the connection returns to the pool with no context.

**B. Fail-closed when tenant context is missing or invalid** (extends T2 and T8)
- B1. No context: SELECT returns 0 rows; UPDATE and DELETE affect 0 rows; INSERT is rejected (`42501`).
- B2. Empty-string context behaves exactly like missing context: 0 rows; writes refused.
- B3. A malformed value set directly in the database (e.g. `'not-a-uuid'`) makes the query **error**. It never falls back to showing data.
- B4. A non-UUID, empty, missing or extra-field tenant or user id passed to `withTenantTransaction` is rejected **before** any SQL is sent.
- B5. A tenant id that does not exist in `platform.tenant`: 0 rows visible; inserts rejected by the foreign key.

**C. Cross-tenant denial for SELECT, INSERT, UPDATE and DELETE** (extends T3–T5), all as `pbe_app` with tenant A's context:
- C1. SELECT of B's rows: 0 rows, both by direct id and by a full scan.
- C2. INSERT with `tenant_id = B`: rejected (`42501`, WITH CHECK).
- C3. UPDATE of B's rows: 0 rows affected; B's data unchanged (verified separately as B).
- C4. UPDATE of an A row to `tenant_id = B` (moving it to another tenant): rejected (`42501`).
- C5. DELETE of B's rows: 0 rows affected; B's rows still present.
- C6. A child row pointing at B's parent: rejected (`23503`, composite foreign key).
- C7. `platform.tenant`: A sees only its own row; INSERT, UPDATE and DELETE are refused.

**D. Actual roles and privileges** (catalogue checks plus real attempts as `pbe_app`)
- D1. **Table ownership:** `pbe_app` owns no table, schema, function or database. Therefore it cannot disable or un-force row security (`ALTER TABLE … DISABLE / NO FORCE ROW LEVEL SECURITY`), drop or alter a policy, change a table's owner, or `TRUNCATE` a tenant table. Each attempt is shown to fail (`42501`).
- D2. **Role escalation:** `SET ROLE pbe_owner`, `SET ROLE pbe_migrator`, `SET SESSION AUTHORIZATION`, `GRANT pbe_owner TO pbe_app`, `CREATE ROLE` and `ALTER ROLE pbe_app BYPASSRLS` all fail. `pbe_app` is a member of no role.
- D3. **Superuser:** `pbe_app` is not a superuser (catalogue). Control test on the throw-away server: a superuser **does** see every tenant's rows, which shows why the runtime role must never be one. The runner's superuser refusal (Stage 2.1) is re-run.
- D4. **BYPASSRLS** (confirmed by the owner). `pbe_app` has no `BYPASSRLS` (catalogue). `SET row_security = off` as `pbe_app` makes a query on a tenant table **error** rather than bypass RLS. Control test on the throw-away server: a `BYPASSRLS` role does see every tenant's rows.
- D5. Re-run of the existing privilege checks: no DDL in any schema, no access to `training`, ledger read-only.

## 5. Acceptance criteria
1. T1–T16 **and every test in §4.1 (A1–A4, B1–B5, C1–C7, D1–D5)** pass on PostgreSQL 18.6; counts reported; nothing skipped without explanation.
2. Every T11 negative fixture demonstrably fails the conformance check (output quoted).
3. The RLS policy SQL and migration 0002 are quoted in STAGE-03.md for review.
4. `pbe_dev` is only migrated forward (0002 added). No existing data or ledger row changes.
5. No new high or critical audit finding. Dependency guard passes. Only `kysely` added as a new package.
6. No HTTP endpoints, NestJS, users or authentication, business tables, science, ML or AI.

## 6. Recommendations included in the Stage 3 prompt (owner approval requested)
1. **[deviation]** Tenant-table pattern as a documented template plus test fixtures, not a dummy table in the real migrations (§3.3).
2. **In-house type generator** instead of `kysely-codegen` (security audit gate; ADR-021).
3. `platform.tenant` gets RLS **enabled but not forced**. Its owner (`pbe_owner`, through migrations and tooling) manages tenant rows. The runtime role `pbe_app` sees only its own tenant. Tenant-owned tables in `app` always use **forced** RLS.

## 7. Exclusions
HTTP/NestJS (Stage 4), users and sessions (Stage 6), tenant administration screens (Stage 7), business tables, science, ML, AI, SSO, production changes, new roles or databases, commits and pushes.

## 8. Rollback
- `0002` is additive.
- Locally: `pbe_test` is rebuilt by the tests.
- `pbe_dev`: a forward-fix migration if anything must change. Applied files are never edited.
- Code: revert to the Stage 2 working tree.

## 9. Risks affected
- R-001 stays open (production-blocking). Stage 3 does not change database ownership.
- R-006 continues: all evidence will again be the coding agent's.
