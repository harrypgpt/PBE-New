# PBE — Open Decisions Register

> **Status:** v0.2 (2026-10-13). v0.2 applies the owner's PBE-00.1 decisions (see the decision log); detailed option analyses are in §A–§C below the table.
> Nothing here has been silently assumed. Where a recommendation is given, it is a **proposal awaiting owner approval**.
> **Blocks** = the earliest roadmap stage that cannot start until the decision is made.
> When a decision is made, record: date, decision, decided by, and link the resulting ADR.

## Legend
- **Owner** = project owner decision. **Sci** = needs a qualified scientific/regulatory reviewer. **Legal** = needs legal/privacy advice. **Tech** = technical choice where the owner can accept the recommendation.

| ID | Decision needed | Options | Recommendation | Type | Blocks | Status |
|---|---|---|---|---|---|---|
| OD-001 | Monorepo tooling | npm workspaces · pnpm workspaces · Turborepo | **npm workspaces**: already installed, fewest tools | Tech | S1 | **Closed 2026-10-14**: npm workspaces approved by owner (PBE-01) |
| OD-002 | **Schema migration runner** (applies the SQL migrations; Prisma Migrate excluded by owner) | In-house TypeScript runner · node-pg-migrate (SQL files) · Graphile Migrate · Kysely Migrator · Drizzle Kit · TypeORM migrations. *Excluded:* Prisma Migrate (owner), Flyway/Liquibase (JVM), Sqitch (Perl), Alembic (Python) | **In-house minimal TypeScript runner** on `pg`. Fallback: **node-pg-migrate** in SQL-file mode. See §A | Tech | S2 | Open: recommendation awaiting approval |
| OD-003 | Request/response schema library | Zod shared schemas (via `packages/contracts`) · class-validator DTOs | **Zod** in `packages/contracts`, shared by web and API, with OpenAPI generation | Tech | S1 | **Closed 2026-10-14**: Zod approved by owner (PBE-01) |
| OD-004 | Local PostgreSQL installation and major version | Postgres.app · Homebrew · Docker Desktop; PG 15, 16 or 17 | **Postgres.app, PostgreSQL 17.** The minimum of **15** is confirmed by the design (`security_invoker` views) | Owner/Tech | S2 | Open (database engine itself **confirmed**: PostgreSQL only) |
| OD-005 | Language for statistical methods (L2) | ~~Python worker~~ · ~~R worker~~ · TypeScript in `science-core` | **TypeScript**. If a method can't be implemented and validated in TS, it is not offered (ADR-008) | Tech/Sci | S10 | **Closed 2026-10-13**: resolved by owner decision (ADR-022) |
| OD-006 | Reference sources for scientific test vectors | Published worked examples; named reference tools run by the reviewer **outside** PBE | Reviewer selects examples/tools; vectors stored as data files with tool, version, date and operator. These tools are **never** part of the PBE repo, CI or runtime (ADR-022) | Sci | S10 | Open |
| OD-007 | ML training approach (TypeScript only) | (a) In-PBE TypeScript training worker (`packages/ml-core`) for transparent model families · (b) TensorFlow.js pure-JS backend · ~~(c) external Python pipeline~~ (excluded) | **(a)**. Model family chosen once data volume and outcome labels are known (OD-020). See §C | Tech/Owner | S26 | Open |
| OD-008 | Model artifact and inference format (no Python) | (a) Versioned JSON model artifact evaluated by TypeScript · (b) ONNX via `onnxruntime-node` (prebuilt native; must pass the toolchain check) · ~~Python inference sidecar~~ (excluded) | **(a)**, matching OD-007(a); no new runtime. See §C | Tech | S27 | Open |
| OD-009 | Authentication approach | Built-in email/password + TOTP MFA · external IdP (OIDC/SAML) · both | **Built-in + MFA first**, SSO per tenant later | Owner | S3 | Open |
| OD-010 | Initial jurisdictions and their parameters (equivalence limits, CI level, dissolution-metric conditions, HVD/NTI handling) | e.g., US FDA, EMA, others | Owner selects jurisdictions; **Sci** reviewer enters each parameter with citation to the current guidance | Owner + Sci | S10 | Open |
| OD-011 | Study designs supported for *analysis* in v1, and order | 2×2×2 crossover · 3-period partial replicate · 4-period full replicate · parallel | **2×2×2 crossover first**; others stored-only until validated | Sci | S11 | Open |
| OD-012 | Allow-list and priority order for "Fetch Missing Information" sources | Regulatory labelling databases, pharmacopoeias, public product-assessment reports, etc. | Owner + Sci define list; check each source's **terms of use/licensing** before automated retrieval | Owner + Sci + Legal | S25 | Open |
| OD-013 | Consent details: granularity, duration, revocation effect on already-trained models, location of pseudonymised training extracts | Retrain/retire on revocation vs. exclude from future training only | Needs legal input; design supports both | Owner + Legal | S24 | Open |
| OD-014 | Retention periods per class (evidence, runs, audit, technical traces, temp uploads, IP logging) | — | Owner + Legal to set; system makes them configurable | Owner + Legal | S12 (temp uploads), S31 (all) | Open |
| OD-015 | Hosting provider, regions and secret manager | Any major cloud with regional hosting | Defer until local MVP is stable; choose with data-residency needs of first customers | Owner | S32 | Open |
| OD-016 | Compliance posture (GxP computerised-system validation, 21 CFR Part 11 / Annex 11 support, GDPR controller/processor roles, DPA templates) | — | Engage QA/regulatory and legal before the first real customer. **No compliance claims until assessed** | Owner + Legal | S31 | Open |
| OD-017 | Report generation technique | HTML → PDF via headless browser · PDF library | **HTML → PDF** for consistent branding; reconsider if headless browser is too heavy | Tech | S21 | Open |
| OD-018 | Branding: relationship with techypharma.com and rights to logos/colours | Inspired-by palette only · use of official assets with permission | **Inspired-by** unless rights confirmed in writing | Owner | S6 | Open |
| OD-019 | Wording of decision-support disclaimer and limitations text | — | Draft in SYSTEM_OVERVIEW §1.1; legal review | Owner + Legal | S21 (reports), S6 (UI placeholder) | Open |
| OD-020 | ML acceptance criteria (metrics, thresholds, subgroup checks, min test-set size) and leakage grouping key | — | Pre-register with Sci reviewer **before** any training | Owner + Sci | S26 | Open |
| OD-021 | Background job implementation | pg-boss · minimal in-house table | **pg-boss** (PostgreSQL-only, maintained) unless dependency review objects | Tech | S12 | Open |
| OD-022 | Ownership/licence of tenant data in shared training and of models derived from it | — | Contractual definition required | Owner + Legal | S24 | Open |
| OD-023 | Version control: initialise git and choose remote hosting (private) | Local git only · GitHub/GitLab private repo | **Initialise git in Stage 1**; private remote once chosen | Owner | S1 | **Closed 2026-10-14**: git initialised locally in Stage 1; private remote to be configured later (owner, PBE-01) |
| OD-024 | Who is the qualified scientific reviewer(s) signing off method specs, rulesets and model acceptance | Internal expert · external consultant | Must be named before S10 | Owner | S10 | Open |
| OD-025 | Key management provider; tenant-managed keys (BYOK) | Cloud KMS · HSM · BYOK later | Local dev key file now (no real data); cloud KMS at deployment; BYOK as enterprise option | Owner/Tech | S12 (dev), S32 (prod) | Open |
| OD-026 | Break-glass support access policy | Tenant-approved only · emergency with post-notification | Tenant approval by default; emergency path with mandatory notification | Owner + Legal | S5 | Open |
| OD-027 | Malware scanner for uploads | ClamAV local · cloud scanning service | **ClamAV** locally/self-hosted; cloud service later if needed | Tech | S12 | Open |
| OD-028 | Test runner | Jest (Nest default) · Vitest | **Jest** for API (Nest default), **Vitest** acceptable for packages; or Jest everywhere for simplicity | Tech | S1 | **Closed 2026-10-14**: Jest approved by owner for initial backend unit testing (PBE-01); Stage 1 uses Jest for all workspaces |
| OD-029 | Definition of the first usable release (MVP) | e.g., through S21 (deterministic + statistics + C1/C3/C4 + reports, no ML) | **MVP = through S23**, with no ML predictions; ML-based features in a later release after governance gates | Owner | S16 | Open |
| OD-030 | Mechanistic / PBPK modelling in scope for Digital Twin? | No · later validated module | **No** for initial scope | Owner + Sci | S22 | Open |
| OD-031 | Canonical units: dissolution time (min vs h), concentrations, AUC units | — | Sci reviewer to confirm canonical unit table | Sci | S9 | Open |
| OD-032 | Scanned-PDF support (OCR) | Not supported · local OCR · cloud OCR (data-processing implications) | **Not supported initially**; text-based PDFs only | Owner | S14 | Open |
| OD-033 | Role-assignment scoping depth for v1 | Tenant only · tenant + department · tenant + department + project | **Tenant + project** | Owner | S5 | Open |
| OD-034 | Whether any real sponsor data may be used in local/staging environments | Never · anonymised with approval | **Never** until production-readiness gate | Owner | S9 | Open |
| OD-035 | Subject-level PK data: accepted at all? if so, pseudonymisation rules | Summary-level only · pseudonymised subject-level | **Pseudonymised subject-level allowed**, with upload checks and legal review | Owner + Legal | S11 | Open |
| OD-036 | May a CRO tenant share historical studies across its client sponsors? | No · only with each sponsor's documented authorisation | **No** in v1 | Owner + Legal | S24 | Open |
| OD-037 | **Data-access layer** (how TypeScript code queries PostgreSQL; must not generate or apply schema) | Kysely (typed query builder) · Drizzle ORM (query API only) · plain `pg` + typed repositories · TypeORM · MikroORM · Prisma Client without Migrate | **Kysely**, with row types generated from the migrated database and a CI drift check. See §B | Tech | S2 | Open: recommendation awaiting approval |
| OD-038 | **Technical reviewer for SQL migrations and security-relevant code** (the owner is a non-coder) | Named internal engineer · external contractor · periodic external audit | Name a reviewer before S2. Until then, migrations may be prepared but **not** applied beyond local/test | Owner | S2 (apply beyond local) | Open |
| OD-039 | **NestJS major version.** NestJS 12 (released 2026-08) is ESM-only; Jest supports native ESM only experimentally | Stay on NestJS 11 (CommonJS, works with Jest) · move to NestJS 12 with ESM + experimental Jest ESM · move to NestJS 12 and switch test runner (reopens OD-028) | **Stay on NestJS 11.2.x for now**; revisit when Jest ESM support is stable or NestJS 11 support ends. Recorded in Stage 1 | Tech/Owner | — (review before S31) | Open: Stage 1 uses 11.2.7 pending approval |
| OD-040 | **evidence → science dependency points upward** (tier 3 → tier 4) in MODULE_BOUNDARIES.md §3 | (a) evidence calls `packages/science-core` directly for unit conversion (packages are not tiered), and the `science` module stays tier 4 · (b) move the `science` module to tier 1/2 · (c) keep as a documented exception | **(a)**: no layering exception needed. Until decided, `tooling/module-boundaries.json` encodes it as an explicit labelled exception | Owner/Tech | S8 | Open |
| OD-041 | **Development-only npm audit findings** without upstream fixes: `braces` ≤3.0.3 (high, DoS via nested glob patterns) and `sprintf-js` ≤1.1.3 (moderate, DoS via format precision), via ESLint's Next plugin and Jest. Production dependencies: 0 findings | Accept with waiver until fixed upstream · replace affected dev tools | **Waiver until Stage 3** (security tests start there); re-run `npm audit` at every stage gate | Owner | S3 | Open: waiver requested in STAGE-01 report |

