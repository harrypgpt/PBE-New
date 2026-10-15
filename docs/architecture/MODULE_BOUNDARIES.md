# PBE — Module Boundaries

> **Status:** Baseline v0.1. Defines every backend module, what it owns, what it may depend on, and how the seven differentiating capabilities map onto modules.

---

## 1. Boundary rules (apply to all modules)

1. **Ownership.** Each table belongs to exactly one module. Other modules never query another module's tables directly. They call its exported service interface.
2. **Layering.** Dependencies point **downward only** (§2). No cycles. Lint import rules enforce this from Stage 1.
3. **Tenant context.** Every module that owns tenant data receives the tenant context from the request or job, and never from client-supplied body fields. Modules access PostgreSQL only through the shared data-access layer (OD-037), which opens each transaction with the tenant context. Modules never create or alter schema; schema changes happen only through SQL migrations (ADR-021).
4. **Permissions.** Every exported operation declares its required permission. See [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) §3.
5. **Audit.** Every state-changing operation on tenant data emits an audit event through the `audit` module.
6. **No hidden science.** No scientific formula may be written outside `packages/science-core` (L1/L2), the `prediction` module (L3) or a registered capability engine (L4).
7. **Frontend has no business logic.** `apps/web` displays data and collects input. All validation rules that matter are enforced again in the API.

---

## 2. Layer diagram

```
 Tier 6  Presentation & output   reporting · owner-console · ai-assist (optional, L5)
                                          │
 Tier 5  Capability engines (L4) insights/* (risk-fingerprint, sensitivity, virtual-be,
                                 formulation-optimization, next-best-action) · digital-twin
                                          │
 Tier 4  Computation             runs · prediction (L3) · ml-governance · rules · science (L1/L2)
                                          │
 Tier 3  Evidence                evidence · ingestion · external-sources · historical-studies · consent
                                          │
 Tier 2  Domain structure        projects · reference-data
                                          │
 Tier 1  Platform                identity · tenancy · access-control · audit · files · jobs · config
```

A module may depend on any module in a **lower** tier. Dependencies within the same tier are allowed only when listed in §3.

---

## 3. Module catalogue

### Tier 1 — Platform

| Module | Owns | Responsibilities | Depends on |
|---|---|---|---|
| `config` | — | Typed configuration loading, secret references, feature flags | — |
| `identity` | users, credentials, sessions, mfa_factors | Sign-up by invitation, login, logout, password hashing, MFA, session management | config, audit |
| `tenancy` | tenants, departments, memberships | Company onboarding, departments, user↔tenant membership, tenant context middleware | identity, audit |
| `access-control` | roles, permissions, role_permissions, role_assignments | Permission catalogue, configurable roles, policy evaluation (`can(user, action, resource)`) | tenancy |
| `audit` | audit_events, technical_traces | Append-only tenant audit trail; owner technical trace | config |
| `files` | stored_files, file_access_log | Upload intake, MIME/type validation, hashing, encryption, malware-scan hook, download authorisation | access-control, audit |
| `jobs` | jobs | PostgreSQL job queue, worker loop, retries, idempotency keys | config |

### Tier 2 — Domain structure

| Module | Owns | Responsibilities | Depends on |
|---|---|---|---|
| `projects` | projects, scenarios | Project and Scenario lifecycle, membership, archival | Tier 1 |
| `reference-data` | drug_substances, reference_products, platform_reference_library | Drug and reference-product master data, plus an owner-curated library that tenants may copy from (never write to) | Tier 1 |

### Tier 3 — Evidence

| Module | Owns | Responsibilities | Depends on |
|---|---|---|---|
| `evidence` | dataset_versions, evidence records (formulation, COA, dissolution, PK, pilot BE, study design), value_provenance, approvals | Canonical evidence model, draft → review → approved → frozen lifecycle, provenance, unit normalisation calls | projects, reference-data, science (units only), Tier 1 |
| `ingestion` | extraction_jobs, raw_extractions, field_mappings | Parse CSV/XLSX → PDF/DOCX; store raw extracted values with location; propose mappings; hand drafts to `evidence` | files, evidence, jobs |
| `external-sources` | external_source_registry, fetch_requests, fetched_values | "Fetch Missing Information": allow-listed sources, prioritisation, retrieval record; results enter `evidence` only as drafts that need approval | evidence, jobs |
| `historical-studies` | historical_studies, reuse_authorisations | Sponsor-authorised historical study library; scoped reuse grants into projects | evidence, consent |
| `consent` | consent_policies, consent_grants, consent_events | Versioned, revocable training-consent records; eligibility queries | tenancy, audit |

