# PBE — Data and Database Design

> **Status:** Baseline v0.2 (2026-10-13), conceptual and logical design. Physical column types and indexes are finalised per stage in reviewed SQL migrations (ADR-021).
> **Engine:** PostgreSQL is the **only** database (ADR-021). Minimum major version 15 (required for `security_invoker` views); recommended 17 (OD-004).
> **Schema source of truth:** hand-written SQL migrations in `db/migrations/`. No Prisma Migrate and no ORM-generated schema. Migration runner: OD-002; data-access layer: OD-037.

---

## 1. Design principles

1. **Tenant column everywhere.** Every tenant-owned table has `tenant_id uuid NOT NULL` with RLS (ADR-004).
2. **Immutable once frozen.** Frozen Dataset Versions, their records and Runs are never updated or deleted by the application role (ADR-005).
3. **Raw kept beside canonical.** Original text, value and unit are stored next to canonical normalised values (ADR-020).
4. **Every scientific value has provenance** (ADR-011).
5. **Standard columns** on every mutable table: `id (uuidv7)`, `tenant_id`, `created_at`, `created_by`, `updated_at`, `updated_by`, `row_version` (optimistic locking). Immutable tables have `created_*` only.
6. **Time.** All timestamps are `timestamptz`, stored in UTC.
7. **Numbers.** Scientific values are stored as `numeric` (exact decimal), not floating point. Each value also records its *reported significant figures or decimals*, so the original precision is preserved.
8. **No secrets or keys in the database** other than wrapped (encrypted) data keys.

---

## 2. Entity overview

```
tenants ─┬─ departments
         ├─ memberships ── users
         ├─ role_assignments ── roles ── role_permissions ── permissions(platform)
         ├─ projects ── scenarios ── dataset_versions ─┬─ formulations ── formulation_components
         │                                             ├─ coa_results
         │                                             ├─ dissolution_profiles ── dissolution_points
         │                                             ├─ pk_studies ── pk_parameters / pk_concentration_points
         │                                             ├─ pilot_be_results
         │                                             ├─ study_designs
         │                                             └─ value_provenance
         │                       scenarios ── runs ─┬─ run_inputs (snapshot)
         │                                          ├─ run_outputs
         │                                          └─ run_artifacts (reports)
         ├─ drug_substances, reference_products
         ├─ stored_files ── raw_extractions ── field_mappings
         ├─ fetch_requests ── fetched_values
         ├─ historical_studies ── reuse_authorisations
         ├─ consent_grants ── consent_events
         └─ audit_events

platform (no tenant_id): permissions, method_registry, rulesets/ruleset_versions,
  platform_reference_library, external_source_registry, consent_policies,
  training_datasets*, dataset_splits*, model_versions, evaluations, promotion_decisions,
  technical_traces, jobs
  (*contain only pseudonymised references to consent-eligible tenant records, see §8)
```

---

## 3. Core structural entities

| Table | Key columns (beyond standard) | Notes |
|---|---|---|
| `tenants` | name, legal_name, region, status, data_residency_region, kek_ref | `kek_ref` points to the key in the KMS; it is never the key itself |
| `departments` | tenant_id, name, parent_department_id | Configurable hierarchy |
| `users` | email (citext, unique), display_name, status, mfa_required | A user can belong to several tenants |
| `memberships` | tenant_id, user_id, department_id, status | |
| `projects` | tenant_id, code, name, product_name, dosage_form, route, release_type, scope_status, owner_department_id, status | `scope_status` comes from applicability (IN_SCOPE / OUT_OF_SCOPE / UNDETERMINED) |
| `scenarios` | tenant_id, project_id, code, name, description, comparison_type, prandial_state (FASTING/FED/BOTH), jurisdiction_ruleset_id, status | |
| `dataset_versions` | tenant_id, scenario_id, version_no, status (DRAFT/IN_REVIEW/APPROVED/FROZEN/SUPERSEDED), parent_version_id, content_hash, frozen_at, frozen_by, change_reason | `version_no` is unique per scenario. Once FROZEN, immutable |

---

## 4. Canonical evidence records

All evidence tables have `tenant_id`, `dataset_version_id` and a link to `value_provenance` for each scientific value. Logical groups:

### 4.1 Drug and reference product
- `drug_substances`: INN/name, identifiers (e.g., UNII, CAS, where known), salt form, molecular weight, pKa values, solubility data (value, medium, pH, temperature), permeability information, BCS class **as reported, with source** (never auto-assigned without a defined, cited method), therapeutic-index flag (with source), known PK characteristics (with source).
- `reference_products`: product name, marketing authorisation holder, strength, dosage form, jurisdiction, lot information, labelling sources.

### 4.2 Test formulation and COA
- `formulations`: role (TEST / REFERENCE), strength, dosage form, release type, manufacturing process type, batch ID, batch size, manufacture date.
- `formulation_components`: component name, function (API, filler, binder, disintegrant, lubricant, …), amount per unit, unit, grade, supplier (optional).
- `coa_results`: test name, specification, result value, unit, method reference, batch link.

