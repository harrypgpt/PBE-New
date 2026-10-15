# PBE — Testing and Acceptance Gates

> **Status:** Baseline v0.2 (2026-10-13). v0.2 adds the numbered tenant-isolation tests (§5), schema-change tests and toolchain checks (no Python, no Prisma Migrate). Every stage in [../IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md) must pass the gate described here before the next stage starts.

---

## 1. Golden rule

**A test is "passed" only if it was actually executed and its result was observed.** Stage reports must include the exact commands run and their real output summary, such as pass/fail counts. "Should pass", "expected to pass" or untested claims are reported as **NOT RUN**.

## 2. Test types

| Type | Scope | Tooling (proposed) | When |
|---|---|---|---|
| Static checks | Type-check, lint (incl. module import boundaries), format | `tsc`, ESLint, Prettier | Every stage |
| Toolchain policy | (1) No Python artifacts in the repo (`*.py`, `requirements*.txt`, `pyproject.toml`, `Pipfile`, `setup.py`). (2) No `prisma` package and no `prisma migrate` script. (3) Clean `npm ci` succeeds with no Python interpreter on `PATH`. (4) The lockfile is scanned for packages that build with `node-gyp`; any hit fails unless allow-listed with proof it installs from prebuilt binaries | Node.js check script + CI job | From Stage 1 |
| Unit | Pure functions, services with fakes | Jest or Vitest (choose in Stage 1) | Every stage with code |
| Scientific regression | `science-core` methods vs test vectors from cited sources / named reference implementations | Same runner, `tests/scientific-vectors/` | Every stage touching science; always in CI |
| Integration | API + real PostgreSQL (incl. RLS, migrations, triggers). **Always real PostgreSQL** of the target major version: no SQLite, no in-memory emulators, no mocked database for isolation or migration tests | Test DB, created/migrated per run | From Stage 2 |
| Tenant-isolation suite | Cross-tenant read/write/list/search/file/download/run/report attempts | Integration | From Stage 4; extended in every stage that adds tenant data |
| Authorization matrix | Every endpoint × role → expected allow/deny | Integration, generated from permission metadata | From Stage 5 |
| Contract | OpenAPI spec diff; request/response schema conformance | Generated spec + snapshot | From Stage 1 |
| End-to-end | Critical user journeys in a browser | Playwright (proposed) | From Stage 6 |
| Security | Dependency audit, secret scan, header checks, upload abuse cases, auth abuse (brute force, session fixation, CSRF), log-redaction tests | npm audit / scanners; custom tests | From Stage 3; full review in S31 |
| Reproducibility | Re-execute stored runs → identical output hash | Integration | From Stage 16 |
| Schema change | M1–M11 in [DEPLOYMENT_AND_MIGRATION.md](DEPLOYMENT_AND_MIGRATION.md) §4.5: fresh apply, upgrade apply, no-op re-run, checksum tamper, revert round-trip, drift, RLS coverage, role privileges, immutability, isolation suite, backup → restore | Node.js test scripts + `pg_dump`/`psql` | From Stage 2 |
| Accessibility (goal) | Automated a11y checks on key pages | axe (proposed) | From Stage 6 |

## 3. Standard stage gate (applies to every stage)

A stage **passes** only if all applicable items are true:

1. ☐ All stage acceptance criteria met, each with evidence (test name, screenshot or command output).
2. ☐ Type-check: 0 errors.
3. ☐ Lint: 0 errors (warnings listed).
4. ☐ All automated tests executed; 0 failures; skipped tests listed with reasons.
5. ☐ Tenant-isolation suite passes (from Stage 4).
6. ☐ Authorization matrix passes (from Stage 5).
7. ☐ Scientific regression vectors pass (when science exists).
8. ☐ Schema-change tests M1–M11 pass (from Stage 2; M7 and M10 from Stage 4), and the toolchain policy check passes: no Python, no Prisma Migrate (from Stage 1).
9. ☐ No secrets in repository (scan executed).
10. ☐ Docs updated: affected architecture docs, method specs, OpenAPI, decision register.
11. ☐ Stage completion report written to `docs/stage-reports/STAGE-XX.md`.
12. ☐ Owner reviewed the report and explicitly authorised the next stage.

**Fail** = any unchecked item without an owner-approved waiver. Waivers are recorded in the report with reason and expiry.

## 4. Stage completion report template