*Same-tier dependencies allowed:* `ingestion → evidence`, `external-sources → evidence`, `historical-studies → evidence, consent`.

### Tier 4 — Computation

| Module | Owns | Responsibilities | Depends on |
|---|---|---|---|
| `science` | method_registry | Wraps `packages/science-core` (TypeScript); registers method IDs and versions; exposes methods to other modules | — (pure package) |
| `rules` | rulesets, ruleset_versions | Versioned readiness rules, applicability-domain rules, jurisdiction parameters (cited) | science |
| `runs` | runs, run_inputs, run_outputs, run_artifacts | Run creation, immutable input snapshot, orchestration via `jobs`, engine registry, reproducibility check | evidence, rules, science, prediction, jobs |
| `prediction` | inference_logs | L3 inference with **production-promoted** models only; applicability check per model | ml-governance (read-only model registry) |
| `ml-governance` | training_datasets, dataset_splits, model_versions, evaluations, promotion_decisions | Consent-gated dataset assembly, de-identification, leakage checks, TypeScript training via `packages/ml-core`, candidate evaluation, owner approval, promotion/rollback | consent, evidence (read via eligibility interface), science |

*Same-tier dependencies allowed:* `runs → rules, science, prediction`; `prediction → ml-governance`; `ml-governance → science`; `rules → science`.

### Tier 5 — Capability engines

| Module | Responsibilities | Depends on |
|---|---|---|
| `digital-twin` | Versioned composite view of drug + formulation + dissolution + PK + study design for a Scenario, tied to Dataset Versions and Runs; explicit validity limits | evidence, runs |
| `insights/risk-fingerprint` | C1 engine | runs, science, prediction, rules |
| `insights/formulation-optimization` | C2 engine | runs, prediction, rules, digital-twin |
| `insights/virtual-be` | C3 engine | runs, science, prediction |
| `insights/sensitivity` | C4 engine | runs, science, prediction |
| `insights/next-best-action` | C7 engine | runs, rules, insights/risk-fingerprint, insights/sensitivity |

C6 (Failure & Pilot-to-Pivotal Learning) lives in `ml-governance` (training) and `prediction` (inference), because it is a *model family*, not a separate runtime engine (§5).

### Tier 6 — Presentation and output

