# Stage 07A — Organisations, roles, permissions, break-glass and audit: completion report

Date: 2026-10-17   Authorised by owner on: 2026-10-17   Agent/model: Claude Code (Claude Opus 5.5)

> **Evidence qualification.** Every result here comes from the coding agent's own runs on this Mac. **Nothing has been independently verified** (R-006). Nothing here claims production readiness.

## 1. Summary

**Recommendation: BLOCKED** (not FAIL) on one item that needs your decision, **B-1** (§6).

Everything in the Stage 7A scope was built and tested on PostgreSQL 18 (`pbe_test`) through the API:
- organisations, memberships, departments, configurable roles;
- the fixed permission catalogue and the per-request permission guard;
- the Super Admin (platform owner) and the first-Tenant-Admin onboarding exception;
- break-glass (one hour, read-only, approved, audited);
- one-time activation and reset tokens;
- the append-only, transactional business audit trail;
- the operator command for the first Super Admin.

**The blocker:** Stage 7A creates the first real organisation tables. Stage 3 requires these to **force** row-level security. PostgreSQL's backup tool cannot copy forced tables unless it runs as a role that bypasses row-level security, and no PBE role can. So:
- the three restore-drill tests now fail;
- **I did not apply migration 0004 to `pbe_dev`**, because its backups would stop working.

Fixing this needs administrator rights. I prepared the SQL for your review (§6) and did **not** run it.

**Results:**
- New Stage 7A security tests: **34/34** (33 on three runs, plus one layer-isolation test added after the mutation checks).
- Final `npm run verify`: **13/15**:
  - Jest **574 passed, 5 failed**: 3 restore-drill tests and 2 `pbe_dev` checks, **all caused by B-1**;
  - the schema-drift step also fails, because `pbe_dev` is deliberately one migration behind;
  - Playwright **30/30**.
- Nothing skipped.

## 2. Decisions recorded (owner, 2026-10-17)

| Decision | Recorded as |
|---|---|
| Break-glass: written purpose, Tenant Admin approval, read-only, one organisation, full audit, **max 1 hour, no automatic renewal** | ADR-028 (OD-26 approved) |
| Super Admin = `platform_owner`, no default customer-data access; Scientific Reviewer and Support boundaries documented, **not created** | ADR-029; `authorisation.ts` |
| First Tenant Admin bootstrapped by the Super Admin, **only when creating the organisation** | ADR-029; SECURITY §5 updated |
| Tokens: secure, single use, **max 4 hours**, hash-only, separate delivery channel, never shown to administrators; user chooses the password | ADR-029; **R-011 recorded** (no verified channel exists yet) |
| Fixed permission catalogue; configurable roles and departments; role names carry no power | ADR-029 |
| Templates: Tenant Administrator, Project Lead, Scientist, QA/QC Reviewer, Scientific Reviewer, Viewer (least privilege); last-admin protection | ADR-029; migration 0004 seed |
| First Super Admin via the operator command; MFA required; audited | `npm run user -- grant-platform-role` |
| Split into 7A and 7B; 7A only | STAGE-07-PLAN.md status |

## 3. What was built

**Migration `0004_tenancy_access_audit.sql`** (additive, `expand`):
- **Seeds:** `platform.permission` (12 permissions) and role templates.
- **Organisation tables** — 7 `app` tables, all with RLS **enabled and forced**:
  - `membership` (holds the organisation's own copy of the member's email and name, because `pbe_app` cannot read accounts);
  - `department`, `membership_department`, `role`, `role_permission`, `membership_role`, `tenant_setting`.
- **Platform tables:**
  - `platform_role_assignment` (only `platform_owner` allowed);
  - `break_glass_grant` (database checks: **one-hour maximum**, approval complete, never self-approved);
  - `user_token` (database check: **four-hour maximum**, hash only).
- **Sessions:** two nullable columns on `user_session` (active tenant, break-glass grant).
- **Audit:** `audit.audit_event`, append-only (trigger), INSERT-only for `pbe_app`, and only for its own organisation (row-level security on insert).
- **Policies:** two narrow SELECT policies let a user see **their own** memberships and organisation names, and only while **no** organisation is selected.
- **Functions:** 18 reviewed SECURITY DEFINER functions, each acting on one key. Two of them are **not** executable by `pbe_app`:
  - `operator_platform_role_set` (operator only);
  - an internal helper.

**API: 33 new routes (41 in total).**
- Organisation routes act **only on the session's active organisation**. No organisation id is ever taken from the request (S7 contract test).
- The guard decides permissions **on every request from the database**, so revocation is immediate.
- Break-glass requests run in a **read-only PostgreSQL transaction**, so PostgreSQL itself refuses writes.
- Administrative changes in one organisation are **serialised with an advisory lock**, so the lock-out rule holds under concurrency.
- Each change and its audit row are written in **one transaction**.

**Shared definition (`packages/contracts/src/authorisation.ts`):**
- the fixed permission catalogue;
- the templates;
- default departments;
- the platform-role mapping;
- the administrative permissions that require MFA.

A test proves the database catalogue and templates equal the code (§8).

**Tokens:**
- Delivered only to a **development outbox** on this Mac (`.data/outbox/`, git-ignored, files readable by the local user only).
- Never in API responses.
- The API **refuses to start in production mode** with this outbox (R-011).

**Operator command:** `npm run user -- grant-platform-role | revoke-platform-role --email …`.
- Uses an **operator connection** (`pbe_owner` through the migration login) that the API never has.
- Requires MFA and ends the user's sessions.
- Audited in the business trail and the security log.

**Website:** only the session data mapping (active organisation name) changed; the screens are Stage 7B.

## 4. Files

