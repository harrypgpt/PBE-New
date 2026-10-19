# Risk Register

Status: living document. Created 2026-10-17 (Stage 2 approval). Every stage report must list the
risks it opened, changed or closed. A risk marked **production-blocking** must be resolved, and
its mitigation verified by tests, before Stage 29 (SaaS deployment readiness) can pass. Accepting
it for local development does not make it acceptable for production.

| Field | Meaning |
|---|---|
| Owner | Who decides (product owner) and who implements (coding agent) |
| Resolve by | The latest roadmap stage at which the mitigation must be implemented and tested |
| Status | Open / Mitigating / Closed (closing needs evidence in a stage report) |

## Summary

| ID | Risk | Severity | Production-blocking | Resolve by | Status |
|---|---|---|---|---|---|
| R-001 | Migration login can act as the database owner, so it could drop `pbe_dev` (or a production database) | High | **Yes** | Stage 28 | Open |
| R-002 | Test-only `pbe_restore_drill` can create databases with any name | Low | Yes (must not exist in production as is) | Stage 29 | Open |
| R-003 | Migration safety checks are lexical, not a full SQL parser | Medium | No (mitigated by review) | Stage 28 review | Open |
| R-004 | 20 moderate, dev-only audit findings not formally accepted | Low | No | Owner decision, any time | Open |
| R-005 | GitHub repository privacy unconfirmed | Medium | Yes (before any push) | Before first push | Open |
| R-006 | All test evidence so far is produced by the coding agent; nothing is independently verified | Medium | Yes (an external security review is planned in Stage 28) | Stage 28 | Open |
| R-008 | API framework is one major version behind (NestJS 11 while 12 exists) | Low–Medium | No, if 11 stays supported with no high/critical advisories; **Yes** otherwise | Reassessed every stage | Open |
| R-009 | Third-party licence review outstanding (LGPL, MPL, CC-BY and packages without a licence field) | Medium | **Yes** (until reviewed and approved before commercial release) | Before commercial release (Stage 29 at the latest) | Open |
| R-010 | MFA encryption key kept in the local `.env` file (development-only storage) | High | **Yes** (until an approved production key-management solution protects it, OD-28) | Stage 28/29 | Open |
| R-011 | No verified delivery channel for activation and reset tokens (development outbox only) | High | **Yes** (until an approved verified channel, e.g. an email provider, is implemented and tested) | Before any non-local use | Open |
| R-007 | PostgreSQL cannot stop the runtime role from setting its own tenant **or user** context; only the data-access gateway and lint rule prevent it | Medium | **Yes** (temporarily accepted for development only, 2026-10-17) | Stage 28 | Open |

---

### R-001 — Migration execution is not separated from database ownership

- **Recorded:** 2026-10-17. Found in the Stage 2.1 security review (STAGE-02.md §13.2, §14.6).
- **Description:**
  - `pbe_migrator` is a member of `pbe_owner` (INHERIT and SET), so that migrations create objects owned by `pbe_owner`.
  - `pbe_owner` also **owns the databases** `pbe_dev` and `pbe_test`.
  - PostgreSQL therefore lets the migration login run `DROP DATABASE pbe_dev` or `ALTER DATABASE …`.
- **Current safeguards (code only, not enforced by the server):**
  - No PBE command drops `pbe_dev`.
  - Migration files cannot contain `DROP/CREATE/ALTER DATABASE`; the runner rejects them before connecting.
  - `drop-disposable` refuses every name except `pbe_restore_check_<hex>`.
  - The password exists only in `.env` (permissions 600).
