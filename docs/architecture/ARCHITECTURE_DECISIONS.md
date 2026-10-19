# Architecture Decisions (ADRs)

Status: Draft for product-owner review, MA-00, 2026-10-16.

This file lists **confirmed** decisions only. A decision is confirmed when the product owner fixed it in the MA-00 brief (ADR-001 to ADR-012) or explicitly approved it later (ADR-013 onward). Recommendations awaiting approval belong in [OPEN_DECISIONS_REGISTER.md](OPEN_DECISIONS_REGISTER.md). When an open decision is approved, it moves here as a new ADR. The ADR must quote the approval (date and the owner's words).

A confirmed decision can be changed only by a new ADR that the owner explicitly approves. Agents must not reinterpret or work around these decisions.

---

### ADR-001 — Frontend: Next.js, React, TypeScript
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** The user interface is a Next.js application written in TypeScript with React.
- **Consequences:** The web app never connects to PostgreSQL directly. All data flows through the versioned API (ADR-002). Server-side rendering features may be used for UI only. They must not bypass API authorisation.

### ADR-002 — Backend: NestJS, TypeScript, versioned REST
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** The server is a NestJS application in TypeScript that exposes versioned REST APIs (`/api/v1/...`).
- **Consequences:** Standards are in [API_CONTRACT_STANDARDS.md](API_CONTRACT_STANDARDS.md). There is no GraphQL and no RPC framework.

### ADR-003 — PostgreSQL is the only database
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** PostgreSQL is the single authoritative persistent store. SQLite, in-memory database substitutes and second databases are not allowed. Tests that involve database behaviour use real PostgreSQL.
- **Consequences:** Background jobs, sessions and audit logs are stored in PostgreSQL (OD-22, OD-08). Uploaded original files are stored as files, with metadata and checksums in PostgreSQL (OD-15). These files are binary objects, not a second database.

### ADR-004 — Hand-written, numbered SQL is the schema source of truth
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** The database structure is defined only by hand-written, numbered SQL files in `db/migrations/`. Applied files are checksummed. Any change to an applied file is detected and rejected. Schema changes are reviewed and tested. Expand → migrate → contract is used where applicable. Production changes are forward-only when reversal could lose data.
- **Consequences:** The migration runner is chosen under OD-06, the data-access layer under OD-07. Details are in [DATA_AND_DATABASE_DESIGN.md §7](DATA_AND_DATABASE_DESIGN.md#7-schema-management-and-migrations).

### ADR-005 — No Python anywhere in PBE
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** PBE has no Python runtime, service or Python-based scientific engine. All scientific computation is TypeScript.
- **Consequences:** Statistical and numerical routines must be implemented or sourced in TypeScript/JavaScript and verified with known-answer tests (OD-18, OD-19). Stage 1 adds an automated check that rejects Python-based project dependencies and scripts. Note: macOS ships a system Python 3.9. That is not part of PBE and must not be used by PBE tooling.

### ADR-006 — No Prisma Migrate and no ORM schema synchronisation
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** These are not allowed: Prisma Migrate, TypeORM `synchronize`, Drizzle Kit `push`, or any tool that creates or changes the schema from code models.
- **Consequences:** Any data-access library chosen under OD-07 must be used only to query an already-migrated schema. Stage 1 adds a dependency guard. Stage 2 adds a schema-drift check that compares the live schema with a fresh migration run.

### ADR-007 — Modular monolith; no microservices initially
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** One deployable API process and one web process. Modules are logical boundaries inside them. Modules are not separate network services.
- **Consequences:** Module boundaries are enforced by code structure and automated lint rules ([MODULE_BOUNDARIES.md §7](MODULE_BOUNDARIES.md#7-boundary-enforcement)).

### ADR-008 — No extra infrastructure without documented need and approval
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** No Redis, Kubernetes, message queues or other infrastructure unless a documented requirement exists and the owner approves it.
- **Consequences:** Background work uses a PostgreSQL-backed job table inside the API process (OD-22).

### ADR-009 — No external AI provider selected yet
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** No external AI provider is chosen. External AI must not receive sponsor-confidential data without an approved data-processing design and authorisation.
- **Consequences:** The AI-assistance module (S9) is designed behind an interface and stays disabled until OD-20 is resolved (Stage 27).

### ADR-010 — Local-first development, designed for multi-tenant SaaS
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** Development starts locally in VS Code. The design must support secure multi-customer SaaS later without a rewrite. Configuration, secrets, code and environment settings stay separate.
- **Consequences:** Tenant isolation, RLS and audit exist from the first tenant-owned table (Stage 3 onward). See [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md).

### ADR-011 — Initial scientific scope: immediate-release oral solid dosage forms
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** The only supported scope is IR oral solid dosage forms. All other routes and forms are marked unsupported unless separately implemented and scientifically validated. The scientific core is regulatory-neutral. Jurisdiction rules live in versioned rulesets.
- **Consequences:** See [../PRODUCT_SCOPE_AND_MVP.md](../PRODUCT_SCOPE_AND_MVP.md).

### ADR-012 — No participant-level clinical subject data
- **Status:** Confirmed (owner, MA-00 brief).
- **Decision:** PBE does not collect or store participant-level clinical subject data. PK/BE evidence is accepted only as summary statistics.
- **Consequences:** The schema has no subject-level tables. Ingestion warns about and blocks files that appear to contain subject-level data ([SECURITY_PRIVACY_AND_TENANCY.md §8](SECURITY_PRIVACY_AND_TENANCY.md#8-no-participant-level-data)).

---

## Decisions approved from the open-decisions register

### ADR-013 — Monorepo with npm workspaces (from OD-01)
- **Status:** Approved by owner, 2026-10-16 (Stage 1 prompt: "OD-01: npm workspaces.").
- **Decision:** One repository using npm workspaces: `apps/web`, `apps/api`, `packages/contracts`, `packages/science-core`, plus `db/` and `tooling/` folders. No Nx or Turborepo.
- **Consequences:** Module boundaries are enforced by lint rules ([MODULE_BOUNDARIES.md §7](MODULE_BOUNDARIES.md#7-boundary-enforcement)).

### ADR-014 — Retain the existing GitHub repository (from OD-03)
- **Status:** Approved by owner, 2026-10-16 (Stage 1 prompt: "OD-03: retain the existing GitHub repository. Do not push or change remote settings until repository privacy is confirmed.").
- **Decision:** Keep `origin` = `https://github.com/harrypgpt/PBE-New.git` and its history.
- **Condition:** Repository privacy is **not yet confirmed**. Until the owner confirms it, agents do not push or change remote settings. The owner makes all commits.

### ADR-015 — Jest for unit testing, Playwright for browser-level testing (from OD-04)
- **Status:** Approved by owner, 2026-10-16 (Stage 1 prompt: "OD-04: Jest for unit testing and Playwright for required browser-level testing.").
- **Decision:** Jest (with `ts-jest`) in every workspace. Playwright for browser-level and end-to-end tests when those tests are first required (Stage 5 smoke test). React Testing Library for components is part of the Stage 5 set-up.
- **Consequences:** Stage 1 installs Jest only. Playwright is not installed until a stage needs browser tests, which avoids downloading browsers before there is a page to test.

### ADR-016 — Node.js 24, exact pinned version 24.21.0 (from OD-25)
- **Status:** Approved by owner, 2026-10-16 (Stage 1 prompt: "OD-25: pin Node.js 24 and document the exact supported version.").
- **Decision:** The exact supported and tested version is **Node.js 24.21.0** (`.nvmrc`). `package.json` `engines` allows `>=24.21.0 <25` with `engine-strict`. npm `>=11` (11.19.0 tested).
- **Consequences:** The toolchain check in `npm run verify` fails on any other major version or an older 24.x.

### ADR-017 — PostgreSQL major version 18 (from OD-05)
- **Status:** Approved by owner, 2026-10-16 (Stage 2 prompt: "The product owner has approved: OD-05: PostgreSQL major version 18.").
- **Decision:** PostgreSQL 18 is the supported major version in every environment. Local install observed in MA-00: PostgreSQL 18.6 (EDB installer, `/Library/PostgreSQL/18`), CLI tools not on PATH.
- **Consequences:** The managed host chosen under OD-14 must offer PostgreSQL 18. PBE scripts locate the PostgreSQL `bin` folder through configuration rather than by changing the owner's shell set-up.
- **Re-confirmed:** by the owner on 2026-10-17 ("OD-05: PostgreSQL 18 — Approved."). No change to the decision.

### ADR-018 — In-house TypeScript SQL migration runner (from OD-06, option A)
- **Status:** Approved by owner, 2026-10-17 (Stage 2 authorisation: "OD-06, Option A: Build a small in-house TypeScript SQL migration runner — Approved.").
- **Decision:** PBE applies its hand-written, numbered SQL files (ADR-004) with a small runner written in TypeScript in `tooling/`. It talks to PostgreSQL through the `pg` (node-postgres) driver only. It meets every requirement in [DATA_AND_DATABASE_DESIGN.md §7.3](DATA_AND_DATABASE_DESIGN.md#73-runner-requirements-whichever-tool-is-chosen-under-od-06): ordering, SHA-256 integrity, advisory lock, per-file transactions with an explicit no-transaction directive, safe failure, `status` command and drift check.
- **Rationale:** The requirement set is small and must be proven by PBE's own tests whichever tool is used. An in-house runner adds no Java or other runtime (unlike Flyway), has no naming or workflow conventions to adapt to (unlike the third-party Node runners, whose behaviour was never verified), and keeps every rule in code the project can read and test.
- **Rejected alternatives (from OD-06):** (B) Postgrator / node-pg-migrate, which remain the fallback if the in-house runner cannot pass the Stage 2 tests; (C) Flyway, which needs Java; (D) graphile-migrate, whose workflow is unusual; (E) dbmate, a separate binary with unverified integrity checks.
- **Consequences:** PBE maintains the runner. Its behaviour is defined by its Stage 2 tests against real PostgreSQL 18. The runner always connects as `pbe_migrator`, never as a superuser.

### ADR-019 — One project database, `pbe_dev`, for every stage
- **Status:** Decided by owner, 2026-10-17 (Stage 2: "i need pbe_dev main only one tabel use so proper migration run for all stage code", after choosing "one database only" over the recommended three-database layout).
- **Decision:** PBE uses a single local database, `pbe_dev`, in every stage. All migrations of all stages are applied to it and recorded in one ledger table, `pbe_meta.schema_migration`. The separate `pbe_test` and `pbe_restore_check` databases are not used.
- **How the rest of the design adapts:**
  - Database tests run in `pbe_dev` but **only read** PBE's own schemas. Everything they create lives in temporary schemas named `zz_test_<random>` (pattern-checked in code) that are dropped afterwards. `npm run db -- clean-test-schemas` removes leftovers from interrupted runs.
  - The drift check compares `pbe_dev` with a committed fingerprint, `db/schema-snapshot.txt`, refreshed by `npm run db -- migrate` (or `snapshot` after a manual migration).
  - Backups are verified by decoding the whole archive with `pg_restore` and comparing schemas, every table's row count and every ledger row with the live database.
- **Accepted gaps (owner decision; revisit no later than Stage 28):**
  1. Tests share the project database. A faulty test could damage project data. Mitigation: tests only write in `zz_test_*` schemas, enforced by a name check, and only synthetic data is allowed until OD-12(a).
  2. "The migrations build a correct database from empty" is proven once, by the first real apply to `pbe_dev`, not re-proven on every test run.
  3. A backup is proven complete and readable, but **restoring it into a database is not tested**. A real restore drill needs a second database (Stage 28 / SaaS backups under OD-14).
  4. Drift is measured against the committed snapshot, not a fresh rebuild. A manual change made *before* a snapshot is refreshed would be captured into it.
- **Supersedes:** the database list in DATA_AND_DATABASE_DESIGN.md §8, DEPLOYMENT_AND_MIGRATION.md §2, TESTING_AND_ACCEPTANCE_GATES.md §2 (database rule) and the `pbe_test` / restore wording of roadmap Stage 2.
- **Superseded by ADR-020** on 2026-10-17. Kept here as history.

### ADR-020 — Separate development, test and temporary restore databases
- **Status:** Decided by owner, 2026-10-17 (Stage 2.1: "The required development and testing databases are: `pbe_dev` … `pbe_test` … A temporary isolated database for backup restoration verification." and "Do not run destructive tests against `pbe_dev`."). **Supersedes ADR-019.**
- **Decision:**
  - `pbe_dev` is the development database. Automated tests never write to it; they read it only inside `READ ONLY` transactions.
  - `pbe_test` is the automated-test database. The tests rebuild it from empty.
  - Backup restores are verified in a **temporary** database named `pbe_restore_check_<10 hex>`, created and dropped by the restore drill itself, as the dedicated role below. PBE tooling can drop only databases matching that exact pattern and owned by that role.
- **Privileges (revised 2026-10-17 after the owner's security review request):** a first draft gave `CREATEDB` to `pbe_owner`. It was withdrawn **before being applied**, because `pbe_migrator` (a member of `pbe_owner` with SET) could then have created any number of databases. Instead:
  - `pbe_owner`, `pbe_migrator` and `pbe_app` have **no** `CREATEDB`.
  - A separate test-only login, `pbe_restore_drill`, is the **only** role with `CREATEDB`. It is not a member of any PBE role, may connect only to `pbe_test` (no schema or table access there), cannot connect to `pbe_dev`, and has a 5-connection limit.
  - PostgreSQL lets a role drop only databases it owns, so this role cannot drop `pbe_dev` or `pbe_test`. That is enforced by the server, and tested.
  - Restores use `pg_restore --no-owner`. The restored copy is owned by `pbe_restore_drill`, and comparisons map that one role name back to `pbe_owner`.
  - No role is a superuser or has `BYPASSRLS`. Applied by the owner-run bootstrap, which keeps the existing passwords.
- **Known residual risk (unchanged, pre-existing; tracked as R-001 in [RISK_REGISTER.md](RISK_REGISTER.md), production-blocking):** `pbe_migrator` can `SET ROLE pbe_owner`, and `pbe_owner` owns `pbe_dev`, so the migrator login could technically drop `pbe_dev`. No PBE command does so, and migrations cannot contain `DROP DATABASE`, but only code enforces this, not the server. Recommended hardening for owner decision by Stage 28: give the databases a separate owner role that `pbe_migrator` is not a member of.
- **Superuser and teardown tests** run only on a private throw-away PostgreSQL 18 instance that the tests create (`initdb`, socket only) and delete. They never touch the real local server.
- **Teardown** (`db/bootstrap/teardown-local.sql`) never drops `pbe_dev`. It removes `pbe_test` and temporary restore databases, and removes the PBE roles only after `pbe_dev` has been removed deliberately by hand.
- **Consequences:** ADR-019 gaps 1–3 are closed. Gap 4 is reduced: drift is checked against both the committed snapshot and a fresh rebuild in `pbe_test`.

### ADR-021 — Kysely data-access layer with generated database types (from OD-07, option B)
- **Status:** Approved by owner, 2026-10-17 ("OD-07: Approve Kysely with a dedicated data-access layer and generated TypeScript database types.").
- **Decision:**
  - Application code reaches PostgreSQL only through a dedicated data-access layer in `apps/api/src/modules/db/`. It uses the `pg` driver and the **Kysely** type-safe query builder. Raw SQL through Kysely's `sql` template is allowed for complex queries.
  - Every tenant-scoped query runs inside one transaction helper that sets the tenant context (`set_config(…, true)`, i.e. transaction-local).
  - TypeScript types for the database are **generated** from a freshly migrated `pbe_test` and committed. `verify` fails if they are out of date.
- **Not changed:** the schema is still defined only by hand-written, numbered SQL migrations (ADR-004). Kysely never creates or changes the schema. No ORM, Prisma or Drizzle (ADR-006). TypeScript only (ADR-005). PostgreSQL only (ADR-003). Modular monolith (ADR-007).
- **Type-generation tool (evaluated 2026-10-17 in a scratch copy of the project, not in the repository):**
  - `kysely` 0.29.6 is MIT, has **no dependencies**, no install scripts and no audit findings. **Used.**
  - `kysely-codegen` 0.20.0 is MIT. It installed no banned optional driver and the dependency guard passed, **but** it added **3 high-severity audit findings** (GHSA-vfj7-8cjw-p6xm in `braces`, through `micromatch`). There is no fixed version; npm's only offer is a major downgrade. Using it would fail the `verify` audit gate, which is not weakened for convenience. **Not used.**
  - **Instead:** a small in-house generator in `tooling/migrate/` (`npm run db -- typegen`). It reuses the runner's catalogue access and has explicit, tested type mappings. Exact decimals (`numeric`) and 64-bit integers map to `string`, never to a lossy `number`.
- **Consequences:**
  - One small runtime dependency (`kysely`) in `apps/api`.
  - The generator is PBE's to maintain.
  - A lint rule restricts `kysely` and `pg` imports in `apps/api` to the `db` module, so no code can bypass the tenant-context helper by importing the driver directly.

### ADR-022 — Shared Zod contracts with in-house validation and API documentation (from OD-02, option A)
- **Status:** Approved by owner, 2026-10-17 ("OD-02 — Shared API contracts: Use Zod-based request and response definitions in `packages/contracts`. Implement validation and API documentation generation in-house. Do not add `@nestjs/swagger`, `nestjs-zod`, or other packages that violate the approved dependency guard. Validate every request and response against the shared contracts.").
- **Decision:**
  - Every API route has a contract in `packages/contracts`: Zod schemas for path, query and body, every response status, and its access declaration.
  - The API validates **every request and every response** against it, using in-house NestJS code.
  - OpenAPI 3.1 is generated in-house from the same contracts (Zod's native JSON Schema) and committed. `verify` checks it is in sync.
  - No `@nestjs/swagger`, no `nestjs-zod`, and no package that fails the dependency guard.
- **Consequences:** one source of truth for web, API and documentation. Unknown fields are rejected (mass-assignment protection).

### ADR-023 — NestJS 11.2.7 with the Express adapter (from OD-29, option A)
- **Status:** Approved by owner, 2026-10-17 ("OD-29 — Framework selection: Approve Option A: NestJS 11.2.7 with Express. Record R-008 for the major-version lag. Reassess framework support, security advisories, compatibility, and upgrade options at every subsequent stage. Do not weaken dependency or security gates.").
- **Decision:**
  - The API uses NestJS **11.2.7** with `@nestjs/platform-express`.
  - NestJS 12 (ES-module-only) is not used for now, because it cannot run under the approved Jest set-up (ADR-015).
  - NestJS 11 with Fastify is rejected: it pins fastify 5.11.3, which has high-severity advisories.
- **Consequences:**
  - Risk **R-008** (one major version behind) is tracked.
  - **Every stage report must reassess** NestJS support status, security advisories, compatibility, and upgrade options to NestJS 12+.
  - Dependency and security gates are never weakened to keep this version.

### ADR-024 — Native HTML components with central design tokens; no UI library (from OD-24)
- **Status:** Approved by owner, 2026-10-17 ("Standard web elements and reusable accessible components; no Mantine or full design library. Individual Radix components may be considered later when justified and approved.").
- **Decision:**
  - The UI is built from native HTML elements and in-house, accessible React components, styled with CSS Modules (built into Next.js).
  - No complete component library (MUI, Mantine or similar).
  - Individual Radix primitives may be proposed later, one at a time, each needing justification, the dependency gates and owner approval.
  - Colours, typography, spacing and other visual values live only in central design tokens (`apps/web/src/ui/tokens.css`). They are **clearly marked neutral placeholders** until the TechyPharma-inspired design system is supplied (baseline D-1). Replacing them must not require rebuilding components.
- **Consequences:**
  - Smallest supply chain; fits the strict content security policy.
  - More in-house component work, all covered by component and accessibility tests.

### ADR-025 — Next.js 16.4.2; same-origin forwarding of /api/v1 to the API (from OD-30)
- **Status:** Approved by owner, 2026-10-17 ("Next.js 16.4.2, conditional on verification of package availability, Node.js compatibility, security status and dependency checks. If a prerequisite fails, stop and report rather than silently substituting another version.").
- **Decision:**
  - The web app uses Next.js 16.4.2 (App Router).
  - The browser talks only to the web origin, which forwards `/api/v1/*` to the API. CORS stays closed on the API.
  - Next.js middleware is never a security boundary: access decisions stay in the API guard and PostgreSQL RLS.
- **Consequences:**
  - Next.js support and advisories are reassessed at every stage, like R-008.
  - The version changes only through the dependency gates and an owner decision.

### ADR-026 — PBE-native authentication, server-side sessions and TOTP MFA (from OD-08, option A)
- **Status:** Approved by owner, 2026-10-17 (Stage 6 authorisation, all nine decisions in STAGE-06-PLAN.md §11, with refinements).
- **Decision:**
  - Sign-in is implemented in the NestJS API with PostgreSQL and Kysely.
  - Passwords are hashed with Argon2id via `@node-rs/argon2`.
  - TOTP uses `otpauth`; enrolment QR codes use `qrcode`.
  - A versioned, internally stored compromised-password blocklist is used. Candidate passwords are **never** sent to an external service.
- **Policy (owner-refined):**
  - Unique, permanent user ids; email unique ignoring case.
  - **Passwords 15–128 characters.**
  - Common and compromised passwords refused.
  - Gradual rate limiting after five failed attempts, plus a per-address limit.
  - Identical public errors for unknown email and wrong password.
  - Sessions: 30-minute idle and 12-hour absolute limits, rotated on authentication, ended on sign-out; password change ends other sessions, reset ends all.
  - TOTP with 10 single-use backup codes. Enrolment is confirmed only by a valid code. Replay and backup-code reuse are refused.
  - MFA secrets and recovery codes never appear in logs, URLs, API errors or reports.
- **Consequences:**
  - Highest-risk module; external review in Stage 28.
  - The development MFA key is stored in `.env` (R-010, production-blocking).
  - Authentication alone grants **no** customer data.

### ADR-027 — Narrow, reviewed access to identity data (from OD-31, option A)
- **Status:** Approved by owner, 2026-10-17.
- **Decision:**
  - `pbe_app` has **no table privileges** on credential, session, MFA or throttle tables.
  - It reaches them only through a small set of reviewed `SECURITY DEFINER` functions owned by `pbe_owner`, each with a fixed `search_path` and each taking a single key (one email, one session-token hash, one user id).
  - There is no function or grant that returns many credentials at once.
  - `audit.security_event` is INSERT-only for `pbe_app`, and a trigger refuses UPDATE, DELETE and TRUNCATE.
- **Consequences:**
  - Effective permissions are tested against real PostgreSQL (S6-17).
  - Function bodies are dollar-quoted, so the lexical migration checks do not inspect them (R-003). They are reviewed in the stage report.

### ADR-022 amendment — "any signed-in user" access kind (2026-10-17)
- **Status:** Approved by owner, 2026-10-17 (STAGE-06-PLAN.md §11.7).
- **Decision:** route contracts may declare `{ kind: 'authenticated' }`: any user with a fully signed-in session (MFA completed where required).
  - It grants **no** role, tenant or resource permission.
  - `permission` routes stay refused until Stage 7.
  - Default deny is unchanged: every route still declares its access.

### ADR-028 — Break-glass access for the Super Admin (from OD-26, option A, owner settings)
- **Status:** Approved by owner, 2026-10-17 (Stage 7 decisions, §11.1).
- **Decision:**
  - The Super Admin has **no default access** to customer data.
  - Access needs a written reason (purpose) and explicit approval by an authorised Tenant Admin of that organisation.
  - It is **read-only**, restricted to the approved organisation and purpose, with complete audit logging.
  - **Maximum one hour; no automatic renewal** (further access needs a fresh request and approval). It can be revoked at any time.
- **Consequences:**
  - Enforced in the API guard and the database (grant table with a one-hour check constraint).
  - Every request, approval, entry, use, expiry and revocation is recorded in the business audit trail and the security log.

### ADR-029 — Stage 7 authorisation model (Stage 7 decisions §11.2–§11.8)
- **Status:** Approved by owner, 2026-10-17.
- **Decision:**
  - **Permissions** are a fixed catalogue of stable identifiers in code (`packages/contracts`), mirrored in `platform.permission`. The server checks only these identifiers; **role names are not security controls**.
  - **Roles**, role-to-permission assignments and **departments** are configurable per organisation. Editable starting templates: Tenant Administrator, Project Lead, Scientist, QA/QC Reviewer, Scientific Reviewer, Viewer, with least-privilege defaults.
  - The last person able to manage roles and permissions cannot be removed or deactivated.
  - **Platform roles:** Super Admin = `platform_owner`, with no default customer-data access. Scientific Reviewer and Support boundaries are documented for later stages; no such roles or accounts are created in Stage 7.
  - **Onboarding exception:** the Super Admin may nominate and bootstrap the **first** Tenant Admin of a new organisation. After that, only that organisation's authorised administrators manage its users.
  - **Activation and password reset:** cryptographically secure, single-use tokens, at most **four hours** valid. Only a hash is stored. Tokens are delivered through a separate channel and are never shown to administrators. The user chooses their own password. Every step is audited.
  - **First Super Admin:** a controlled operator command on the local Mac for a fictional account; no hard-coded or printed credentials; MFA required; the bootstrap is audited.
  - **Delivery:** Stage 7A (rules, database, audit; API only), then Stage 7B (administration screens).
- **Consequences:**
  - No verified delivery channel exists yet (no email provider). Stage 7A delivers tokens through a development outbox on this Mac only (R-011, production-blocking).

### ADR-030 — Stage 8 projects and scenarios (decisions D8-1 to D8-8)
- **Status:** Approved by owner, 2026-10-18 ("PBE Stage 8 — Decisions Approved; Proceed With Implementation": all of D8-1 to D8-8 approved as recommended in [STAGE-08-PLAN.md §2](../stage-plans/STAGE-08-PLAN.md#2-prerequisites-and-decisions-needed-owner)).
- **Decision:**
  - **D8-1 MVP scope (OD-13):** Stages 1–10 and 12–19 (no ML, no AI, no PDF/Word extraction).
  - **D8-2 Controlled vocabulary:** a **draft** (`packages/contracts/src/vocabulary.ts`, version `draft-2026-10-18`) built only from the ADR-011 table. Borderline terms (chewable, orodispersible, fixed-dose combination) are "needs reviewer decision" and are treated as **unsupported** until the scientific reviewer includes them (OD-10, Stage 12). The reviewer gate stays explicit: the vocabulary is flagged `draft-pending-reviewer-confirmation`, and a test fails on any unreviewed change.
  - **D8-3 Project fields:** name, molecule, strength (value + unit: mg, g, µg), dosage form, route, release type, product characteristics, scope status with reasons and vocabulary version, status. Dose metadata is deferred to Stage 9.
  - **D8-4 Permissions** (fixed catalogue, ADR-029): `tenant.projects.read` (view-only), `tenant.allprojects.read` (view-only; see every project whatever its departments), `tenant.projects.create`, `tenant.projects.manage`, `tenant.scenarios.manage`. Holders of the three changing permissions must use MFA (existing rule). The recommended name `tenant.projects.read_all` was written `tenant.allprojects.read` because permission identifiers allow only letters and dots (approved at closure).
  - **D8-5 Templates:** Project Lead: read, create, manage, scenarios. Scientist: read, scenarios. QA/QC Reviewer, Scientific Reviewer, Viewer: read. **Deviation from the plan, approved at closure:** the Tenant Administrator template holds **all** project permissions (not only read), because a member can grant only permissions they hold; with read only, nobody in a new organisation could give project permissions to others. All templates stay editable per organisation.
  - **D8-6 Department visibility (option B), enforced by PostgreSQL row-level security:** a project without departments is visible to every member with `tenant.projects.read`; a project with departments only to their members, holders of `tenant.allprojects.read`, and a Super Admin with an approved, unexpired break-glass grant (read-only, ADR-028). Scenarios follow their project. The API adds one rule: whoever sets departments must remain able to see the project.
  - **D8-7 Scenario codes:** `F001`, `F002` …, generated from a per-project counter under a row lock, unique per project (database constraint), never reused; no deletion in Stage 8.
  - **D8-8 Archived projects:** remain visible and become read-only for everyone (API check under the row lock, plus a database trigger); no deletion.
  - **Schema profiles:** migrations 0005 (backup read access) and 0006 (projects) stay proposed until the backup prerequisites are resolved (STAGE-07A-BACKUP-REVIEW.md §24). The API accepts exactly one of two migration ledgers: the base ledger its generated types come from (0001–0004) or that plus 0005 and 0006. The projects module uses only hand-written SQL and is active only on the second profile. The permission catalogue in force is the one seeded at the connected ledger (each permission records the migration that adds it).
- **Decision closure (owner, 2026-10-18, "PBE Stage 8 — Decision Closure and Integration Readiness"):** the four points raised in the Stage 8 report are approved:
  1. The Tenant Administrator template holds **all five** project permissions by default. The delegation rule (a member grants only permissions they hold), the lock-out rule and tenant isolation apply unchanged.
  2. **`tenant.allprojects.read`** is the identifier. It passes the shared naming rule (`PERMISSION_PATTERN`) and the database check on `platform.permission`; the draft name `tenant.projects.read_all` fails both. It is used consistently in code, migration, templates and documents.
  3. The API supports exactly the two schema profiles above and **refuses every other migration ledger at start-up**. Health reports "unavailable" if the ledger changes after start-up. On the base profile, project routes answer **404 "This feature is not available on this database yet."** (not 403), and the project permissions are absent from the catalogue, the session and role editing.
  4. **No project edit screen in Stage 8.** Changing a project is available through the API only; the limitation is recorded in the product baseline.
- **Consequences:**
  - Projects can be used only on databases with 0006. **Applied to `pbe_test` and `pbe_dev` on 2026-10-18** in the owner-authorised integration phase (STAGE-08-INTEGRATION-PLAN.md), after a verified administrator backup; 0005 and 0006 now live in `db/migrations/`. `pbe_test` and `pbe_dev` stay at 0004.
  - A later vocabulary change is visible: every project stores the vocabulary version used for its scope check.

---

## Requirements carried from the brief (also confirmed)

The MA-00 brief requires these patterns. They are therefore treated as confirmed. *How* each is implemented may still depend on open decisions.

| Ref | Requirement | Where specified |
|---|---|---|
| R-01 | Tenant-scoped authorisation plus PostgreSQL RLS where appropriate, tenant-aware composite foreign keys, and transaction-scoped tenant context | [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md), [DATA_AND_DATABASE_DESIGN.md](DATA_AND_DATABASE_DESIGN.md) |
| R-02 | Zod validation for API requests and responses | [API_CONTRACT_STANDARDS.md](API_CONTRACT_STANDARDS.md) |
| R-03 | Immutable, reproducible prediction runs; project/scenario/dataset versioning | [DATA_AND_DATABASE_DESIGN.md](DATA_AND_DATABASE_DESIGN.md) |
| R-04 | Separate, explicit, versioned, auditable training consent | [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) |
| R-05 | Every result page and report states that outputs can be wrong and need scientific and human judgement | [SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md) |
| R-06 | Stage gates with real test evidence and owner authorisation | [TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md) |
| R-07 | Platform-owner role distinct from tenant administrators | [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) |
