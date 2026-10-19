# Open Decisions Register

Status: Draft for product-owner review, MA-00, 2026-10-16.

**Every entry below is OPEN unless its status says Approved.** A "Recommendation" is the architect's proposal, not an approval. To approve an entry, the owner says so explicitly (e.g. "Approve OD-06 option A"). The agent then sets the status to *Approved*, records the date and the owner's words, and adds a matching ADR in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md).

"Resolve by" means the decision must be approved **before that stage starts**.

## Summary

| ID | Decision | Recommendation (short) | Resolve by | Status |
|---|---|---|---|---|
| OD-01 | Monorepo structure and workspaces | One repo, npm workspaces: `apps/web`, `apps/api`, `packages/contracts`, `packages/science-core`, `db/`, `tooling/` | Stage 1 | **Approved** 2026-10-16 → ADR-013 |
| OD-02 | Shared schema validation and API docs | Zod schemas in `packages/contracts`; NestJS Zod pipe; OpenAPI generated from Zod | Stage 4 | **Approved** 2026-10-17 → ADR-022 |
| OD-03 | Git repository and private remote | Keep existing GitHub remote; confirm private; branch protection; owner commits | Stage 1 | **Approved with condition** 2026-10-16 → ADR-014 |
| OD-04 | Test runner and frontend testing | Jest everywhere + React Testing Library + Playwright for E2E | Stage 1 | **Approved** 2026-10-16 → ADR-015 |
| OD-05 | PostgreSQL version and local install | PostgreSQL 18 (already installed, 18.6) | Stage 2 | **Approved** 2026-10-16 → ADR-017 |
| OD-06 | SQL migration runner | Small in-house TypeScript runner on `pg` | Stage 2 | **Approved** 2026-10-17 → ADR-018 |
| OD-07 | Data-access layer | `pg` driver + Kysely query builder (types generated from migrated DB); raw SQL allowed | Stage 3 | **Approved** 2026-10-17 → ADR-021 |
| OD-08 | Authentication and MFA | In-app server-side sessions in PostgreSQL, Argon2id, TOTP MFA; OIDC SSO later | Stage 6 | **Approved** 2026-10-17 → ADR-026 |
| OD-09 | First jurisdiction rulesets | Harmonised IR-oral-solid guideline ruleset first + one regional ruleset chosen by market | Stage 12 | Open |
| OD-10 | Scientific reviewer and method approval | Named, qualified, independent reviewer(s); recorded approvals | Stage 12 | Open |
| OD-11 | Model acceptance criteria | Predefined metrics and thresholds set by reviewers before any training | Stage 25 | Open |
| OD-12 | Retention, consent and legal review | Qualified legal review in three steps (before real data, before training, before SaaS) | Stage 9 (part a) | Open |
| OD-13 | MVP scope | Stages 1–10 and 12–19 | Stage 8 | **Approved** 2026-10-18 → ADR-030 |
| OD-14 | Deployment, hosting and backup strategy | Major cloud with managed PostgreSQL 18, region by customer base | Stage 29 | Open |
| OD-15 | File storage for uploads and reports | Storage interface; local folder in dev; S3-compatible object storage in SaaS | Stage 10 | Open |
| OD-16 | Document extraction libraries | Small, well-maintained JS parsers per format; no OCR initially | Stage 10 | Open |
| OD-17 | Report generation format and engine | HTML view + pure-JS PDF generation | Stage 16 | Open |
| OD-18 | Numerical/statistical routines in TypeScript | Minimal in-house functions with KATs, plus seedable PRNG | Stage 14 | Open |
| OD-19 | ML implementation approach in TypeScript | Start with transparent models; library chosen against data | Stage 25 | Open |
| OD-20 | External AI provider and data processing | Defer; decide with DPA and tenant opt-in | Stage 27 | Open |
| OD-21 | Authoritative sources for Fetch Missing Information | Public, licence-compatible sources first; per-source approval | Stage 23 | Open |
| OD-22 | Background job execution | In-house PostgreSQL job table with `SKIP LOCKED` | Stage 10 | Open |
| OD-23 | Readiness scoring method | Gates + reviewer-weighted completeness, quality, applicability | Stage 12 | Open |
| OD-24 | UI component and styling approach | Native HTML + in-house accessible components, CSS Modules, central design tokens; no UI library | Stage 5 | **Approved** 2026-10-17 → ADR-024 |
| OD-25 | Node.js version policy | Node 24 LTS (installed: v24.21.0), pinned | Stage 1 | **Approved** 2026-10-16 → ADR-016 |
| OD-26 | Platform-owner access to tenant data (break-glass) | No default access; time-limited, tenant-approved, audited grants | Stage 7 | **Approved** 2026-10-17 → ADR-028 |
| OD-27 | Sponsor-facing vs owner-level report content | Two views; sponsor view hides model internals, never hides limitations or assumptions | Stage 16 | Open |
| OD-29 | NestJS major version and HTTP adapter (added 2026-10-17) | NestJS 11.2.7 + Express adapter (NestJS 12 is ES-module-only and cannot run under the approved Jest set-up) | Stage 4 | **Approved** 2026-10-17 → ADR-023 |
| OD-30 | Next.js version and browser-to-API routing (added 2026-10-17) | Next.js 16.4.2; browser talks only to the web origin, which forwards `/api/v1/*` to the API; CORS stays closed | Stage 5 | **Approved** 2026-10-17 → ADR-025 |
| OD-31 | Runtime access to identity data (added 2026-10-17) | Narrow owner-owned functions for pre-sign-in look-ups; RLS by `app.user_id` otherwise; no bulk read of hashes or MFA secrets | Stage 6 | **Approved** 2026-10-17 → ADR-027 |
| OD-28 | Encryption key management | Local: disk encryption; SaaS: managed KMS + application-level file encryption | Stage 28 | Open |