## Decision log

| Date | ID | Decision | Decided by | ADR |
|---|---|---|---|---|
| 2026-10-13 | — | PostgreSQL is the only database | Owner (PBE-00.1) | ADR-021 |
| 2026-10-13 | OD-002 (constraint) | Prisma Migrate is not used | Owner (PBE-00.1) | ADR-021 |
| 2026-10-13 | OD-005 | No Python, Python services or Python dependencies; statistical methods in TypeScript | Owner (PBE-00.1) | ADR-022, ADR-008 |
| 2026-10-13 | — | Initial application stack stays Next.js, React, TypeScript, NestJS | Owner (PBE-00.1) | ADR-022 |
| 2026-10-13 | — | Database-level tenant isolation (RLS) preserved, proven by T-ISO-01 to T-ISO-14 | Owner (PBE-00.1) | ADR-004 |
| 2026-10-14 | OD-001 | npm workspaces | Owner (PBE-01) | ADR-002 |
| 2026-10-14 | OD-003 | Zod for shared request/response schemas | Owner (PBE-01) | — |
| 2026-10-14 | OD-023 | Initialise git locally; private remote later | Owner (PBE-01) | — |
| 2026-10-14 | OD-028 | Jest for initial backend unit testing | Owner (PBE-01) | — |

---

