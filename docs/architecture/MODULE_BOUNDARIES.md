# Module Boundaries

Status: Draft for product-owner review, MA-00, 2026-10-16. The repository layout depends on OD-01.

## 1. Proposed repository structure (recommendation, OD-01)

```
PBE-New/
├── apps/
│   ├── web/                     Next.js UI (ADR-001)
│   └── api/                     NestJS modular monolith (ADR-002, ADR-007)
│       └── src/modules/<module>/  one folder per platform module (§3)
├── packages/
│   ├── contracts/               Zod schemas, shared enums, API types (OD-02)
│   └── science-core/            pure TypeScript scientific modules S1–S8 (§4)
├── db/
│   ├── migrations/              0001_<name>.sql … hand-written, numbered (ADR-004)
│   └── tests/                   SQL-level tests (RLS conformance, constraints)
├── tooling/                     migration runner (if in-house, OD-06), guards, verify scripts
├── docs/
│   ├── architecture/            this document set
│   ├── stage-reports/           STAGE-NN.md completion reports
│   ├── IMPLEMENTATION_ROADMAP.md
│   └── PRODUCT_SCOPE_AND_MVP.md
└── package.json                 npm workspaces root
```

Rule: a new top-level folder or a new workspace package needs a documented reason in the stage report and owner approval.

## 2. Dependency direction

```
apps/web ──► packages/contracts
apps/api ──► packages/contracts
apps/api ──► packages/science-core
packages/science-core ──► (nothing in PBE; minimal reviewed third-party numeric libs only)
packages/contracts    ──► zod only
```

Forbidden:
- `science-core` importing from `apps/*`, `contracts`, database drivers, file system, network, clock or random APIs. Time and randomness are passed in as arguments.
- `apps/web` importing from `apps/api` or `science-core`. The UI never computes scientific results.
- Any module other than `ai-assist` importing an AI client library.

## 3. Platform modules (inside `apps/api`)

| Module | Owns (tables / concepts) | Main responsibilities | May call |
|---|---|---|---|
| `config` | — | Load and validate environment config (Zod) at start-up; fail fast | — |
| `db` | connection pool, transaction helper, generated DB types | Kysely access as `pbe_app` (ADR-021); tenant-context transactions; migrations status check. The only `apps/api` module allowed to import `kysely` or `pg`. | — |
| `identity` | users, credentials, sessions, MFA factors | Login, logout, session rotation, MFA | `audit` |
| `tenancy-access` | tenants, memberships, departments, roles, permissions | Tenant lifecycle, role/permission evaluation, guards | `audit` |
| `audit` | audit_event | Append-only audit write; audit search (Stage 28) | — |
| `projects` | projects, scenarios | Project/scenario CRUD, scope check, status | `audit`, `readiness` (read) |
| `datasets` | dataset_version, evidence_value, evidence_source | Draft editing, unit normalisation via S1, review, approval, locking, hashing | `audit`, `files`, S1 |
| `files` | stored_file | Store and retrieve originals by checksum; access control; export handling | `audit` |
| `jobs` | job | PostgreSQL job queue (OD-22), retries, idempotency | — |
| `ingestion` | extraction_batch, extracted_value | Parse CSV/Excel/PDF/Word; produce raw and candidate values for review | `files`, `jobs`, `datasets`, S1 |
| `retrieval` | retrieval_request, retrieved_value | Fetch missing information from approved sources | `jobs`, `datasets` |
| `science-registry` | method, method_version, ruleset, ruleset_version, unit_conversion | Register reviewed methods/rulesets; record approvals; expose applicability | `audit` |
| `readiness` | (computed; cached readiness_snapshot) | Readiness and applicability evaluation per method | S1, S4, `science-registry` |
| `runs` | prediction_run, run_output, graph_node, graph_edge | Create immutable runs, orchestrate S2–S8, record decision graph | science-core, `science-registry`, `model-registry`, `jobs` |
| `reporting` | report | Render results and downloadable reports (sponsor vs owner views) | `runs`, `files`, S8 |
| `consent` | consent_policy_version, tenant_consent | Versioned training consent; withdrawal | `audit` |
| `historical-data` | historical_study, eligibility_review, training_dataset | Authorised historical ingestion, de-duplication, eligibility | `consent`, `files`, `audit` |
| `model-registry` | model, model_version, model_evaluation, model_promotion | Candidate models, evaluation records, approval, promotion, rollback, monitoring | `historical-data`, S5, `audit` |
| `ai-assist` | ai_interaction | Optional AI suggestions behind an interface; disabled by default | `audit` only. It **cannot** call `datasets` write APIs or `runs`. |
| `platform-admin` | platform_user, break_glass_grant | Platform-owner functions separate from tenant admin | `tenancy-access`, `audit` |

