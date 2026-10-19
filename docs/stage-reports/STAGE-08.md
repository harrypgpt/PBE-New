# Stage 08 — Dashboard, projects and scenarios: completion report

Date: 2026-10-18   Authorised by owner: "PBE Stage 8 — Decisions Approved; Proceed With Implementation" (2026-10-18; D8-1 to D8-8 approved, ADR-030)   Agent/model: Claude Code (Claude Opus 5.5)

> **Evidence qualification.** Every result here comes from the coding agent's own runs on this Mac. **Nothing has been independently verified** (R-006). Nothing here claims production readiness.

## 1. Summary

**Recommendation: NOT a full PASS.** The Stage 8 software is built and its tests pass. The stage cannot fully pass yet, for two reasons:
- **Acceptance criterion 4 is not met.** Migration 0006 has not been applied to `pbe_test` or `pbe_dev`. It needs migration 0005 (backup read access) first, and 0005 needs the backup-login set-up (B-1), which is still blocked.
- **Known test failures remain.** The 5 known B-1 and `pbe_backup` failures are still there (§5).

Until both are resolved, projects can be used **only on throw-away test servers**. The owner's manual check (S8-12) is not possible yet, because no lasting database has the projects tables.

**What was built:**
- **Dashboard** (home page when signed in):
  - who you are and your organisation, with a link to switch;
  - your recent projects, with scope and status;
  - "Pending tasks" and "Recent runs", which say plainly that these come later (no invented data);
  - quick actions, shown according to your permissions.
- **Projects list.**
- **Project wizard** ("Create a project"):
  - controlled terms only;
  - a **live scope check by the API**, which shows "Supported" or "**Unsupported scope**" with every reason;
  - a review step, then creation.
- **Project page:**
  - details, scope with its reasons, and status;
  - scenarios F001, F002 …: add a scenario, edit its description;
  - archive (the project becomes read-only).
- **Behind the screens:**
  - five new permissions and the template mapping;
  - department-based visibility, enforced by PostgreSQL;
  - scenario codes that are safe under simultaneous requests and never reused;
  - archive protection in the API and in the database;
  - an audit row for every change, written in the same transaction.

**Tests (all on this Mac):**

| Suite | Result |
|---|---|
| New API tests on a throw-away server (real API and real PostgreSQL 18 with 0006) | **26/26** |
| New database tests for 0006 on a throw-away server | **17/17** |
| New browser tests on a throw-away stack | **9/9** |
| New web component tests | **13/13** |
| Earlier unit tests (vocabulary, scope check, validation, codes) | **43/43** |
| Full Jest | **774 passed, 5 failed** (the 5 known failures, §5) |
| Full browser suite | **48/48** (39 earlier + 9 new) |

Seven deliberate breaks were made to check the tests: six were caught, and one was caught only by a second safety layer (§4.3).

## 2. Decisions as implemented (ADR-030)

| # | Decision | How it is implemented | Deviation |
|---|---|---|---|
| D8-1 | MVP = Stages 1–10 and 12–19 (OD-13) | OD-13 marked approved in the register; scope and roadmap updated | — |
| D8-2 | Draft vocabulary, reviewer gate explicit | Unchanged draft (ADR-011 terms only), flagged `draft-pending-reviewer-confirmation`. Borderline terms count as unsupported and say they await the scientific reviewer. The wizard says the list is a draft | — |
| D8-3 | Project fields | As recommended; dose metadata deferred to Stage 9 | — |
| D8-4 | Five permissions | `tenant.projects.read`, `tenant.allprojects.read`, `tenant.projects.create`, `tenant.projects.manage`, `tenant.scenarios.manage`; holders of the last three must use MFA | The plan's name `tenant.projects.read_all` is written **`tenant.allprojects.read`**: permission names allow only letters and dots |
| D8-5 | Template mapping | Project Lead: all four project permissions. Scientist: read and scenarios. QA/QC Reviewer, Scientific Reviewer, Viewer: read. Existing organisations' template-linked roles receive them in the migration; custom roles are not touched | **Tenant Administrator holds all five, not only "read".** A member can only grant permissions they hold. With "read" only, nobody in a new organisation could give project permissions to anyone. The template stays editable |
| D8-6 | Department visibility (B), in PostgreSQL | Projects with departments are hidden from non-members by a database rule. Holders of `tenant.allprojects.read`, and a Super Admin with an approved, unexpired break-glass grant (read-only), see all. Scenarios follow their project. Extra API rule: you cannot set departments that would hide the project from yourself | — |
| D8-7 | Scenario codes | Per-project counter taken under a row lock; unique per project in the database; never reused; no deletion | — |
| D8-8 | Archive | Visible, read-only for everyone: refused by the API (409), and also by a database trigger | — |