## §A — OD-002: schema migration runner (detailed analysis)

**Fixed requirements (from ADR-021 and DEPLOYMENT §4), whichever runner is chosen:**
- plain `.sql` files,
- strict ordering,
- checksum verification of applied files,
- an advisory lock,
- one transaction per file, with a declared non-transactional exception,
- `lock_timeout` and `statement_timeout`,
- refusal to run as the wrong role,
- a pre-flight check that a verified backup exists (staging/production),
- paired revert scripts that are never run automatically,
- a `schema_migrations` record with checksum and release,
- runs on Node.js with no Python, JVM or Perl.

| Option | Advantages | Disadvantages / risks | Fit |
|---|---|---|---|
| **1. In-house minimal runner** (TypeScript, built on `pg`, roughly a few hundred lines with tests) | Meets every requirement exactly; no extra dependency (brief rule 6); fully documented and testable (M1–M11); simple to explain to the owner | PBE owns its correctness; it needs its own tests and review (OD-038); not battle-tested by others | **Recommended** |
| **2. node-pg-migrate** (SQL-file mode) | Mature, PostgreSQL-specific, npm-native, uses a lock and a migrations table | PBE-specific needs (checksums, backup pre-flight, role refusal, paired revert scripts) still need wrapper code; feature details must be verified against the installed version in S2 before relying on them | **Fallback** |
| 3. Graphile Migrate | SQL-first; designed around forward-only migrations | Opinionated workflow (`current.sql`, shadow database); more concepts for a non-coding owner | Viable, not preferred |
| 4. Kysely Migrator | Built in if Kysely is chosen (OD-037) | Migrations written in TypeScript, not plain SQL, so less transparent for review; no checksums | Not preferred |
| 5. Drizzle Kit (`generate`/`migrate`) | Generates SQL from a TypeScript schema | Schema is defined in TypeScript, contrary to ADR-021; generators handle RLS, triggers and composite tenant keys only partly; risk of `push` bypassing review | Not recommended |
| 6. TypeORM migrations | NestJS integration | Entity-driven generation and the `synchronize` risk, contrary to ADR-021 | Not recommended |
| ✗ Prisma Migrate | — | Excluded by owner decision | Excluded |
| ✗ Flyway / Liquibase / Sqitch / Alembic | Mature tools | Need a JVM, Perl or Python, contrary to ADR-022 | Excluded |

