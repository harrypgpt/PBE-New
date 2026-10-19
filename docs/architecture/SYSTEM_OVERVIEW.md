# System Overview

Status: Draft for product-owner review, MA-00, 2026-10-16.

## 1. Who uses PBE

| Actor | Belongs to | Typical work |
|---|---|---|
| Project manager | Tenant | Creates projects, tracks status and pending tasks |
| R&D / formulation scientist | Tenant | Defines scenarios (F001, F002 …), enters formulation and dissolution evidence |
| QC analyst | Tenant | Provides COA and analytical evidence; reviews extracted values |
| QA | Tenant | Reviews approvals, audit trails and reports |
| Scientific reviewer (tenant) | Tenant | Approves dataset versions for scientific use; reviews results |
| Director | Tenant | Reads dashboards, comparisons and reports |
| Tenant administrator | Tenant | Manages users, departments, roles, consent settings for their tenant |
| PBE scientific reviewer | Platform | Reviews and approves scientific methods, rulesets and models (OD-10) |
| PBE platform owner | Platform | Operates the platform, manages tenants, models and rulesets. Has **no** default access to tenant confidential evidence (OD-26). |

Roles are configurable per tenant ([SECURITY_PRIVACY_AND_TENANCY.md §4](SECURITY_PRIVACY_AND_TENANCY.md#4-authorisation-roles-and-departments)).

## 2. Core workflow

```
Dashboard
   │
   ▼
Project  (molecule, strength, dosage form, route, dose …; scope check)
   │
   ▼
Scenario / Formulation  (F001, F002, F003 … alternative formulations or conditions)
   │
   ▼
Dataset Version  (draft → in review → approved [immutable] → superseded)
   │   evidence sections · uploads/extraction · fetch-missing · review & approve
   │   readiness + applicability shown continuously
   ▼
Prediction Run  (immutable; pinned method / ruleset / model versions; seeded)
   │
   ▼
Results and Report  (status, outputs, uncertainty, drivers, missing evidence, next actions,
                     comparison with other scenarios/runs, downloadable report)
```

UI conventions: each multi-step page has next/back navigation, a progress indicator, mandatory-field markers, contextual guidance and specific validation messages that say what to fix and why.

### 2.1 Dashboard
Shows the welcome message and user identity, projects with status, pending tasks (reviews awaiting the user, incomplete datasets), recent prediction runs, readiness, important warnings, and quick actions: *New project* and *Continue*.

### 2.2 Project creation
Fields are captured with controlled vocabularies where they exist: dosage form, route, release type, strength unit. The scope check runs immediately. A project outside IR oral solid scope can be saved as a record, but it is marked **Unsupported scope**. Prediction runs are blocked for it, and the reason is shown.

### 2.3 Evidence sections (per dataset version)
1. Drug and physicochemical properties
2. API characteristics
3. Formulation composition and process
4. Test and reference product details
5. Dissolution method and timepoint profiles
6. COA and formulation records
7. Optional pilot PK / BE summary statistics (summary level only, ADR-012)
8. Study design, fasting/fed status and sampling metadata

No section is entirely mandatory. The **minimum dataset** for each method is defined by approved method metadata (Stage 12). Readiness shows what is missing for which output.

### 2.4 Value origins
Every evidence value is tagged with one origin: `user_entered`, `extracted`, `retrieved`, `derived`, `predicted`, `simulated` or `assumption`. Extracted and retrieved values start as `pending_review` and must be reviewed by an authorised user before they can enter an approved dataset version.

## 3. Runtime components

| Component | Technology | Responsibility | Talks to |
|---|---|---|---|
| Web app (`apps/web`) | Next.js, React, TS | UI, forms, client-side validation using shared Zod schemas | API only |
| API (`apps/api`) | NestJS, TS | Authentication, authorisation, tenant context, business rules, orchestration, background jobs | PostgreSQL, file storage |
| Scientific core (`packages/science-core`) | Pure TS library | Units, deterministic calculations, statistics, simulation, risk logic. No I/O. | Nothing (called by API) |
| Contracts (`packages/contracts`) | TS + Zod | Request/response schemas and shared enums | Imported by web and API |
| PostgreSQL | v18 locally (OD-05) | All persistent data, RLS, sessions, job queue, audit | — |
| File storage | Local directory → object storage (OD-15) | Original uploaded files and generated report files | Accessed by API only |

There is no Redis, no message broker and no separate scientific service (ADR-007, ADR-008).

## 4. Key flows

### 4.1 Authenticated request
1. The browser sends a request with a session cookie to `/api/v1/...`.
2. The API validates the session and loads the user, their tenant memberships and their roles.
3. The guard checks the permission for the route and resource.
4. The API opens a database transaction and runs `SET LOCAL` for the tenant context and user id (see [DATA_AND_DATABASE_DESIGN.md §4](DATA_AND_DATABASE_DESIGN.md#4-tenant-isolation-in-the-database)).
5. Repository queries run under RLS. Writes that matter add audit rows in the same transaction.
6. The response is validated against its Zod schema and returned.

### 4.2 Ingestion
1. Upload: the original file is stored unchanged with its SHA-256 checksum, and metadata is stored in PostgreSQL.
2. A background job is queued in the PostgreSQL job table.
3. Extraction writes **raw extracted values** (raw text, raw unit, location in file) plus a parsed candidate value.
4. Normalisation proposes a normalised value and unit, using approved unit conversions only.
5. A reviewer accepts, edits (the edit is recorded) or rejects each value.
6. Accepted values join the draft dataset version with origin `extracted` and a link to the source.

### 4.3 Fetch Missing Information (Stage 23)
1. The user requests retrieval for specific missing fields.
2. The system queries approved, authoritative sources (OD-21). It sends **no** sponsor-confidential data to external services unless OD-20 and the data-processing approvals allow it.
3. Retrieved candidates are stored with source, URL/identifier, retrieval timestamp, retrieved text and stated uncertainty.
4. The user reviews, edits, approves or rejects each value. Nothing is added to an approved dataset silently.

### 4.4 Prediction run
1. The user selects an **approved** dataset version and the outputs wanted.
2. Readiness and applicability are evaluated. Blocking failures are shown and the run is refused or limited.
3. The run record is created **before** computation. It pins the dataset version hash, method versions, ruleset version, model version (if any), random seed, and software build id.
4. The scientific core computes outputs. Each step writes decision-graph nodes and edges.
5. The run is finalised as `completed` or `failed`. A completed run is immutable. Re-running creates a new run.
6. Results show the status colour, outputs, uncertainty, assumptions, applicability warnings, missing evidence, next actions and the mandatory limitation statement.

### 4.5 Scenario comparison
Two or more runs or dataset versions are compared. The comparison shows changed inputs (with origin), changed method or ruleset versions, and changed outputs. It flags comparisons that are not like-for-like, such as different ruleset versions.

## 5. Status system (summary)

| Colour | Meaning | Rule |
|---|---|---|
| Grey | Insufficient evidence or unsupported applicability | Default whenever readiness gates fail or the case is out of the applicability domain |
| Amber | Important limitations or elevated uncertainty | Triggered by approved ruleset conditions |
| Red | Scientifically justified high-risk condition | Only from approved rules with references. Missing data alone **never** produces Red. |
| Green | Supported by predefined, validated criteria | **Disabled** until validated criteria are approved (see [SCIENTIFIC_AND_ML_GOVERNANCE.md §4](SCIENTIFIC_AND_ML_GOVERNANCE.md#4-status-colours)) |