---

### OD-01 — Monorepo structure and npm workspaces
- **Decision:** How to organise the code repository.
- **Options:** (A) one repository with npm workspaces; (B) one repository with a monorepo tool (Nx or Turborepo); (C) separate repositories for web and API.
- **Pros/cons:** A: + built into npm, nothing extra to learn; − no build caching. B: + caching and task graphs; − extra tool and configuration for a non-coder to maintain. C: + independent releases; − shared contracts become hard to keep in sync, double the setup.
- **Recommendation:** A, with the layout in [MODULE_BOUNDARIES.md §1](MODULE_BOUNDARIES.md#1-proposed-repository-structure-recommendation-od-01). Lint-enforced boundaries.
- **Consequences:** Security: neutral. Scientific: `science-core` isolation is easy to enforce. Operational: simplest; Nx or Turborepo can be added later if builds become slow.
- **Dependencies:** OD-25. **Resolve by:** Stage 1. **Status:** Approved 2026-10-16, owner: "OD-01: npm workspaces." → ADR-013.

### OD-02 — Shared schema validation approach
- **Decision:** How Zod schemas are shared between web and API, enforced in NestJS, and turned into API documentation.
- **Options:** (A) Zod in `packages/contracts`, a small NestJS validation pipe, OpenAPI generated from Zod with a maintained generator library; (B) NestJS class-validator DTOs plus separate Zod on the web (duplicate definitions); (C) OpenAPI-first with generated Zod.
- **Pros/cons:** A: + one source of truth, matches R-02; − generator library choice needs care. B: − duplication and drift; conflicts with the Zod requirement. C: + strong documentation; − YAML-first is harder for a non-coder; generated code adds complexity.
- **Recommendation:** A. The exact generator and pipe library (or a minimal in-house pipe) is chosen in Stage 4 after checking maintenance and Zod-version compatibility.
- **Stage 4 preparation evidence (2026-10-17, scratch copies of the project only):**
  - **Zod 4.6.7:** MIT, ships CommonJS, and produces JSON Schema natively (`z.toJSONSchema`, draft 2020-12, the dialect of OpenAPI 3.1). Verified in a spike.
  - **`nestjs-zod` 5.5.0:** supports only NestJS 10–11; incompatible with NestJS 12. Not needed.
  - **`@asteasolutions/zod-to-openapi` 9.1.0:** clean (MIT, +2 packages, no findings), but not needed.
  - **`@nestjs/swagger` 12.0.2:** **fails the dependency guard** (unreviewed install script). Rejected.
- **Refined recommendation (for approval):**
  - Zod 4 schemas in `packages/contracts`.
  - A small in-house NestJS validation pipe (strict objects; field-level errors as Problem Details).
  - OpenAPI 3.1 assembled in-house from the contracts, using Zod's native JSON Schema output, committed as `openapi/openapi.json`, with an "in sync" test.
  - **No new dependency beyond `zod`.**
- **Consequences:** Security: strict schemas block mass-assignment. Scientific: unit-bearing values are typed consistently. Operational: one place to change contracts.
- **Dependencies:** OD-01. **Resolve by:** Stage 4. **Status:** Approved 2026-10-17 (refined option A: Zod contracts, in-house validation and OpenAPI; no `@nestjs/swagger` or `nestjs-zod`) → ADR-022.

### OD-03 — Git repository and private remote strategy
- **Observed:** remote `origin` = `https://github.com/harrypgpt/PBE-New.git`; branch `main`. Visibility could **not** be verified (GitHub CLI not installed). `.gitignore` is deleted in the working tree (unstaged). Earlier code and docs are in history.
- **Options:** (A) keep this GitHub repository, confirm it is private, enable branch protection, secret scanning and 2FA; (B) create a new private repository and leave the old one archived; (C) local-only git until the SaaS stage.
- **Pros/cons:** A: + continuity, off-machine backup; − old history (superseded code) remains visible to collaborators. B: + clean history; − migration step. C: + no exposure; − no off-machine backup.
- **Recommendation:** A. The owner confirms visibility is **Private** on GitHub. The owner makes commits, one per passed stage, tagged `stage-NN-pass`. Stage 1 recreates `.gitignore`.
- **Consequences:** Security: a public repository would expose architecture and future code; it must be private. Operational: tags make rollback to a passed stage simple.
- **Dependencies:** none. **Resolve by:** Stage 1. **Status:** Approved with condition 2026-10-16, owner: "retain the existing GitHub repository. Do not push or change remote settings until repository privacy is confirmed." Privacy still unconfirmed → ADR-014.

### OD-04 — Test runner and frontend testing strategy
- **Options:** (A) Jest in all workspaces + React Testing Library + Playwright (E2E); (B) Vitest in all workspaces + RTL + Playwright; (C) Vitest for web and packages, Jest for the API.
- **Pros/cons:** A: + NestJS's default and documented path; Next.js supports it; − slower; ESM configuration can be awkward. B: + fast, modern ESM; − NestJS decorator metadata needs an SWC plugin, which is more set-up to keep working. C: − two runners to learn and maintain.
- **Recommendation:** A, the most conventional path for both frameworks. B is a valid alternative if Stage 1 shows Jest set-up problems.
- **Consequences:** Operational: one runner, one report format for completion reports.
- **Dependencies:** OD-01. **Resolve by:** Stage 1. **Status:** Approved 2026-10-16, owner: "Jest for unit testing and Playwright for required browser-level testing." → ADR-015.

### OD-05 — PostgreSQL local installation and supported version
- **Observed:** PostgreSQL 18.6 (EDB installer, `/Library/PostgreSQL/18`), accepting connections on `localhost:5432`; CLI tools not on PATH; pgAdmin 4 installed.
- **Options:** (A) PostgreSQL 18 as the supported major version; (B) standardise on 17 for wider managed-hosting availability; (C) a Docker-based PostgreSQL (Docker not installed).
- **Pros/cons:** A: + already installed and current; − the managed hosting chosen later must offer 18, to be checked. B: − needs a second install locally. C: − adds Docker for a non-coder.
- **Recommendation:** A. Supported major = 18 in all environments. Stage 2 documents how PBE scripts find the `bin` folder (configured path), so the owner's shell setup does not need changing.
- **Consequences:** Operational: one major version everywhere; upgrades via a planned migration.
- **Dependencies:** OD-14 (the host must support 18). **Resolve by:** Stage 2. **Status:** Approved 2026-10-16, owner: "OD-05: PostgreSQL major version 18." → ADR-017.

### OD-06 — SQL migration runner
- **Requirements:** [DATA_AND_DATABASE_DESIGN.md §7.3](DATA_AND_DATABASE_DESIGN.md#73-runner-requirements-whichever-tool-is-chosen-under-od-06).
- **Options:** (A) small in-house TypeScript runner on `pg` (ledger, SHA-256, advisory lock, per-file transaction, status command); (B) an established Node SQL-file runner (e.g. Postgrator or node-pg-migrate in SQL mode); (C) Flyway Community (JVM-based); (D) graphile-migrate; (E) dbmate (Go binary).
- **Pros/cons:** A: + exactly our rules, no extra runtime, fully covered by our own tests; − we own maintenance (a few hundred lines). B: + existing tool; − each must be verified for checksum rejection, locking and transaction behaviour; file-naming conventions differ. C: + mature, strong checksums; − requires a Java runtime. D: + SQL-first; − its development workflow is unusual and harder for a non-coder. E: + simple plain SQL; − separate binary; integrity checks need verifying.
- **Recommendation:** A, because the requirement set is small and must be proven by tests anyway. B is the fallback if A cannot pass the Stage 2 tests. Feature claims about third-party tools here are **not verified** and must be checked before choosing them.
- **Consequences:** Security: runner uses `pbe_migrator` only. Operational: one fewer external dependency; behaviour documented in our own code.
- **Dependencies:** OD-05. **Resolve by:** Stage 2. **Status:** Approved 2026-10-17, owner: "OD-06, Option A: Build a small in-house TypeScript SQL migration runner — Approved." → ADR-018. (Recorded as Open on 2026-10-16; Stage 2 was blocked until this approval.)

### OD-07 — Database access / data-access layer
- **Options:** (A) `pg` (node-postgres) only, hand-written SQL in repository functions, rows parsed with Zod; (B) `pg` + Kysely type-safe query builder, with TypeScript types generated by introspecting the already-migrated database; (C) Drizzle ORM for queries only (no Drizzle Kit); (D) Prisma Client without Migrate; (E) TypeORM without `synchronize`.
- **Pros/cons:** A: + simplest and most transparent; − no compile-time column checking. B: + compile-time checks catch wrong columns; SQL stays the schema source; easy raw-SQL escape; − one more library and a type-generation step. C: + good typing; − its schema-in-code model invites accidental use of Drizzle Kit (ADR-006 risk). D: − needs a parallel schema file, a heavy engine and the pull/introspect workflow; confusing next to ADR-006. E: − decorator entities duplicate the schema; `synchronize` risk.
- **Recommendation:** B, with A's patterns allowed for complex SQL. Tenant context is applied by a single transaction helper that every repository must use.
- **Consequences:** Security: one enforced transaction helper means RLS context is never skipped. Operational: types regenerate after each migration (a `verify` step checks they are current).
- **Dependencies:** OD-06. **Resolve by:** Stage 3. **Status:** Approved 2026-10-17, owner: "Approve Kysely with a dedicated data-access layer and generated TypeScript database types." → ADR-021. Type generation is in-house, because `kysely-codegen` adds high-severity audit findings (see ADR-021).

### OD-08 — Authentication and MFA strategy
- **Options:** (A) in-app authentication: Argon2id passwords, server-side sessions in PostgreSQL, TOTP MFA, OIDC SSO added later; (B) hosted identity provider (e.g. Auth0, Microsoft Entra ID, AWS Cognito); (C) self-hosted Keycloak.
- **Pros/cons:** A: + no external service or extra infrastructure; full control of tenancy mapping; − security-sensitive code that we own and must test well. B: + mature MFA and SSO; − vendor choice, cost, data residency, external dependency during local development. C: − extra infrastructure (ADR-008).
- **Recommendation:** A, using well-established libraries for hashing and TOTP (never custom cryptography), with an authentication interface that lets B or OIDC be added at the SaaS stage. An independent security review of this module before production (Stage 28).
- **Consequences:** Security: highest-risk module; needs dedicated tests and later an external review. Operational: no extra services.
- **Dependencies:** OD-07. **Resolve by:** Stage 6. **Status:** Approved 2026-10-17 (option A, with the owner-refined policy: passwords 15–128 characters) → ADR-026. Refined for Stage 6 (2026-10-17): security policy, library evidence and sub-decisions in [STAGE-06-PLAN.md §6, §9, §11](../stage-plans/STAGE-06-PLAN.md#11-decisions-needed-from-the-owner-before-implementation).

### OD-09 — First jurisdiction-specific rulesets
- **Options:** (A) a ruleset based on the internationally harmonised guideline for BE of IR solid oral dosage forms (the ICH M13 series; the reviewer must confirm the current adopted version and its status in each target region); (B) FDA guidance first; (C) EMA guideline first; (D) A plus one regional ruleset for the first customers' market.
- **Pros/cons:** A: + matches the IR oral solid scope; harmonised; − regional implementation details may differ. B/C: + concrete for that market; − narrower.
- **Recommendation:** D. Every parameter is entered by a qualified reviewer with a citation (document, version, section). Nothing is entered from memory.
- **Consequences:** Scientific: determines BE limits and design rules used by S3/S6/S7. Operational: ruleset versioning from day one.
- **Dependencies:** OD-10. **Resolve by:** Stage 12. **Status:** Open.

### OD-10 — Scientific reviewer and method approval
- **Decision:** Who reviews and approves methods, rulesets, readiness scoring and models, and how.
- **Options:** (A) a named external consultant (clinical pharmacology or biostatistics plus formulation science); (B) an in-house expert; (C) a review panel per domain.
- **Recommendation:** C as the goal, A as the minimum. The reviewer is independent of the person or agent who implemented the method. Approval is recorded in the registry with name, qualification summary, date, method version and evidence reviewed.
- **Consequences:** Scientific: without it no method can be approved, and outputs stay Grey or unavailable. This is the **critical-path non-software dependency**.
- **Dependencies:** none. **Resolve by:** Stage 12. **Status:** Open.

### OD-11 — Model acceptance criteria
- **Decision:** Metrics, thresholds, calibration requirements and subgroup checks that a candidate model must meet.
- **Options:** (A) criteria set by the reviewers before any training, fixed per model purpose; (B) criteria set after seeing the results (rejected: biased).
- **Recommendation:** A. No threshold values are proposed in MA-00.
- **Consequences:** Scientific: protects against overclaiming. Operational: blocks ML promotion until defined.
- **Dependencies:** OD-10, Stage 24 data. **Resolve by:** Stage 25. **Status:** Open.

### OD-12 — Retention, consent and legal review
- **Decision:** Legal and policy positions listed in [SECURITY_PRIVACY_AND_TENANCY.md §11](SECURITY_PRIVACY_AND_TENANCY.md#11-legal-and-regulatory-questions-for-qualified-review-od-12).
- **Options:** (A) engage qualified counsel in three steps: (a) before any real sponsor data is entered, (b) before training consent is offered, (c) before SaaS go-live; (B) one review before SaaS go-live only.
- **Recommendation:** A. Until (a) is resolved, only synthetic or fictional data is used.
- **Consequences:** Security and privacy: defines retention and deletion behaviour. Scientific: defines which data can train models.
- **Dependencies:** none. **Resolve by:** Stage 9 for (a), Stage 24 for (b), Stage 29 for (c). **Status:** Open.

### OD-13 — MVP scope
- **Options and recommendation:** see [../PRODUCT_SCOPE_AND_MVP.md §4](../PRODUCT_SCOPE_AND_MVP.md#4-proposed-mvp-od-13). Recommended: Stages 1–10 and 12–19 (no ML, no AI, no PDF/Word extraction).
- **Consequences:** Defines the first demonstrable product; C2, C4, C6 and C7 come after MVP.
- **Dependencies:** OD-10 (method availability). **Resolve by:** Stage 8. **Status:** **Approved** by the owner on 2026-10-18 (Stage 8 decision D8-1: "All of D8-1..D8-8 are approved"): Stages 1–10 and 12–19 → ADR-030. The remaining Stage 8 points (Tenant Administrator permissions, the identifier `tenant.allprojects.read`, schema profiles, no edit screen) were closed by the owner on the same day and are recorded in ADR-030 ("Decision closure").

### OD-14 — Deployment, hosting and backup strategy
- **Options:** (A) a major cloud (AWS, Azure or Google Cloud) with managed PostgreSQL, object storage and KMS; (B) a simpler platform-as-a-service with managed PostgreSQL; (C) self-managed servers.
- **Pros/cons:** A: + enterprise customers expect it; strong security tooling; − more configuration. B: + simple; − fewer compliance and residency options. C: − high operational burden.
- **Recommendation:** A, with the region chosen by first customers' data-residency needs. RPO/RTO targets set with the owner.
- **Dependencies:** OD-05, OD-12(c), OD-28. **Resolve by:** Stage 29. **Status:** Open.

### OD-15 — File storage
- **Options:** (A) a storage interface with a local folder in development and S3-compatible object storage in SaaS; (B) store files in PostgreSQL `bytea`; (C) local folder everywhere.
- **Recommendation:** A. B makes the database and backups large and slow. C cannot scale to several API instances.
- **Consequences:** Security: tenant-scoped keys, no public URLs. Operational: backups must cover both stores consistently.
- **Dependencies:** OD-14 (SaaS provider). **Resolve by:** Stage 10. **Status:** Open.

### OD-16 — Document extraction libraries
- **Options per format:** CSV (a streaming CSV parser), Excel (an `.xlsx` reader library), Word (a `.docx` text and table extractor), PDF (text-layer extraction). Scanned PDFs need OCR.
- **Recommendation:** choose one maintained, permissively licensed library per format at Stage 10 (CSV/Excel) and Stage 11 (PDF/Word), with licence and distribution checks. No OCR in the initial scope; scanned PDFs get a "manual entry needed" message.
- **Consequences:** Security: parsers handle untrusted files, so they run with size and time limits; macros are never executed.
- **Dependencies:** OD-15, OD-22. **Resolve by:** Stage 10 (CSV/Excel), Stage 11 (PDF/Word). **Status:** Open.

### OD-17 — Report generation
- **Options:** (A) HTML view plus a pure-JavaScript PDF generator; (B) headless browser (Chromium) HTML→PDF; (C) HTML only, printed by the user.
- **Pros/cons:** A: + no browser in production; − two templates (HTML and PDF). B: + one template; − heavy runtime dependency and attack surface. C: − not controlled enough for formal reports.
- **Recommendation:** A, decided after Stage 16 layout requirements are known.
- **Dependencies:** OD-27. **Resolve by:** Stage 16. **Status:** Open.

### OD-18 — Numerical and statistical routines in TypeScript
- **Need:** distribution functions (for example the t-distribution, and possibly noncentral t, for power calculations), and a seedable, versioned pseudo-random generator for simulation.
- **Options:** (A) minimal in-house implementations of only the needed functions, each with KATs from independent references; (B) a general JS statistics library; (C) a mix: library where it is verified, in-house where it is not.
- **Recommendation:** C. Whatever is chosen, every function used scientifically has KATs, and the PRNG algorithm and version are recorded in each run.
- **Consequences:** Scientific: numerical accuracy directly affects outputs; tolerances must be justified.
- **Dependencies:** OD-10. **Resolve by:** Stage 14. **Status:** Open.

### OD-19 — ML implementation approach (TypeScript)
- **Options:** (A) transparent models (e.g. regularised regression) implemented in TS with tests; (B) a JS ML library; (C) TensorFlow.js.
- **Recommendation:** decide only when Stage 24 shows what eligible data exists. Prefer A for interpretability and C1 attribution.
- **Dependencies:** OD-11, Stage 24. **Resolve by:** Stage 25. **Status:** Open.

### OD-20 — External AI provider and data processing
- **Options:** (A) no AI; (B) an external provider with a data-processing agreement, no-training terms, regional processing and tenant opt-in; (C) a self-hosted model (extra infrastructure).
- **Recommendation:** keep (A) until Stage 27, then decide between A and B. Never send sponsor-confidential data without an approved design.
- **Dependencies:** OD-12. **Resolve by:** Stage 27. **Status:** Open.

### OD-21 — Authoritative sources for Fetch Missing Information
- **Options:** public scientific databases, regulatory product information, licensed pharmacopeial or commercial sources.
- **Recommendation:** start with public, licence-compatible sources. Each source is approved individually with its terms of use, reliability notes and the fields it may populate. Queries send only public identifiers (e.g. a molecule name), never confidential formulation data.
- **Dependencies:** OD-10, OD-12. **Resolve by:** Stage 23. **Status:** Open.

### OD-22 — Background job execution
- **Options:** (A) in-house PostgreSQL job table with `FOR UPDATE SKIP LOCKED`; (B) a PostgreSQL-based job library; (C) Redis-based queue (excluded by ADR-008 without approval).
- **Pros/cons:** A: + schema in our SQL files (ADR-004), small; − we maintain it. B: + features; − some such libraries create and migrate their own tables automatically, which conflicts with ADR-004. This must be checked per library.
- **Recommendation:** A.
- **Dependencies:** OD-07. **Resolve by:** Stage 10. **Status:** Open.

### OD-23 — Readiness scoring method
- **Recommendation:** the structure in [SCIENTIFIC_AND_ML_GOVERNANCE.md §3](SCIENTIFIC_AND_ML_GOVERNANCE.md#3-prediction-readiness), with reviewer-approved weights per method. No percentage is shown before approval.
- **Dependencies:** OD-10. **Resolve by:** Stage 12. **Status:** Open.

### OD-24 — UI component and styling approach
- **Options:** (A) accessible headless primitives (e.g. Radix) with a single styling approach (CSS Modules or Tailwind); (B) a complete component library (e.g. MUI or Mantine); (C) hand-built components only.
- **Recommendation:** B for speed and built-in accessibility in form-heavy pages, **or** A if the owner wants a more distinctive design. Decided at Stage 5 with a short visual comparison.
- **Evidence (2026-10-17, Stage 5 preparation):** trial installs of Radix, MUI and Mantine in a disposable copy; all pass the guard with 0 high/critical findings. See [STAGE-05-PLAN.md §8](../stage-plans/STAGE-05-PLAN.md#8-dependency-findings-trial-install-in-a-disposable-copy).
- **Refined recommendation:** option A in its minimal form: native HTML + CSS Modules in Stage 5 (no UI package), individual Radix primitives added only when a stage needs a complex widget ([STAGE-05-PLAN.md §10](../stage-plans/STAGE-05-PLAN.md#10-decisions-needed-from-the-owner-before-implementation)).
- **Dependencies:** none. **Resolve by:** Stage 5. **Status:** Approved 2026-10-17, owner: "Standard web elements and reusable accessible components; no Mantine or full design library. Individual Radix components may be considered later when justified and approved." → ADR-024.

### OD-25 — Node.js version policy
- **Observed:** Node v24.21.0 and npm 11.19.0 installed.
- **Recommendation:** pin Node 24 (an LTS line) via `.nvmrc` and the `engines` field; check at `verify` time.
- **Resolve by:** Stage 1. **Status:** Approved 2026-10-16, owner: "pin Node.js 24 and document the exact supported version." Exact version 24.21.0 → ADR-016.

### OD-26 — Platform-owner access to tenant data
- **Options:** (A) no default access; break-glass grants that are time-limited, tenant-approved (or contract-defined emergency), and audited; (B) standing read access for support.
- **Recommendation:** A.
- **Consequences:** Security: strongest isolation and customer trust. Operational: support needs a defined procedure.
- **Dependencies:** OD-12. **Resolve by:** Stage 7. **Status:** Approved 2026-10-17, option A with a **one-hour maximum and no automatic renewal** → ADR-028. Detailed proposal for Stage 7 (tenant-admin approval, read-only, proposed 4-hour maximum, fully audited): [STAGE-07-PLAN.md §11](../stage-plans/STAGE-07-PLAN.md#11-decisions-needed-from-the-owner-before-implementation).

### OD-27 — Sponsor-facing vs owner-level report content
- **Recommendation:** two views. The sponsor view shows inputs, provenance, outputs, uncertainty, assumptions, method and ruleset names and versions, limitations and references. It hides proprietary model internals (weights, rule tuning). The owner-level view adds the full decision graph and internals. Limitations and assumptions are **never** hidden.
- **Dependencies:** OD-12, OD-17. **Resolve by:** Stage 16. **Status:** Open.

### OD-29 — NestJS major version and HTTP adapter (added 2026-10-17, Stage 4 preparation)
- **Decision:** which NestJS major version and HTTP adapter the API uses (ADR-002 fixes NestJS but not the version or adapter).
- **Evidence:** spikes in scratch copies of the project (2026-10-17). Not in the repository.

  | Option | Result |
  |---|---|
  | (A) NestJS **11.2.7** + **Express** adapter | Works under the **approved, unchanged** Jest set-up (DI, real HTTP request, Zod). 97 new packages; audit **0 high/critical**; guard pass; no install scripts. Express 5.2.1, multer 2.4.0. 11.2.7 was released on 2026-09-30, so it is maintained. |
  | (B) NestJS **12.1.3** (+ Express or Fastify) | Runs under plain Node 24. But NestJS 12 is **ES-module-only**: Jest cannot load it with our CommonJS set-up, the test-only transform fails on `import.meta`, and Jest's experimental ES-module mode failed too. Would need converting the API to ES modules on experimental Jest, or a test runner other than Jest (a change to ADR-015). Audit 0 high. |
  | (C) NestJS 11.2.7 + **Fastify** adapter | **Rejected:** it pins fastify 5.11.3, which has several **high** advisories (incl. GHSA-p68q-wchp-6fh7, an authentication bypass). The fix is only in fastify 5.12.5. |

- **Recommendation:** **A.**
  - It is the only option that is clean on security **and** testable with the approved tools today.
  - Track "one major version behind" as a risk; re-evaluate NestJS 12 each stage, and upgrade once Jest can run it without experimental flags or ADR-015 is revisited.
  - The `busboy` and `streamsearch` packages (no licence field in the lockfile) arrive through multer, used for uploads. PBE does not use uploads before Stage 10; they are checked again then.
- **Consequences:**
  - Security: no known high or critical findings at preparation time.
  - Operational: a later major upgrade is expected.
  - TypeScript: `experimentalDecorators` and `emitDecoratorMetadata` must be enabled for `apps/api` (verified in the spike).
- **Dependencies:** OD-02, ADR-015. **Resolve by:** Stage 4. **Status:** Approved 2026-10-17, option A (NestJS 11.2.7 + Express), with R-008 tracked and reassessed every stage → ADR-023.

### OD-30 — Next.js version and browser-to-API routing (added 2026-10-17, Stage 5 preparation)
- **Decision:** which Next.js version the web app uses (ADR-001 fixes Next.js but not the version), and how the browser reaches the API.
- **Options:** (A) same origin: the web server forwards `/api/v1/*` to the API, CORS closed; (B) the browser calls the API on its own port with a CORS allow-list; (C) Next.js server routes re-implement each API call.
- **Recommendation:** **A**, with Next.js **16.4.2** (latest stable at preparation; trial build and component test passed, 0 high/critical findings). It keeps one origin, a first-party session cookie in Stage 6 and no duplicated logic. Next.js support and advisories are reassessed every stage. Middleware is never used as a security boundary.
- **Dependencies:** ADR-001, ADR-022. **Resolve by:** Stage 5. **Status:** Approved 2026-10-17, option A with Next.js 16.4.2, conditional on verifying availability, Node.js compatibility, security status and dependency checks (stop and report if any fails; no silent substitution) → ADR-025.

### OD-31 — Runtime access to identity data (added 2026-10-17, Stage 6 preparation)
- **Decision:** how `pbe_app` reaches user accounts, password hashes, sessions and MFA secrets, which are platform-level (not tenant) data.
- **Options:** (A) narrow, reviewed functions owned by `pbe_owner` for the look-ups needed before sign-in (login by email, session by token hash), and RLS keyed on `app.user_id` for everything else; (B) direct table grants.
- **Recommendation:** **A**. `pbe_app` gets no bulk read of password hashes or MFA secrets. Follows DATA_AND_DATABASE_DESIGN.md §4.5 (security-definer functions that are reviewed, audited and few). See [STAGE-06-PLAN.md §11](../stage-plans/STAGE-06-PLAN.md#11-decisions-needed-from-the-owner-before-implementation).
- **Dependencies:** OD-08, ADR-021. **Resolve by:** Stage 6. **Status:** Approved 2026-10-17, option A → ADR-027.

### OD-28 — Encryption key management
- **Recommendation:** local: macOS FileVault (owner confirms). SaaS: a managed KMS, envelope encryption for stored files, documented rotation, no keys in code or `.env` committed.
- **Dependencies:** OD-14. **Resolve by:** Stage 28 (design), implemented in Stage 29. **Status:** Open.
