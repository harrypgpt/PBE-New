# Implementation Roadmap

Status: Draft for product-owner review, MA-00, 2026-10-16.
**No stage starts without the owner's explicit authorisation.** The agent stops at the end of every stage.

## 1. How each stage works
1. The owner sends the stage prompt and authorises it, after approving the open decisions that stage requires.
2. The agent inspects the workspace, implements only the listed scope, and runs the listed tests on real tooling (real PostgreSQL where the database is involved).
3. The agent writes `docs/stage-reports/STAGE-NN.md` using the template in [architecture/TESTING_AND_ACCEPTANCE_GATES.md §6](architecture/TESTING_AND_ACCEPTANCE_GATES.md#6-completion-report-template-docsstage-reportsstage-nnmd). It reports only checks actually executed.
4. The agent recommends PASS, FAIL or BLOCKED. **The owner decides.** If the stage passes, the owner commits and tags `stage-NN-pass` (OD-03).

**Standard rollback for every stage:** return the working tree to the previous `stage-NN-pass` tag (owner-run `git` command or with agent help), then rebuild local and test databases from migrations. Stage-specific notes are added below.

**Standard gate for every stage:** PASS only if every acceptance criterion has attached evidence, `verify` passes in full, the cross-tenant and RLS conformance suites pass (from Stage 3), and no out-of-scope change was made. Otherwise the result is FAIL, or BLOCKED when a decision or external input is missing.

## 2. Stage map

| Phase | Stage | Title | Depends on | Decisions needed | Capabilities |
|---|---|---|---|---|---|
| A Foundation | 1 | Repository foundation and guardrails | MA-00 approved | OD-01, OD-03, OD-04, OD-25 | — |
| | 2 | Local PostgreSQL, roles, migration runner, backup/restore | 1 | OD-05, OD-06 | — |
| | 3 | Data-access layer, tenant context and RLS harness | 2 | OD-07 | — |
| | 4 | API foundation | 3 | OD-02 | — |
| | 5 | Web foundation | 4 | OD-24 | — |
| B Identity & tenancy | 6 | Authentication, sessions and MFA | 5 | OD-08 | — |
| | 7 | Tenancy, roles, departments, platform owner, audit | 6 | OD-26 | — |
| C Core workflow | 8 | Dashboard, projects and scenarios | 7 | OD-13 | C5 (start) |
| | 9 | Dataset versions and manual evidence entry | 8 | OD-12(a) | C5 |
| | 10 | File storage, job runner, CSV/Excel ingestion | 9 | OD-15, OD-16, OD-22 | — |
| | 11 | PDF/Word ingestion (post-MVP) | 10 | OD-16 | — |
| D Science | 12 | Method and ruleset registry; readiness and applicability | 9 | OD-09, OD-10, OD-23 | — |
| | 13 | First deterministic methods (S2) | 12 | (methods selected under OD-10) | — |
| | 14 | Statistical and study-design methods (S3) | 12 | OD-18 | — |
| | 15 | Immutable prediction runs and decision graph | 13, 14 | — | C5 |
| | 16 | Results, explanations and reports | 15 | OD-17, OD-27 | — |
| | 17 | Scenario comparison and digital twin views | 15, 16 | — | C5 |
| E Differentiators | 18 | BE Risk Fingerprint (rule-based) | 12, 15, 16 | — | C1 |
| | 19 | Virtual pivotal BE simulation | 14, 15, 16 | — | C3 |
| | 20 | Sensitivity and failure-condition engine | 18, 19 | — | C4 |
| | 21 | Next best experiment | 12, 18, 20 | — | C7 |
| | 22 | Formulation optimisation / reverse engineering | 20, 21 | — | C2 |
| F Evidence & learning | 23 | Fetch Missing Information | 9, 10 | OD-21 | — |
| | 24 | Historical data, consent and eligibility | 7, 9, 10 | OD-12(b) | C6 |
| | 25 | ML pipeline and model registry | 15, 24 | OD-11, OD-19 | C6 (C1 attribution) |
| | 26 | Pilot-to-pivotal learning, monitoring, calibration, drift | 25 | — | C6 |
| G AI & operations | 27 | Optional AI assistance | 16 | OD-20 | — |
| | 28 | Security hardening, audit search, retention/deletion, restore drill | 7 and all feature stages in the release | OD-12, OD-28 | — |
| | 29 | SaaS deployment readiness | 28 | OD-14, OD-12(c), OD-28 | — |

**Mandatory product baseline (owner, 2026-10-17):** [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md) applies to Stages 5, 6, 7, 28 and 29 and to every UI stage. It does not change the stage order or scope boundaries. Its dependencies (D-1 to D-8) must be resolved in the named stage plans.

MVP (OD-13, **approved** 2026-10-18, ADR-030): Stages 1–10 and 12–19. Stage 23 can be moved earlier (after Stage 10) if the owner prefers. Its dependencies allow it.

---

## Phase A — Foundation

### Stage 1 — Repository foundation and guardrails
1. **Objective/scope:** Create the empty, working monorepo skeleton, toolchain and the single `verify` command, with guardrails. No features.
2. **Files/modules:** root `package.json` (workspaces), `.gitignore`, `.nvmrc`, `.editorconfig`, TypeScript base config, lint and format config, test runner config, empty workspace packages (`apps/web`, `apps/api`, `packages/contracts`, `packages/science-core`) containing only placeholder exports and a trivial test, `tooling/` guard scripts, `README.md` (how to run `verify`).
3. **Exclusions:** no Next.js pages, no NestJS modules, no database, no migrations, no authentication, no business logic.
4. **Prerequisites/decisions:** OD-01, OD-03 (repository confirmed private), OD-04, OD-25.
5. **Tasks:** workspace set-up; strict TypeScript; lint rules for module boundaries ([architecture/MODULE_BOUNDARIES.md §2](architecture/MODULE_BOUNDARIES.md#2-dependency-direction)) and `science-core` purity; dependency guard (rejects Python tooling, Prisma Migrate / schema-sync tools, SQLite and in-memory database packages); secret scan; Node version check; dependency audit; `verify` aggregator.
6. **Automated tests:** guard self-tests (a fixture with a forbidden dependency or import must fail the check); secret-scan self-test; one trivial test per workspace; type-check; lint.
7. **Manual verification:** owner runs `npm ci` then `npm run verify` and sees the summary.
8. **Acceptance criteria:** clean install from lockfile succeeds; `verify` passes; each guard demonstrably fails on its bad fixture; `.gitignore` excludes `.env`, `node_modules`, build output; no package installs a Python, Prisma Migrate or SQLite dependency (guard output quoted).
9. **Security/scientific:** establishes supply-chain and secret hygiene; no scientific content.
10. **Rollback:** delete created files (working tree was empty apart from `.git`).
11. **Report:** STAGE-01.md, including the dependency list with licences.
12. **Gate:** standard.

### Stage 2 — Local PostgreSQL, roles, migration runner, backup/restore
> **Database layout (ADR-020, owner, 2026-10-17; supersedes ADR-019):** `pbe_dev` (development), `pbe_test` (tests), and temporary `pbe_restore_check_<hex>` databases created and dropped by the restore drill. The text below is the original plan.

1. **Objective/scope:** Connect to local PostgreSQL 18; create `pbe_dev` and `pbe_test` databases and the roles; build or adopt the migration runner; first migration (`0001`) creates `pbe_meta` and the schema skeleton only; verified backup and restore.
2. **Files/modules:** `db/migrations/0001_*.sql`, `tooling/` runner (if OD-06 = A), DB bootstrap script (role and database creation, run once with admin credentials supplied by the owner at run time and never stored), `.env.example`, backup/restore scripts, `db/tests/`.
3. **Exclusions:** no tenant tables, no data-access layer, no API.
4. **Prerequisites/decisions:** OD-05, OD-06; the owner provides the local PostgreSQL admin password interactively.
5. **Tasks:** runner commands `status` and `migrate`; ledger; SHA-256 checksums; advisory lock; per-file transactions and the no-transaction directive; refuse on gap, duplicate, mismatch or missing file; schema-drift check; backup with `pg_dump -Fc`; restore into a scratch database.
6. **Automated tests (real PostgreSQL):** fresh apply; idempotent re-run; modified-file rejection; missing-file rejection; numbering gap rejection; concurrent runners (two processes) apply once; failing migration rolls back and leaves the ledger consistent; runtime role cannot run DDL; drift check.
7. **Manual verification:** owner sees the runner `status` output and the databases in pgAdmin.
8. **Acceptance criteria:** all tests pass on PostgreSQL 18; backup file restored and row counts / ledger matched (evidence quoted); `pbe_app` is not superuser, not owner and has no `BYPASSRLS` (catalogue query output quoted).
9. **Security/scientific:** least-privilege roles from day one; credentials only in a git-ignored `.env`.
10. **Rollback:** drop `pbe_dev`, `pbe_test` and the PBE roles with a documented teardown script (owner-approved before running).
11. **Report:** STAGE-02.md incl. migration checksums and backup/restore evidence; FileVault status as reported by the owner.
12. **Gate:** standard.

### Stage 3 — Data-access layer, tenant context and RLS harness
> **Detailed plan for owner review:** [stage-plans/STAGE-03-PLAN.md](stage-plans/STAGE-03-PLAN.md) (2026-10-17). Applies ADR-020 and ADR-021, and proposes one deviation: a documented template plus test fixtures instead of a dummy table.

1. **Objective/scope:** Typed database access, the single tenant-context transaction helper, the `platform.tenant` table, one minimal tenant-owned test table pattern, and the standing cross-tenant and RLS conformance suites.
2. **Files/modules:** `apps/api/src/modules/db/`, migration `0002_*` (tenants plus RLS helper functions), generated DB types, `db/tests/rls-conformance`.
3. **Exclusions:** no HTTP endpoints, no users or authentication.
4. **Prerequisites/decisions:** OD-07.
5. **Tasks:** connection pool; `withTenantTransaction(tenantId, userId, fn)` using `SET LOCAL`; context always cleared; type generation step and its "up to date" check; tenant-aware composite foreign key pattern; RLS policy template.
6. **Automated tests:** with no context set, zero rows are visible; tenant A context cannot read or write B's rows; cross-tenant FK insert is rejected; context does not leak between pooled transactions (concurrency test); conformance catalogue test (and a negative fixture without RLS fails it).
7. **Manual verification:** none beyond reading the report.
8. **Acceptance criteria:** all tests pass on real PostgreSQL; a deliberately non-compliant table makes the conformance test fail (evidence).
9. **Security/scientific:** core tenant-isolation mechanism; highest scrutiny.
10. **Rollback:** standard; migrations re-applied from scratch locally.
11. **Report:** STAGE-03.md with the RLS policy SQL quoted for review.
12. **Gate:** standard.

### Stage 4 — API foundation
> **Detailed plan for owner review:** [stage-plans/STAGE-04-PLAN.md](stage-plans/STAGE-04-PLAN.md) (2026-10-17). Needs OD-02 and the new OD-29 (NestJS version) approved before implementation.

1. **Objective/scope:** NestJS application with `/api/v1`, configuration validation, Zod validation pipe, Problem-Details errors, structured redacted logging, request ids, health endpoint (including database and migration-ledger check), default-deny permission decorator, OpenAPI generation.
2. **Files/modules:** `apps/api/src/{main,app.module}`, `config`, `health`, common error/logging/validation, `packages/contracts` (problem-details, health), `openapi/` output.
3. **Exclusions:** no authentication (routes are health only), no domain modules.
4. **Prerequisites/decisions:** OD-02.
5. **Tasks:** as in the objective; refuse start-up if the migration ledger does not match the expected version.
6. **Automated tests:** config validation (missing or invalid variables); invalid request gives a 400 Problem Details response; unknown route gives a 404 Problem Details response; log redaction test (secrets and evidence-like fields never appear); OpenAPI in-sync test; route-without-permission test fails; health integration test with real PostgreSQL; start-up refuses on ledger mismatch.
7. **Manual verification:** owner opens `http://localhost:<port>/api/v1/health`.
8. **Acceptance criteria:** all tests pass; generated OpenAPI committed and in sync.
9. **Security/scientific:** error and log hygiene established.
10. **Rollback:** standard.
11. **Report:** STAGE-04.md.
12. **Gate:** standard.

### Stage 5 — Web foundation
> **Detailed plan for owner review:** [stage-plans/STAGE-05-PLAN.md](stage-plans/STAGE-05-PLAN.md) (2026-10-17). Needs OD-24 and the new OD-30 (Next.js version and web-to-API routing) approved before implementation.

1. **Objective/scope:** Next.js app shell: layout, navigation skeleton, typed API client using contracts, error and loading states, accessible form primitives, the reusable **limitation-statement** component, and an E2E smoke test.
2. **Files/modules:** `apps/web/*`, `packages/contracts` additions.
3. **Exclusions:** no login, no real data pages.
4. **Prerequisites/decisions:** OD-24.
5. **Tasks:** shell, health status page calling the API, UI conventions (progress indicator, mandatory markers, validation message pattern) as components.
6. **Automated tests:** component tests; accessibility checks on the shell (an automated a11y rule check); E2E smoke test with browser → web → API → PostgreSQL health.
7. **Manual verification:** owner opens `http://localhost:3000` and sees the shell and API status.
8. **Acceptance criteria:** tests pass; one command starts web and API together.
9. **Security/scientific:** security headers baseline (content security policy etc.) configured and tested.
10. **Rollback:** standard.
11. **Report:** STAGE-05.md with screenshots if the agent can capture them.
12. **Gate:** standard.

## Phase B — Identity and tenancy

### Stage 6 — Authentication, sessions and MFA
> **Detailed plan for owner review:** [stage-plans/STAGE-06-PLAN.md](stage-plans/STAGE-06-PLAN.md) (2026-10-17). Needs OD-08 (with its security policy), library choices, D-4, the new OD-31 and an `authenticated` access kind approved before implementation.
> **Baseline dependencies for the Stage 6 plan:** F-1, F-3, F-5, F-8, F-9; D-3 (secure admin-initiated reset; self-service recovery needs an email provider), D-4 (compromised-password screening, a sub-decision of OD-08), D-5 (prompt revocation), D-6 (security-event log starts here). See [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md).

1. **Objective/scope:** user accounts, password login, server-side sessions, logout, session rotation, TOTP MFA enrolment and verification, lockout and rate limiting, login UI.
2. **Files/modules:** `identity` module, migrations for users, credentials, sessions and MFA factors, web login and MFA pages, contracts.
3. **Exclusions:** no SSO, no self-service sign-up (users are created by an admin or seed), no password-reset email (an email provider is not chosen; reset is admin-driven until then; recorded as a gap).
4. **Prerequisites/decisions:** OD-08.
5. **Tasks:** as in the objective; CSRF protection; secure cookie flags; audit events (stored in a minimal audit table here, or wired in Stage 7; the choice is recorded).
6. **Automated tests:** correct and incorrect password; lockout and back-off; session fixation (id rotates); expired session rejected; logout invalidates; MFA required when configured; TOTP replay rejected; rate limit triggers; cookies have the correct flags; secrets never logged.
7. **Manual verification:** owner logs in with a seeded user and enrols MFA with an authenticator app.
8. **Acceptance criteria:** all tests pass; a password hash parameter record is in the report.
9. **Security/scientific:** highest-risk module; flagged for external review in Stage 28.
10. **Rollback:** standard; sessions table can be truncated safely.
11. **Report:** STAGE-06.md.
12. **Gate:** standard.

### Stage 7 — Tenancy, roles, departments, platform owner, audit
> **Detailed plan for owner review:** [stage-plans/STAGE-07-PLAN.md](stage-plans/STAGE-07-PLAN.md) (2026-10-17). Needs OD-26, the D-2 confirmation and the decisions in its §11 before implementation.
> **Baseline dependencies for the Stage 7 plan:** F-2 (Super Admin and Tenant Admin; D-2), F-3, F-4 (no hard-coded role or department catalogue), F-6, F-7 (business audit trail separate from security events and technical logs; D-6), F-9; D-5 (admin-driven revocation), D-7 (user context for the web app). See [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md).

1. **Objective/scope:** tenants, memberships, active-tenant selection, departments, configurable roles and permissions with default templates, permission guards, platform roles separate from tenant roles, break-glass design per OD-26, append-only audit events.
2. **Files/modules:** `tenancy-access`, `platform-admin`, `audit` modules; migrations; admin UI pages (tenant admin: users and roles; platform owner: tenants).
3. **Exclusions:** no audit search UI (Stage 28); no SSO.
4. **Prerequisites/decisions:** OD-26.
5. **Tasks:** as in the objective; authorisation matrix definition file; separation-of-duties configuration.
6. **Automated tests:** authorisation matrix tests; cross-tenant suite for every new resource; platform owner cannot read tenant data without a grant; break-glass grant expires and is audited; the audit table rejects UPDATE and DELETE from the runtime role.
7. **Manual verification:** owner creates two test tenants and confirms that users in one cannot see the other.
8. **Acceptance criteria:** all tests pass; RLS conformance passes for all new tables.
9. **Security/scientific:** tenant isolation end-to-end through the API.
10. **Rollback:** standard.
11. **Report:** STAGE-07.md with the authorisation matrix.
12. **Gate:** standard.

## Phase C — Core workflow

### Stage 8 — Dashboard, projects and scenarios
**Status (2026-10-18):** decisions D8-1 to D8-8 approved, and the four follow-up points closed (ADR-030); implemented; migrations 0005 and 0006 applied to `pbe_test` and `pbe_dev` after a verified backup (integration phase, 2026-10-18); awaiting the owner's check S8-12 and Stage 8 review. Known limitation: no project edit screen ([STAGE-08.md](stage-reports/STAGE-08.md)). Migration 0006 is not applied to `pbe_test` or `pbe_dev` (backup prerequisites, STAGE-08-PLAN.md §8).

1. **Objective/scope:** dashboard (welcome, identity, projects and status, pending tasks, recent runs placeholder, quick actions); project creation with controlled vocabularies and scope check; scenarios F001… per project.
2. **Files/modules:** `projects` module; migrations; contracts; web pages for dashboard, project wizard and scenario list.
3. **Exclusions:** no evidence entry, no runs.
4. **Prerequisites/decisions:** OD-13; initial controlled vocabulary for dosage form and route (draft, flagged for reviewer confirmation in Stage 12).
5. **Tasks:** as in the objective; unsupported-scope badge and blocking reason.
6. **Automated tests:** validation rules; scope check (supported vs unsupported cases); scenario code uniqueness per project; cross-tenant; E2E create project → add scenario.
7. **Manual verification:** owner creates a project and two scenarios and sees them on the dashboard.
8. **Acceptance criteria:** tests pass; unsupported forms are clearly marked, and the reason is shown.
9. **Security/scientific:** scope check prevents out-of-scope use.
10. **Rollback:** standard.
11. **Report:** STAGE-08.md.
12. **Gate:** standard.

### Stage 9 — Dataset versions and manual evidence entry
1. **Objective/scope:** dataset version lifecycle (draft → in review → approved → superseded); the evidence sections; value-origin taxonomy; S1 unit registry and normalisation (only conversions approved for the stage, listed in the report); review and approval with separation of duties; immutability and content hash.
2. **Files/modules:** `datasets` module; `science-core` S1; migrations; contracts; web evidence-entry pages with guidance.
3. **Exclusions:** no uploads, no readiness percentage, no calculations.
4. **Prerequisites/decisions:** OD-12(a), or the owner confirms synthetic data only.
5. **Tasks:** as in the objective; raw value is always preserved; summary-level PK fields only.
6. **Automated tests:** unit conversion KATs (from cited conversion factors); unknown unit is flagged, not guessed; raw value preserved; approved version immutable (trigger test via the runtime role); content hash stable for identical content; self-approval blocked by default; cross-tenant.
7. **Manual verification:** owner enters evidence for F001, submits it, approves it as a second user, then tries to edit it and is refused.
8. **Acceptance criteria:** tests pass; no participant-level field exists in the schema (schema listing quoted).
9. **Security/scientific:** provenance foundation (C5); integrity of approved data.
10. **Rollback:** standard.
11. **Report:** STAGE-09.md.
12. **Gate:** standard.

### Stage 10 — File storage, job runner and CSV/Excel ingestion
1. **Objective/scope:** storage interface with a local implementation; upload with checksum; PostgreSQL job runner; CSV and Excel extraction to raw plus candidate values; review UI (accept, edit, reject); participant-level data detection and blocking.
2. **Files/modules:** `files`, `jobs`, `ingestion` modules; migrations; web upload and review pages.
3. **Exclusions:** PDF and Word; OCR; external retrieval.
4. **Prerequisites/decisions:** OD-15, OD-16 (CSV/Excel), OD-22.
5. **Tasks:** as in the objective; size and type limits; timeouts; idempotent jobs.
6. **Automated tests:** original preserved byte-for-byte (checksum); extraction records the source location; edits are recorded with the original kept; rejected values never enter the dataset; malicious or oversized files are rejected; subject-level fixture is blocked; job retry and idempotency; concurrent workers do not double-process; cross-tenant file access denied.
7. **Manual verification:** owner uploads a provided sample CSV and Excel file and reviews the values.
8. **Acceptance criteria:** tests pass; extracted values show origin `extracted` and a source link.
9. **Security/scientific:** untrusted-file handling; provenance.
10. **Rollback:** standard; local file store folder can be deleted for test data.
11. **Report:** STAGE-10.md including the parser libraries' licences.
12. **Gate:** standard.

### Stage 11 — PDF/Word ingestion (post-MVP)
1. **Objective/scope:** text-layer PDF and DOCX extraction of tables and fields into the same review flow.
2. **Files/modules:** `ingestion` extractors; fixtures.
3. **Exclusions:** OCR of scanned documents; AI extraction.
4. **Prerequisites/decisions:** OD-16 (PDF/Word).
5. **Tasks:** extractors; page and table location provenance; "manual entry needed" for scanned PDFs.
6. **Automated tests:** fixture documents with known expected extractions; scanned-PDF detection; malformed file handling.
7. **Manual verification:** owner uploads a sample COA PDF.
8. **Acceptance criteria:** expected values extracted on the fixtures, with the precision and recall measured on the fixture set and reported as fixture results only.
9. **Security/scientific:** parser sandboxing limits.
10. **Rollback:** standard.
11. **Report:** STAGE-11.md.
12. **Gate:** standard.

## Phase D — Science

### Stage 12 — Method and ruleset registry; readiness and applicability
1. **Objective/scope:** `science-registry` (methods, method versions, rulesets, ruleset versions, approvals, references); method descriptor contract; KAT harness; first ruleset version entered by the reviewer; readiness and applicability engine (checklist; percentage only if OD-23 is approved); controlled vocabulary confirmed by the reviewer.
2. **Files/modules:** `science-registry`, `readiness` modules; `science-core` S4 skeleton; migrations; web readiness panel.
3. **Exclusions:** no scientific calculations yet.
4. **Prerequisites/decisions:** OD-09, OD-10, OD-23; reviewer available.
5. **Tasks:** as in the objective; approval workflow records reviewer identity and evidence.
6. **Automated tests:** unapproved method cannot be used by a run; ruleset values carry citations (schema-enforced); readiness gates give Grey when the minimum dataset is missing; missing data alone never yields Red; readiness percentage hidden when the scoring method is not approved.
7. **Manual verification:** reviewer enters and approves a ruleset version; owner sees the readiness checklist on F001.
8. **Acceptance criteria:** tests pass; the reviewer's approval recorded in the database (quoted).
9. **Security/scientific:** only platform reviewers can approve; the start of scientific governance.
10. **Rollback:** standard; ruleset versions are never deleted, only retired.
11. **Report:** STAGE-12.md, which separates software verification from scientific approval.
12. **Gate:** standard **plus** reviewer sign-off recorded.

### Stage 13 — First deterministic methods (S2)
1. **Objective/scope:** implement the deterministic methods the reviewer selected (e.g. dissolution comparison approaches), with descriptors, KATs and approval.
2. **Files/modules:** `science-core` S2; registry entries; tests.
3. **Exclusions:** statistical methods; runs (methods are callable in tests only).
4. **Prerequisites/decisions:** reviewer's method list with sources and KAT sets.
5. **Tasks:** transcribe the formulas exactly from cited sources; applicability rules; warnings.
6. **Automated tests:** KATs within declared tolerances; applicability (out-of-domain input gives `not_applicable`); unit handling; property tests where meaningful.
7. **Manual verification:** reviewer checks the formula transcription against the source.
8. **Acceptance criteria:** KATs pass; reviewer approval recorded per method version.
9. **Security/scientific:** dissolution similarity is never phrased as in-vivo BE (wording test).
10. **Rollback:** retire the method version.
11. **Report:** STAGE-13.md with KAT sources.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 14 — Statistical and study-design methods (S3)
1. **Objective/scope:** reviewer-selected methods: summary-statistic BE assessment for Cmax and AUC, CI handling, ISCV handling, power and sample size (evaluable and enrolment with dropout) for supported designs, fasting and fed context handling.
2. **Files/modules:** `science-core` S3; numerical routines (OD-18); registry entries.
3. **Exclusions:** simulation (Stage 19).
4. **Prerequisites/decisions:** OD-18; reviewer's KAT sets.
5. **Tasks:** as in the objective; design-specific inputs; explicit assumptions.
6. **Automated tests:** KATs against independent references; sample-size refuses when any required input is missing (never from ISCV alone); ISCV and inter-subject variability never interchangeable (type-level and runtime tests); numeric-routine KATs.
7. **Manual verification:** reviewer compares several cases with independent calculations.
8. **Acceptance criteria:** KATs pass; reviewer approval per method version.
9. **Security/scientific:** core statistical correctness; tolerances justified.
10. **Rollback:** retire the method version.
11. **Report:** STAGE-14.md.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 15 — Immutable prediction runs and decision graph
1. **Objective/scope:** `runs` module: create run → pin versions and seed → compute via approved methods → record outputs, status colour, warnings and decision graph → finalise immutably. Green technically disabled.
2. **Files/modules:** `runs` module; migrations; job integration; contracts.
3. **Exclusions:** report rendering (Stage 16), ML (Stage 25).
4. **Prerequisites/decisions:** at least one approved method (13 or 14).
5. **Tasks:** as in the objective; idempotent creation; failure recording.
6. **Automated tests:** run on a draft dataset refused; completed run immutable; re-execution gives identical outputs (reproducibility); graph completeness (every output traces to evidence); Green cannot be produced; cross-tenant.
7. **Manual verification:** owner runs F001 and sees raw results in a basic view.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** reproducibility contract (R-03).
10. **Rollback:** standard; runs are never deleted.
11. **Report:** STAGE-15.md.
12. **Gate:** standard.

### Stage 16 — Results, explanations and reports
1. **Objective/scope:** results page (status, outputs, uncertainty, assumptions, applicability warnings, missing evidence, limitation statement); S8 explanation content; downloadable report in sponsor and owner-level views.
2. **Files/modules:** `reporting` module, `science-core` S8, web results pages, report templates.
3. **Exclusions:** comparisons (Stage 17); AI text.
4. **Prerequisites/decisions:** OD-17, OD-27; limitation wording from OD-12.
5. **Tasks:** as in the objective; report provenance footer; audited downloads.
6. **Automated tests:** limitation statement present on every result view and report; sponsor report excludes internals (content test); report reproduces run values exactly; downloads audited; cross-tenant.
7. **Manual verification:** owner downloads and reads a report.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** export handling; honest presentation.
10. **Rollback:** standard.
11. **Report:** STAGE-16.md with a sample report attached (synthetic data).
12. **Gate:** standard.

### Stage 17 — Scenario comparison and digital twin views (C5)
1. **Objective/scope:** compare dataset versions and runs: changed inputs (with origin), changed versions, changed outputs; like-for-like warnings; digital-twin overview of a scenario's evidence history with a "not a PBPK model" banner.
2. **Files/modules:** `runs` and `datasets` comparison services; web comparison pages.
3. **Exclusions:** sensitivity analysis.
4. **Prerequisites/decisions:** none new.
5. **Tasks:** as in the objective.
6. **Automated tests:** diff correctness on fixtures; mismatched ruleset versions flagged; banner present.
7. **Manual verification:** owner compares F001 and F002.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** no cross-tenant comparison possible.
10. **Rollback:** standard.
11. **Report:** STAGE-17.md.
12. **Gate:** standard. **End of the core MVP workflow.**

## Phase E — Differentiators

### Stage 18 — BE Risk Fingerprint (C1, rule-based)
1. **Objective/scope:** risk drivers from approved ruleset rules and evidence quality: factor, direction, evidence quality, uncertainty, contribution type; shown in results and reports.
2. **Files/modules:** `science-core` S7 (risk), S8; registry rule entries; web fingerprint panel.
3. **Exclusions:** ML attribution.
4. **Prerequisites/decisions:** reviewer-approved risk rules with references.
5. **Tasks:** as in the objective; causal-language guard.
6. **Automated tests:** fixture cases give the expected drivers; missing data alone never gives Red; no causal wording without a causal tag; reproducibility.
7. **Manual verification:** reviewer checks the fingerprints on example cases.
8. **Acceptance criteria:** tests pass; reviewer approval of the rule set.
9. **Security/scientific:** avoids overclaiming.
10. **Rollback:** retire the rule version.
11. **Report:** STAGE-18.md.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 19 — Virtual pivotal BE simulation (C3)
1. **Objective/scope:** seeded simulation of study outcomes per endpoint from approved S3 methods and stated assumptions; outcome distributions and simulated pass proportion labelled "under stated assumptions".
2. **Files/modules:** `science-core` S6; `runs` integration; web simulation page.
3. **Exclusions:** model-informed simulation (needs Stage 25).
4. **Prerequisites/decisions:** OD-18 PRNG; reviewer-approved simulation method.
5. **Tasks:** as in the objective; run-size limits; background execution.
6. **Automated tests:** same seed gives identical results; agreement with analytical power within Monte-Carlo error where both apply (KAT); labelling test; resource limits.
7. **Manual verification:** reviewer checks example simulations.
8. **Acceptance criteria:** tests pass; reviewer approval. **End of the recommended MVP.**
9. **Security/scientific:** must not be presented as a BE success probability.
10. **Rollback:** retire the method version.
11. **Report:** STAGE-19.md.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 20 — Sensitivity and failure-condition engine (C4)
1. **Objective/scope:** perturbation plans over inputs and assumptions; sensitivity results; tipping points; "what could make this fail" list.
2. **Files/modules:** `science-core` S6/S7; web sensitivity page.
3. **Exclusions:** optimisation.
4. **Prerequisites/decisions:** reviewer-approved perturbation ranges and method.
5. **Tasks:** as in the objective.
6. **Automated tests:** monotonicity and boundary fixtures; reproducibility; ranges shown in the output.
7. **Manual verification:** reviewer review.
8. **Acceptance criteria:** tests pass; reviewer approval.
9. **Security/scientific:** conditional on the stated ranges.
10. **Rollback:** retire the method version.
11. **Report:** STAGE-20.md.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 21 — Next best experiment (C7)
1. **Objective/scope:** ranked recommended experiments or measurements from readiness gaps, C1 drivers and C4 sensitivities, each with rationale, the uncertainty targeted and limitations.
2. **Files/modules:** `science-core` S7/S8; web panel.
3. **Exclusions:** automated experiment design optimisation beyond the approved logic.
4. **Prerequisites/decisions:** reviewer-approved ranking logic.
5. **Tasks:** as in the objective.
6. **Automated tests:** ranking fixtures; every recommendation has a rationale and limitation; no recommendation without a linked gap or driver.
7. **Manual verification:** reviewer review.
8. **Acceptance criteria:** tests pass; reviewer approval.
9. **Security/scientific:** advisory wording.
10. **Rollback:** retire the version.
11. **Report:** STAGE-21.md.
12. **Gate:** standard **plus** reviewer sign-off.

### Stage 22 — Formulation optimisation / reverse engineering (C2)
1. **Objective/scope:** given objectives and constraints, explore candidate formulation *directions or ranges* supported by evidence; suppress or limit output where evidence is insufficient.
2. **Files/modules:** `science-core` S7; web optimisation page.
3. **Exclusions:** exact recipes without validated relationships.
4. **Prerequisites/decisions:** reviewer-approved relationships and constraints; an honest assessment of whether evidence supports any output.
5. **Tasks:** as in the objective.
6. **Automated tests:** constraint satisfaction; suppression when the evidence basis is insufficient; reproducibility.
7. **Manual verification:** reviewer review.
8. **Acceptance criteria:** tests pass; reviewer approval. The stage may legitimately end as "interface only, outputs disabled" if no validated relationships exist. That outcome is reported explicitly, not as a failure to hide.
9. **Security/scientific:** high overclaiming risk; strongest wording controls.
10. **Rollback:** retire the version.
11. **Report:** STAGE-22.md.
12. **Gate:** standard **plus** reviewer sign-off.

## Phase F — Evidence and learning

### Stage 23 — Fetch Missing Information
1. **Objective/scope:** retrieval from approved sources for missing fields; candidates with source, retrieval date and uncertainty; review, edit, approve or reject; never silent.
2. **Files/modules:** `retrieval` module; source adapters; web review page.
3. **Exclusions:** AI-based retrieval; sending confidential data.
4. **Prerequisites/decisions:** OD-21.
5. **Tasks:** as in the objective; outbound request audit; allow-listed hosts only.
6. **Automated tests:** adapters against recorded fixtures (no live calls in tests); outbound payload contains only allowed public identifiers; nothing enters the dataset without approval; provenance recorded.
7. **Manual verification:** owner fetches a missing physicochemical property for a fictional project using a public molecule.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** data-egress control.
10. **Rollback:** disable the source adapters by configuration.
11. **Report:** STAGE-23.md.
12. **Gate:** standard.

### Stage 24 — Historical data, consent and eligibility (C6 foundation)
1. **Objective/scope:** versioned consent policies and tenant consent records; authorised historical-study ingestion (summary level); quality checks; duplicate and related-study grouping; eligibility review; `training` schema populated only with eligible, consented cases.
2. **Files/modules:** `consent`, `historical-data` modules; migrations; admin pages.
3. **Exclusions:** model training.
4. **Prerequisites/decisions:** OD-12(b).
5. **Tasks:** as in the objective; withdrawal handling; lineage per case.
6. **Automated tests:** no consent means no training rows (module and grant level); withdrawal recorded and enforced for future datasets; related-study grouping fixtures; audit of each eligibility decision.
7. **Manual verification:** tenant admin grants consent for a test tenant; the owner sees the eligible-case counts.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** consent integrity (R-04); leakage-prevention groundwork.
10. **Rollback:** standard; consent history is never deleted.
11. **Report:** STAGE-24.md.
12. **Gate:** standard.

### Stage 25 — ML pipeline and model registry
1. **Objective/scope:** reproducible training on locked, group-split datasets; evaluation against predefined criteria; model versions; human approval and promotion; rollback; S5 inference with applicability-domain checks; C1 ML attribution if approved.
2. **Files/modules:** `model-registry`, `science-core` S5; migrations; platform admin pages.
3. **Exclusions:** displaying any probability to sponsors unless a model is approved.
4. **Prerequisites/decisions:** OD-11, OD-19; sufficient eligible data judged by the reviewer.
5. **Tasks:** as in the objective.
6. **Automated tests:** group leakage test; training reproducibility (same inputs give the same model); promotion requires approvals; rollback; unapproved model never used in sponsor runs.
7. **Manual verification:** reviewer examines the evaluation report.
8. **Acceptance criteria:** software tests pass. **Model validation is a separate outcome:** the stage can PASS as software while no model is approved.
9. **Security/scientific:** training data never crosses tenant boundaries outside consent.
10. **Rollback:** promote the previous approved version.
11. **Report:** STAGE-25.md, with the software-verification and model-validation categories reported separately.
12. **Gate:** standard; model promotion is a separate owner and reviewer decision.

### Stage 26 — Pilot-to-pivotal learning, monitoring, calibration and drift (C6)
1. **Objective/scope:** link pilot and pivotal outcomes (consented); compare predictions with actual outcomes; calibration and drift tracking; review triggers; failure-learning reports.
2. **Files/modules:** `model-registry` monitoring, `historical-data`; dashboards for platform roles.
3. **Exclusions:** automatic retraining or promotion.
4. **Prerequisites/decisions:** Stage 25 complete; monitoring thresholds approved by the reviewer.
5. **Tasks:** as in the objective.
6. **Automated tests:** monitoring computations on fixtures; triggers fire correctly; no automatic promotion.
7. **Manual verification:** reviewer review.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** honest performance reporting.
10. **Rollback:** disable monitoring jobs by configuration.
11. **Report:** STAGE-26.md.
12. **Gate:** standard.

## Phase G — AI and operations

### Stage 27 — Optional AI assistance (S9)
1. **Objective/scope:** `ai-assist` behind an interface, disabled by default; per-tenant opt-in; suggestion-only flows (e.g. extraction suggestions, guidance text) that pass through normal human review.
2. **Files/modules:** `ai-assist` module; configuration; web suggestion UI.
3. **Exclusions:** AI writing data, results or reports; any AI use without OD-20 approval.
4. **Prerequisites/decisions:** OD-20.
5. **Tasks:** as in the objective; payload minimisation; audit.
6. **Automated tests:** the module cannot call write services (boundary and permission tests); disabled tenant sends nothing (network-egress test with a fake provider); suggestions are labelled; accepting a suggestion triggers normal review.
7. **Manual verification:** owner enables it for a test tenant only.
8. **Acceptance criteria:** tests pass.
9. **Security/scientific:** data-egress and integrity.
10. **Rollback:** feature flag off.
11. **Report:** STAGE-27.md.
12. **Gate:** standard.

### Stage 28 — Security hardening, audit search, retention and deletion, restore drill
> **Baseline dependencies for the Stage 28 plan:** F-7 (filterable audit and security-event views with access control; tamper evidence; D-6), F-9 and D-8 (release-gate security suites). See [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md).

1. **Objective/scope:** audit search UI with access control; retention classes and deletion procedure; audit tamper-evidence evaluation; dependency and configuration review; threat-model review; restore drill; key management design (OD-28); preparation for an independent security review.
2. **Files/modules:** `audit`, retention jobs, documentation runbooks.
3. **Exclusions:** hosting.
4. **Prerequisites/decisions:** OD-12, OD-28.
5. **Tasks:** as in the objective.
6. **Automated tests:** audit search access control; deletion removes the targeted data and files and keeps records under audit hold; full security suite; restore drill evidence.
7. **Manual verification:** owner runs the restore drill with guidance.
8. **Acceptance criteria:** tests pass; the external review is scheduled, or its findings are tracked.
9. **Security/scientific:** consolidates security posture; it does not claim compliance.
10. **Rollback:** standard.
11. **Report:** STAGE-28.md.
12. **Gate:** standard.

### Stage 29 — SaaS deployment readiness
1. **Objective/scope:** staging and production environments on the chosen host; managed PostgreSQL 18; object storage; KMS; TLS; secrets; monitoring; backups and point-in-time recovery; migration deployment runbook rehearsed on staging.
2. **Files/modules:** deployment configuration, runbooks, environment documentation.
3. **Exclusions:** go-live itself, which is a separate owner decision.
4. **Prerequisites/decisions:** OD-14, OD-12(c), OD-28.
5. **Tasks:** as in the objective; production readiness checklist ([architecture/DEPLOYMENT_AND_MIGRATION.md §7](architecture/DEPLOYMENT_AND_MIGRATION.md#7-production-readiness-checklist-stage-29-gate)).
6. **Automated tests:** full suite against staging; cross-tenant suite on staging; restore on staging; migration rehearsal.
7. **Manual verification:** owner walkthrough on staging.
8. **Acceptance criteria:** checklist complete with evidence.
9. **Security/scientific:** first exposure to the internet; highest operational risk.
10. **Rollback:** previous release redeploy; database forward-fix or PITR runbook.
11. **Report:** STAGE-29.md.
12. **Gate:** standard; **production operational readiness** is claimed only here and only with evidence.
