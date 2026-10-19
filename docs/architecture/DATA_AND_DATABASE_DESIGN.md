# Data and Database Design

Status: Draft for product-owner review, MA-00, 2026-10-16.
Confirmed constraints: ADR-003 (PostgreSQL only), ADR-004 (hand-written numbered SQL), ADR-006 (no ORM schema sync), ADR-012 (no participant-level data).
Open: OD-05 (PostgreSQL version), OD-06 (migration runner), OD-07 (data-access layer), OD-15 (file storage), OD-22 (job queue).

## 1. Observed local environment (inspected 2026-10-16, read-only)

- PostgreSQL **18.6** is installed with the EDB installer at `/Library/PostgreSQL/18`. It includes pgAdmin 4 and the `psql` app.
- The server reported `accepting connections` on `localhost:5432` (`pg_isready`).
- The PostgreSQL command-line tools are **not** on the shell `PATH`. Stage 2 must handle this, for example by documenting the full path or a PATH entry. That is a choice for the owner, not something to change silently.
- No PBE databases or roles were created or inspected during MA-00.

## 2. Schemas and roles

| PostgreSQL schema | Purpose |
|---|---|
| `pbe_meta` | Migration ledger and schema metadata |
| `app` | Tenant-scoped application data (RLS enforced) |
| `platform` | Platform-level data: tenants registry, platform users, methods, rulesets, models, consent policy versions |
| `training` | Consented, eligibility-reviewed training datasets (C6). Separated by grants, not mixed into `app`. |
| `audit` | Append-only audit events |

| Database role | Privileges | Used by |
|---|---|---|
| `pbe_owner` | Owns schemas and objects; `NOLOGIN` | Nobody directly |
| `pbe_migrator` | Member of `pbe_owner`; can run DDL | Migration runner only |
| `pbe_app` | DML on required tables only; **no** DDL, **not** owner, **no** `BYPASSRLS`, not superuser | API at runtime |
| `pbe_readonly` (later) | Read-only on chosen views | Support or reporting, if approved |

Owners of a table bypass RLS unless `FORCE ROW LEVEL SECURITY` is set. That is why the runtime role is never the owner, and tenant tables also use `FORCE`.

## 3. Core entities (logical model)

```
platform.tenant ─┬─< app.membership >── platform.user_account
                 ├─< app.department, app.role, app.role_permission
                 ├─< app.project ─< app.scenario ─< app.dataset_version ─< app.evidence_value
                 │                                        │                     │
                 │                                        │                     └─> app.evidence_source ─> app.stored_file
                 │                                        └─< app.prediction_run ─< app.run_output
                 │                                                     └─< app.graph_node / app.graph_edge
                 ├─< app.extraction_batch ─< app.extracted_value
                 ├─< app.retrieval_request ─< app.retrieved_value
                 ├─< app.report
                 ├─< app.tenant_consent ─> platform.consent_policy_version
                 └─< app.job
platform.method ─< platform.method_version (approval records)
platform.ruleset ─< platform.ruleset_version
platform.model ─< platform.model_version ─< platform.model_evaluation / platform.model_promotion
training.training_case (consented copies or references with eligibility review id)
audit.audit_event
```

### 3.1 Key tables (summary; columns are finalised in each stage's migration)