### 4.3 Dissolution
- `dissolution_profiles`: formulation_id, batch, apparatus, rotation speed, medium, pH, volume, temperature, surfactant, number of units, method reference.
- `dissolution_points`: profile_id, time (canonical h or min, OD-031), mean % dissolved, SD, CV%, n, individual unit values (optional, separate child table `dissolution_unit_values`).

### 4.4 Pharmacokinetics and pilot BE
- `study_designs`: design_type (see §4.5), number of periods, sequences, treatments, washout duration, prandial state, number of subjects (planned/dosed/completed/analysed), analyte (parent/metabolite), dose, sampling schedule (child table `sampling_timepoints`).
- `pk_parameters`: subject- or summary-level Cmax, AUC0–t, AUC0–∞, Tmax, t½, with unit, by treatment and period where available.
- `pk_concentration_points`: subject, period, treatment, time, concentration, BLQ flag. Optional; enables L1 derivation of NCA parameters only when that method is defined and validated.
- `pilot_be_results`: endpoint (Cmax, AUC0–t, AUC0–∞), point estimate (GMR), CI lower, CI upper, CI level (e.g., 90%), **ISCV (within-subject CV)** with source origin, inter-subject CV (stored **separately**), power, sample size, analysis method reference, statistical model description.

**Variability fields are never merged.** `iscv_within_subject`, `cv_inter_subject`, `cv_total` and `cv_wr_reference_scaled` (if applicable) are distinct columns. Each records how it was obtained: reported, derived from residual mean square error (with method version), or assumed.

### 4.5 Study design catalogue (`study_design_types`, platform table)
Each design type has: code (e.g., `2X2X2_CROSSOVER`, `3_PERIOD_PARTIAL_REPLICATE`, `PARALLEL`), description, **`analysis_supported` (bool)** and the method IDs that support it. A design can be *stored* without support. It can be *analysed* only when `analysis_supported = true`, which requires a validated method (OD-011).

---

## 5. Provenance and value origin

`value_provenance` (one row per scientific value, or per record when the whole record shares a source):

| Column | Meaning |
|---|---|
| `target_table`, `target_id`, `target_field` | Which value |
| `origin` | `USER_ENTERED` · `EXTRACTED` · `EXTERNAL_FETCHED` · `HISTORICAL_REUSED` · `DERIVED` · `PREDICTED` · `SIMULATED` · `ASSUMED` |
| `review_status` | `PENDING_REVIEW` · `APPROVED` · `REJECTED` · `SUPERSEDED` |
| `raw_text`, `raw_value`, `raw_unit` | Exactly what the source said |
| `source_file_id`, `source_locator` | e.g., page 4, table 2, row 3; or sheet "PK", cell C12 |
| `external_source_id`, `external_reference`, `retrieved_at` | For fetched values |
| `historical_study_id`, `reuse_authorisation_id` | For reused values |
| `derived_from` (array of provenance IDs), `method_ref` | For derived values, e.g., `units.convert@1.0.0` |
| `model_version_id` | For predicted values |
| `ai_assisted` (bool), `ai_provider_ref` | Whether L5 suggested the mapping (never the value itself) |
| `approved_by`, `approved_at`, `approval_comment` | Human approval |

**Rules**
- Only `APPROVED` values may enter a frozen Dataset Version.
- `PREDICTED` and `SIMULATED` values live in **run outputs**, never in evidence tables. This makes it impossible to treat a prediction as an observation.
- `ASSUMED` values (e.g., an assumed GMR for planning) are allowed only as **run parameters**, are always labelled, and appear in reports as assumptions.

---

## 6. Runs

| Table | Key columns |
|---|---|
| `runs` | tenant_id, code (`RUN-YYYY-NNNNNN`), scenario_id, dataset_version_id, dataset_content_hash, run_type, engine_id, engine_version, status, requested_by, requested_at, started_at, finished_at, seed (bigint), input_snapshot_hash, output_hash, parent_run_id (for re-execution/comparison), idempotency_key |
| `run_inputs` | run_id, snapshot (jsonb, canonical), parameters (jsonb), readiness_result (jsonb), applicability_result (jsonb) |
| `run_method_refs` | run_id, kind (METHOD/RULESET/MODEL/ENGINE), ref_id, version |
| `run_outputs` | run_id, output_schema_version, output (jsonb), warnings, limitations, uncertainty_summary |
| `run_artifacts` | run_id, artifact_type (REPORT_PDF, EXPORT_XLSX, …), stored_file_id, content_hash |
| `run_reproductions` | original_run_id, reproduction_run_id, output_hash_match (bool), checked_at |

**Immutability enforcement.** Triggers reject UPDATE/DELETE on `run_inputs`, `run_method_refs`, `run_outputs` and `run_artifacts`. On `runs`, only the status/timestamp columns may change, only along permitted forward transitions, and only while the run is non-terminal.

---

## 7. Files and ingestion