- **Impact if exploited or mistaken:** loss of a whole database, including in production if the same pattern were deployed.
- **Severity:** High. **Likelihood (local):** low.
- **Production-blocking:** **Yes.** Owner decision on 2026-10-17: "Track the risk and require mitigation before production; do not treat it as production-acceptable."
- **Proposed mitigation: separate database ownership from migration execution.**
  1. Create a new `NOLOGIN` role, `pbe_db_owner`, that owns the databases (`ALTER DATABASE … OWNER TO pbe_db_owner`, run by the administrator; this does not touch data). Neither `pbe_migrator` nor `pbe_owner` is a member of it.
  2. `pbe_owner` keeps owning schemas and objects. It receives `CREATE` (and `CONNECT`) **on the database**, so migrations can still create schemas.
  3. Result: `pbe_migrator` can still run migrations, but PostgreSQL refuses `DROP DATABASE` and `ALTER DATABASE` (`42501`).
  4. The `public` schema belongs to `pg_database_owner`, which then means `pbe_db_owner`. Its lock-down (`REVOKE ALL ON SCHEMA public FROM PUBLIC`, currently in migration 0001) must move into the administrator-run provisioning SQL for new environments, and be checked by a conformance test. Already-migrated databases keep their applied state; applied migration files are never edited (ADR-004).
  5. In SaaS (OD-14): the managed database owner, the migration role and the runtime role are three separate identities. Database-level operations go through a break-glass procedure.
- **Verification required to close:**
  - Tests showing `pbe_migrator` gets `42501` on `DROP DATABASE` and `ALTER DATABASE` for `pbe_dev` and `pbe_test`.
  - All migrations still apply from empty in `pbe_test`.
  - Drift checks still pass.
  - Superuser-free bootstrap tested first on the throw-away server.
- **Owner:** product owner (approves the ownership change); coding agent (implements and tests).
- **Resolve by:** **Stage 28** (security hardening), at the latest. It may be scheduled earlier, as a small dedicated stage, whenever the owner wishes. It must be closed before Stage 29.
- **Status:** Open.

### R-002 — Test-only restore role can create databases

- **Description:** `pbe_restore_drill` has `CREATEDB`. PostgreSQL limits it to dropping only databases it owns, and it cannot connect to `pbe_dev` (tested). But it can create databases with any name (resource use only).
- **Mitigation:** local/test use only; password only in `.env`; 5-connection limit. In SaaS, restore drills run in a separate, isolated environment (OD-14), and this role must not exist on production servers.
- **Resolve by:** Stage 29. **Owner:** product owner / coding agent. **Status:** Open.

### R-003 — Lexical migration safety checks

- **Description:** the runner's checks on migration files do not parse SQL fully. Statements inside `DO $$ … $$` or function bodies are not inspected.
- **Mitigation:** every migration is reviewed; reviewers must read dollar-quoted bodies. Stage 28 reviews whether stronger checks are needed.
- **Resolve by:** Stage 28 review. **Status:** Open.

### R-004 — Moderate audit findings not formally accepted