## §B — OD-037: data-access layer (detailed analysis)

**Fixed requirements:**
- must never create or alter schema,
- must make it easy to run every request in a transaction that starts with `set_config('app.tenant_id', …, true)`,
- types must follow the SQL schema, not define it,
- uses the pure-JS `pg` driver,
- no Python or native build.

| Option | Advantages | Disadvantages / risks | Fit |
|---|---|---|---|
| **1. Kysely** (type-safe SQL query builder) | SQL stays visible and reviewable; strong TypeScript typing; small and pure TS; explicit transactions make the tenant context easy to centralise; types can be generated from the migrated database (e.g., `kysely-codegen`, a dev-only tool), keeping the database as the source of truth | Not a full ORM, so relations are written as joins; codegen adds a dev dependency (or types are maintained by hand, checked by a drift test) | **Recommended** |
| 2. Drizzle ORM (query API only, no Drizzle Kit migrations) | Typed, SQL-like API; popular | Schema is declared in TypeScript as well as in SQL, two sources of truth with drift risk; temptation to use Drizzle Kit | Viable, not preferred |
| 3. Plain `pg` + hand-written repositories (+ Zod row validation) | Fewest dependencies; maximum transparency | More boilerplate; manual typing; easier to make mistakes in dynamic filters and sorting | Viable fallback |
| 4. TypeORM | Long NestJS integration history | Decorator entities duplicate the schema; weaker type safety on queries; `synchronize` risk | Not recommended |
| 5. MikroORM | Full unit-of-work ORM | More concepts; its entity-manager behaviour must be carefully aligned with per-transaction tenant context | Not recommended for v1 |
| 6. Prisma Client without Prisma Migrate | Readable API; good documentation | A second schema file that must be re-introspected after each migration; ships a separate query-engine component; per-transaction tenant context is more involved; risk that someone runs Prisma Migrate anyway | Not recommended |

## §C — OD-007 / OD-008: ML without Python

- Training runs inside PBE's governed environment as a TypeScript worker. That keeps consent snapshots, grouped splits, leakage checks and reproducibility under the same controls (SCIENTIFIC §5).
- Transparent model families (e.g., penalised regression or small tree ensembles) are implementable and auditable in TypeScript. Which family to use is decided only once the eligible data and labels are known (OD-020). **No model performance is assumed.**
- The model artifact is a versioned JSON document (coefficients/structure, feature schema, applicability domain), hashed and stored in the model registry. Inference is plain TypeScript, so no new runtime is needed.
- If a needed method can't be implemented and validated in TypeScript, the capability waits (fails closed). It is not routed to Python. A future change needs a new ADR approved by the owner.