**Implementation choice (within the approved boundaries): schema profiles.** The API now accepts exactly one of two migration ledgers:
- 0001–0004: today's `pbe_test` and `pbe_dev`;
- 0001–0006: throw-away servers only.

The check is still exact; it was not weakened. On 0001–0004 the projects routes are unavailable and nobody holds the project permissions. Each permission records the migration that adds it, so the catalogue shown and accepted always matches the connected database.

**Not built (outside the plan's screen list):**
- an "Edit project" screen. The API supports changing a project (`PUT /projects/:id`, with the scope checked again and tested), but §5 of the plan lists no edit screen.

## 3. Files

**New:**
- **Contracts:**
  - `packages/contracts/src/projects.ts` (route contracts added to the earlier input schemas);
  - `packages/contracts/src/vocabulary.ts` (draft, unchanged).
- **API:**
  - `apps/api/src/modules/projects/{projects.controller.ts, projects.service.ts, scope.ts, scenario-code.ts}`;
  - `apps/api/src/modules/db/projects.ts`.
- **Migration** (proposed, not applied): `db/migrations-proposed/0006_projects_scenarios.sql`.
- **Web:**
  - `apps/web/src/projects/{Dashboard.tsx, ProjectsList.tsx, ProjectWizard.tsx, ProjectDetail.tsx, ScopeBadge.tsx, labels.ts, projects.module.css}`;
  - `apps/web/app/projects/{page.tsx, new/page.tsx, [projectId]/page.tsx}`.
- **Tests:**
  - `db/tests/projects-draft.throwaway.db.spec.ts`;
  - `db/tests/projects-api.throwaway.db.spec.ts`;
  - `apps/api/test/projects.spec.ts`;
  - `apps/web/test/projects.spec.tsx`;
  - `apps/web/e2e/projects.e2e.ts`;
  - `apps/web/e2e/throwaway-stack.ts`.

**Changed:**
- **Contracts:** `packages/contracts/src/authorisation.ts` (permissions, templates, per-version helpers) and `routes.ts`.
- **API:**
  - `apps/api/src/app.ts` (projects module; schema profile resolved at start-up);
  - `apps/api/src/modules/db/{schema-version.ts, index.ts}`;
  - `apps/api/src/modules/tenancy/tenancy.service.ts` (catalogue of the connected database).
- **Web:** `apps/web/app/page.tsx` (dashboard) and `apps/web/src/navigation.ts` ("Projects" link).
- **Tests:** `db/tests/tenancy-access.db.spec.ts` compares the catalogue at the database's version.
- **OpenAPI:** `openapi/openapi.json` (regenerated: 49 routes).
- **Documents:**
  - `ARCHITECTURE_DECISIONS.md` (ADR-030);
  - `OPEN_DECISIONS_REGISTER.md` (OD-13 approved);
  - `PRODUCT_SCOPE_AND_MVP.md`;
  - `IMPLEMENTATION_ROADMAP.md`;
  - `PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md` (Stage 8 application);
  - `STAGE-08-PLAN.md`.

## 4. Tests (named)

### 4.1 Throw-away servers only
Every Stage 8 database, API and browser test makes its **own private PostgreSQL 18 server**:
- created with `initdb` in a temporary folder;
- reachable only through a socket in that folder, never port 5432;
- set up with the real bootstrap and the real migrations 0001–0004, plus the proposed 0005 and 0006;
- deleted afterwards.

The browser stack starts the API with a clean environment (no `.env`), and refuses anything that is not such a server. After each run, no `/tmp/pbe-pg-*` folder remained.

### 4.2 Results

| # | Test | Result |
|---|---|---|
| S8-1 | Validation: required fields, lengths, strength > 0 and finite, units and terms from the vocabulary only; a client-supplied scope status, free-text term, foreign field or organisation id is refused (400) and nothing is stored | Pass (unit + API) |
| S8-2 | Scope check: every ADR-011 case, borderline terms (unsupported, "awaits reviewer"), unknown terms, several reasons; computed by the server and stored with the vocabulary version | Pass (unit + API) |
| S8-3 | Codes F001…; the client cannot choose one; unique per project (database); **8 simultaneous additions → F003–F010**, no duplicates; 4 simultaneous counter takes in the database → 1–4 | Pass (unit + DB + API) |
| S8-4 | **Cross-tenant, direct requests:** B cannot list, read, change, archive or add or change scenarios of A's project (404) and A's data is unchanged. In the database, B sees none of A's rows and cannot insert them; with no organisation context nothing is visible | Pass (API + DB) |
| S8-5 | Matrix per template: Project Lead 200/201/200/201; Scientist 200/403/403/201; QA/QC, Scientific Reviewer, Viewer 200/403/403/403; no role: 403 everywhere. MFA required for project-changing permissions. **Break-glass:** the Super Admin reads all projects; every write, and the scope check (a POST), is refused (403); use is audited; after revocation, 403 | Pass (API) |
| S8-6 | Department visibility through the API and in the database: department member sees it; other department or none gets 404 and no listing; `tenant.allprojects.read` sees all; break-glass approved: sees, expired or none: does not; a creator cannot hide a project from themselves (400); another organisation's department is refused (400) | Pass (API + DB) |
| S8-7 | Audit: one row per change in the same transaction (`project.created/changed/archived`, `scenario.created/changed`), with request id and digests, and no product data. **No row on any refused change** (validation, archived) | Pass (API) |
| S8-8 | RLS conformance (all `app` tables), RLS forced on the 3 new tables, and the temporary lifting inside 0006 restored; backup login can read everything; `pbe_app` has no DELETE on projects or scenarios and no TRUNCATE anywhere; catalogue and templates in the database equal the code | Pass (DB) |
| S8-9 | Browser: dashboard → create project (supported) → add F001 and F002 → dashboard shows it with 2 scenarios. An unsupported product shows "Unsupported scope" with both reasons in the wizard and on its page. Archive makes the page read-only | Pass (9/9) |
| S8-10 | axe (WCAG 2.1 AA): 0 violations on dashboard, wizard (errors, details, review), project page, list, archived page. **Project created with the keyboard only** | Pass |
| S8-11 | Deliberate breaks (§4.3) | 6 of 7 caught, 1 caught by the second layer |
| S8-12 | Owner's manual check | **Not possible yet** (no lasting database has 0006) |
| D8-8 | Archived: change, scenario add or edit, and archive again → 409, nothing written; the database refuses the same changes (trigger), and the project stays readable | Pass (API + DB) |
| — | Backend bypass in the browser: Super Admin `GET /api/v1/projects` → 403; scenario on the archived project → 409; forged `scopeStatus` → 400. Session tokens and passwords never appear in the API logs | Pass |

### 4.3 Deliberate breaks (S8-11)
Each break was made in a copy of the file. The API tests were run, and the file was then restored and compared byte-for-byte (identical).

| Break | Caught by |
|---|---|
| M1 Scope check skipped (everything "supported") | "an unsupported product is recorded and MARKED" |
| M2 Creator-department rule removed | "nobody can hide a project from themselves" |
| M3 Audit row on creation skipped | "a supported product … audited" |
| M4 Scenario number always 1 (code reuse) | 3 tests (order, simultaneous additions, matrix) |
| M5 Service allows break-glass writes | **Not caught by itself**: the access guard refuses them first (two layers) |
| M6 Access guard allows break-glass POST for read permissions | "break-glass: … may READ projects and nothing else" |
| M7 Department rule in 0006 opened (`USING (true)`) | "a member of another department … gets 404" |

Earlier breaks of the 0006 draft (P1–P6: borderline as supported, RLS not forced, code not unique, unsupported without reason, missing backup grant, tenant rule opened) were all caught (STAGE-08-PLAN.md §11). They were not repeated after the rewrite; the 17 database tests cover the same rules.

## 5. Commands executed and results (2026-10-18)

| Command | Result |
|---|---|
| `npx jest --ci --selectProjects "database (PostgreSQL 18)" --testPathPatterns projects-draft` | 17/17 |
| `npx jest --ci --selectProjects "database (PostgreSQL 18)" --testPathPatterns projects-api` | 26/26 |
| `npx jest --ci --selectProjects @pbe/api @pbe/contracts @pbe/web` | 238/238 before the web tests were added; web alone afterwards 121/121 |
| `npx jest --ci` (full) | **774 passed, 5 failed** (below) |
| `npx playwright test --config e2e/playwright.config.ts projects` (in `apps/web`) | 9/9 |
| `npx playwright test --config e2e/playwright.config.ts` (full) | **48/48** |
| `npm run lint`, `npm run format:check`, `npm run typecheck` | Pass |
| `npm run build` | Pass (20 web routes, including `/projects`, `/projects/new`, `/projects/[projectId]`) |
| `npm run check:secrets`, `check:deps`, `check:lockfile` | Pass |
| `node tooling/scripts/openapi.cjs --check` | Pass (49 routes) |
| `node --env-file=.env tooling/migrate/dist/cli.js typegen --check` | Pass (types unchanged: built from the 0001–0004 ledger) |
| `node --env-file=.env tooling/migrate/dist/cli.js drift` | No drift: `pbe_dev` matches the snapshot and the rebuilt `pbe_test` (490 entries), so **`pbe_dev` is unchanged** |
| `npm run audit:deps` | Pass: 0 high or critical (20 moderate, unchanged); no new dependency |

**The 5 known failures** (same reasons as in Stage 7B, not caused by Stage 8):
- **4 × backup and restore drill:** `pg_dump failed`. The backup login cannot read the protected tables (B-1).
- **1 × "no PBE role has BYPASSRLS; pbe_backup does not exist yet":** `pbe_backup` exists on the real server (incident of 2026-10-18; left untouched as instructed).

**Two test-only fixes made during the work:**
- the database test's fictional administrator had no role, and its fictional break-glass grant had no approver; the database correctly refused both;
- the browser test's "Strength" locator did not allow for the required-field marker.

No product code was changed to make a test pass.

## 6. Acceptance criteria (STAGE-08-PLAN.md §7)

| # | Criterion | Status |
|---|---|---|
| 1 | S8-1 to S8-11 pass; counts reported; nothing skipped without explanation | **Met** (S8-11: the one break caught only by the second layer is explained) |
| 2 | Unsupported forms clearly marked, reason shown (UI and API) | **Met** |
| 3 | RLS conformance and backup coverage for every new table | **Met** (throw-away server) |
| 4 | Migration applied to `pbe_test`, then to `pbe_dev` only after a verified backup | **Not met**: blocked by B-1. 0005 and 0006 stay in `db/migrations-proposed/` |
| 5 | 0 high/critical audit findings; no new dependency | **Met** |
| 6 | This report, with no claim of independent verification | **Met** |
| — | S8-12 owner's manual check | **Open** (needs criterion 4) |

## 7. Risks and limitations

- **Projects exist only on throw-away servers** until 0005 and 0006 can be applied (B-1 execution phase, STAGE-07A-BACKUP-REVIEW.md §24). The order of steps then:
  1. verified backup;
  2. 0005 and 0006 on `pbe_test`;
  3. regenerate the database types;
  4. verified backup of `pbe_dev`;
  5. 0005 and 0006 on `pbe_dev`;
  6. owner check S8-12.
- **The vocabulary is a draft.** The scientific reviewer (OD-10) must confirm it in Stage 12. Borderline forms stay unsupported until then.
- **Open risks:** R-001, R-007, R-009, R-010 and R-011 remain **open**; Stage 8 does not resolve them. `pbe_backup` (created in the interrupted set-up, incident of 2026-10-18) is untouched and remains to be decided.
- **API on the base profile:** the projects routes exist but answer "not available" (404). Break-glass sessions would otherwise see a "Projects" menu link that cannot load; this is not shown, because the catalogue follows the database.

## 8. Review gate

Work stops here. **Stage 9 is not started**, and nothing was applied to `pbe_dev`. No commit or push was made.

The owner's review is needed on:
- the D8-5 deviation (the Tenant Administrator holds all project permissions);
- the permission name `tenant.allprojects.read`;
- the schema-profile approach;
- the plan for criterion 4 (§7).

## 9. Decision closure and integration readiness (2026-10-18)

Order: "PBE Stage 8 — Decision Closure and Integration Readiness". The owner approved the four points in §8. Agent's own runs; **not independently verified**.

### 9.1 Decisions recorded
| # | Decision | Recorded in |
|---|---|---|
| 1 | Tenant Administrator holds all five project permissions by default; delegation, lock-out and isolation rules unchanged | ADR-030 (closure, D8-5 marked approved); product baseline (F-4) |
| 2 | Identifier `tenant.allprojects.read` | ADR-030 (closure, D8-4 marked approved) |
| 3 | Exactly two schema profiles; every other ledger refused; unavailable capability reported as such | ADR-030 (closure); product baseline (capability reporting) |
| 4 | No project edit screen in Stage 8 | ADR-030 (closure); product baseline (known limitation); roadmap status |
| — | OD-13 note that the remaining Stage 8 points are closed | Open decisions register |

### 9.2 Change made for decision 3
Before, on a database without 0006 the project routes answered **403 "access denied"**, which wrongly suggested a missing permission. The access guard now answers **404 "This feature is not available on this database yet."** for any route whose permission the connected database does not have. Sign-in is still checked first (401). This is in `apps/api/src/common/route.ts` and `apps/api/src/app.ts`. The service's own check stays as a second layer.

### 9.3 New or extended tests
| Suite | Result | What it adds |
|---|---|---|
| `db/tests/schema-profiles.throwaway.db.spec.ts` (new, throw-away server) | **5/5** | Start-up accepted at 0001–0004 and at 0001–0006; refused at 0001–0005 and with an unknown 0007; health turns 503 if the ledger changes after start-up |
| `db/tests/tenancy-access.db.spec.ts` (`pbe_test`, at 0004) | **38/38** (2 new) | Base profile: project routes answer 404 "not available" (not 403); no project permission in the catalogue, the session or role editing (400); signed out still 401 |
| `db/tests/projects-api.throwaway.db.spec.ts` | **31/31** (5 new) | Delegation: the Tenant Administrator delegates through a custom role; a role manager without project permissions cannot grant any of them (403); a Project Lead cannot manage roles (403); another organisation's roles cannot be assigned (400); `tenant.projects.read_all` refused (400) and absent from sessions |
| `db/tests/projects-draft.throwaway.db.spec.ts` | **18/18** (1 new) | The database naming check accepts `tenant.allprojects.read` and refuses `tenant.projects.read_all` |
| `apps/api/test/projects.spec.ts` | **47/47** (4 new) | Every catalogue code passes `PERMISSION_PATTERN`; the draft name fails; routes and templates use catalogue codes only; Tenant Administrator template has all five; base schema has none of them |
| Deliberate break M8: the "not available" check removed | **Caught** (the base-profile test fails); file restored byte-for-byte |

Permissions, default roles, department restrictions, tenant isolation and API authorisation are also covered by the earlier tests in §4.2 (all still passing).

### 9.4 Full regression
| Command | Result |
|---|---|
| `npx jest --ci` | **791 passed, 5 failed**: the same 5 known failures (4 × backup drill, `pg_dump failed`, B-1; 1 × `pbe_backup` exists). Not weakened or skipped |
| Full browser suite, run 1 | **35 passed, 2 failed, 11 did not run**. Both failed tests ran for 10–12 minutes against a 60-second limit (S6-19 sign-in; S8-10 keyboard wizard). The Mac's power log shows sleep and wake activity during the run, which points to the test machine being paused rather than to a product fault. This is an explanation, not proof |
| Full browser suite, run 2 (immediately after, unchanged code) | **48/48** in 41 s |
| `npm run lint`, `npm run typecheck`, `npm run check:secrets`, OpenAPI check, typegen check, drift | All pass; `pbe_dev` unchanged (drift) |

### 9.5 Remaining integration gaps
1. **0005 and 0006 are proposals only.** They are not on `pbe_test` or `pbe_dev` until the backup prerequisites (B-1) are met. Steps: §7.
2. **The owner's manual check S8-12** waits for gap 1.
3. **Database types** are still generated from 0001–0004. The projects module uses hand-written SQL; types are regenerated once 0006 reaches `pbe_test`.
4. **The 5 known backup failures** stay until B-1 is executed.
5. **The vocabulary is a draft** until the scientific reviewer confirms it (OD-10, Stage 12).
6. **No project edit screen** (accepted limitation).
7. R-001, R-007, R-009, R-010 and R-011 remain open; `pbe_backup` is untouched.

### 9.6 Verdict
**Stage 8: PASS WITH CONDITIONS for the software; NOT PASSED as a stage.** The four decisions are recorded and verified. Every Stage 8 test passes, and nothing was weakened or skipped. Acceptance criterion 4 and S8-12 stay open until the projects migration can be applied after a verified backup. Stage 9 is not started; nothing was applied to `pbe_dev`; no commit or push.

## 10. Integration readiness (2026-10-18)

Order: "PBE — Stage 8 Integration Readiness". The full plan, facts, assumptions, risks, commands and authorisations are in [STAGE-08-INTEGRATION-PLAN.md](../stage-plans/STAGE-08-INTEGRATION-PLAN.md). **Nothing was executed on the real server.** Read-only checks only; `pbe_backup` and all data are preserved.

**New findings:**
- `pbe_dev` holds no user or organisation data.
- At 0004 only the PostgreSQL administrator can make a complete backup.
- The server restarted at 16:17 IST, so its connection rules must be re-confirmed.
- The API refuses the in-between ledger 0001–0005, so 0005 and 0006 are applied in one maintenance window.

**New work** (rehearsed on throw-away servers only):

| Item | Result |
|---|---|
| `integration-0005-0006` rehearsal (pre-migration administrator backup → 0005 → backup → 0006 with project data → backup and restore → full recovery) | 10/10 |
| `apply-`/`revert-pg-hba-pbe-backup.sql` (connection-rule change without `sudo`, verified copy, check before reload, undo) | 5/5 |
| Setup script on today's real state (`pbe_backup` present, password unknown) | 4/4 |
| `compare-backups` command | in the rehearsal (positive and negative) |
| Schema profiles written out explicitly + test that generated types match one | 2/2 |
| Deliberate breaks: 0006 without grant; pre-reload check disabled | both caught; files restored byte-for-byte |

**Final regression (after all of the above):**
- `npx jest --ci`: **812 passed, 5 failed**. These are the same 5 known backup failures (4 × drill `pg_dump failed`, 1 × `pbe_backup` detector), kept visible.
- Full browser suite: **48/48**.
- OpenAPI, typegen and drift pass; `pbe_dev` unchanged.
- Lint, format, typecheck and secret scan pass.
- No throw-away server left behind.

**Verdict unchanged:** Stage 8 software PASS WITH CONDITIONS; the stage is not passed until the plan's phases are authorised and executed, and S8-12 is done. Stage 9 not started.

## 11. Integration executed (2026-10-18)

The owner authorised the whole plan ("Yes, run it all"): administrator backup first (D-I1). The owner also confirmed that nobody else changes the server and that `pbe_backup` was authorised.

The administrator password was taken from the owner's stored file into a temporary, owner-only password file that `psql` and `pg_dump` read. It was never printed, and the file was deleted at the end. Agent's own runs; **not independently verified**.

| Phase | Command(s) | Result |
|---|---|---|
| 0 | Snapshot copy; app and session check | App not running; only 2 idle pgAdmin sessions (administrator), no application session |
| 1 | `npm run db:inspect-connections` | **Rules identical** to the 11:16 report; `pg_hba.conf` unchanged since 2026-10-12 (A1 confirmed) |
| 2 | `pg_dump` as administrator; `pg_restore --list`; `compare-backups` (file against itself) | `backups/pbe_dev-pre-0005-admin-2026-10-18T13-19-44Z.dump`: 123,362 bytes, owner-only, sha256 `378b4f2d…a075a33ee`. It decodes completely and restores cleanly. **All protected tables empty, `platform.tenant` 0** (A2 confirmed) |
| 3 | `npm run db:bootstrap` | 4 × `authentication scram-sha-256`, "Bootstrap complete". `.env` gained only `PBE_PG_BACKUP_USER` and `PBE_PG_BACKUP_PASSWORD`; the other 10 entries were unchanged; mode 600. Large-object/WAL revoke now applied in both databases |
| 4 | `apply-pg-hba-pbe-backup.sql`, stamp `20261018-1851` | Verified copy `/Library/PostgreSQL/18/data/pg_hba.conf.pre-pbe-backup-20261018-1851`. 12 rules (6 new on top), 0 errors, reloaded. Other logins unaffected; `pbe_backup` → `postgres` refused |
| 5 | Session check | 0 application sessions |
| 6 | Move 0005; `migrate --db test`, `--db dev`; `verify-backup-access`; `restore-drill --db dev`; `compare-backups` | 0005 applied to both. **`BACKUP ACCESS VERIFIED`** (27/27 connection checks on the real server; audit and coverage pass in both databases). **`RESTORE DRILL PASSED`**. **`BACKUPS HOLD THE SAME DATA`**: administrator backup versus the first backup-login backup, ledger [1–4] versus [1–5] |
| 7 | Move 0006; migrate test and dev; `typegen`; `restore-drill --db dev`; `verify-backup-access` | 0006 applied to both; schema snapshot 596 entries; types regenerated (`SCHEMA_VERSIONS = [1–6]`, 167 columns). **`RESTORE DRILL PASSED`** (identical, 596 entries, ledger 6). **`BACKUP ACCESS VERIFIED`** |
| 8 | Test updates (below); `npm run verify`; `npm run dev` | **`npm run verify`: 15/15** (Jest **818/818**, browser **48/48**). App started; health ok |

**Test updates made in phase 8.** Every test stays exact; none was skipped or weakened.
- **The 4 backup-drill tests** now back up and compare as the backup login, which their own comment named as the target ("legacy path until the backup login exists"). The test fixture schema is granted to the backup login, like every PBE schema. **They now pass**, after failing since Stage 7A.
- **The `pbe_backup` detector** ("does not exist yet") is replaced by an exact check of the approved state:
  - only `pbe_backup` has BYPASSRLS, with exactly the approved attributes and read-only setting;
  - backup coverage is clean in `pbe_test` and `pbe_dev`.
- **The function inventory** lists 0006's two reviewed functions (`access_breakglass_active_here()`, `project_visible(…)`); PUBLIC still has none.
- **The `pbe_test` base-profile test** now checks the 0006 profile (projects available, five permissions present). The "not available" rule moved to an access-guard unit test, so it stays covered.
- **Test set-up:** tests that rehearse 0005/0006 step by step take them from `db/migrations/` with a version limit.

**One unexplained result, kept on record.** The first `npm run verify` reported the Jest step as failed after 38 s, without any output. The run before it (Jest alone) passed 818/818, and so did the two runs after it (Jest alone, then `npm run verify` 15/15). The cause is unknown. `verify` now prints the exit code and signal of a failed step, so a repeat would be explained.

**Rollback assets kept:**
- the administrator backup above;
- `backups/schema-snapshot-before-0005.txt`;
- the `pg_hba.conf` copy and `db/bootstrap/revert-pg-hba-pbe-backup.sql`.

**Acceptance criteria now:**
- Criterion 4 (migration applied to `pbe_test`, then `pbe_dev` after a verified backup): **met**.
- **The 5 known failures are resolved by fixing the cause: 0 failures.**
- **Open:** S8-12, the owner's manual check. `pbe_dev` has no user accounts yet, so the owner needs an account to do it.

**Verdict:** every Stage 8 acceptance criterion is met **except the owner's manual check S8-12**. The recommendation is PASS once S8-12 is done. Stage 9 not started; nothing committed or pushed.

## 12. Final acceptance check S8-12 (2026-10-19)

Order: "PBE Stage 8 — Final Acceptance Check". The owner authorised creating fictional accounts in `pbe_dev`. The check ran as browser automation (Chromium driven by Playwright) against the running app (`npm run dev`, http://localhost:3000, API on `pbe_dev`). Agent's own run; **not independently verified**. The owner may repeat it by signing in with the fictional accounts.

**Accounts and organisations** (created with the approved workflow):
- The **Super Admin** was created with the operator tool (`user create`, `grant-platform-role`).
- In the browser, the Super Admin created **both organisations**, each with a first administrator.
- Each administrator **activated** with the one-time link from the development outbox, chose a password, enrolled an authenticator app and chose their organisation.

Passwords were generated at random, never printed, and stored only in `~/PBE-fictional-acceptance-accounts.txt` (owner-only, outside the project) so the owner can sign in.

| Item | Identifier |
|---|---|
| Super Admin | user `01a154b5-8ff1-76b5-b20c-48a4741dff79`, `fictional.superadmin.1ac9bf@example.test` |
| Organisation A | `48e83d23-a796-453c-a562-876e044cb5d8`, "Fictional Acceptance Org A (TEST DATA 1ac9bf)", slug `fictional-accept-a-1ac9bf` |
| Administrator A | user `01a154b5-9615-7cf0-9649-789ea0045407`, membership `01a154b5-9616-7474-a61f-2ed64d40e18e`, `fictional.admin-a.1ac9bf@example.test` |
| Organisation B (unrelated) | `212db730-3553-48c0-8aa8-926fc3dd6516`, "Fictional Acceptance Org B (TEST DATA 1ac9bf)", slug `fictional-accept-b-1ac9bf` |
| Administrator B | user `01a154b5-967e-7570-895c-bda763fb3937`, membership `01a154b5-967e-79a2-b75e-bb23624cfa81`, `fictional.admin-b.1ac9bf@example.test` |
| Project | `01a154ce-b709-7d4d-949a-ee6414d47f8a`, "Fictional Acceptance Project (TEST DATA 1ac9bf)": Fictionalol 50 mg, tablet, oral, immediate release; scope **supported** (vocabulary `draft-2026-10-18`); status **active** |
| Scenario F001 | `01a154ce-b916-7668-ae82-fd845de03cdd`, "Fictional reference formulation (TEST)" |
| Scenario F002 | `01a154ce-b945-74b4-a1ea-4e3c51b320ab`, "Fictional test formulation (TEST)" |

**Results:**

| # | Check | Result |
|---|---|---|
| 1 | Administrator A signs in (password + authenticator) and holds the five project permissions | Pass |
| 2 | Project created with the wizard; live scope check "Supported"; review step | Pass |
| 3–4 | Two scenarios added on the project page; codes **F001** and **F002** (the project's first allocations) | Pass |
| 5 | Dashboard row: scope "Supported", status "Active", 2 scenarios | Pass |
| 6 | Project page lists F001 and F002 with their descriptions | Pass |
| 7 | **Unrelated organisation B, direct API requests:** A's project not listed; `GET`, `PUT`, archive, add scenario, change scenario → **404 each**; B's Projects page "No projects yet." Super Admin without break-glass → 403; signed out → 401. A's project unchanged afterwards | Pass |
| — | axe WCAG 2.1 AA on the wizard review, dashboard and project page | 0 violations |
| — | Database cross-check (read-only, backup login) | Organisations, the 3 accounts, the project (in organisation A, `next_scenario_number` 3) and F001/F002 exist in **`pbe_dev`**; **none in `pbe_test`**. Audit: 1 `project.created` and 2 `scenario.created`; **no row from B's refused attempts** |

**Evidence** (non-sensitive) in [assets/stage-08](assets/stage-08/):
- `1-wizard-review.png`, `2-dashboard.png`, `3-project-page.png`, `4-org-b-projects.png`;
- `acceptance-evidence.json` (identifiers and check results only).

The screenshots were viewed after capture and contain no password, code or token. Pages showing authenticator keys or recovery codes were not captured.

**Defect found and fixed during the check (Stage 7B code).**
- **What failed:** the first attempt stopped at activation. "Set your password" said the link was incomplete, but **only under `npm run dev`**.
- **Why:** React's development Strict Mode runs page start-up twice. The second run found the address bar already cleaned and replaced the token with "none". Production builds run it once, which is why the browser tests (production build) never saw it.
- **Fix:** `apps/web/src/auth/SetPasswordForm.tsx` now reads the link once per page; the address bar is still cleaned at once.
- **Regression test** in `apps/web/test/admin.spec.tsx` renders the page under Strict Mode. It **failed before the fix and passes after**.
- **How the check resumed:** with the same organisations and the still-unused activation links (the failed page never sent anything). The Super Admin's password from attempt 1 existed only in that run's memory, so it was reset with the operator tool (`reset-password`, `reset-mfa`). No extra test data was created.

**Regression after the fix:** `npm run verify` **15/15**: Jest 819/819 and browser 48/48 (run with the app stopped; the app was restarted afterwards).

**Environment:**
- No PostgreSQL role, password, connection rule or server setting was changed.
- No migration was run.
- Nothing was committed or pushed.
- The fictional data is labelled "TEST DATA" / "(TEST)" and uses `example.test` addresses.

### Verdict

Every Stage 8 acceptance criterion is now met:
- S8-1 to S8-11 pass;
- unsupported scope is marked with its reason;
- RLS conformance and backup coverage pass;
- the migration was applied to `pbe_test` and `pbe_dev` after a verified backup;
- 0 high/critical audit findings;
- this report;
- **S8-12** done as above (browser automation).

**Recommendation: Stage 8 PASS.** Stopped for the owner's review; Stage 9 is not started.

