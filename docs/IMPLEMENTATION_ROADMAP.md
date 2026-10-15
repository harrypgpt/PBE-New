# PBE — Implementation Roadmap

> **Status:** Baseline v0.2 (2026-10-13). v0.2: owner decisions from PBE-00.1 applied: PostgreSQL only; SQL-first migrations without Prisma Migrate (ADR-021); TypeScript only, no Python (ADR-022).
> Stage 0 (architecture) is complete as documentation only. **No stage starts without the owner's explicit authorisation.**
> Every stage must pass the **Standard Stage Gate** in [architecture/TESTING_AND_ACCEPTANCE_GATES.md](architecture/TESTING_AND_ACCEPTANCE_GATES.md) §3 *in addition to* the stage-specific criteria below, and must produce `docs/stage-reports/STAGE-XX.md`.
> "Blocking ODs" refers to [architecture/OPEN_DECISIONS_REGISTER.md](architecture/OPEN_DECISIONS_REGISTER.md).

## Overview

| Phase | Stages | Outcome |
|---|---|---|
| A. Foundation | S1–S6 | Repo, database, login, tenants, permissions, audit, UI shell |
| B. Evidence | S7–S15 | Projects, scenarios, canonical evidence, uploads, extraction, readiness |
| C. Runs and statistics | S16–S17 | Immutable reproducible runs; validated power and sample size |
| D. Capabilities (no ML) | S18–S23 | C1, C3, C4, reports, C5, C7 → **proposed MVP (OD-029)** |
| E. Data governance and learning | S24–S29 | Consent, historical reuse, external fetch, ML governance, C6, C2, owner dashboard |
| F. Optional AI and go-live | S30–S32 | AI provider interface, hardening, deployment |

---

## Phase A — Foundation

### S1 — Repository skeleton and tooling
- **Depends on:** S0. **Blocking ODs:** 001, 003, 023, 028.
- **Scope:** git init; workspace layout (apps/api, apps/web, packages/contracts, packages/science-core); strict TS; lint (incl. import-boundary rules), format, test runner; toolchain policy check (no Python, no Prisma Migrate); `/health/live`; minimal web page; `npm run verify`; `.env.example`; README for the owner. **No database code in S1.**
- **Acceptance criteria:**
  1. `npm install` and `npm run verify` succeed from a fresh clone.
  2. `GET /health/live` returns 200 (integration test).
  3. A lint test proves an illegal cross-tier import fails.
  4. The OpenAPI spec is generated and committed.
  5. The secret scan runs and passes.
  6. The toolchain policy check runs and passes: no Python artifacts; no `prisma` package; `npm ci` succeeds with no Python on `PATH`; no `node-gyp` builds in the lockfile.
- **Test gate:** static + toolchain policy + unit + contract.

### S2 — Database baseline, migrations, backup/restore
- **Depends on:** S1. **Blocking ODs:** 002, 004, 037; 038 (only for applying migrations beyond local/test).
- **Scope:**
  - local PostgreSQL (≥ 15) and a role bootstrap script (`pbe_migrator`, `pbe_app`);
  - the SQL migration runner per [DEPLOYMENT_AND_MIGRATION.md](architecture/DEPLOYMENT_AND_MIGRATION.md) §4: checksums, advisory lock, timeouts, role refusal, paired revert scripts, `schema_migrations`;
  - the `db/schema.sql` snapshot and drift check;
  - the data-access layer (OD-037) with transaction-scoped tenant-context plumbing (no tenant tables yet);
  - `/health/ready` checks the DB; backup/restore scripts; test DB lifecycle.
  - **No Prisma Migrate, no ORM schema generation, no Python.**
- **Acceptance criteria:**
  1. Tests M1–M6, M8 and M11 (DEPLOYMENT §4.5) executed and passing.
  2. `pbe_app` cannot run DDL (test).
  3. A checksum-tampered migration makes the runner refuse (test).
  4. Backup → restore into a scratch DB → verification script passes (executed, not assumed).
  5. `/health/ready` reports DB status.
- **Test gate:** + integration + schema-change tests.

### S3 — Identity and authentication
- **Depends on:** S2. **Blocking ODs:** 009.
- **Scope:** users, Argon2id, sessions (HttpOnly cookie), CSRF, logout, TOTP MFA, login rate limiting, invitation flow (no public sign-up).
- **Acceptance criteria:**
  1. Login/logout/session expiry tests pass.
  2. MFA enrol/verify tests pass.
  3. Brute-force attempts are rate-limited (test).
  4. Passwords and tokens never appear in logs (redaction test).
  5. Session cookie flags verified.
- **Test gate:** + security tests (auth).

