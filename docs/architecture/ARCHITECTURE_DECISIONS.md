# PBE — Architecture Decision Records (ADRs)

> **Status:** Baseline v0.2 (2026-10-13). v0.2 applies the owner's technology decisions from PBE-00.1 (see the revision history at the end).
> Each ADR is **Accepted** (fixed by the owner's brief, or a low-risk default consistent with it) or **Proposed** (needs owner approval; linked to an open decision).
> To change an accepted ADR, add a new ADR that *supersedes* or *refines* it, and record the change in the revision history. Never edit history silently.

| ID | Title | Status |
|---|---|---|
| ADR-001 | Modular monolith | Accepted (owner brief) |
| ADR-002 | Monorepo with `apps/` and `packages/` | Proposed (OD-001) |
| ADR-003 | Strict TypeScript across the stack | Accepted |
| ADR-004 | Shared-schema multi-tenancy with PostgreSQL Row-Level Security | Accepted |
| ADR-005 | Immutable Dataset Versions and Runs | Accepted |
| ADR-006 | Five separated computation layers (L1–L5) | Accepted |
| ADR-007 | PostgreSQL-backed background jobs; no Redis or message broker | Accepted (library: OD-021) |
| ADR-008 | Pure, I/O-free `science-core` package with versioned methods, in TypeScript | Accepted (language fixed by ADR-022; OD-005 closed) |
| ADR-009 | Storage abstraction, preserved originals, envelope encryption | Accepted (KMS: OD-025) |
| ADR-010 | URI-versioned REST API with OpenAPI | Accepted |
| ADR-011 | Value-level provenance and origin classification | Accepted |
| ADR-012 | Replaceable AI provider interface, disabled by default | Accepted |
| ADR-013 | ML governance: registry, consent gating, owner-controlled promotion | Accepted (details: OD-007, OD-008, OD-020; runtime constrained by ADR-022) |
| ADR-014 | Rulesets as versioned data | Accepted (content: OD-010) |
| ADR-015 | Append-only tenant audit trail plus separate technical trace | Accepted |
| ADR-016 | UUIDv7 identifiers plus human-readable run codes | Accepted |
| ADR-017 | Forward-only migrations with backup-based recovery | Accepted; refined by ADR-021 (runner: OD-002) |
| ADR-018 | Capabilities as pluggable analysis engines | Accepted |
| ADR-019 | No outbound network calls from the computation path | Accepted |
| ADR-020 | Canonical units with original values retained | Accepted |
| ADR-021 | PostgreSQL-only, SQL-first schema changes; database is the schema source of truth; no Prisma Migrate | Accepted (owner decision 2026-10-13; runner OD-002, data-access layer OD-037) |
| ADR-022 | TypeScript-only runtime, build and CI toolchain; no Python | Accepted (owner decision 2026-10-13) |

---

### ADR-001 — Modular monolith
**Context.** A non-coding owner must be able to maintain a small, verifiable system. The brief forbids microservices and extra infrastructure unless justified.
**Decision.** One NestJS backend process with strongly separated modules (see [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md)), one Next.js frontend and one PostgreSQL database.
**Consequences.** Simple deployment and debugging. Module boundaries must be enforced by convention, lint rules (e.g., import restrictions) and code review rather than by network boundaries. A module can be extracted into its own service later if a documented requirement appears, for example heavy ML inference.

### ADR-002 — Monorepo with `apps/` and `packages/`
**Decision (proposed).** Use a single repository with npm workspaces: `apps/api`, `apps/web`, `packages/contracts`, `packages/science-core`.
**Why.** npm is already installed, so no extra tool is needed. Shared contracts keep the frontend and backend types aligned.
**Alternative.** pnpm or Turborepo: faster, but extra tooling. → OD-001.

### ADR-003 — Strict TypeScript
**Decision.** Turn on `strict: true` everywhere. Don't use `any` in domain or science code without a written justification. Treat lint and type-check failures as gate failures.

### ADR-004 — Shared-schema multi-tenancy with PostgreSQL Row-Level Security
**Context.** Strict tenant isolation is required from day one.
**Options considered.**
1. Database per tenant: strongest isolation, heavy operations.
2. Schema per tenant: migration complexity grows with the number of tenants.
3. **Shared schema with a `tenant_id` column, enforced by both an application guard and PostgreSQL RLS.**
**Decision.** Option 3. Every tenant-owned table has `tenant_id NOT NULL` and an RLS policy restricting rows to `current_setting('app.tenant_id')`. The API connects as a role **without** `BYPASSRLS` and sets the tenant context **per transaction** (`SET LOCAL`). Platform-level tables, such as the owner's model registry, are separate and have no tenant data.
**Consequences.** Two independent layers must both fail before data leaks across tenants. Every stage that adds a tenant-owned table must add RLS policies and cross-tenant tests (see [TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md) §5). The design keeps a future move to database-per-tenant possible for customers who require it.

### ADR-005 — Immutable Dataset Versions and Runs
**Decision.** Once a Dataset Version is *frozen*, it and its records cannot be updated or deleted by the application role (enforced by triggers and RLS). A change creates a new version. Runs are insert-only. Run status moves forward only (`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED`). Results are written once.
**Content hashing.** Each frozen Dataset Version and each Run input snapshot stores a SHA-256 hash of its canonical JSON serialization.
**Exception.** Legal deletion obligations, such as erasure requests or end of contract, follow a documented, audited *crypto-shredding / purge* procedure ([SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) §9). This is the only path that removes immutable data.

### ADR-006 — Five separated computation layers
**Decision.** L1 deterministic science, L2 statistics, L3 ML prediction, L4 capability engines and L5 optional AI assistance are separate code units with separate version identifiers (see [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) §5).
**Rule.** L5 output is never stored as a scientific value. If a user accepts an L5 suggestion, such as a field mapping, the resulting value is recorded with origin `USER_ENTERED` or `EXTRACTED` and with a provenance note that AI assistance was used. A human approves it.

### ADR-007 — PostgreSQL-backed background jobs
**Decision.** Long-running work (extraction, runs, reports) is queued in a PostgreSQL job table with row locking (`FOR UPDATE SKIP LOCKED`) and runs in a worker process. The worker uses the same codebase and can be started as a second process. No Redis, RabbitMQ or Kafka.
**Open.** Use a maintained library such as pg-boss, or a minimal in-house table → OD-021.

### ADR-008 — Pure `science-core` package
**Decision.** All L1/L2 methods live in a pure library with no database, network, file system or clock access. Each method has a stable identifier and semantic version (e.g., `stats.tost.power@1.0.0`), a specification in `docs/methods/`, and a test-vector file.
**Language (v0.2).** TypeScript only (ADR-022). A Python or R worker is no longer an option. Reference tools that a scientific reviewer uses *outside* PBE to produce test vectors are not part of PBE: the repository never contains, installs or calls them, and CI only compares against the stored vector files ([SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md) §2).
**Consequence.** If a method needs a numerical routine that cannot be implemented and validated in TypeScript, PBE does not offer it. It fails closed, and the gap is recorded as a new open decision. It is never worked around with a non-TypeScript runtime.

### ADR-009 — Storage abstraction, preserved originals, envelope encryption
**Decision.** Files are stored through a `FileStorage` interface (local disk in development, S3-compatible object storage in the cloud). Original uploads are never modified. Each file is encrypted with a per-file data key, and that key is wrapped by a tenant key-encryption key held by a key-management provider (local key file **for development only**; cloud KMS in production → OD-025). Metadata, hash, size, detected MIME type and uploader are kept in the database.

### ADR-010 — URI-versioned REST API with OpenAPI
**Decision.** All endpoints live under `/api/v1/…`. OpenAPI documentation is generated from code and checked in CI. See [API_CONTRACT_STANDARDS.md](API_CONTRACT_STANDARDS.md).

### ADR-011 — Value-level provenance and origin classification
**Decision.** Every scientific value records its **origin**: `USER_ENTERED`, `EXTRACTED`, `EXTERNAL_FETCHED`, `HISTORICAL_REUSED`, `DERIVED`, `PREDICTED`, `SIMULATED` or `ASSUMED`. It also records a **review status** and a **provenance link** to its source, which can be a file and location, an external source and retrieval time, a parent values plus method version, or a model version. See [DATA_AND_DATABASE_DESIGN.md](DATA_AND_DATABASE_DESIGN.md) §5.

### ADR-012 — Replaceable AI provider interface, disabled by default
**Decision.** Define an `AiAssistProvider` interface. The only implementation shipped initially is `NullAiProvider`, which returns "not available". Enabling a real provider requires: (a) an owner-approved data-processing design, (b) tenant opt-in, (c) a per-request redaction policy and (d) audit logging. See [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) §8.

### ADR-013 — ML governance
**Decision.** Production inference uses only models with status `PRODUCTION` in the model registry. A model reaches that status only after evaluation against pre-registered acceptance criteria and explicit owner approval. Training data may include only records with valid, unrevoked consent at dataset-assembly time. Splits are grouped to prevent leakage. See [SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md).
**Until a model passes, PBE gives no ML-based BE probability.** Deterministic and statistical outputs (L1/L2) can still be shown.
**Runtime (v0.2).** Training and inference must run in TypeScript/Node.js inside PBE's governed environment (ADR-022). The training approach and model artifact format are OD-007 and OD-008.

### ADR-014 — Rulesets as versioned data
**Decision.** Readiness rules, applicability-domain rules and jurisdiction parameters (e.g., equivalence limits, conditions for dissolution-similarity metrics) are stored as **versioned, cited ruleset documents**, not hard-coded constants. Each Run records the ruleset version it used. Ruleset content must be authored and signed off by a qualified person (OD-010, OD-024).

### ADR-015 — Audit trail and technical trace
**Decision.** Two separate stores:
- **Tenant audit trail.** Append-only, tenant-scoped and visible to authorised tenant users. Records who did what, when, to which record, and why (reason for change where required).
- **Platform technical trace.** Owner-level operational logs with request IDs, timings and error codes, and **no scientific content**.

### ADR-016 — Identifiers
**Decision.** Primary keys are UUIDv7: time-ordered, so they index well. Users see codes such as `PRJ-000123` and `RUN-2026-000456` (unique per tenant). Codes are never reused.

### ADR-017 — Forward-only migrations with backup-based recovery
**Decision.** Schema migrations are versioned and forward-only in production. Every migration is reviewed for reversibility. Recovery uses a **verified backup before migration** plus a forward-fix migration. Down-migrations may exist for development only. See [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md).
**Refined by ADR-021 (v0.2).** ADR-021 defines the tooling, the paired revert scripts and the rollback options. The forward-only production principle is unchanged.

### ADR-018 — Capabilities as pluggable analysis engines
**Decision.** Each differentiating capability is an `AnalysisEngine` registered with the run orchestrator by `runType`. Each engine declares its required inputs, method versions, required permissions and applicability checks. New capabilities are added as new engines without changing the core Project → Scenario → Dataset Version → Run model.

### ADR-019 — No outbound network calls from the computation path
**Decision.** Runs execute only on the frozen snapshot. Fetch Missing Information is a separate, user-initiated workflow whose results must be approved and frozen into a new Dataset Version before any run can use them.

### ADR-020 — Canonical units
**Decision.** Each quantity has one canonical unit per quantity type (e.g., concentration in ng/mL, time in h, dose in mg). The original value and unit text are always retained alongside the canonical value. Conversions use versioned, tested conversion methods. Unknown or ambiguous units block approval.

### ADR-021 — PostgreSQL-only, SQL-first schema changes; no Prisma Migrate
**Context.** The owner decided on 2026-10-13 that PostgreSQL is the only database and that Prisma Migrate is not used. The design relies on PostgreSQL features that ORM schema generators often handle poorly or not at all: Row-Level Security policies, `FORCE ROW LEVEL SECURITY`, immutability triggers, role grants, composite tenant foreign keys and `security_invoker` views.
**Decision.**
1. **PostgreSQL is the only database** in every environment, tests included. No SQLite, in-memory database emulators, Redis, MongoDB or other datastore. Jobs, sessions and idempotency records also live in PostgreSQL (ADR-007).
2. **Schema changes are hand-written, reviewed, plain `.sql` migration files** in `db/migrations/`. They are the **single source of truth** for the schema. Application types are derived *from* the database, never the other way round.
3. **Prisma Migrate is not used.** The same goes for any tool that generates or applies schema changes from an ORM model (e.g., TypeORM `synchronize`, Drizzle Kit `push`), unless a later ADR approves it.
4. Each forward migration has a **paired, tested revert script**. It is used only through the rollback procedure, never run automatically ([DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md) §4).
5. Applied migrations are **checksummed**. Editing a migration after it has been applied anywhere is detected and blocks the runner.
6. After migrations run, a normalised schema snapshot (`db/schema.sql`) is committed. CI fails if the live schema and the snapshot differ (drift check).
7. The tool that applies migrations (OD-002) and the application's data-access layer (OD-037) are **separate decisions**. Neither may be an ORM-driven schema generator.
**Consequences.** Schema changes are fully transparent SQL, which suits a scientific, audited product. More discipline is needed: review checklist, revert scripts and drift checks. A technical reviewer for migrations is needed because the owner is a non-coder (OD-038).

### ADR-022 — TypeScript-only runtime, build and CI toolchain; no Python
**Context.** Owner decision of 2026-10-13: no Python, Python services or Python dependencies. The initial stack is Next.js, React, TypeScript and NestJS.
**Decision.**
1. All PBE code is TypeScript running on Node.js: application, worker, science, ML, scripts and tests. Shell scripts are allowed only as thin wrappers, such as calling `pg_dump`.
2. The repository contains no `.py` files, `requirements.txt`, `pyproject.toml`, `Pipfile` or similar.
3. **Indirect Python is excluded too.** npm packages that compile native code at install time through `node-gyp` need Python. They are not allowed unless the package ships prebuilt binaries for every target platform *and* installs without Python. Pure-JavaScript packages, or packages with prebuilt N-API binaries, are preferred. Examples: `pg` (pure JS) instead of `pg-native`; a prebuilt Argon2 binding such as `@node-rs/argon2` instead of one that may fall back to `node-gyp`. The exact package is chosen in Stage 3.
4. A CI check fails the build if Python artifacts appear in the repository, and a clean `npm ci` must succeed with no Python interpreter on `PATH` ([TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md) §2).
5. Other non-Node runtimes are also excluded from the core toolchain: R, JVM (Flyway/Liquibase), Perl (Sqitch), and standalone Go or Rust binaries outside npm-delivered prebuilt N-API modules. Introducing one needs a new ADR. **Exception:** PostgreSQL's own client tools (`psql`, `pg_dump`, `pg_restore`), which ship with the database.
**Consequences.**
- Fewer mature numerical and ML libraries are available. Science and ML scope is limited to what can be implemented **and validated** in TypeScript (ADR-008, ADR-013).
- Reviewers can still use any external tool, outside PBE, to produce reference test vectors.

---

## Revision history

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-13 | Baseline (Stage 0) |
| v0.2 | 2026-10-13 | PBE-00.1 owner decisions: added ADR-021 and ADR-022; ADR-008 language fixed to TypeScript (OD-005 closed); ADR-013 runtime constrained; ADR-017 refined by ADR-021 |

