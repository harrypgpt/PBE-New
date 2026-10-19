# Deployment and Migration

Status: Draft for product-owner review, MA-00, 2026-10-16. The hosting choice is OD-14; key management is OD-28.

## 1. Environments

| Environment | Purpose | Data | When |
|---|---|---|---|
| Local development | Owner and agent build in VS Code | Synthetic or fictional only, until OD-12 permits real data | Stage 1 |
| Local test | Automated tests | Created and destroyed by test runs | Stage 2 |
| Staging (SaaS) | Pre-production verification | Synthetic or anonymised only | Stage 29 |
| Production (SaaS) | Customers | Real tenant data | After Stage 29 PASS and owner go-live decision |

Each environment has its own database, credentials, file storage location and configuration. Nothing is shared.

## 2. Local setup (target state after Stages 1–5)
- Node.js: v24.21.0 is installed (observed during MA-00). The pinned version is confirmed under OD-25.
- npm: 11.19.0 is installed (observed).
- PostgreSQL 18.6, EDB installer, running on `localhost:5432` (observed). The command-line tools are not on PATH. The databases `pbe_dev` (development) and `pbe_test` (automated tests) (ADR-020), and roles from [DATA_AND_DATABASE_DESIGN.md §2](DATA_AND_DATABASE_DESIGN.md#2-schemas-and-roles) are created in Stage 2, after approval.
- Docker: not installed (observed). It is **not** required for local development under this plan.
- One command starts web and API. One command runs `verify`.

## 3. Configuration and secrets separation
- Code: git repository.
- Configuration: environment variables with a committed `.env.example` (placeholders only).
- Secrets: a local `.env` (git-ignored) in development; the platform secret store in SaaS.
- Environment-specific settings (URLs, limits, retention defaults) come from configuration, never from code branches like `if (production)` that change behaviour silently.

## 4. Path from local to SaaS (no rewrite)

| Concern | Local | SaaS (Stage 29) | Why no rewrite is needed |
|---|---|---|---|
| Web | `next dev` / `next start` | Same app built and hosted (OD-14) | Same code |
| API | `nest start` | Same app as a long-running process (at least two instances behind a load balancer) | Stateless API; sessions and jobs in PostgreSQL |
| Database | Local PostgreSQL 18 | Managed PostgreSQL, same major version | Same SQL migrations |
| Files | Local directory outside the repo (e.g. `~/pbe-data/files`) | Object storage behind the same storage interface (OD-15) | Storage interface from Stage 10 |
| Jobs | In-process PostgreSQL job worker | Same; optionally a separate worker process from the same codebase | `SKIP LOCKED` is safe with several workers |
| Tenants | Seeded test tenants | Real tenants created by the platform owner | RLS from Stage 3 |
| TLS | Not needed on localhost | Mandatory | Configuration |

**Data migration local → SaaS:** synthetic local data is **not** migrated. If the owner decides real evaluation data entered locally must move, a one-time export/import procedure is designed and tested in Stage 29. It uses `pg_dump` of tenant-scoped data plus a file checksum manifest, and verifies counts and hashes after import.

## 5. Migration operations and recovery

### 5.1 Normal deployment order
1. Take a backup (or confirm a recent point-in-time-recovery window), and verify it for contract-phase changes.
2. Run the migration runner `status`. Confirm that the pending files are the expected ones.
3. Run migrations with `pbe_migrator`.
4. Deploy the new API and web builds. The API checks the ledger version at start-up.
5. Run smoke tests.
6. Record the deployment in the deployment log.

### 5.2 Runbook: failed migration
1. The runner has stopped. The failing file's transaction has rolled back, and earlier files remain applied.
2. Do **not** edit the failed file if it was applied anywhere else. If it was applied nowhere, fix it and retry.
3. If partially applied in a non-transactional file, inspect the state and write a forward-fix migration.
4. Keep the old API version running. It remains compatible thanks to expand-first changes.
5. Record the incident.

### 5.3 Runbook: bad data change discovered later
Forward-fix migration, or a point-in-time restore into a **separate** database, followed by a targeted repair. Never restore over production without the owner's go-ahead.

### 5.4 Checksum mismatch detected
This means an applied file was modified. Restore the original file from git history, and put the intended change into a new numbered file.

## 6. Backup and restore
- Local: `pg_dump -Fc` with a verified restore test in Stage 2. Restore is repeated in Stage 28.
- SaaS: automated backups plus point-in-time recovery, encrypted and retained per OD-12 and OD-14. File storage uses versioning or backup. RPO and RTO targets are set under OD-14. A quarterly restore drill is proposed (frequency to be approved).
- A backup is considered good only after a successful restore test.

## 7. Production readiness checklist (Stage 29 gate)
TLS everywhere · managed secrets · MFA for admin roles · backups plus a tested restore · monitoring and alerts (uptime, errors, database health, job failures) · log retention without confidential values · incident response contacts · dependency audit clean or accepted · cross-tenant suite passing against staging · legal items from OD-12 closed or explicitly accepted by the owner.