- `stored_files`: tenant_id, original_filename, detected_mime, declared_mime, size_bytes, sha256, storage_key, wrapped_data_key, encryption_alg, scan_status (PENDING/CLEAN/INFECTED/ERROR), uploaded_by, retention_class.
- `raw_extractions`: stored_file_id, extractor_id + version, locator, raw_text, raw_value, raw_unit, confidence (if the extractor provides one; never invented).
- `field_mappings`: raw_extraction_id → proposed target (table/field), proposed_by (RULE/USER/AI_SUGGESTION), status.

Supported formats are explicit, versioned, allow-listed. Initially CSV and XLSX; then PDF (text-based; scanned PDFs need OCR, OD-032) and DOCX. Anything else is rejected with a clear message.

---

## 8. Consent, historical data and ML tables

- `consent_policies` (platform): versioned consent text and scope definitions.
- `consent_grants` (tenant): tenant_id, policy_version, scope (e.g., which data categories, which projects or all), granted_by, granted_at, valid_until, status (ACTIVE/REVOKED/EXPIRED).
- `consent_events` (append-only): grant/revoke/expire history.
- `historical_studies` (tenant): a study registered for reuse, with outcome label (PASS/FAIL/BORDERLINE/REFORMULATED/UNKNOWN) and source evidence.
- `reuse_authorisations` (tenant): which historical study may be reused in which project, by whom, until when.
- `training_datasets` (platform): id, assembled_at, consent snapshot time, eligibility criteria version, row count, content hash, **pseudonymised record references** (no tenant names), feature schema version.
- `dataset_splits`: training_dataset_id, split (TRAIN/VALIDATION/TEST), grouping key type (e.g., drug substance + sponsor + product family), record references.
- `model_versions`: model family, version, training_dataset_id, code commit, hyperparameters, artifact hash, status (CANDIDATE/VALIDATED/APPROVED/PRODUCTION/RETIRED/REJECTED), applicability-domain definition.
- `evaluations`: model_version_id, split, pre-registered criteria version, metrics (as computed), pass/fail, report file.
- `promotion_decisions`: model_version_id, decision, decided_by (owner), rationale, decided_at.

Whether pseudonymised training extracts sit in the platform schema or in a separate restricted database/schema is open: **OD-013 / OD-022**.

---

## 9. Audit

- `audit_events` (tenant, append-only): tenant_id, actor_user_id, actor_type (USER/SYSTEM/BREAK_GLASS), action, resource_type, resource_id, before_hash/after_hash (or field-level diff where safe), reason, request_id, ip (hashed or truncated per OD-014), occurred_at. Each row stores the hash of the previous row (`prev_hash`), forming a per-tenant **hash chain** that makes tampering detectable.
- `technical_traces` (platform): request_id, route template (no IDs or values in free text), status code, duration, error code, tenant_id (for correlation only), **no request/response bodies**.

---

## 10. RLS pattern (illustrative)

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Composite key so children can only reference parents in the same tenant
ALTER TABLE projects ADD CONSTRAINT projects_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE scenarios ADD CONSTRAINT scenarios_project_fk
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id);

-- Views never bypass RLS
CREATE VIEW project_summaries WITH (security_invoker = true) AS SELECT ...;
```
- The application connects as `pbe_app` (no superuser, no `BYPASSRLS`, not the table owner).
- Migrations run as `pbe_migrator` (table owner), never used by the running app. Roles are created by the bootstrap script, not by migrations ([DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md) §4.1).
- If `app.tenant_id` is not set, queries return **no rows**. They do not return all rows. `NULLIF` handles the empty string a pooled session holds after an earlier `SET LOCAL` has ended, so the comparison becomes NULL (no rows) instead of a cast error.
- Tenant context is applied with `SET LOCAL` / `set_config('app.tenant_id', $1, true)` at the start of every transaction, by shared data-access infrastructure (OD-037), never by individual feature code.
- **Foreign-key checks are not filtered by RLS.** Composite `(tenant_id, …)` foreign keys are therefore mandatory between tenant-owned tables.
- **Views** must use `security_invoker = true`. **`SECURITY DEFINER`** functions need an allow-list entry.
- Proven by tests T-ISO-01 to T-ISO-14 ([TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md) §5).

---

## 11. Canonical serialization and hashing

The hashes in `content_hash`, `input_snapshot_hash` and `output_hash` use **one** canonical JSON form: sorted keys, numbers as decimal strings exactly as stored, UTF-8 encoding and no insignificant whitespace. Its spec is versioned (`canonical-json@1`). The algorithm is SHA-256.

---

## 12. Retention classes

Each file and record carries a `retention_class`, such as `EVIDENCE`, `RUN_RECORD`, `AUDIT`, `TECH_TRACE` or `TEMP_UPLOAD`. Periods are configuration, not code: **OD-014**.

---

## 13. Schema change management

All schema changes follow [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md) §4:
- plain, numbered, checksummed SQL migrations, each with a paired revert script,
- a reviewed checklist,
- safe application as `pbe_migrator` with an advisory lock and timeouts,
- tests M1–M11,
- the rollback options.

Application TypeScript row types are **derived from the migrated database** (by introspection or hand-maintained types checked against it, per OD-037), never the reverse.