| Table | Essential columns and rules |
|---|---|
| `project` | `tenant_id`, `id`, molecule, strength (value + unit), dosage_form, route, release_type, dose metadata, `scope_status` (`supported` / `unsupported` with reason), status |
| `scenario` | `tenant_id`, `id`, `project_id`, code (`F001` …; unique per project), description |
| `dataset_version` | `tenant_id`, `id`, `scenario_id`, version_no, `state` (`draft`, `in_review`, `approved`, `superseded`), `content_hash` (SHA-256 of canonical content on approval), approved_by, approved_at. **Immutable once `approved`** (trigger-enforced). |
| `evidence_value` | `tenant_id`, `id`, `dataset_version_id`, section, field_key, `origin` (enum below), `raw_value` (text), `raw_unit`, `normalised_value` (`numeric`), `normalised_unit`, `conversion_id`, `source_id`, `review_state` (`pending_review`, `accepted`, `edited`, `rejected`), `uncertainty` (structured), `assumption_note` |
| `evidence_source` | `tenant_id`, `id`, kind (`file`, `external`, `user`, `calculation`), `stored_file_id`, location in file (page, sheet, cell), external citation (URL or identifier, retrieved_at, publisher) |
| `stored_file` | `tenant_id`, `id`, original filename, media type, size, `sha256`, storage key, uploaded_by, uploaded_at, retention class |
| `prediction_run` | `tenant_id`, `id`, `dataset_version_id`, `dataset_content_hash`, method versions (JSON list), `ruleset_version_id`, `model_version_id` (nullable), `seed`, `software_build`, `state` (`queued`, `running`, `completed`, `failed`), timestamps. **Immutable once `completed` or `failed`.** |
| `run_output` | `tenant_id`, `run_id`, output_key, value (structured JSON with units), status colour, warnings, assumptions |
| `graph_node` / `graph_edge` | `tenant_id`, `run_id`, node type (`evidence`, `transformation`, `calculation`, `prediction`, `simulation`, `decision`), refs. Append-only. |
| `audit_event` | `tenant_id` (nullable for platform events), actor, action, target, before/after digests, request id, timestamp. Append-only; no UPDATE or DELETE grants. |

### 3.2 Value-origin enumeration

`user_entered` · `extracted` · `retrieved` · `derived` · `predicted` · `simulated` · `assumption`

- `derived`, `predicted` and `simulated` values are produced by the system and always link to the run or method version that produced them.
- `assumption` values must carry a justification note and are highlighted in results and reports.
- Only `accepted` or `edited` values (after review) can appear in an approved dataset version.

### 3.3 Numbers and units

- `raw_value` is kept exactly as entered or extracted (text). It is never overwritten.
- `normalised_value` uses PostgreSQL `numeric` to avoid storage rounding. Computation uses IEEE double precision in TypeScript, and known-answer tests state their tolerances.
- Conversions come only from the approved unit-conversion registry (S1). An unknown unit means the value is not normalised and is flagged. It is never guessed.

## 4. Tenant isolation in the database