**Created:**
- `db/migrations/0004_tenancy_access_audit.sql`;
- `db/bootstrap/proposed-stage-07a-backup-roles.sql` (**not executed**, §6);
- `packages/contracts/src/authorisation.ts`, `tenancy.ts`;
- `apps/api/src/modules/db/tenancy.ts`;
- `apps/api/src/modules/tenancy/` (`access.ts`, `tenancy.service.ts`, `tenancy.controller.ts`, `token-outbox.ts`);
- `db/tests/tenancy-access.db.spec.ts`;
- this report.

**Changed:**

| File | Change |
|---|---|
| `packages/contracts/src/auth.ts`, `routes.ts`, `index.ts` | Session response gains `activeTenant`, `breakGlass`, `platformRoles`; 33 routes registered; API version 0.7.0 |
| `apps/api/src/common/route.ts`, `common/http.ts` | Guard resolves permissions per request; unknown permissions refused |
| `apps/api/src/modules/db/tenant-context.ts`, `database.ts`, `index.ts` | `withUserTransaction`; read-only transactions; operator connection |
| `apps/api/src/modules/auth/*` | Session info moved to the tenancy service; DI token |
| `apps/api/src/config/config.ts` | `PBE_TOKEN_OUTBOX_DIR`; production refused (R-011) |
| `apps/api/src/cli/user.ts`, `app.ts` | Super Admin commands; wiring |
| `apps/api/src/modules/db/database-types.ts`, `openapi/openapi.json` | Regenerated (138 columns; 41 routes) |
| `tooling/migrate/src/typegen.ts` and its test | **Bug fix:** a timestamp with a default was wrapped as `Generated<Timestamp>`, which Kysely does not unwrap (the column read as the wrong type). It now gets an explicit `ColumnType`; new unit test |
| `apps/web/src/session/server-session.ts` | Shows the active organisation name |
| Earlier tests (product changes, no check weakened) | `auth.db.spec.ts` (session shape), `auth-privileges.db.spec.ts` (the exact list of functions `pbe_app` may run now includes the Stage 7A ones; still "exactly these and nothing else"), `contracts.spec.ts` (guard now needs a database; every permission must be in the catalogue; no tenant id in tenant routes) |
| Docs | ADR-028, ADR-029; OD-26 approved; SECURITY §5; R-011; R-008 log; STAGE-07-PLAN status |

**No new packages** (586 installed, unchanged).

## 5. Commands executed and results (2026-10-17)

| # | Command | Result |
|---|---|---|
| 1 | `npm run db -- restore-drill --db dev` (**before** writing 0004; nothing pending) | **RESTORE DRILL PASSED**: schema identical (202 entries), all 9 tables identical, usable, 0 pending; temporary copy dropped. This closes the Stage 6 backup note |
| 2 | Recorded ADR-028, ADR-029, R-011; plan and SECURITY §5 | Done |
| 3 | `npm run db -- migrate --db test`; `typegen` | Applied (30 ms); later rebuilt after two edits (member name copy; token look-up) |
| 4 | `tsc` | **Found** the type-generator timestamp bug (§4); fixed and tested (28/28) |
| 5 | Stage 6 suites after the change | 42/42 after updating the session shape and the reviewed-function list |
| 6 | `tenancy-access.db.spec.ts` ×3 | **33/33** each time |
| 7 | Full Jest | 572 passed, 6 failed (§1) |
| 8 | `npm run db -- backup --db test` (to see the failure) | `pg_dump: … query would be affected by row-level security policy for table "department"` (§6) |
| 9 | Role check | Only the `postgres` superuser has BYPASSRLS (§6) |
| 10 | `npm run openapi`; ESLint; Prettier; secret scan; dependency guard; `npm audit` | 41 routes; clean; PASS; PASS; 0 high/critical (20 moderate, R-004) |
| 11 | Mutation checks | §9: all 9 detected (two only after adding layer-isolating tests) |
| 12 | `npm run verify` | **First run 12/15:** the secret scan flagged a psql variable reference (`PASSWORD :'…'`) that I had quoted in this report. It is not a credential; the scanner exempts the pattern only in `.sql` files. The report line was reworded; the scanner was not changed (13/13). **Final run 13/15:** Jest (5 failures) and schema drift, **both caused by B-1 only**; every other step passes, including E2E 30/30 |
| 13 | State check | Databases `pbe_dev`, `pbe_test`, `postgres`; **`pbe_dev` still at 0003** (not migrated, by decision) |

## 6. Migration and backup evidence, and blocker B-1

