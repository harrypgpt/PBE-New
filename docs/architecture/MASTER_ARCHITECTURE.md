# PBE — Master Architecture

| | |
|---|---|
| Document | MASTER_ARCHITECTURE.md (entry point for all architecture documents) |
| Produced by | MA-00 (Master Architecture, Product Blueprint and Engineering Contract) |
| Date | 2026-10-16 |
| Status | **Draft for product-owner review.** Nothing in this set is approved until the owner says so. |

## 1. Plain-language summary

PBE (Predictive Bioequivalence Engine) is decision-support software. Pharmaceutical teams use it to judge formulation and bioequivalence (BE) risk before they run a pivotal BE study. It never guarantees BE success and never replaces a required regulatory study.

PBE will be built as **one application** (a "modular monolith") with three parts:

1. **A website** (Next.js + React + TypeScript) that users work in.
2. **A server** (NestJS + TypeScript) that enforces security, stores data and runs scientific calculations.
3. **One PostgreSQL database.** It is the only place data lives permanently. Its structure is defined by hand-written, numbered SQL files.

All scientific work is written in TypeScript and split into separately testable modules. Machine learning (ML) and optional AI assistance are kept apart from deterministic science. They can never silently change scientific inputs or results.

Work proceeds in **29 small stages** (see [IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md)). Each stage ends with real test evidence, a written report and a PASS/FAIL decision. The owner must authorise every stage.

## 2. Document set and authority

If two documents disagree, the higher one in this list wins, and the conflict must be reported and fixed:

1. [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md): confirmed decisions (ADRs).
2. [OPEN_DECISIONS_REGISTER.md](OPEN_DECISIONS_REGISTER.md): unresolved decisions. A recommendation there is **not** approved.
3. This document.
4. The topic documents:
   - [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md): users, workflow, runtime components and main flows.
   - [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md): modules, interfaces and allowed dependencies.
   - [DATA_AND_DATABASE_DESIGN.md](DATA_AND_DATABASE_DESIGN.md): data model, tenancy in the database and SQL migrations.
   - [API_CONTRACT_STANDARDS.md](API_CONTRACT_STANDARDS.md): REST, validation, errors and logging standards.
   - [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md): security, privacy, consent and isolation.
   - [SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md): scientific methods, status rules, ML and AI governance.
   - [TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md): test strategy, gate rules and report template.
   - [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md): local-first path to SaaS, migrations in operation, backup and recovery.
   - [RISK_REGISTER.md](RISK_REGISTER.md): tracked risks, including production-blocking ones (added 2026-10-17).
5. [../PRODUCT_SCOPE_AND_MVP.md](../PRODUCT_SCOPE_AND_MVP.md): product scope, supported dosage forms and proposed MVP.
6. [../IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md): stages, gates and dependencies.

Earlier PBE documents and code exist only in git history (commits `7976b25`, `d4a3bb3`; removed in `d1ec8dd`). **They are not authoritative.** They may be consulted only if the owner asks for it.

## 3. Architecture at a glance

```
 Browser (pharma user)
      │  HTTPS
      ▼
 apps/web  ── Next.js / React / TypeScript (UI only; no direct DB access)
      │  versioned REST  /api/v1/...  (Zod-validated contracts from packages/contracts)
      ▼
 apps/api  ── NestJS modular monolith
      │   platform modules: identity · tenancy/access · audit · projects · datasets ·
      │                     ingestion · retrieval · readiness · runs · reporting ·
      │                     historical-data · consent · model-registry · ai-assist
      │   scientific core (pure TypeScript, packages/science-core):
      │        S1 validation/units · S2 deterministic · S3 statistics/study design ·
      │        S4 features/evidence quality · S5 predictive models · S6 simulation/sensitivity ·
      │        S7 risk/optimisation · S8 explanation  (S9 AI assistance lives in apps/api, isolated)
      ▼
 PostgreSQL (single authoritative store; row-level security; schema = db/migrations/*.sql)
      +
 File storage for uploaded originals (local folder in development, object storage later; OD-15)
```