### S4 — Tenancy, departments, memberships, RLS
- **Depends on:** S3.
- **Scope:** tenants, departments, memberships; tenant switcher; per-transaction tenant context; RLS on all tenant tables; tenant-isolation test harness.
- **Acceptance criteria:**
  1. Tenant-isolation tests **T-ISO-01 to T-ISO-14** ([TESTING_AND_ACCEPTANCE_GATES.md](architecture/TESTING_AND_ACCEPTANCE_GATES.md) §5) pass for tenants/departments/memberships. T-ISO-09 (jobs) is deferred to S12, when jobs are introduced; T-ISO-14 (file downloads) to S12; owner-endpoint checks to S5.
  2. Schema-change tests M7 (RLS coverage) and M10 pass.
  3. All tenant-table foreign keys are composite `(tenant_id, …)`; all views are `security_invoker`.
- **Test gate:** + tenant-isolation suite.

### S5 — Roles, permissions, audit trail
- **Depends on:** S4. **Blocking ODs:** 026, 033.
- **Scope:** permission catalogue, configurable roles, deny-by-default guard, CI check for undeclared permissions; append-only, hash-chained tenant audit trail; technical trace; audit viewer API.
- **Acceptance criteria:**
  1. The authorization matrix (all endpoints × default roles) passes.
  2. An endpoint without a permission fails CI.
  3. Audit rows cannot be updated or deleted by `pbe_app` (test).
  4. The hash-chain verification script detects a tampered row (test).
  5. Owner endpoints reject tenant roles.
- **Test gate:** + authorization matrix.

### S6 — Web application shell and design system
- **Depends on:** S5. **Blocking ODs:** 018, 019 (placeholder text allowed).
- **Scope:** design tokens (owner-approved), layout, navigation, login/MFA screens, tenant switcher, user/role admin screens, disclaimer component, error/empty/loading states, responsive layout.
- **Acceptance criteria:**
  1. The owner approves the design tokens and screenshots.
  2. E2E: login → switch tenant → view users passes.
  3. Responsive layout at phone/tablet/desktop widths verified with screenshots.
  4. Automated accessibility check: no critical violations on built pages.
- **Test gate:** + e2e + a11y.

## Phase B — Evidence

### S7 — Projects and scenarios
- **Depends on:** S6.
- **Scope:** CRUD, codes, archival, project-scoped roles, scope fields (dosage form, route, release type).
- **Acceptance criteria:**
  1. CRUD + audit events present.
  2. Isolation and authorization tests extended.
  3. An out-of-scope dosage form is flagged `OUT_OF_SCOPE` on the project.
- **Test gate:** standard.

### S8 — Reference data and units library
- **Depends on:** S7. **Blocking ODs:** 031.
- **Scope:** drug substances, reference products, owner-curated library (copy-into-tenant); `science-core` units module with canonical unit table and conversions.
- **Acceptance criteria:**
  1. Unit conversion vectors (cited) pass.
  2. Unknown or ambiguous units are rejected.
  3. Tenants cannot modify the platform library.
- **Test gate:** + scientific regression (units).

### S9 — Dataset versions, formulation, COA, provenance, approval
- **Depends on:** S8. **Blocking ODs:** 034.
- **Scope:** dataset version lifecycle (DRAFT → IN_REVIEW → APPROVED → FROZEN), formulation/components/COA manual entry, `value_provenance`, review/approve with optional segregation of duties, freeze with content hash, immutability triggers.
- **Acceptance criteria:**
  1. Frozen versions reject update/delete at the DB level (test).
  2. Editing creates a new version with a parent link.
  3. The content hash is stable across re-serialisation (test).
  4. Unapproved values cannot be frozen.
  5. Every value shows its origin in the API.
- **Test gate:** standard + immutability tests.

### S10 — Dissolution data and dissolution methods
- **Depends on:** S9. **Blocking ODs:** 005, 006, 010, 024.
- **Scope:** dissolution profiles/points entry; method specs + implementations for the approved dissolution metrics; jurisdiction ruleset v1 (cited) for applicability conditions.
- **Acceptance criteria:**
  1. Method specs are reviewer-signed.
  2. Vectors from a cited source pass.
  3. When conditions are not met, the method refuses (test).
  4. No BE conclusion is produced from dissolution alone (test on API output).
- **Test gate:** + scientific regression.

### S11 — PK, pilot BE and study design data; basic statistics
- **Depends on:** S10. **Blocking ODs:** 011, 035.
- **Scope:** study design (catalogue with `analysis_supported`), sampling schedule, PK parameters, optional concentration data, pilot BE summary results; ISCV / inter-subject CV kept as separate fields; method(s) for deriving GMR/CI/ISCV from subject-level data for the approved design only.
- **Acceptance criteria:**
  1. Reported values are stored as reported and not recomputed.
  2. Derived values carry method version + parents.
  3. Unsupported designs cannot be analysed (test).
  4. Statistical vectors from a named reference implementation pass.
