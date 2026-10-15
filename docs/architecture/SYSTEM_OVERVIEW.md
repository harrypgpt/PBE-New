# PBE — System Overview

> **Status:** Architecture baseline v0.2 (2026-10-13). v0.2 applies the owner's technology decisions (PostgreSQL only, no Prisma Migrate, no Python). Nothing described here is built yet.
> **Audience:** Project owner, future engineers, reviewers.
> **Related:** [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) · [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md) · [OPEN_DECISIONS_REGISTER.md](OPEN_DECISIONS_REGISTER.md) · [../IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md)

---

## 1. What PBE is

**PBE (Predictive Bioequivalence Engine)** is a decision-support platform for pharmaceutical development teams. It brings together drug, formulation, dissolution, pharmacokinetic (PK), pilot BE and approved historical evidence. It then helps teams judge the **risk** of a future pivotal bioequivalence (BE) study and decide what to do next.

### 1.1 What PBE is not

- PBE **does not guarantee** BE success.
- PBE **does not replace** any study a regulator requires.
- PBE **does not** produce regulatory submissions or regulatory conclusions.
- PBE **does not** let any AI or large language model (LLM) decide scientific results (see §5).

Every prediction screen and report must show this statement in visible form, not hidden in a footer:

> *"PBE outputs are decision-support estimates with stated uncertainty and limitations. They do not establish bioequivalence and do not replace any required regulatory study."*

The final wording is open decision **OD-019**.

### 1.2 Initial scientific scope

| In scope (initial) | Out of initial prediction scope |
|---|---|
| Immediate-release (IR) oral solid dosage forms: tablets and capsules, including film-coated tablets | Modified/extended/delayed release, orally disintegrating, chewable, oral suspensions/solutions, sublingual/buccal, transdermal, inhalation, injectables, topical, ophthalmic, nasal, locally acting GI products, biologics, and any other form or route |

For out-of-scope products, users may **store and view** data. The applicability check (§4.3) must **block** any prediction, simulation or BE-probability output and say why. A scope can only be extended through a documented validation stage (see [SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md) §9).

---

## 2. Users and actors

| Actor | Description |
|---|---|
| **Platform Owner** | The PBE operator. Controls the historical-data learning dashboard, ML model promotion, platform configuration and the curated reference library. Has **no default access** to tenant scientific data (see [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) §4). |
| **Platform Operator / Support** | Technical staff. Can access technical traces and metadata. Access to tenant content requires a time-limited, audited break-glass grant. |
| **Tenant (Company)** | A sponsor organisation, such as a pharmaceutical company or CRO, that subscribes to PBE. It is the unit of data isolation. |
| **Tenant Administrator** | Manages the tenant's users, departments, roles and consent settings. |
| **Department** | A configurable group inside a tenant, such as Formulation R&D, Clinical Pharmacology, Regulatory Affairs or QA. |
| **Scientist / Analyst** | Enters and approves data, executes runs and reviews results. |
| **Reviewer / Approver** | Approves extracted data, external values and reports. |
| **Viewer / Auditor** | Read-only access, including audit-trail views where permitted. |

Roles are configurable. The names above are examples, not fixed roles. See [SECURITY_PRIVACY_AND_TENANCY.md](SECURITY_PRIVACY_AND_TENANCY.md) §3.

---

## 3. Core domain hierarchy

```
Tenant (Company)
 └── Project            e.g., "Generic Drug X 10 mg IR tablet"
      └── Scenario      e.g., "Formulation F3 vs RLD, fasting"
           └── Dataset Version   immutable, approved snapshot of evidence (v1, v2, …)
                └── Run          immutable, reproducible analysis/prediction on exactly one Dataset Version
```

- **Project:** groups all work for one development product.
- **Scenario:** one hypothesis or configuration, such as a candidate formulation, fed/fasting condition or study design, compared against a reference product.
- **Dataset Version:** a frozen, approved set of canonical evidence records with full provenance. Edits always create a **new** version and never change a frozen one.
- **Run:** a single execution of one or more versioned methods or models on one Dataset Version. Each Run has a unique ID and an immutable input snapshot. It records the exact method, ruleset and model versions used. Re-executing it must reproduce the same output (see [SCIENTIFIC_AND_ML_GOVERNANCE.md](SCIENTIFIC_AND_ML_GOVERNANCE.md) §6).