## 4. Architectural principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Evidence before claims** | No output is shown as reliable unless it rests on a reviewed method or a validated model. Green status starts disabled. |
| P2 | **Provenance everywhere** | Every value records its origin: user-entered, extracted, retrieved, derived, predicted, simulated or assumption. It also keeps its source, unit and raw form. |
| P3 | **Immutability of what was decided** | Approved dataset versions and prediction runs never change. Corrections create new versions. |
| P4 | **Tenant isolation by default** | Tenant scoping is enforced in the application *and* in PostgreSQL row-level security (RLS). |
| P5 | **Deterministic science first** | Transparent calculations and rules come before ML. ML is optional, governed and never a prerequisite. |
| P6 | **AI is advisory and fenced** | Optional AI can suggest; a human must accept every suggestion through normal review. AI can never write approved data or results. |
| P7 | **Regulatory-neutral core, jurisdiction rulesets** | Thresholds and acceptance limits live in versioned, reviewed rulesets, not in code. |
| P8 | **Boring, few dependencies** | No Redis, queues, microservices or Kubernetes unless a documented need is approved. |
| P9 | **Small verifiable stages** | Each stage is testable on its own, reports real evidence and stops for approval. |
| P10 | **Honest success categories** | Build success ≠ test success ≠ security verification ≠ scientific verification ≠ model validation ≠ production readiness. |

## 5. Seven differentiating capabilities: summary map

Full detail is in [MODULE_BOUNDARIES.md §6](MODULE_BOUNDARIES.md#6-differentiating-capabilities-c1c7) and [SCIENTIFIC_AND_ML_GOVERNANCE.md §8](SCIENTIFIC_AND_ML_GOVERNANCE.md#8-differentiating-capabilities-scientific-guardrails).

| ID | Capability | Primary modules | First implementation stage | Can work without ML? |
|---|---|---|---|---|
| C1 | BE Risk Fingerprint | S4, S7, S8, rulesets | Stage 18 | Yes (approved rule-based drivers). ML attribution later (Stage 25+). |
| C2 | Reverse Engineering and Formulation Optimisation | S7, S6, rulesets | Stage 22 | Partly (constraint-based exploration only) |
| C3 | Virtual Pivotal BE / Digital Rehearsal | S6, S3, (S5) | Stage 19 | Yes (statistical simulation from reviewed assumptions) |
| C4 | Failure-Condition and Sensitivity Engine | S6, S7 | Stage 20 | Yes |
| C5 | BE and Formulation Digital Twin | datasets, runs, decision graph | Stages 9, 15, 17 | Yes (a versioned record, **not** a PBPK model) |
| C6 | Failure Learning and Pilot-to-Pivotal Learning | historical-data, consent, model-registry, S5 | Stages 24–26 | No. This capability is ML/statistical learning, gated by consent and validation. |
| C7 | Next Best Experiment / Next Best Action | S7, S8, readiness | Stage 21 | Yes (rule- and sensitivity-based) |

Having an interface for a capability does **not** mean the capability is scientifically validated.

## 6. Confirmed vs. proposed

- **Confirmed** (fixed by the owner in the MA-00 brief): see [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md): ADR-001 to ADR-012 (MA-00 brief) and ADR-013 to ADR-016 (approved 2026-10-16 for Stage 1).
- **Proposed by the architect, awaiting approval:** every entry still open in [OPEN_DECISIONS_REGISTER.md](OPEN_DECISIONS_REGISTER.md), the MVP boundary, and the stage order.

## 7. Glossary

| Term | Meaning in PBE |
|---|---|
| BE | Bioequivalence |
| GMR | Geometric mean ratio (test/reference) |
| ISCV | **Intra**-subject coefficient of variation. It is not inter-subject variability. |
| IR oral solid | Immediate-release oral solid dosage form (initial supported scope) |
| Tenant | One customer organisation (a sponsor). Its data is isolated from other tenants. |
| Platform owner | The PBE operator. This role is separate from, and does not automatically include, tenant administrator access. |
| Dataset version | An immutable, approved snapshot of evidence for one scenario |
| Prediction run | An immutable record of one execution of methods/models against one dataset version |
| Ruleset | A versioned, reviewed set of jurisdiction-specific or scientific rules and parameters |
| Method | A versioned scientific calculation with references, assumptions, applicability and known-answer tests |
| KAT | Known-answer test: a test comparing method output with an independently sourced reference result |
| RLS | PostgreSQL row-level security |
| OD-nn | An open decision in the register |
| ADR-nnn | A confirmed architecture decision |