| Module | Responsibilities | Depends on |
|---|---|---|
| `reporting` | Prediction reports, scenario comparisons, exports (PDF/XLSX/CSV); every report references run IDs, versions and limitations | runs, digital-twin, insights/*, files |
| `owner-console` | Platform-owner dashboards: historical-data learning dashboard (aggregate, consent-eligible data only), model registry UI, platform health | ml-governance, consent, audit (technical trace) |
| `ai-assist` | Optional L5 assistance through the `AiAssistProvider` interface; disabled by default | config, audit |

---

## 4. Core cross-module flows

**Approve-and-freeze.** `ingestion` creates a draft → `evidence` validates it and normalises units (via `science`) → a reviewer approves → `evidence.freezeDatasetVersion()` computes the content hash and locks the version.

**Execute a run.** The API calls `runs.create({datasetVersionId, runType, parameters})` → `runs` asks `rules` for readiness and applicability → it snapshots the inputs and computes the hash → it enqueues a job → the worker resolves the `AnalysisEngine` for `runType` → the engine calls `science` / `prediction` → outputs are written once → an audit event is emitted.

**Train a model (owner).** `ml-governance` asks `consent` for eligible records as of time T → takes a de-identified extract → makes a grouped split → trains in a TypeScript worker (no Python; ADR-022, OD-007) → evaluates against pre-registered criteria → owner approval → promotion → `prediction` uses the new version for **new** runs only. Old runs keep their original model reference.

---

## 5. Seven differentiating capabilities — mapping

| # | Capability | Primary module(s) | Required inputs | Depends on (methods/modules) | Output stored as | Earliest stage | Can ship before ML? |
|---|---|---|---|---|---|---|---|
| **C1** | **BE Risk Fingerprint** | `insights/risk-fingerprint` | Frozen Dataset Version; readiness result | `rules` (risk-factor rules v1), `science` (dissolution metrics, variability), later `prediction` (model attributions) | Run output: ranked drivers, each with evidence link, direction, magnitude class and method of attribution | S18 | **Yes.** v1 is transparent rule- and evidence-based. Model-based attributions are added once a production model exists, labelled with their method |
| **C2** | **Reverse Engineering & Formulation Optimization** | `insights/formulation-optimization` | Digital twin; objective (e.g., target ratio range); constraints (excipient limits, process constraints); validated model | `prediction` (validated model with applicability domain), `rules` (constraint ruleset), `digital-twin` | Run output: candidate change sets, predicted effect with uncertainty, constraint satisfaction, applicability flags | S28 | **No.** Requires a validated predictive model linking formulation attributes to outcomes. Until then, only *manual what-if* via C4 is available |
| **C3** | **Virtual Pivotal BE / Digital Rehearsal** | `insights/virtual-be` | Assumed or estimated GMR, ISCV (with source), design, N, equivalence limits, α | `science` (TOST, seeded simulation), optionally `prediction` (GMR distribution) | Run output: simulated pass proportion, distribution summaries, seed, number of simulations, all assumptions | S19 | **Yes.** Statistical simulation from stated assumptions. ML-informed priors are added later |
| **C4** | **Failure-Condition & Sensitivity Engine** | `insights/sensitivity` | Base run; parameter ranges | `science` (power/sample size), `virtual-be`, later `prediction` | Run output: sensitivity table/curves, failure boundaries (e.g., GMR at which power < target) | S20 | **Yes** for statistical sensitivity. Model-input sensitivity is added after S27 |
| **C5** | **BE & Formulation Digital Twin** | `digital-twin` | Dataset Versions for a Scenario; Runs | `evidence`, `runs` | Twin version record linking evidence version + run outputs + declared validity limits | S22 | **Yes.** It is a versioned evidence-and-results representation, **not** a mechanistic PBPK model (out of scope unless separately validated, OD-030) |
| **C6** | **Failure Learning & Pilot-to-Pivotal Learning** | `ml-governance` + `prediction` | Consent-eligible historical studies incl. failed/borderline/reformulated; linked pilot→pivotal pairs | `consent`, `historical-studies`, leakage-safe grouped splits | Model versions with evaluation reports; at inference, predictions with model version reference | S26–S27 | **No.** Learning *is* ML. Before then, historical evidence can still be shown descriptively |
| **C7** | **Next Best Experiment / Next Best Action** | `insights/next-best-action` | Readiness gaps; risk fingerprint; sensitivity results | `rules` (action catalogue ruleset), C1, C4 | Run output: ranked recommendations, each with rationale, which uncertainty it targets and expected information value class | S23 | **Yes.** v1 is rule-based (missing evidence, high-sensitivity parameters). Quantitative value-of-information ranking is a later version |

### 5.1 Incremental-delivery guarantee

All seven capabilities share these elements:
- the same `Run` entity (with `runType` = `RISK_FINGERPRINT`, `FORMULATION_OPTIMIZATION`, `VIRTUAL_BE`, `SENSITIVITY`, `NEXT_BEST_ACTION`; the digital twin uses `TWIN_SNAPSHOT`),
- the same `AnalysisEngine` interface (ADR-018),
- the same input-snapshot, provenance and report pipeline.

So each capability can be added, versioned or replaced **without schema changes to the core**. A new engine adds only its own output-schema version and method specification.

### 5.2 Engine interface (conceptual)

```ts
interface AnalysisEngine<P, O> {
  runType: RunType;                       // e.g. 'VIRTUAL_BE'
  engineVersion: string;                  // semver
  requiredPermission: Permission;
  parameterSchema: Schema<P>;             // validated before snapshot
  outputSchema: Schema<O>;                // validated before write
  methodRefs(): MethodRef[];              // science/model versions used
  checkApplicability(input: Snapshot, p: P): ApplicabilityResult;
  execute(input: Snapshot, p: P, ctx: { seed: bigint }): Promise<O>;  // pure w.r.t. snapshot
}
```