---

## 4. End-to-end flow

```
 ┌─────────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
 │ 1. Capture  │──▶│ 2. Extract & │──▶│ 3. Review &    │──▶│ 4. Freeze    │
 │ upload/entry│   │  normalize   │   │  approve       │   │ Dataset Ver. │
 └─────────────┘   └──────────────┘   └────────────────┘   └──────┬───────┘
        ▲                 ▲                                       │
        │      ┌──────────┴─────────┐                             ▼
        │      │ Fetch Missing Info │                    ┌────────────────┐
        │      │ (approval required)│                    │ 5. Readiness & │
        │      └────────────────────┘                    │ applicability  │
        │                                                └──────┬─────────┘
        │                                                       ▼
 ┌──────┴────────────┐  ┌────────────────┐            ┌────────────────────┐
 │ 8. Next Best      │◀─│ 7. Insights    │◀───────────│ 6. Run (immutable) │
 │ Experiment/Action │  │ (7 capabilities)│           │ deterministic +    │
 └───────────────────┘  └───────┬────────┘            │ statistical + ML   │
                                ▼                     └────────────────────┘
                        ┌────────────────┐
                        │ 9. Reports &   │
                        │ comparisons    │
                        └────────────────┘
```

### 4.1 Capture
Users enter data manually or upload files. Supported formats start with CSV and XLSX. PDF and DOCX follow later (see roadmap). Original files are kept unchanged, with a SHA-256 hash.

### 4.2 Extract, normalize, validate, approve
Deterministic parsers extract **raw values**. The raw values are kept, then normalized to canonical units and structures and validated. Nothing extracted is used in a run until a user with the required permission **approves** it.

### 4.3 Readiness and applicability
Before any prediction, PBE checks two things:
- **Readiness:** which required and recommended inputs are present, missing or of low quality. The result comes with missing-data guidance.
- **Applicability domain:** whether the product and evidence fall inside the validated scope of each requested method or model.

The result is one of three states: *Ready*, *Ready with limitations* or *Not supported*. Each comes with reasons.

### 4.4 Run
A run executes in layers that are kept clearly apart:
1. **Deterministic scientific calculations**, such as unit conversion, dissolution metrics and log-transformations.
2. **Statistical methods**, such as GMR and 90% CI from supplied data, ISCV, power and sample size.
3. **ML predictions**, but only from an *approved, production-promoted* model whose applicability domain covers the input.
4. **Capability engines** (the seven differentiators), which combine layers 1–3.

Optional AI assistance (Layer 5) is **never** part of a run's scientific output (§5).

### 4.5 Insights, next actions, reports
The seven differentiating capabilities ([MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md) §5) build on run outputs. Reports are generated from immutable runs and contain run IDs, version references, uncertainty and limitations.

---

## 5. Separation of computation layers

| Layer | Examples | Determinism | Governance |
|---|---|---|---|
| **L1 Deterministic science** | Unit conversion, dissolution similarity metrics, AUC by trapezoidal rule when raw concentration–time data is provided | Fully deterministic | Versioned method spec + regression test vectors |
| **L2 Statistics** | Log-scale GMR, 90% CI, ISCV derivation, TOST power, sample size | Deterministic; seeded RNG where simulation is used | Versioned method spec, cited source, validated against reference implementation outputs |
| **L3 ML prediction** | BE probability, Cmax/AUC ratio prediction, pilot-to-pivotal outcome models | Deterministic at inference for a fixed model artifact | Model registry, consent-gated training data, acceptance criteria, owner approval |
| **L4 Capability engines** | Risk fingerprint, sensitivity, virtual BE, optimization, next best action | Deterministic for fixed inputs + seed | Each capability has a method spec and acceptance criteria |
| **L5 Optional AI assistance** | Summarising text, suggesting field mappings for human review, drafting explanation prose | **Non-deterministic** | Disabled by default; never writes scientific values; every suggestion requires human approval; no sponsor data leaves PBE without an approved data-processing design |

---

## 6. Technology summary

