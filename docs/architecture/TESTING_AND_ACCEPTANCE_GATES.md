# Testing and Acceptance Gates

Status: Draft for product-owner review, MA-00, 2026-10-16. The test runner choice is OD-04.

## 1. Seven kinds of success (never substitute one for another)

| # | Category | What proves it | What it does **not** prove |
|---|---|---|---|
| 1 | Documentation consistency | Cross-reference and ID checks pass; reviewer reads the documents | That the software works |
| 2 | Software build success | Type-check and build complete without errors | That behaviour is correct |
| 3 | Automated test success | Named test suites pass, with counts reported | Security, scientific correctness |
| 4 | Security verification | Security tests (cross-tenant, authz, injection, secrets, dependency audit); later an independent review | Scientific correctness; absence of all vulnerabilities |
| 5 | Scientific method verification | KATs pass **and** a qualified reviewer approves the method | That predictions are accurate |
| 6 | Predictive model validation | Predefined acceptance criteria met on an independent test set and approved | Production readiness; future performance |
| 7 | Production operational readiness | Deployment, monitoring, backup/restore drills, runbooks, security review | Scientific validity |

Every stage report states which categories were achieved, which were not, and why.

## 2. Test types

| Type | Scope | Environment | From stage |
|---|---|---|---|
| Static checks | Type-check, lint, boundary rules, dependency guard, secret scan | Local | 1 |
| Unit | Pure functions, services with fakes for **non-database** collaborators | Local | 1 |
| Database / migration | Migration runner behaviour, constraints, triggers, RLS | **Real PostgreSQL** (test database) | 2 |
| Integration | API + real PostgreSQL | Real PostgreSQL | 3–4 |
| Contract | Request/response Zod schemas, OpenAPI in sync | Local | 4 |
| Frontend component | React components | Local (jsdom) | 5 |
| End-to-end | Browser flows against running web + API + PostgreSQL | Local | 5 (smoke), 8+ |
| Security | Cross-tenant access, authorisation matrix, session handling, log redaction, upload handling | Real PostgreSQL | 3, 4, 6, 7 and every stage after |
| Scientific KAT / regression | Method outputs vs reference results with tolerances; frozen run re-execution | Local | 13+ |
| ML evaluation | Leakage, reproducibility, acceptance criteria | Local | 25+ |

**Database rule (ADR-003):** any test that involves SQL, transactions, constraints or RLS runs on real PostgreSQL. There are no SQLite, no pg-mem and no mocked query results for such tests. Under ADR-020 the tests run in `pbe_test`, which they rebuild from the migrations. They are never run against `pbe_dev`, which they only read inside `READ ONLY` transactions. Backup restores go into temporary `pbe_restore_check_<hex>` databases. Superuser and teardown tests run only on a private throw-away PostgreSQL instance.

## 3. Standing test suites that grow every stage
- **Cross-tenant suite:** for every tenant-owned resource, a user in tenant B cannot list, read, update, delete or reference tenant A's resource through the API, or directly under the `pbe_app` role with B's context.
- **RLS conformance:** a catalogue check that every tenant table has RLS enabled and forced, plus a policy and tenant-aware foreign keys.
- **Authorisation matrix:** roles × endpoints, with expected allow or deny.
- **Limitation-statement presence:** on every result view and report (from Stage 16).
- **Green-disabled test:** Green cannot be produced until validated criteria are approved (from Stage 15).
- **Scientific regression:** stored runs re-execute to identical outputs, within declared tolerances (from Stage 15).

## 4. The `verify` command
Stage 1 creates one command (e.g. `npm run verify`) that runs all available static checks and test suites and prints a summary. Every stage extends it. The completion report quotes its actual output.

## 5. Gate rules
1. A stage PASSES only if every acceptance criterion is met **and** evidence is attached: command, date, and the relevant output with counts.
2. If a test fails, the agent reports it, fixes it if the fix is safely within the stage's scope, reruns it, and reports both the failure and the rerun.
3. A failure outside scope, or one that needs a decision, is reported as FAIL or BLOCKED with options. The agent does not work around it silently.
4. Skipped or not-run checks are listed as **not executed**, with the reason. They never count as passed.
5. The agent never begins the next stage. The owner authorises each stage explicitly.
6. A PASS covers only the categories in §1 that the stage claims and evidences.
7. **Release gate (owner baseline, 2026-10-17):** no release (Stage 29 or any deployment beyond local development) proceeds unless the security suites for tenant boundaries, role permissions, authentication, session revocation and audit completeness pass in full. See [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md) F-9.

## 6. Completion report template (`docs/stage-reports/STAGE-NN.md`)

```markdown
# Stage NN — <title>: completion report
Date: YYYY-MM-DD   Authorised by owner on: YYYY-MM-DD   Agent/model: …

## 1. Plain-language summary (3–6 sentences for the owner)
## 2. Scope delivered vs planned (table: item | planned | delivered | notes)
## 3. Files created / changed / deleted (with one-line purpose each)
## 4. Dependencies added (name, version, purpose, licence, alternatives)
## 5. Database migrations added (file, checksum, expand/migrate/contract)
## 6. Checks executed (command | date/time | result | counts) — real output excerpts
## 7. Checks NOT executed and why
## 8. Acceptance criteria (criterion | evidence | met? yes/no)
## 9. Success categories achieved (see TESTING_AND_ACCEPTANCE_GATES.md §1)
## 10. Security and scientific implications
## 11. Problems found, fixes made, reruns
## 12. Open decisions affected (OD-nn: resolved / still open / new)
## 13. Rollback / recovery notes
## 14. Recommended verdict: PASS / FAIL / BLOCKED (final decision is the owner's)
## 15. Proposed next stage prompt (not to be started without authorisation)
```

## 7. Manual verification
When a stage changes visible behaviour, the report includes a short click-through script that the owner can follow (e.g. "open http://localhost:3000, log in as …, you should see …"), together with what was actually observed when the agent ran it, if it could run it.