```markdown
# Stage XX — <name> — Completion Report
Date: YYYY-MM-DD   Result: PASS | FAIL | PASS WITH WAIVERS

## 1. Scope delivered
## 2. Files created / changed
## 3. Acceptance criteria — evidence
| # | Criterion | Evidence | Result |
## 4. Commands executed and actual results
(paste command + summary line, e.g., "Tests: 42 passed, 0 failed")
## 5. Tests not run / skipped (and why)
## 6. Known issues and risks
## 7. Decisions made / new open decisions
## 8. Waivers requested
## 9. Recommended next stage
```

## 5. Tenant-isolation tests

Tenant isolation is proven at **two levels**. The database level proves isolation holds even if application code is wrong. The API level proves the application never asks for another tenant's data. Every test runs against real PostgreSQL. Every new tenant-owned table or endpoint must be added to these suites in the same stage, and T-ISO-01 makes forgetting a table fail automatically.

### 5.1 Database-level tests (run as `pbe_app`, from Stage 4)

| ID | Test | Passes when |
|---|---|---|
| T-ISO-01 | **RLS coverage (catalogue)**: query `pg_class`/`pg_policies` for every table with a `tenant_id` column | Every such table has RLS **enabled and forced**, and a policy whose `USING` and `WITH CHECK` both reference `app.tenant_id`. Any new table without this fails the build |
| T-ISO-02 | **App role privileges** | `pbe_app` is not superuser, lacks `BYPASSRLS`, owns no tables, and cannot run DDL |
| T-ISO-03 | **No context = no data** | Without `app.tenant_id` set, SELECT on each tenant table returns 0 rows, and INSERT fails |
| T-ISO-04 | **Cross-tenant read** | With context = tenant A, selecting tenant B's rows by primary key returns 0 rows, for every tenant table |
| T-ISO-05 | **Cross-tenant write** | With context = A: UPDATE/DELETE targeting B's rows affect 0 rows; INSERT with `tenant_id = B` is rejected by `WITH CHECK`; UPDATE changing `tenant_id` from A to B is rejected |
| T-ISO-06 | **Cross-tenant references** | Inserting an A row whose foreign key points at a B parent fails (composite `(tenant_id, id)` FKs) |
| T-ISO-07 | **Pooled-connection leakage** | With a pool of size 1: a transaction for A, then a transaction with no context on the same connection, returns 0 rows. Context never carries over |
| T-ISO-08 | **Views and functions** | All views have `security_invoker = true`. `SECURITY DEFINER` functions match the reviewed allow-list exactly |
| T-ISO-09 | **Background jobs** | A job for A runs with A's context only and cannot read B's rows. A job without tenant context reads no tenant data |

### 5.2 API-level tests (from Stage 4, extended each stage)

| ID | Test | Passes when |
|---|---|---|
| T-ISO-10 | GET a resource of tenant A from a tenant B session | **404**, with no indication the resource exists |
| T-ISO-11 | List/search/filter as B | Never returns A's rows (fixtures seed both tenants with look-alike data) |
| T-ISO-12 | PATCH/DELETE/action endpoints (approve, freeze, run, reproduce, export) on A's resources from B | **404**, and a database check confirms nothing changed |
| T-ISO-13 | Request body or query containing A's `tenantId` from B's session | Ignored or rejected; never written. Data is created only under B |
| T-ISO-14 | File and report download across tenants, and owner endpoints with tenant roles | **404** for cross-tenant files/reports; **403** for owner endpoints |

The authorization matrix (§2) complements these: it checks *permissions within* a tenant, and T-ISO checks *isolation between* tenants.

## 6. Scientific regression rules

- Each test vector file states its **source**: a citation of a published example, **or** reference tool + version + date + the person who ran it. It also states the tolerance and why that tolerance is justified.
- Vectors without a recorded source are not allowed in the repository.
- Changing a vector requires a new method version (except fixing a documented transcription error, with reviewer sign-off).
- Out-of-domain inputs have tests asserting the method **refuses**, not that it returns a number.

## 7. Production-readiness gate (before any real sponsor data)

In addition to the stage gates: a security review and penetration test, completed backup/restore drill, incident-response procedure, data-processing terms, an owner-approved retention policy, and **scientific acceptance per SCIENTIFIC_AND_ML_GOVERNANCE §10** for any predictive feature enabled. Until then, PBE is labelled **"Not for use with confidential sponsor data / pre-production"**.