| Concern | Choice | Notes |
|---|---|---|
| Architecture | **Modular monolith** | ADR-001 |
| Frontend | **Next.js + React + TypeScript** | `apps/web` |
| Backend | **NestJS + TypeScript** | `apps/api` |
| Database | **PostgreSQL only** (≥ 15; 17 recommended) | Row-Level Security for tenant isolation (ADR-004, ADR-021). No other datastore, including in tests |
| Schema changes | **Hand-written SQL migrations**, checksummed, with paired revert scripts; **no Prisma Migrate** | ADR-021; runner OD-002 (recommended: in-house TypeScript runner) |
| Data access | Typed query layer over the pure-JS `pg` driver; never generates schema | OD-037 (recommended: Kysely) |
| Languages / runtimes | **TypeScript on Node.js only**, plus PostgreSQL client tools. **No Python** (including no `node-gyp` native builds), R, JVM or Perl | ADR-022 |
| API | **Versioned REST** (`/api/v1/...`) with OpenAPI | [API_CONTRACT_STANDARDS.md](API_CONTRACT_STANDARDS.md) |
| Background work | PostgreSQL-backed job table | No Redis or queues (ADR-007) |
| File storage | Local encrypted filesystem in development; S3-compatible object storage later | Behind a storage interface (ADR-009) |
| AI provider | **None selected**; replaceable interface with a disabled "Null" provider by default | ADR-012 |
| Deployment | Local-first; future secure SaaS with regional data residency option | [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md) |

### 6.1 Proposed repository layout

```
PBE-New/
├── apps/
│   ├── api/                 NestJS modular monolith (all backend modules)
│   │   └── src/modules/     one folder per module (see MODULE_BOUNDARIES.md)
│   └── web/                 Next.js application (UI only, no business logic)
├── packages/
│   ├── contracts/           Shared API request/response schemas and types
│   ├── science-core/        Pure, I/O-free deterministic + statistical methods (L1/L2), TypeScript
│   ├── ml-core/             TypeScript model training/inference primitives (added at S26; OD-007)
│   └── ui/                  Shared design-system components (optional, Stage 6)
├── db/
│   ├── bootstrap/           One-time role creation script (run by an administrator)
│   ├── migrations/          Numbered plain-SQL migrations (incl. RLS, triggers, grants) + revert/ scripts
│   └── schema.sql           Committed schema snapshot for review and drift checks
├── docs/
│   ├── architecture/        This document set
│   ├── methods/             Scientific method specifications (one per method version)
│   ├── stage-reports/       Completion report per stage
│   └── IMPLEMENTATION_ROADMAP.md
├── scripts/                 Backup, restore, seed, verification scripts
└── tests/
    ├── e2e/                 End-to-end tests
    └── scientific-vectors/  Reference test vectors for scientific regression
```

This layout is a **proposal**. Stage 1 creates the application skeleton (OD-001, OD-003, OD-023, OD-028). Stage 2 creates `db/` (OD-002, OD-004, OD-037).

---

## 7. Visual identity

The UI must look clean, modern, responsive and professional, like enterprise pharmaceutical software, **inspired by** techypharma.com. Stage 6 needs a short design-token specification covering colour, typography, spacing and component states, and the owner must approve it. PBE must not copy logos, trademarks or proprietary assets unless the owner confirms the rights (OD-018).

Accessibility target: WCAG 2.2 AA as a design goal. This is not a compliance claim.

---

## 8. Quality attributes

| Attribute | Target |
|---|---|
| Scientific integrity | Traceable, versioned, reproducible; no fabricated values |
| Security | Tenant isolation enforced in **both** the application and the database |
| Maintainability | Small modules, documented contracts, a stage-gated roadmap the non-coding owner can follow |
| Reproducibility | Any production run can be re-executed to an identical output hash while its method versions are retained |
| Portability | Standard PostgreSQL, S3-compatible storage, containerisable; no cloud lock-in at the core |
| Auditability | Append-only audit trail per tenant, plus a separate technical trace for the owner |

---

## 9. Explicit non-goals for v1

- Microservices, message brokers, Redis, Kubernetes.
- Any database other than PostgreSQL; Prisma Migrate or any ORM-generated schema.
- Python (services, scripts or dependencies), R, JVM or Perl runtimes.
- Real-time collaboration.
- Automatic regulatory submission content.
- Any prediction for out-of-scope dosage forms.
- Any LLM-generated scientific number.
- Claims of GxP validation, 21 CFR Part 11, GDPR compliance or any certification. Controls are designed to *support* such assessments later (OD-016).