- **Description:** 20 moderate findings (GHSA-hp3w-g68c-fv3c, `sprintf-js` through Jest's coverage tooling). Dev-only, no fix available. There are 0 high and 0 critical; the `verify` gate fails on high.
- **Resolve by:** owner acceptance, or a later Jest release that removes the chain. **Status:** Open.

### R-005 — Repository privacy unconfirmed

- **Description:** GitHub visibility of `harrypgpt/PBE-New` has not been confirmed (ADR-014). Nothing has been pushed.
- **Resolve by:** before any push. **Owner:** product owner. **Status:** Open.

### R-007 — Tenant context can be set by any code running as pbe_app

- **Widened 2026-10-17 (Stage 6 authorisation):** the same weakness applies to `app.user_id` (user-context impersonation). Any SQL running as `pbe_app` could set it. Stage 6 does not use `app.user_id` for authorisation (identity functions take explicit keys, ADR-027), but later RLS policies that use it inherit this risk. The exit criteria are unchanged: mitigation by signed context or per-tenant logins, implemented and tested against real PostgreSQL.

- **Recorded:** 2026-10-17. Found in Stage 3, and proven by the test `LIMITATION (documented, R-007)` in `db/tests/tenancy.db.spec.ts`.
- **Description:**
  - Row-level security trusts `app.tenant_id`, which the data-access layer sets per transaction.
  - PostgreSQL custom settings cannot be restricted per role. Any SQL running as `pbe_app` could call `set_config('app.tenant_id', …)` and then read that tenant's rows.
  - The database therefore cannot tell the approved path (`withTenantTransaction`) apart from an unapproved one.
- **Current safeguards (tested):**
  - Only `apps/api/src/modules/db` may import `kysely` or `pg`, or contain `set_config` or `app.tenant_id`. This is an ESLint rule, with failing fixtures in `lint-boundaries.test.cjs`.
  - All queries are parameterised, so a value can never become SQL.
  - Context is transaction-local and validated as a UUID before any SQL is sent.
  - Missing, empty or malformed context fails closed.
  - The runtime role cannot change policies, ownership or row security.
- **Impact if exploited:** a code defect or SQL-injection flaw could read another tenant's data.
- **Options for stronger, database-enforced control (owner decision):**
  - (a) Keep the architectural control and add a Stage 28 security review. **Recommended now.**
  - (b) Signed context: the gateway passes a tenant id plus an HMAC that a `SECURITY DEFINER` function verifies against a key `pbe_app` cannot read. This needs secure key storage (OD-28).
  - (c) A separate database role per tenant. Operationally heavy.
- **Owner decision, 2026-10-17: temporary acceptance with mandatory conditions.**
  - The risk stays **open and documented**.
  - The current design is **not production-safe** and must not be described as such. R-007 is **production-blocking**.
  - **Mitigation is required before production.**
  - **By Stage 28:** evaluate **and test** stronger database-enforced tenant isolation, including at least (b) signed tenant context and (c) separate database logins per tenant. Choose one, with the owner's approval.
  - **R-007 is not closed** until the selected mitigation is implemented **and** tested against real PostgreSQL behaviour. Tests must show that a session running as the runtime role can no longer read another tenant's rows by setting its own context.
  - Until then, the architectural safeguards above must stay in place, and their tests must keep passing.
- **Owner:** product owner (decision); coding agent (evaluation, implementation, tests). **Resolve by:** Stage 28. **Status:** Open (temporarily accepted for development only).

### R-008 — NestJS one major version behind (ADR-023)

- **Recorded:** 2026-10-17 (OD-29 approval).
- **Description:**
  - The API uses NestJS 11.2.7, while NestJS 12 exists (12.0.0 was released on 2026-08-27).
  - NestJS 12 is ES-module-only and cannot currently run under the approved Jest set-up.
  - Support for 11 may end, and fixes may stop being back-ported.
- **Owner condition (2026-10-17):** reassess **at every subsequent stage**: framework support status, security advisories (audit, GitHub advisories), compatibility, and upgrade options. Never weaken dependency or security gates to stay on 11.
- **Becomes production-blocking if:** NestJS 11 stops receiving security fixes, or any high or critical advisory affects the versions in use.
- **Upgrade path:** NestJS 12+ once Jest can load it without experimental flags, or with an owner-approved change to the test set-up (ADR-015) and the module format.
- **Status:** Open. **Reassessment log:**
  - Stage 4 (2026-10-17): 11.2.7 released 2026-09-30, after 12.0.0, so 11 is still maintained; no advisories for NestJS, Express, multer, body-parser or busboy; 12.1.3 is still ES-module-only, so the Jest blocker is unchanged. Not production-blocking. ([STAGE-04.md §4](../stage-reports/STAGE-04.md#4-dependency-findings))
  - Stage 5 preparation (2026-10-17): npm now tags 11.2.7 as `legacy` and 12.1.3 as `latest`; no 11.x release since 2026-09-30. 12.1.3 is still ES-module-only (`"type": "module"`). `npm audit`: 0 high or critical, 20 moderate; none in NestJS, Express, multer, body-parser or busboy. Not production-blocking. Watch item: the `legacy` tag suggests 11 may soon stop receiving fixes. ([STAGE-05-PLAN.md §8](../stage-plans/STAGE-05-PLAN.md#8-dependency-findings-trial-install-in-a-disposable-copy))
  - Stage 7A (2026-10-17, re-checked): unchanged (NestJS 11.2.7 `legacy`, 12.1.3 `latest`, ES-module-only; no advisories). Not production-blocking.
  - Stage 7 preparation (2026-10-17): unchanged (NestJS 11.2.7 `legacy`, 12.1.3 `latest`, ES-module-only; no advisories). Not production-blocking.
  - Stage 6 report (2026-10-17, re-checked): unchanged (`legacy` 11.2.7, `latest` 12.1.3, ES-module-only; no advisories). Not production-blocking.
  - Stage 6 preparation (2026-10-17): unchanged (`legacy` 11.2.7, `latest` 12.1.3, ES-module-only; no advisories). Not production-blocking.
  - Stage 5 report (2026-10-17, re-checked): unchanged (`legacy` 11.2.7, `latest` 12.1.3, ES-module-only; no advisories). Not production-blocking. ([STAGE-05.md §4](../stage-reports/STAGE-05.md#4-dependency-findings))

### R-009 — Third-party licence review outstanding

- **Recorded:** 2026-10-17 (owner approval of STAGE-05-PLAN.md §10.3).
- **Description:** some dependencies carry licences that need a qualified review before commercial use:
  - `@img/sharp-libvips-*` (LGPL-3.0-or-later): native image library, installed with Next.js's optional `sharp`; never loaded, because PBE disables image optimisation;
  - `axe-core`, `@axe-core/playwright` (MPL-2.0): test-only;
  - `caniuse-lite` (CC-BY-4.0): build-time data;
  - `busboy`, `streamsearch` (no licence field): pulled in by multer through NestJS/Express.
- **The agent does not decide licence questions;** it lists the facts.
- **Mitigation:** a licence review (`npm run licenses` output plus a qualified reviewer) completed and approved by the owner before any commercial release. Each stage report lists new licences.
- **Production-blocking:** **Yes**, until the review is completed and approved. **Status:** Open.

### R-010 — MFA encryption key in local development storage

- **Recorded:** 2026-10-17 (Stage 6 authorisation).
- **Description:**
  - TOTP secrets are encrypted at rest (AES-256-GCM), but the key `PBE_MFA_ENCRYPTION_KEY` lives in the git-ignored `.env` file (permissions 600) on this Mac.
  - Anyone with that file and a database copy could decrypt MFA secrets.
  - **This is development-only storage and is not production-ready.**
- **Exit criteria:** an approved production key-management solution (OD-28; for example, a managed KMS with rotation), implemented and tested. Until then: **production-blocking.**
- **Status:** Open.

### R-011 — No verified delivery channel for one-time tokens

- **Recorded:** 2026-10-17 (Stage 7 decisions §11.4).
- **Description:**
  - The owner requires activation and password-reset tokens to reach users through a **separate verified channel** and never through administrators.
  - No email or other provider is chosen. Stage 7A writes each token message to a local development outbox (git-ignored `.data/outbox/`, permissions 600) on this Mac, which only the operator can read.
  - The API never returns tokens to administrators. But the outbox is **not** a verified channel to a real person.
- **Exit criteria:** an approved delivery provider (owner decision), with verified recipient addresses, implemented and tested. Until then: **production-blocking**; the outbox must never be enabled outside local development.
- **Status:** Open.

### R-006 — No independent verification yet

- **Description:** all test, restore and security evidence so far comes from the coding agent's own runs (Stages 1–2).
- **Mitigation:** reproducible commands are listed in each stage report. An independent security review is planned in Stage 28.
- **Resolve by:** Stage 28. **Status:** Open.