Each module exposes a public `*.service.ts` interface. Other modules may use only that public interface. They must not use another module's repositories or tables. Cross-module writes go through the owning module.

## 4. Scientific modules (`packages/science-core`)

All scientific modules are **pure functions**: same inputs give the same outputs. Each module exports versioned methods. Each method declares an id, a version, inputs (with units), outputs, assumptions, applicability conditions, references and a known-answer test set ([SCIENTIFIC_AND_ML_GOVERNANCE.md §2](SCIENTIFIC_AND_ML_GOVERNANCE.md#2-scientific-method-lifecycle)).

| ID | Module | Responsibility | Depends on |
|---|---|---|---|
| S1 | `validation-units` | Field validation, unit registry, dimension checks, approved conversions, raw → normalised with traceability | — |
| S2 | `deterministic` | Reviewed deterministic calculations (e.g. dissolution profile comparison methods selected under OD-10) | S1 |
| S3 | `statistics` | Reviewed statistical methods: BE metrics from summary statistics, CI handling, ISCV handling, power and sample size, study-design variants | S1 |
| S4 | `features-evidence` | Derived features and evidence-quality scoring; readiness and applicability evaluation logic | S1, S2 |
| S5 | `predictive` | Inference with **approved** model versions only; applicability-domain checks; returns predictions with uncertainty and model id. Model training code lives here too, but runs only through `model-registry` workflows. | S1, S4 |
| S6 | `simulation` | Seeded, reproducible simulation (C3) and sensitivity analysis (C4) | S3, S5 (optional) |
| S7 | `risk-optimisation` | Risk-driver assessment (C1), failure-condition analysis (C4 with S6), candidate exploration (C2), next-best-experiment ranking (C7) | S4, S6, S5 (optional) |
| S8 | `explanation` | Builds structured explanations, limitation statements and report content models. **No free-text generation by AI.** | all above (read-only) |

S9, optional AI assistance, is the `ai-assist` module in `apps/api`. It is deliberately outside `science-core`.

### 4.1 Module interface shape (illustrative, not final code)

```ts
// Every scientific method follows this shape (finalised in Stage 12).
interface MethodDescriptor {
  id: string;                 // e.g. "S3.sample-size.2x2-crossover" (example id only)
  version: string;            // semver; any behaviour change = new version
  inputs: FieldSpec[];        // names, units, required/optional
  outputs: FieldSpec[];
  assumptions: string[];
  applicability: ApplicabilityRule[];
  references: ReferenceCitation[];
  reviewStatus: 'draft' | 'approved' | 'retired';   // stored in DB registry, not code
}
interface MethodResult<T> {
  value: T | null;
  status: 'ok' | 'not_applicable' | 'insufficient_data' | 'error';
  warnings: Warning[];
  assumptionsUsed: string[];
  trace: TraceStep[];         // feeds the decision graph
}
```

## 5. AI isolation rules (S9)

1. `ai-assist` receives explicit, minimal, approved input and returns **suggestions** only.
2. Suggestions are stored as `ai_interaction` records and presented to a human. Accepting one creates a normal user action with origin `user_entered`, or `extracted` with an AI-assist flag, and normal review rules apply.
3. `ai-assist` has no write permission on evidence, dataset versions, runs or results. This is enforced at module level and by a separate database role or grant set, decided in Stage 27.
4. Outputs of S1–S8 are never passed through AI before they are shown or reported.
5. Disabled by default per tenant. Enabling it requires tenant-admin consent and the approvals under OD-20.

## 6. Differentiating capabilities (C1–C7)

| Cap. | Architectural home | Data contract (input → output) | Dependencies | Test strategy | Stages |
|---|---|---|---|---|---|
| **C1 BE Risk Fingerprint** | S7 risk + S4 evidence quality + S8 explanation; risk rules in rulesets | Approved dataset version + readiness → list of drivers {factor, direction, evidence quality, uncertainty, contribution type (rule-based / model attribution), references}. No causal wording unless evidence is tagged causal. | S4, rulesets (Stage 12), runs (Stage 15) | KATs on reviewed example cases; tests that missing data never yields Red; wording tests for no causal claims | 18; ML attribution after 25 |
| **C2 Reverse Engineering & Optimisation** | S7 optimisation using S6 | Objective(s) + constraints + current scenario → ranked candidate *directions or ranges* with supporting evidence and confidence. Never an exact recipe without supporting evidence. | C4, C7, validated relationships (none assumed) | Constraint-satisfaction tests; tests that output is suppressed or limited when the evidence basis is insufficient | 22 |
| **C3 Virtual Pivotal BE** | S6 simulation using S3 (and S5 if an approved model exists) | Study design + reviewed assumptions (GMR, ISCV, n, dropout, limits from ruleset) + seed → distribution of endpoint-specific outcomes, simulated pass proportion **under stated assumptions**, uncertainty | S3 (Stage 14), runs | Seed reproducibility; comparison with analytical power where both exist; KATs | 19 |
| **C4 Failure-Condition & Sensitivity** | S6 sensitivity + S7 failure analysis | Base run + perturbation plan → sensitivity results, tipping points, "what could make this fail" list | C3 | Monotonicity and boundary tests; reproducibility | 20 |
| **C5 Digital Twin** | `datasets` (versioned evidence) + `runs` + decision graph + comparison views | Twin = versioned aggregate of drug, API, formulation, dissolution, PK summary, study design and scenarios. Explicitly **not** a PBPK model. | Stages 9, 15, 17 | Version immutability tests; graph completeness tests; comparison diff tests | 9, 15, 17 |
| **C6 Failure & Pilot-to-Pivotal Learning** | `historical-data` + `consent` + `model-registry` + S5 | Eligible consented cases (success / fail / borderline / reformulated, pilot ↔ pivotal pairs) → governed candidate models and learning reports | Consent (24), ML pipeline (25), outcome monitoring (26) | Leakage tests (group splits), consent-filter tests, reproducible training, acceptance-criteria gate | 24, 25, 26 |
| **C7 Next Best Experiment** | S7 ranking + readiness + S8 | Current readiness gaps + C1 drivers + C4 sensitivities → ranked suggested experiments or measurements, each with the expected uncertainty it addresses, rationale and limitations | C1, C4, readiness | Ranking-logic tests on fixtures; tests that every recommendation states its rationale and limitation | 21 |

## 7. Boundary enforcement

- Stage 1: lint rules (an ESLint import-restriction configuration, OD-01) that encode §2 and §3. Violations fail `verify`.
- Stage 1: dependency guard that rejects Python tooling, Prisma Migrate / schema-sync tools, SQLite and in-memory DB packages (ADR-003, ADR-005, ADR-006).
- Stage 3 onward: a database conformance test that every tenant-owned table has RLS enabled **and forced**, with a tenant policy ([DATA_AND_DATABASE_DESIGN.md §4](DATA_AND_DATABASE_DESIGN.md#4-tenant-isolation-in-the-database)).
- `science-core` purity check: a lint rule banning `fs`, `net`, `http`, `Date.now`, `Math.random`, and database or AI client imports.