- **Test gate:** + scientific regression.

### S12 — Secure file upload and storage
- **Depends on:** S9. **Blocking ODs:** 021, 025 (dev), 027, 014 (temp uploads).
- **Scope:** upload endpoint, type/size allow-list, content sniffing, SHA-256, envelope encryption (dev key), malware-scan hook, authorised download, job queue introduced.
- **Acceptance criteria:**
  1. A disallowed type gets 415.
  2. A spoofed extension is rejected.
  3. Stored bytes are encrypted (test reads raw storage).
  4. Cross-tenant download gets 404 (T-ISO-14), and jobs run only with their tenant's context (T-ISO-09).
  5. Unscanned files cannot be parsed.
- **Test gate:** + security (upload abuse cases).

### S13 — Structured extraction (CSV/XLSX) and review
- **Depends on:** S12.
- **Scope:** deterministic parsers, raw extraction with locators, mapping templates, normalisation, review UI, approval into a draft Dataset Version.
- **Acceptance criteria:**
  1. Raw values and locators are preserved.
  2. Normalised values link to raw values.
  3. Nothing enters a version without approval.
  4. Formula-injection payloads are neutralised.
- **Test gate:** standard + fixture-file tests.

### S14 — Document extraction (text-based PDF, DOCX)
- **Depends on:** S13. **Blocking ODs:** 032.
- **Scope:** table/text extraction with locators; review UI highlighting the source location.
- **Acceptance criteria:**
  1. Fixture documents extract to the expected raw values (fixtures created for the test, with expected values written alongside).
  2. Scanned PDFs are reported as unsupported.
  3. Macros and embedded content are not executed.
- **Test gate:** standard.

### S15 — Readiness and applicability engine
- **Depends on:** S11. **Blocking ODs:** 010.
- **Scope:** ruleset engine, readiness ruleset v1, applicability (product scope) ruleset v1, readiness preview endpoint and UI with missing-data guidance.
- **Acceptance criteria:**
  1. Each rule has a test.
  2. Out-of-scope products return `NOT_SUPPORTED` with reasons.
  3. The ruleset version appears in the output.
- **Test gate:** standard.

## Phase C — Runs and statistics

### S16 — Run engine (immutable, reproducible)
- **Depends on:** S15, S12 (jobs).
- **Scope:** run creation with idempotency, snapshot + hash, method/ruleset/engine references, `AnalysisEngine` registry, worker execution, a deterministic "evidence summary" run type, reproduce endpoint, run rate limits.
- **Acceptance criteria:**
  1. Run tables are immutable (DB tests).
  2. Reproduce gives a matching output hash (test).
  3. The same idempotency key does not create a duplicate run.
  4. A run cannot start when readiness is a BLOCKER.
- **Test gate:** + reproducibility.

### S17 — Power and sample-size estimation
- **Depends on:** S16. **Blocking ODs:** 005, 006, 010, 011.
- **Scope:** method spec(s) for TOST power and sample size for the supported design(s); all parameters required (endpoint, GMR, limits, design, power, α, variability, dropout).
- **Acceptance criteria:**
  1. Vectors from a named, executed reference implementation pass within the documented tolerance.
  2. A request missing any required parameter is rejected.
  3. Unsupported designs are refused.
- **Test gate:** + scientific regression.

## Phase D — Capabilities without ML (proposed MVP)

### S18 — C1 BE Risk Fingerprint v1 (rule/evidence-based)
- **Depends on:** S17.
- **Acceptance criteria:**
  1. Every driver links to its evidence and rule ID.
  2. The output labels its method as rule-based.
  3. A snapshot test on fixture scenarios gives stable output.

### S19 — C3 Virtual Pivotal BE / Digital Rehearsal v1
- **Depends on:** S17.
- **Acceptance criteria:**
  1. Seeded simulation is reproducible.
  2. All assumptions are listed in the output.
  3. The simulated pass proportion agrees with the analytical power from S17, within the Monte-Carlo error stated in the method spec, on vector cases (test).

### S20 — C4 Failure-Condition and Sensitivity Engine v1
- **Depends on:** S17, S19.
- **Acceptance criteria:**
  1. Parameter sweeps are reproducible.
  2. Failure boundaries are reported with stated assumptions.
  3. Ranges are user-specified or rule-derived and shown.

### S21 — Reports and scenario comparison
- **Depends on:** S18–S20. **Blocking ODs:** 017, 019.
- **Acceptance criteria:**
  1. Reports include run IDs, versions, assumptions, uncertainty, limitations and the disclaimer.
  2. A report is generated only from immutable runs.
  3. The artifact hash is stored.
  4. Export is audited.
  5. CSV/XLSX are protected against injection.