| Prerequisite you set | Evidence |
|---|---|
| Re-run backup verification with nothing pending | **PASSED** (§5 #1) |
| Confirm expected schema and history | `pbe_dev`: 0001–0003 applied, 0 pending; matches its snapshot (202 entries) |
| Run the tests on `pbe_test` | Done: Stage 7A 33/33; full suite as in §1 |
| Verify the backup | **Not possible after 0004:** `pg_dump` cannot read tables with forced row-level security (below) |
| Confirm the migration is additive | Yes: `expand`; only `CREATE`, `INSERT` of seed rows, `ALTER TABLE … ADD COLUMN` (two nullable), `ENABLE/FORCE ROW LEVEL SECURITY` on new tables, policies and grants |
| **Apply to `pbe_dev`** | **Not done.** Applying it would break `pbe_dev` backups. **BLOCKED on B-1** |

**Cause.**
- Stage 3 requires every organisation table to **force** row-level security (also for its owner); this is a security control I must not weaken.
- `pg_dump` reads with row-level security switched off. For forced tables it then **refuses**, unless the role has `BYPASSRLS`. Only a superuser can grant that.
- Turning the force off, or backing up with security on (which would silently copy **zero rows**), would weaken a control or lose data. Both are rejected.

**B-1 (your decision): proposed fix, prepared but NOT executed.** File: [db/bootstrap/proposed-stage-07a-backup-roles.sql](../../db/bootstrap/proposed-stage-07a-backup-roles.sql).

```sql
CREATE ROLE pbe_backup LOGIN;   -- only if it does not exist
ALTER ROLE pbe_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
-- (password: a random value supplied at run time by the bootstrap; see the .sql file; written only to .env)
GRANT pg_read_all_data TO pbe_backup;                  -- read-only
GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;
ALTER ROLE pbe_restore_drill BYPASSRLS;               -- test-only role, pbe_test and its own temporary databases only
```

**What it means:**
- A dedicated, **read-only** backup login can read every table, which is what a backup is.
- The test-only restore role can load such tables into its temporary copies.
- `pbe_app` keeps NOBYPASSRLS, and the API checks that at start-up.

**Risk:** whoever holds the backup password can read all organisations' data. That is true of any backup. I propose recording it as a risk, production-blocking until production backup handling is designed (Stage 29).

**How it would run, after your approval:**
- added to the reviewed bootstrap SQL;
- you run `npm run db:bootstrap`, which asks for the administrator password in the terminal (hidden), never in chat;
- the backup tool switches to `pbe_backup`;
- the restore drill is re-run, then 0004 is applied to `pbe_dev` after a verified backup.

## 7. Authorisation matrix (published per roadmap item 11; source of S7-1)

| Permission (stable id) | Read-only (break-glass) | Tenant Admin. | Project Lead | Scientist | QA/QC Rev. | Scientific Rev. | Viewer | Route(s) |
|---|---|---|---|---|---|---|---|---|
| `tenant.members.read` | yes | ✓ | ✓ | – | – | – | – | GET /tenant/members |
| `tenant.members.manage` | no | ✓ | – | – | – | – | – | POST /tenant/members; …/deactivation, …/reactivation, …/password-reset |
| `tenant.roles.read` | yes | ✓ | – | – | – | – | – | GET /tenant/roles, /tenant/permissions |
| `tenant.roles.manage` | no | ✓ | – | – | – | – | – | POST/PUT/DELETE /tenant/roles; PUT …/members/:id/roles |
| `tenant.departments.read` | yes | ✓ | ✓ | – | – | – | – | GET /tenant/departments |
| `tenant.departments.manage` | no | ✓ | – | – | – | – | – | POST/PUT/DELETE /tenant/departments; PUT …/members/:id/departments |
| `tenant.settings.read` | yes | ✓ | – | – | – | – | – | GET /tenant/settings |
| `tenant.settings.manage` | no | ✓ | – | – | – | – | – | PUT /tenant/settings |
| `tenant.breakglass.approve` | no | ✓ | – | – | – | – | – | GET /tenant/break-glass; …/decision; …/revocation |
| `platform.tenants.read` | – | platform_owner only | | | | | | GET /platform/tenants |
| `platform.tenants.manage` | – | platform_owner only | | | | | | POST /platform/tenants; …/suspension, …/reactivation |
| `platform.breakglass.request` | – | platform_owner only | | | | | | /platform/break-glass (request, list, entry, revocation) |

Notes:
- The four non-admin templates have no permissions yet; their scientific permissions arrive with those features (least privilege).
- "Any signed-in user" routes: session, choose or leave organisation, own password and MFA.
- Public: health, sign-in steps, token password.

## 8. Test results (mandatory list and named tests)

All tests run on real PostgreSQL 18 (`pbe_test`, as `pbe_app`) over real HTTP. Database behaviour was tested directly, not inferred from code or UI.

| Your mandatory test | Tests (in `tenancy-access.db.spec.ts`) | Result |
|---|---|---|
| Cross-organisation read/write isolation | A's admin cannot see, deactivate, reset, rename, delete or assign B's members, departments or roles (404/400); cannot choose B (same answer as unknown); **database:** with A's context, B's rows are invisible and inserting B rows is refused by RLS; with no context nothing is visible | ✓ |
| Immediate permission revocation, deactivation, suspension | Role removed, membership deactivated, organisation suspended: refused at the very next request; reactivation restores; admin-initiated reset ends the member's sessions | ✓ |
| Last-administrator lock-out | Sole role manager cannot remove own admin role, deactivate self, delete or weaken the admin role (409; nothing changed, nothing audited); **two admins removing each other concurrently: exactly one succeeds**, a manager remains | ✓ |
| Break-glass approval, scope, read-only, expiry, revocation | No default access (API and RLS); purpose ≥ 10 characters; not usable before approval; another organisation's admin cannot decide (404); a viewer cannot (403); approval gives exactly **60 minutes**; inside: reads allowed, **every write refused**, other organisations refused; uses audited; revocation is effective at once; expiry (clock moved): refused, marked expired, audited, **no renewal**; **database refuses a grant longer than one hour**; **PostgreSQL rejects writes in the read-only transaction** | ✓ |
| Atomic audit recording | One audit row per change, with its request id; a refused change (duplicate name) writes no row | ✓ |
| Protection against audit alteration or deletion | `pbe_app`: no SELECT, UPDATE, DELETE or TRUNCATE (privilege and real attempts); INSERT for another organisation refused by RLS; even the owner is stopped by the trigger | ✓ |
| User-context and tenant-context impersonation | Tenant or user ids in headers ignored, in query or body refused (400); forged session token refused (401); another user cannot enter someone else's grant (API 403, and the database function refuses it too); **documented limitation R-007:** raw SQL as `pbe_app` can still set `app.tenant_id` itself | ✓ (limitation shown) |
| Role and permission escalation | A role manager without `members.manage` cannot create or change a role to include it, nor assign the admin role; platform and unknown permissions refused (400); the database refuses platform permissions in organisation roles | ✓ |

**Further tests:**
- **S7-1 authorisation matrix:** every template and a no-role member, against every tenant permission; tenant roles never reach platform routes.
- **Catalogue and templates:** database equals code.
- **New organisations:** 6 templates, 7 departments, settings off.
- **S7-11 MFA:** an administrative role sets MFA as required and ends unenrolled sessions.
- **S7-9:** roles and departments renamed, added and removed; **a role named "Tenant Administrator copy" grants nothing**.
- **S7-13:** separation-of-duties setting stored and audited.
- **Tokens:** hash only; exactly 4 hours; only the newest valid; expired refused; the database refuses longer lifetimes; a weak password does not consume the token; single use.
- **Super Admin bootstrap:** via the real operator command; audited as operator; sessions ended; MFA required; `pbe_app` cannot run it.
- **S7-16 hygiene:** no password, token, recovery code or MFA key in logs, audit or security events.
- **S7-3 conformance:** the existing check "real app schema conforms" now covers 7 real tables and passes.
- **S7-12 least privilege:** exact executable-function list (S6-17, extended).

**Not executed in 7A:** S7-14 and S7-15 (browser and accessibility: Stage 7B screens); S7-19 (manual check, after 7B).

## 9. Mutation checks

Seven mutations ran in disposable copies (Stage 7A test file, 33–34 tests); two were database grant or policy changes in `pbe_test`, reverted at once (afterwards 46/46).

| Mutation | Detected by |
|---|---|
| M1 Permission check bypassed in the guard | 9 tests: S7-1 matrix (5 templates + no-role member), S7-5, break-glass, S7-9 |
| M2 Department isolation policy weakened to `true` (database) | 3 tests: S7-2 API and **database** isolation; new-organisation contents |
| M3 Break-glass read-only check removed (API layer) | **First run: not detected**, because the service layer and PostgreSQL's read-only transaction still refused every write (defence in depth). A layer-isolating test was added; **re-run: detected** |
| M4 Break-glass expiry check removed (API layer) | **First run: not detected**, because the database function refused to record use of an expired grant. A layer-isolating test (expiry also clears the session) was added; **re-run: detected** |
| M5 Audit insert skipped | 2 tests: S7-8 atomic audit; S7-13 setting audited |
| M6 `pbe_app` granted UPDATE on `audit.audit_event` (database) | S7-8 audit protection |
| M7 Last-administrator check removed | S7-10 |
| M8 Escalation check removed | escalation test |
| M9 Organisation choice without membership | 11 tests (no default access, isolation, revocation, tokens …) |

## 10. Acceptance criteria (STAGE-07-PLAN.md §7, applied to 7A)

| # | Criterion | Result |
|---|---|---|
| 1 | Named tests pass, nothing skipped | **PASS for 7A tests** (34/34); full suite **not green** (5 failures and the drift step, all caused by B-1) |
| 2 | RLS conformance for all new tables | **PASS** |
| 3 | Authorisation matrix published and the source of S7-1 | **PASS** (§7) |
| 4 | 0004 on `pbe_test`, then on `pbe_dev` after a verified backup | **BLOCKED** (B-1): `pbe_test` done; `pbe_dev` deliberately not migrated |
| 5 | 0 high/critical; guard; no new dependency | **PASS** |
| 6 | Exclusions respected (no screens, no Stage 8) | **PASS** |
| 7 | This report, no claim of independent verification | **PASS** |

## 11. Risks and limitations

| Risk | Status |
|---|---|
| R-001 | **Open, production-blocking** |
| R-007 (tenant and user context) | **Open, production-blocking.** Matters more now that RLS protects real organisation tables; shown by a test |
| R-009 | **Open, production-blocking** |
| R-010 | **Open, production-blocking** |
| **R-011** (new) | **Open, production-blocking:** no verified token delivery channel; development outbox only |
| Proposed with B-1 | Backup role can read all organisations' data: production-blocking until backup handling is designed (Stage 29) |
| R-008 | Re-checked: unchanged (NestJS 11.2.7 `legacy`; 12.1.3 ES-module-only; no advisories) |

**Limitations:**
- A Tenant Admin who adds an existing account learns nothing new from the response, but resets of a shared account affect the person in every organisation they belong to.
- Platform-level account deactivation is not exposed yet.
- Department-based visibility and separation-of-duties enforcement apply from Stage 8/9.
- Function bodies are not inspected by the lexical migration checks (R-003); they are covered by tests and need human review.
- Jest occasionally prints an open-handle warning after the database test files (seen in Stage 6 too); every test completes and passes. Not yet traced.

## 12. Recommendation

**BLOCKED pending B-1.** Stage 7A's rules, database structures and audit trail are implemented and pass their security tests on `pbe_test`. The `pbe_dev` migration, and a fully green verification, need your decision on B-1.

Stage 7B and Stage 8 have **not** been started. Nothing has been committed or pushed.

---

## 13. Continuation within Stage 7A (2026-10-18; no database or server change)

Requested by the owner's "development resumption" order: continue safe Stage 7A work without touching `pbe_dev`, roles, permissions, `pg_hba.conf` or Git history. Agent's own work and tests, **not independently verified**.

**Database targets, confirmed by reading the code before running anything:**
- Database tests refuse any database whose name does not end in `_test` (`db/tests/helpers.ts`).
- They write only to `pbe_test`, its temporary `zz_test_*` schemas, and temporary `pbe_restore_check_*` databases that the restore role creates and drops.
- `pbe_dev` is only read, inside `BEGIN READ ONLY` (2 checks). `npm run db -- drift` and the ledger check also only read it.
- Browser tests start their own API with `PBE_PG_DEV_DATABASE=pbe_test`.
- The application was **not** started against `pbe_dev`. It refuses to anyway: `pbe_dev` is at 0003 and the code expects 0004.

| Task | Change | Evidence |
|---|---|---|
| **S7-4 named test was missing** (plan §5: "switching rotates the session; requests without an active tenant cannot reach tenant routes") | New test in `tenancy-access.db.spec.ts`. A Project Lead in two organisations: no organisation route before choosing (403 "Choose an organisation first."); choosing A issues a new session and the old one is refused (401); switching to B rotates again and the A session cannot be reused; B shows only B's members; leaving rotates and removes the context | 35/35. Mutation (old session not ended on rotation): **only this test** failed |
| **Bug: the API never closed its database pool** (the source of the "Jest did not exit" warning in §11) | NestJS wraps the application in a proxy whose `set` trap silently ignores assignments, so the `app.close = …` override in `app.ts` never ran. On shutdown, or a refused start after `NestFactory.create`, the pool stayed open until idle time-out. Fixed with a NestJS shutdown hook (`DatabaseShutdown`); the pool is closed at most once | Traced: the two open sockets came from the API pool (start-up role check, session look-up). New tests in `api.db.spec.ts` (PostgreSQL's own `pg_stat_activity`): after `app.close()` and after a refused start, no API connection remains. Mutation (hook does nothing): detected. Full `npm test`: **0** "did not exit" warnings |
| **S7-9 static check was missing** ("no authorisation code checks a role name") | New `apps/api/test/authorisation-static.spec.ts`: the guard, the access decision and the effective-permission query contain no template key, role name or name comparison. The permission query reads only role memberships and permission identifiers | 5/5. Mutation (a template-key check added to `access.ts`): detected |

**Files changed:**
- `db/tests/tenancy-access.db.spec.ts` (S7-4 test);
- `apps/api/src/app.ts` (shutdown hook replaces the ignored override);
- `db/tests/api.db.spec.ts` (2 shutdown tests);
- `apps/api/test/authorisation-static.spec.ts` (new);
- this section.

No migration, contract, OpenAPI or dependency change.

**Results (2026-10-18):**

| Command | Database | Result |
|---|---|---|
| `npm test` | `pbe_test`; throw-away servers; `pbe_dev` read-only | **654 passed, 7 failed** (661). The 7 are the known ones: 4 restore drills on `pbe_test` and 2 `pbe_dev` checks (B-1; `pbe_dev` at 0003 by decision); 1 real-server state check that detects the unexplained `pbe_backup` role (STAGE-07A-BACKUP-REVIEW.md §23) |
| `npm run lint`, `format:check`, `typecheck`, `check:secrets`, `build` | none | All passed |
| `npm run test:e2e` | `pbe_test` (own API) | **30/30** |

Not run: `npm run verify` as a whole. Its Jest step would show the same 7 failures, and its drift step fails while `pbe_dev` is behind; every other step was run individually above.

**One run that did not finish:** an API-test run combined with formatting and type-checking produced no output within 10 minutes and was stopped. The cause was not established. Every later run of the same file finished in 1–3 seconds.

**Still blocked (needs decisions, not code):** B-1 / the `pbe_dev` migration; S7-14, S7-15 and S7-19 belong to Stage 7B. Stage 7B and Stage 8 were not started. Nothing was committed or pushed.

## 14. pbe_dev migrated to 0004 and application running (2026-10-18, owner-approved)

The owner chose "Back up, then update pbe_dev" after being told the trade-off: until the backup login (B-1) is in place, **new backups of pbe_dev will fail**; the verified backup below is the way back. Agent's own work, **not independently verified**.

| # | Command | Result |
|---|---|---|
| 1 | `npm run db -- status --db dev` | 0001–0003 applied, 0004 pending |
| 2 | `npm run db -- restore-drill --db dev` (old backup path; pbe_dev had no forced-RLS tables yet) | Backup `backups/pbe_dev-2026-10-18T06-38-46-870Z.dump` (52,212 bytes, owner-only, sha256 `86b6e93c…ba4d536`). Restored copy **identical**: schema 202 entries, ledger 3 rows, all 9 tables (0 rows each), write/read ok. Reported "FAILED" only on the known no-pending rule (0004 was applied to the temporary copy) |
| 3 | `npm run db -- drop-disposable --database pbe_restore_check_5c1d2c108e` | Temporary copy dropped |
| 4 | `npm run db -- migrate --db dev` | 0004 applied (53 ms); 0 pending; snapshot refreshed (490 entries) |
| 5 | `npm run db -- drift` | pbe_dev = pbe_test (490 entries). The snapshot comparison showed a **tooling bug**: an entry spanning several lines (a 0004 policy) was split when read back. Fixed (`snapshotLines` in `tooling/migrate/src/fingerprint.ts`, used by the CLI and the test); snapshot rewritten; **no drift** on both comparisons |
| 6 | `npm run dev` | API on 127.0.0.1:3001 (start-up checks passed on pbe_dev), website on 127.0.0.1:3000. Health `ok` directly and through the website; session without sign-in 401 "Sign-in required"; home page renders (screenshot checked) |
| 7 | `real-migrations.db.spec.ts` | 30/34: the 2 pbe_dev checks now **pass**; 4 restore-drill failures remain (B-1) |

**Not changed:** roles, passwords, permissions, `pg_hba.conf`, server settings, the `pbe_backup` role; migration 0005 was not applied. Nothing committed or pushed.

**Open:**
- pbe_dev backups now fail until B-1 is resolved (STAGE-07A-BACKUP-REVIEW.md §24).
- In development mode an empty grey box shows at the bottom-left of the website (probably the Next.js development indicator without its styles); not investigated.


## 15. Targeted review and verification (2026-10-18)

Owner's order "Stage 7A — Targeted Code Review and Verification". Agent's own review and tests, **not independently verified**.

### Verdict: **PASS WITH CONDITIONS**

The Stage 7A code and tests are complete and verified on `pbe_test` and on the migrated `pbe_dev`. Three conditions must be resolved before any commit, and before Stage 7A can be called PASS:

1. **`.env` is no longer git-ignored (new, urgent).**
   - `.gitignore` was changed at 12:07:08 IST today: its `.env` and `.env.*` lines were removed.
   - `.env` was changed at 12:07:41 and has a new variable `PGADMIN` (6 characters; value not read; nothing in PBE uses it).
   - None of the agent's tool calls wrote either file (session log checked).
   - `git status` now lists `.env`, which contains the database passwords, as committable. The secret scan fails on it, correctly.
   - If `PGADMIN` holds the administrator password, it contradicts the standing rule "never put the administrator password in a file".
   - Not changed by the agent (owner's instruction: do not discard existing changes).
2. **B-1:** `pbe_dev` (now at 0004) cannot be backed up until the backup login exists (STAGE-07A-BACKUP-REVIEW.md §24).
3. **Unexplained `pbe_backup` role** awaiting the owner's confirmation (STAGE-07A-BACKUP-REVIEW.md §23).

### A. The shutdown fix

**Why the previous code did not close the pool.**
- `NestFactory.create` returns the application wrapped in JavaScript proxies.
- The inner proxy uses NestJS's `createExceptionProxy` as its **`set` trap**. That trap returns a value but never stores the assignment.
- So `app.close = async () => { await close(); await db.destroy(); }` had no effect: `app.close()` was always NestJS's own close, and `db.destroy()` never ran.
- Evidence:
  - inside a test, `String(app.close)` printed NestJS's wrapper (`(...args) => { const result = receiver[prop](...args); …`);
  - the two sockets still open after the tests were traced to the API pool (start-up role check and session look-up);
  - they stayed fully open and closed one by one only on the pool's idle timeout.

**The fix.** A NestJS lifecycle provider, `DatabaseShutdown.onApplicationShutdown()`, ends the pool through one memoised `closeDatabase()`.

**Review findings, fixed in this phase:**
- **Building the application could abort the process.** NestJS's default `abortOnError: true` calls `process.abort()` when building the application fails (e.g. a dependency error). `NestFactory.create` was also outside the error handling, so the pool would not have been closed and no "PBE API not started" message printed. Now `abortOnError: false`, a `try/catch` → `closeDatabase()` + `StartupError`. The same setting also stops NestJS's proxy from ending the process on a synchronous error.
- **A failed `app.close()` skipped pool cleanup.** If `app.close()` threw during a failed `init`, the pool was never closed. Now `try { app.close() } finally { closeDatabase() }`.

**Shutdown order and in-progress requests** (NestJS 11 source, `nest-application-context.js` `close()`):
1. `onModuleDestroy`;
2. `beforeApplicationShutdown`;
3. `dispose()`: `server.close()`, which stops new connections and waits for running requests (`forceCloseConnections` is not set);
4. `onApplicationShutdown`, where the pool is ended.

So a running request finishes with the pool still open.

**Closed exactly once:**
- `closeDatabase` is memoised, and every path calls it: start-up refusal, build failure, init failure, `app.close()`, SIGTERM/SIGINT.
- The database library's own `destroy()` is also idempotent, so the memo is a second layer. Removing it (SA4) changed no observable behaviour, so no test can detect it; this is stated rather than hidden.

**Exact diff of `apps/api/src/app.ts`.** The file is untracked in Git; the "before" version was rebuilt by reversing the recorded edits and matches the code read earlier.

```diff
--- apps/api/src/app.ts (before, 2026-10-18 morning)
+++ apps/api/src/app.ts (now)
@@ -1,5 +1,13 @@
 import 'reflect-metadata';
-import { type DynamicModule, Module, RequestMethod, type Type } from '@nestjs/common';
+import {
+  type DynamicModule,
+  Inject,
+  Injectable,
+  Module,
+  type OnApplicationShutdown,
+  RequestMethod,
+  type Type,
+} from '@nestjs/common';
 import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
 import {
   APP_GUARD,
@@ -112,6 +120,22 @@
     throw new StartupError(`Route declarations invalid:\n  - ${problems.join('\n  - ')}`);
 }
 
+/** Ends the database pool when the application closes (idempotent). */
+const DATABASE_CLOSER = Symbol('DATABASE_CLOSER');
+
+/**
+ * NestJS shutdown hook for the database pool. (Assigning a new `app.close` does not work: the
+ * NestJS application proxy silently ignores property assignments, so the pool stayed open.)
+ */
+@Injectable()
+class DatabaseShutdown implements OnApplicationShutdown {
+  constructor(@Inject(DATABASE_CLOSER) private readonly closeDatabase: () => Promise<void>) {}
+
+  async onApplicationShutdown(): Promise<void> {
+    await this.closeDatabase();
+  }
+}
+
 @Module({})
 class AppModule {
   static register(
@@ -121,6 +145,7 @@
     auth: AuthService,
     origins: readonly string[],
     tenancyService: TenancyService,
+    closeDatabase: () => Promise<void>,
   ): DynamicModule {
     return {
       module: AppModule,
@@ -135,6 +160,8 @@
         { provide: EXPECTED_SCHEMA_VERSIONS, useValue: expected },
         { provide: APP_GUARD, useClass: AccessGuard },
         { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
+        { provide: DATABASE_CLOSER, useValue: closeDatabase },
+        DatabaseShutdown,
       ],
     };
   }
@@ -155,6 +182,8 @@
     user: config.PBE_PG_APP_USER,
     password: config.PBE_PG_APP_PASSWORD,
   });
+  let closing: Promise<void> | undefined;
+  const closeDatabase = (): Promise<void> => (closing ??= db.destroy());
   let auth: AuthService;
   try {
     await assertSafeRuntimeRole(db);
@@ -165,44 +194,53 @@
       mfaKey: config.PBE_MFA_ENCRYPTION_KEY,
     });
   } catch (err) {
-    await db.destroy();
+    await closeDatabase();
     logger.event('error', 'startup_refused', { error: err });
     throw new StartupError(`Start-up refused: ${err instanceof Error ? err.message : String(err)}`);
   }
 
-  const app = await NestFactory.create<NestExpressApplication>(
-    AppModule.register(
-      db,
-      expected,
-      options.extraControllers ?? [],
-      auth,
-      config.PBE_WEB_ORIGINS,
-      new TenancyService(
+  let app: NestExpressApplication;
+  try {
+    app = await NestFactory.create<NestExpressApplication>(
+      AppModule.register(
         db,
-        {
-          idleSeconds: config.PBE_SESSION_IDLE_MINUTES * 60,
-          absoluteSeconds: config.PBE_SESSION_ABSOLUTE_HOURS * 3600,
-        },
-        new DevelopmentOutbox(config.PBE_TOKEN_OUTBOX_DIR),
+        expected,
+        options.extraControllers ?? [],
+        auth,
+        config.PBE_WEB_ORIGINS,
+        new TenancyService(
+          db,
+          {
+            idleSeconds: config.PBE_SESSION_IDLE_MINUTES * 60,
+            absoluteSeconds: config.PBE_SESSION_ABSOLUTE_HOURS * 3600,
+          },
+          new DevelopmentOutbox(config.PBE_TOKEN_OUTBOX_DIR),
+        ),
+        closeDatabase,
       ),
-    ),
-    { logger, bodyParser: true },
-  );
+      // abortOnError false: a failure while building the application (for example a dependency
+      // error) comes back here as an error instead of NestJS calling process.abort().
+      { logger, bodyParser: true, abortOnError: false },
+    );
+  } catch (err) {
+    await closeDatabase();
+    logger.event('error', 'startup_refused', { error: err });
+    throw new StartupError(`Start-up refused: ${err instanceof Error ? err.message : String(err)}`);
+  }
   app.getHttpAdapter().getInstance().disable('x-powered-by');
   app.use(requestPipeline(logger));
   app.setGlobalPrefix(API_PREFIX);
   app.useGlobalFilters(new ProblemFilter(logger));
-  app.enableShutdownHooks();
-  const close = app.close.bind(app);
-  app.close = async () => {
-    await close();
-    await db.destroy();
-  };
+  app.enableShutdownHooks(); // app.close() and SIGTERM/SIGINT run DatabaseShutdown
   try {
     await app.init();
     verifyRouteDeclarations(app.get(DiscoveryService), options.routes ?? API_ROUTES);
   } catch (err) {
-    await app.close();
+    try {
+      await app.close();
+    } finally {
+      await closeDatabase(); // in case initialisation failed before the hook could run
+    }
     logger.event('error', 'startup_refused', { error: err });
     throw err instanceof StartupError ? err : new StartupError(String(err));
   }
```

### B. The two new security test groups

| Group | Kind | What it proves | Deliberate break → result |
|---|---|---|---|
| **S7-4** (`tenancy-access.db.spec.ts`) | Behavioural, real HTTP | No organisation route before choosing (403); choosing and switching issue a new session and the old one is refused (401); B shows only B's members; leaving rotates and clears the context | Old session not ended on rotation → **only this test failed** |
| **S7-9 behavioural** (new, `tenancy-access.db.spec.ts`) | Behavioural, real HTTP | In a fresh organisation the admin moves every power to "Custodian …". The built-in role keeps its **exact name "Tenant Administrator" and key `tenant_administrator`** but holds no permissions. A member with only that role is refused on 4 routes and on a write; the admin keeps access through "Custodian" | Access granted by exact name → **detected**; by template key → **detected** |
| **S7-9 static** (`apps/api/test/authorisation-static.spec.ts`) | Source text (second layer) | Guard, access decision and the permission query contain no role name, template key or name comparison | Both breaks above also **detected**; template-key literal in `access.ts` → detected |

The behavioural test is the primary evidence; the text check stays as an additional guard.

**Shutdown tests** (`api.db.spec.ts`; every test-created API is now closed in `finally`):

| Test | Deliberate break → result |
|---|---|
| `app.close()` ends the pool (`pg_stat_activity`, as `pbe_app`) | SA1 hook does nothing → **detected** |
| A request in progress completes; its **second** query starts after shutdown began; then no new requests; pool ended | SA2 pool ended before requests finish → first **not detected** (the request already held a connection); test strengthened with a second query → **detected** (500) |
| Closing twice is harmless | SA4 no memo → **not detected** (library already idempotent; see A) |
| Refused start-up (route without a contract) ends the pool | — |
| A failure while building the application is a `StartupError` and ends the pool (missing dependency) | SA3 create failure not handled → **detected** |
| **Real process:** `node apps/api/dist/main.js` (clean environment, `pbe_test`, `.env` not loaded) answers health, exits by itself after SIGTERM within 10 s, no API connection remains | Passed under SA1 too: in a real process the operating system closes sockets on exit. This test proves the lifecycle, not the hook |

All breaks were applied to the source and restored byte-for-byte (verified). For the process test, the API was rebuilt with each break, then rebuilt clean. **The final runs below used unmodified code.**

### C. Verification (final, unmodified code)

| Command | Database | Result |
|---|---|---|
| Focused: `api.db.spec` | `pbe_test` | **28/28**, exits normally (×3 runs, 0 "did not exit") |
| Focused: `tenancy-access` | `pbe_test` | **36/36** |
| Focused: `authorisation-static` | none | **5/5** |
| `npm test` (once; full output kept) | `pbe_test`, throw-away servers, `pbe_dev` read-only | **660 passed, 6 failed** (666; 42 suites), 34 s, 0 "did not exit" |
| `npm run lint` / `format:check` / `typecheck` / `build` | none | each **passed** |
| `npm run check:secrets` | none | **FAILED: `[env-file] .env`** (condition 1) |
| `check:toolchain`, `check:deps`, `check:lockfile` | none | passed |
| OpenAPI check / migration integrity / typegen check | — / `pbe_dev` read-only / `pbe_test` | passed (41 routes) / 0 pending / up to date (138 columns) |
| Schema drift | `pbe_dev` read-only | **No drift** (snapshot and `pbe_test`, 490 entries) |
| `npm run test:e2e` | `pbe_test` (own API) | **30/30** |
| `npm audit --audit-level=high` | — | passed (0 high/critical; 20 moderate, R-004) |

`npm run verify` was **not** run as a whole and is **not** claimed: its Jest and secret-scan steps would fail for the reasons below.

**The 6 failures:**

| # | Test | Cause (evidence) | Pre-existing? |
|---|---|---|---|
| 1–3 | `real-migrations`: backup → restore drill; restored values; failed verification keeps the copy | `pg_dump: error: query failed: ERROR: query would be affected by row-level security policy for table "department"` (reproduced with `cli.js backup --db test`; no file left: 11 files before and after) | Yes: B-1, reported since 2026-10-17 |
| 4 | `real-migrations`: a damaged archive is rejected | `ENOENT … manual.dump`: reuses the backup that test 1 could not create | Yes: same cause |
| 5 | `backup-tool`: no PBE role has BYPASSRLS | Received `pbe_backup` (bypass true) | Yes: the unexplained role, reported earlier today |
| 6 | `check-secrets`: the real repository passes | `{ file: ".env", rule: "env-file" }` | **New**: the `.gitignore` change at 12:07 IST (condition 1) |

The two `pbe_dev` checks that failed earlier now **pass**: pbe_dev was migrated with the owner's approval (§14).

**The 10-minute run without output, explained.**
- The first version of the shutdown test failed an assertion **before** `own.close()`, leaving an extra API listening.
- Jest therefore never exits, and that command piped Jest into `head`, which waits for the end of output.
- Evidence: a second run of the same version was still alive **38 minutes** later, holding one listening socket (`127.0.0.1:62076`, the extra API). It was then stopped.
- Prevented now: every test-created API is closed in `finally`, a test timer that kept Jest alive is cancelled, and all runs use a hard time limit.

### D. Boundaries

- `pbe_dev` only read (status, drift, two read-only test checks). The application copy that had been connected to it since §14 was stopped first.
- No migration, bootstrap, role, credential, grant, `pg_hba.conf` or server change; `pbe_backup` untouched.
- `pbe_test` used only by the existing, confirmed test workflow.
- Nothing committed, pushed, reset or discarded.
- Stage 7B and Stage 8 not started.

### Remaining risks

- The three conditions above.
- R-001, R-007, R-009, R-010, R-011 open, production-blocking.
- R-008 watched.
- The empty grey box in development mode (§14) not investigated.

## 16. Secret protections restored (2026-10-18; owner's urgent order)

**Summary:** `.env` is protected again and `PGADMIN` is gone, but **the agent made neither change**. When the agent started on this order (about 12:52 IST), both were already done by an edit **not made by the agent** at 12:51. The agent therefore did not edit either file again; it verified the result and recorded the evidence. **Who made the 12:07 and 12:51 changes is not known.** There is no concrete evidence identifying it: both files are owned by `harry`, carry no extended attributes, and show only the times below.

| Time (IST) | File | Change | By the agent? |
|---|---|---|---|
| 12:07:08 | `.gitignore` | `.env` and `.env.*` removed | No (session log) |
| 12:07:41 | `.env` | `PGADMIN` added (6 characters; value never read) | No |
| 12:51:10 | `.env` | `PGADMIN` removed; the 10 PBE settings remain | No |
| 12:51:38 | `.gitignore` | `.env` and `.env.*` restored | No |

**Current `.gitignore` difference from the last commit (non-secret):** only `+test-results/` and `+playwright-report/` (Stage 5).

**Verification:**
- Secret scan **PASS**; scanner tests 13/13.
- `git check-ignore`: `.env`, `.env.local`, `.env.production` ignored; `.env.example` committable (placeholders only).
- `git status` no longer lists `.env`. Tracked files at HEAD: 1. Staged: 0.
- No `.env`, key or dump file, and no secret pattern, in any of the 3 commits; a control search proved the history search works.
- The old `.env.example` files in history hold only non-secret settings.
- `PGADMIN` appears nowhere in the project folder except this report (name only); no editor leftovers.
- `.env` still works: three logins over SCRAM, MFA key 32 bytes, mode 600.

Evidence (no secret values): `backups/evidence-2026-10-18/secret-files-timeline.txt` (git-ignored, owner-only).

**Remaining exposure concerns:**
- **Commitable window.** Between 12:07 and 12:51 `.env` could have been committed. Nothing was staged or committed, so it never reached Git or GitHub. It was not copied by the agent.
- **The value passed through the agent's tools, unprinted.** In that window the agent's tools read `.env` into memory (shell commands and test runs load it) without ever printing or writing the value.
- **Copies outside the project** (for example backups made by macOS) cannot be checked by the agent.
- **If `PGADMIN` was the PostgreSQL administrator password,** consider changing it. That is an administrator action for the owner. pgAdmin also has that password saved.
- **Same unknown actor?** Two unexplained changes today (the `pbe_backup` role, 10:15–10:55; these files, 12:07) were made with access to this Mac account. Not established.

**Not done (as instructed):** no stage, commit, push, reset or discard; no database, role, credential or server change; `pbe_backup` untouched.