1. **Every tenant-owned table** has `tenant_id uuid NOT NULL`, primary key `(tenant_id, id)` or a unique constraint on `(tenant_id, id)`.
2. **Tenant-aware composite foreign keys:** child tables reference `(tenant_id, parent_id) → parent(tenant_id, id)`. This makes cross-tenant links impossible at the database level.
3. **RLS:** `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant table. The policy has the shape `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` with a matching `WITH CHECK`. The exact SQL is fixed and reviewed in Stage 3.
4. **Transaction-scoped context:** the API sets `app.tenant_id` and `app.user_id` with `SET LOCAL` (or `set_config(..., true)`) at the start of every transaction. Context never persists on a pooled connection. If no context is set, no rows are returned.
5. **Platform queries** that legitimately span tenants (for example, the platform-owner tenant list) use `platform` schema tables or dedicated security-definer functions that are reviewed, audited and few.
6. **Conformance test (from Stage 3):** a catalogue query fails the build if any table in `app` lacks a `tenant_id` column, RLS enabled, RLS forced or a tenant policy. The same applies to any foreign key between tenant tables that does not include `tenant_id`.

### 4.1 Data-access layer (ADR-021)
- All application queries go through `apps/api/src/modules/db/`, using Kysely on the `pg` driver and connecting as `pbe_app`.
- Tenant-scoped work runs only inside `withTenantTransaction(...)`, which sets `app.tenant_id` and `app.user_id` with `set_config(name, value, true)`. That is the transaction-local equivalent of `SET LOCAL`, and it accepts bind parameters.
- Database types are generated from a freshly migrated `pbe_test` and committed (`npm run db -- typegen`). `verify` checks they are current.

## 5. Versioning and immutability

| Object | Versioning | Immutability mechanism |
|---|---|---|
| Project, scenario | Editable metadata; changes audited | Audit log |
| Dataset version | New version per change set; `approved` versions frozen | Trigger rejects UPDATE/DELETE of approved versions and their evidence values; `content_hash` recorded |
| Prediction run | Each execution is a new row | Trigger rejects changes after completion; the hash of the inputs is stored |
| Method, ruleset, model versions | Semantic versions; approval records | Approved versions frozen; retirement is a status, never a deletion |
| Consent | Policy versions plus per-tenant decisions with timestamps | Append-only history |

**Reproducibility contract:** a completed run stores everything needed to recompute it: dataset content hash, method versions, ruleset version, model version, seed and software build. Stage 15 includes an automated "re-execute and compare" test.

## 6. Background jobs (OD-22 recommendation)

A `job` table processed by an in-process worker using `SELECT … FOR UPDATE SKIP LOCKED`. Each job has an idempotency key, attempt count, last error and tenant context. No Redis or broker (ADR-008).

## 7. Schema management and migrations

### 7.1 Files
- Location: `db/migrations/`
- Naming: `NNNN_short_description.sql` (four digits, gap-free, e.g. `0001_meta_and_roles.sql`).
- Each file starts with a header comment: purpose, stage, author, and whether it is *expand*, *migrate* or *contract*.
- Files are plain SQL, written by hand and reviewed. No generated DDL is committed without being read and edited as a hand-written file.

### 7.2 Ledger
`pbe_meta.schema_migration(version int PK, name text, checksum_sha256 text, applied_at timestamptz, applied_by text, execution_ms int, runner_version text)`.

### 7.3 Runner requirements (whichever tool is chosen under OD-06)

| Requirement | Behaviour |
|---|---|
| Ordering | Applies pending files in numeric order. A gap or duplicate number causes refusal. |
| Integrity | Recomputes SHA-256 of every **applied** file. Any mismatch or missing file causes refusal, with a clear message naming the file. |
| Concurrency | Holds a PostgreSQL advisory lock (`pg_advisory_lock` with a fixed PBE key) for the whole run. A second runner waits or exits. |
| Transactions | Each file runs in its own transaction, and the ledger row is inserted in the same transaction. Files that must not run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`) carry an explicit directive and must contain a single statement. |
| Failure | On error: roll back that file, stop, report the file and the error, and leave earlier files applied. |
| Status | A `status` command lists applied, pending and modified files without changing anything. |
| Drift check | CI/verify compares the schema of a database built from scratch with the target database (catalogue-based diff). |
| Environments | The runner uses `pbe_migrator` credentials only. The API never runs DDL at start-up; it only checks that the ledger is at the expected version and refuses to start otherwise. |

### 7.4 Change procedure (expand → migrate → contract)
1. **Expand:** add new nullable columns or tables or views. Old code still works.
2. **Migrate:** backfill in batches (a separate migration or job). Deploy code that uses the new structure.
3. **Contract:** after verification and backup, remove old structures in a later migration.

### 7.5 Recovery, forward-fix and rollback
- **Default is forward-fix:** a new migration corrects a problem. Applied files are never edited.
- **Local and test:** drop and recreate from migrations at any time.
- **Production rollback:** only when no data loss is possible. Otherwise restore from backup or forward-fix. Every contract-phase migration requires a verified backup taken immediately before it.
- **Failed migration in production:** the runner stops, the transaction rolls back, the API refuses to start against a ledger mismatch, the operator follows the runbook in [DEPLOYMENT_AND_MIGRATION.md §5](DEPLOYMENT_AND_MIGRATION.md#5-migration-operations-and-recovery).

### 7.6 Migration tests (from Stage 2)
- Fresh apply on an empty database succeeds.
- Re-running applies nothing.
- Modifying an applied file is detected and rejected.
- Concurrent runners do not double-apply.
- A failing file rolls back fully and leaves the ledger consistent.
- Schema drift check passes.

## 8. Backup and restore requirements

| Environment | Requirement |
|---|---|
| Local | `npm run db -- restore-drill` (ADR-020): `pg_dump -Fc` → decode the archive → restore into a temporary `pbe_restore_check_<hex>` database → compare schema, ledger, row counts and row contents → prove it is usable → drop only that temporary database. |
| SaaS | Managed automated backups plus point-in-time recovery. RPO and RTO targets are set under OD-14. Restore drills run at a scheduled frequency and are recorded. File storage is backed up consistently with database references. |

## 9. Explicitly excluded

No SQLite, no in-memory database fakes for database tests, no Prisma Migrate, no TypeORM `synchronize`, no Drizzle Kit `push`, no second database (ADR-003, ADR-006).