### S22 — C5 Digital Twin v1
- **Depends on:** S21. **Blocking ODs:** 030.
- **Acceptance criteria:**
  1. Twin versions link to exact dataset versions and runs.
  2. Validity limits are displayed.
  3. The twin is not described as mechanistic/PBPK.

### S23 — C7 Next Best Experiment / Action v1 (rule-based)
- **Depends on:** S18, S20.
- **Acceptance criteria:**
  1. Each recommendation cites the gap or sensitivity driving it.
  2. Ranking is labelled rule-based.
  3. Fixture-scenario tests pass.
- **→ MVP release candidate if OD-029 is accepted.** Before any real sponsor data, the production-readiness gate (TESTING §7) also applies.

## Phase E — Data governance and learning

### S24 — Consent management and historical-study reuse
- **Depends on:** S16. **Blocking ODs:** 013, 022, 036.
- **Acceptance criteria:**
  1. Consent grant and revoke are append-only events.
  2. The eligibility query excludes revoked, expired and unconsented data (tests).
  3. A reuse authorisation is required and scoped.
  4. The default is no consent.

### S25 — Fetch Missing Information
- **Depends on:** S13. **Blocking ODs:** 012.
- **Acceptance criteria:**
  1. Only allow-listed sources are used.
  2. Every fetched value records source + retrieval time.
  3. A fetched value can't be used until approved.
  4. Runs make no network calls (test).

### S26 — ML governance infrastructure (no production model)
- **Depends on:** S24. **Blocking ODs:** 007, 020.
- **Scope:** `packages/ml-core` (TypeScript; no Python); training dataset assembly, pseudonymisation, grouped/temporal splits, leakage and duplicate checks, model registry, evaluation records, pre-registered criteria storage.
- **Acceptance criteria:**
  1. Leakage tests (a group in two splits) fail the pipeline.
  2. Consent snapshot time is recorded.
  3. The locked test set's access is logged.

### S27 — C6 Failure and Pilot-to-Pivotal Learning; candidate evaluation; promotion; inference
- **Depends on:** S26. **Blocking ODs:** 008, 020.
- **Acceptance criteria:**
  1. A candidate becomes PRODUCTION only after evaluation passes and owner approval is recorded.
  2. Inference refuses out-of-domain inputs.
  3. The model version is stored in runs; the model artifact is a hashed, versioned TypeScript-evaluable artifact (OD-008).
  4. Any displayed metric comes from a stored evaluation.
  5. **If no candidate meets the criteria, the stage still passes as infrastructure, and the UI shows no ML prediction.**

### S28 — C2 Reverse Engineering and Formulation Optimization
- **Depends on:** S27 (a PRODUCTION model with a suitable domain), S22.
- **Acceptance criteria:**
  1. Candidates respect constraints and the applicability domain.
  2. Each candidate is labelled a hypothesis for experimental confirmation.
  3. Reproducible.

### S29 — Owner historical-data learning dashboard
- **Depends on:** S26.
- **Acceptance criteria:**
  1. Shows only consent-eligible, pseudonymised aggregates.
  2. Owner role only.
  3. No tenant names or confidential values appear (test).

## Phase F — Optional AI and go-live

### S30 — AI assistance provider interface
- **Depends on:** S13.
- **Acceptance criteria:**
  1. `NullAiProvider` is the default.
  2. Enabling a provider requires the owner-approved configuration and tenant opt-in (tests).
  3. AI suggestions cannot be written without human approval.
  4. The provenance flag `ai_assisted` is set.

### S31 — Security, privacy and operational hardening
- **Depends on:** S23 (or the latest release candidate). **Blocking ODs:** 014, 016.
- **Acceptance criteria:**
  1. Independent security review / penetration test completed and findings resolved or accepted.
  2. Backup/restore drill executed and verified.
  3. Incident-response and retention procedures documented.

### S32 — Secure SaaS deployment (first region)
- **Depends on:** S31. **Blocking ODs:** 015, 025.
- **Acceptance criteria:**
  1. Infrastructure is defined as code.
  2. Staging → production promotion is executed.
  3. Production smoke tests pass.
  4. Restore test passes in the cloud.
  5. Data residency is configured for the first region.

---

## Dependency graph (simplified)

```
S1→S2→S3→S4→S5→S6→S7→S8→S9─┬→S10→S11→S15→S16→S17─┬→S18─────────┬→S21→S22
                           │                      ├→S19→S20─────┤        
                           │                      │             └→S23 (with S18)
                           └→S12→S13─┬→S14         └→S24→S26─┬→S27→S28 (with S22)
                                     ├→S25                   └→S29
                                     └→S30
S23 → S31 → S32
```
