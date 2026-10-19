# Stage 06 — Authentication, sessions and MFA: completion report

Date: 2026-10-17   Authorised by owner on: 2026-10-17   Agent/model: Claude Code (Claude Opus 5.5)

> **Evidence qualification.** Every result here comes from the coding agent's own runs on this Mac. **Nothing has been independently verified** (R-006). Stage 6 is the highest-risk module and is flagged for the external security review in Stage 28.

## 1. Summary

PBE now has its own sign-in, built in the existing NestJS API with PostgreSQL and Kysely (ADR-026):
- **Accounts:** permanent UUIDv7 user ids; email unique ignoring case. Users are created by an operator command; there is no self-registration.
- **Passwords:**
  - Argon2id hashing;
  - **15–128 characters**;
  - a versioned, internally stored blocklist of 16,050 compromised passwords; no external calls.
- **Throttling:** gradual back-off from the fifth failure, a per-address limit, and identical public errors and timing for unknown emails.
- **Sessions:** server-side; rotated at sign-in, after MFA, on MFA enrolment and on password change; 30-minute idle and 12-hour absolute limits; ended on sign-out. A password change ends every session (the changer gets a fresh one); an operator reset ends all.
- **MFA:** authenticator app (TOTP) with QR enrolment, confirmed only by a valid code; replay refused; 10 single-use recovery codes. MFA secrets are encrypted at rest.
- **Security-event log:** separate and append-only. It never holds passwords, tokens, codes or secrets.
- **Narrow database access (ADR-027):** the runtime role has **no** table privileges on identity data; 21 reviewed single-key functions are the only path.
- **Same-origin check** (CSRF defence) on every state-changing request.
- **New "any signed-in user" access kind.** It grants no role, tenant or customer-data access.
- **Website:** sign-in, verification, authenticator set-up, password change, account page and sign-out, all accessibility-tested.

**Results:**
- `npm run verify` **15/15**.
- Jest **543/543**, Playwright **30/30**, none skipped.
- Accessibility: 0 violations on every new page.
- All deliberate-break checks were detected (§8).

**Not done (excluded):** roles, permissions, tenant memberships, admin UI, deactivation UI, SSO, email or self-service recovery, business features, Stage 7.

## 2. Decisions recorded (owner, 2026-10-17)

| Decision | Recorded as |
|---|---|
| OD-08: PBE-native authentication; `@node-rs/argon2`, `otpauth`, `qrcode`; internal blocklist; owner policy (**15–128 characters**, …) | ADR-026 |
| OD-31: narrow, reviewed look-ups; no bulk credential-reading path | ADR-027 |
| "Any signed-in user" access kind | ADR-022 amendment |
| R-010: MFA key in development storage, **production-blocking** | RISK_REGISTER.md |
| R-007 widened to user-context impersonation (`app.user_id`) | RISK_REGISTER.md |
| Additive migration on `pbe_dev` after backup and passing tests; one fictional development test account allowed | Done (§6); the account is for the owner to create (§11) |

## 3. Files

**Created:**

| Area | Files |
|---|---|
| Migration | `db/migrations/0003_identity_foundation.sql`: 6 identity tables, `audit.security_event`, append-only trigger, 21 access functions, privileges |
| Blocklist | `apps/api/data/compromised-passwords-v1.txt` (16,050 entries) and `.json` manifest (source, licence, commit, file checksums, rule, entry count, SHA-256) |
| API: data access | `apps/api/src/modules/db/identity.ts` (the only code that calls the identity functions) |
| API: auth | `apps/api/src/modules/auth/`: `auth.service.ts`, `auth.controller.ts`, `request-context.ts`, `http-auth.ts` (cookie, client address, same-origin check), `password-policy.ts`, `password-hash.ts`, `secrets.ts` (tokens, recovery codes, AES-256-GCM), `totp.ts` |
| Operator command | `apps/api/src/cli/user.ts` (`npm run user -- create / reset-password / require-mfa / reset-mfa`); `tooling/scripts/auth-init-key.cjs` (`npm run auth:init-key`) |
| Contracts | `packages/contracts/src/auth.ts`: 7 routes and schemas |
| Website | `app/login/page.tsx`, `app/login/mfa/page.tsx`, `app/account/page.tsx`, `app/account/password/page.tsx`, `app/account/mfa/page.tsx`; `src/auth/` (`LoginForm`, `MfaVerifyForm`, `PasswordChangeForm`, `MfaEnrolment`, `SignOutButton`, `messages`, `auth.module.css`); `src/session/server-session.ts`; `src/config/api-origin.ts` |
| Tests | `db/tests/auth.db.spec.ts` (29), `db/tests/auth-privileges.db.spec.ts` (13), `apps/api/test/auth-units.spec.ts` (23), `apps/web/test/auth.spec.tsx` (12), `apps/web/e2e/auth.e2e.ts` (8) |

**Changed:**

| File | Change |
|---|---|
| `packages/contracts/src/route.ts`, `openapi.ts`, `problem-details.ts`, `routes.ts`, `index.ts` | `authenticated` access kind; 4 error codes; 7 routes registered; API version 0.6.0 |
| `openapi/openapi.json` | Regenerated (8 routes) |
| `apps/api/src/common/route.ts` | Guard: same-origin check, `authenticated` (complete session) and `permission` (still 403) |
| `apps/api/src/app.ts`, `common/http.ts`, `config/config.ts`, `common/logger.ts`, `modules/db/index.ts` | Wiring; MFA key, web origins and session settings; redaction of code, recovery and key fields |
| `apps/api/src/modules/db/database-types.ts`, `db/schema-snapshot.txt` | Regenerated (58 columns; 202 entries) |
| `tooling/migrate/src/typegen.ts` and its test | `inet` → `string` (security-event addresses) |
| `apps/web`: `layout.tsx`, `AppShell.tsx`, `navigation.ts`, `forms.tsx`, `next.config.ts`, `package.json` | Server-side session, sign-out, signed-in and signed-out menu entries, input types; `otpauth` as a web test dependency (already installed) |
| Earlier tests (changed because the product changed; no check weakened) | `api.db.spec.ts` (POSTs carry the web Origin; MFA key; "wrong version" lists derived), `contracts.spec.ts` (guard tests for the new kinds), `config.spec.ts` (new settings, including "never prints a value"), `throwaway-server.db.spec.ts` (migration list derived), `smoke.e2e.ts` (menu now shows "Sign in") |
| `package.json`, `package-lock.json` | Dependencies (§4); scripts `user`, `auth:init-key` |
| `.env` (git-ignored, permissions 600) | `PBE_MFA_ENCRYPTION_KEY` added by `npm run auth:init-key`; **never displayed** |
| Docs | ADR-026, ADR-027, ADR-022 amendment; OD-08 and OD-31; R-007 widened, R-010 added, R-008 log; STAGE-06-PLAN status |

## 4. Dependency findings

| Check | Result |
|---|---|
| Versions verified before install | `@node-rs/argon2` 2.2.2, `otpauth` 9.5.2, `qrcode` 1.5.4, `@types/qrcode` 1.5.6: published, not deprecated |
| Native compatibility | `@node-rs/argon2-darwin-arm64` prebuilt binary; **no install script**; worked on Node 24.21.0 / Apple M5 |
| Packages added | 21 (565 → 586) |
| Dependency guard | PASS |
| `npm ls --all` | exit 0 |
| `npm audit` | **0 high, 0 critical**, 20 moderate (unchanged dev-only chain, R-004); no advisories for argon2, otpauth or qrcode |
| Licences | All 26 packages in the new subtrees are MIT or ISC. **No new R-009 items** |
| Blocklist source | SecLists (MIT), pinned commit `913b327317496d062bcc7cace524aaad8a693be2`, three breach-derived lists; checksums in the manifest. Downloaded once to an isolated scratch folder and filtered by a separate script. Candidate passwords are never sent anywhere |
| R-008 (re-checked) | NestJS 11.2.7 still npm `legacy`; 12.1.3 `latest` and still ES-module-only; no advisories. **Not production-blocking** |
| Next.js (ADR-025) | 16.4.2 still `latest`; no advisories |

**Password-hash parameter record (acceptance criterion 2):**

| Parameter | Value |
|---|---|
| Algorithm | Argon2id, version 19 (0x13), via `@node-rs/argon2` 2.2.2 |
| Memory | 65,536 KiB (64 MiB) |
| Passes (time cost) | 3 |
| Parallelism | 1 |
| Salt | 16 random bytes per hash (Node `crypto.randomBytes`) |
| Output | 32 bytes |
| Stored format | `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` (PHC; parameters can be raised later) |
| Input normalisation | Unicode NFKC, before hashing and verifying |
| Measured (Apple M5, Node 24.21.0, 10 runs) | hash median **49.4 ms** (48.0–51.6); verify median **48.7 ms** (48.1–50.0) |

## 5. Commands executed and results (2026-10-17)

| # | Command | Result |
|---|---|---|
| 1 | Recorded ADR-026, ADR-027, ADR-022 amendment, R-010, R-007 widened | Done |
| 2 | `npm view …`; `npm install --save-exact -w @pbe/api @node-rs/argon2@2.2.2 otpauth@9.5.2 qrcode@1.5.4` (and `@types/qrcode`) | +21; gates as in §4 |
| 3 | SecLists download (pinned commit) and filter script | 16,050 entries; secret scan PASS |
| 4 | `npm run db -- status --db dev` and `--db test` | Both at 0001, 0002; 0003 pending |
| 5 | `npm run db -- migrate --db test` | Applied |
| 6 | `npm run db -- typegen` | **First run refused:** `inet` was unsupported. Added an explicit mapping (§7). 58 columns |
| 7 | API, contracts, web code; `tsc`, ESLint, Prettier | Clean (two lint findings fixed later, §7) |
| 8 | `npm run auth:init-key` | Key added to `.env` (permissions 600, git-ignored); not displayed |
| 9 | API unit tests | 79/79 (after fixing one test example, §7) |
| 10 | Database test suite | **Found:** a pg_dump bracket difference (restore drill) and three Stage 3/4 tests with hard-coded version lists; a corrupted migration file, caught by the runner. All fixed (§7) |
| 11 | `auth.db.spec.ts`, `auth-privileges.db.spec.ts` | 29/29 and 13/13 |
| 12 | Web unit tests | 94/94 |
| 13 | `npm run build`; `npm run test:e2e` | **First run:** one test-timing mistake (§7). Then auth 8/8, all 30/30 |
| 14 | `pbe_dev` migration procedure (§6) | Applied after all prerequisites passed |
| 15 | `npm run verify` | **First run 14/15** (two lint findings); **rerun 15/15**, exit 0 |
| 16 | Mutation checks (§8) | All detected |
| 17 | Repeated runs of `auth.db.spec.ts` | 2 intermittent failures in the first 3 runs after a change, cause not captured; two test robustness fixes (§7); then **28 consecutive passing runs** |
| 18 | `npm view` (R-008, Next.js); `npm audit`; licence listing | §4 |
| 19 | Read-only permission evidence from `pbe_dev` | §9 |
| 20 | `npm run verify` (final, after the test-robustness fixes) | **15/15**, exit 0; Jest 543/543; Playwright 30/30 |
| 21 | Clean-up: `npm run db -- drop-disposable` (×5, see §6); state check | Databases: `pbe_dev`, `pbe_test`, `postgres`; 0 `zz_test` schemas; no servers running; `.env` permissions 600 |
| 22 | Documentation check (link, anchor and decision consistency; a replacement for the earlier scratch checker, which was no longer available) | 25 files, 99 links: **0 problems**; 12 approved decisions map to existing ADRs. Prettier and secret scan PASS |

## 6. Migration and backup evidence (`pbe_dev`)

Your five steps, in order:

| Step | Evidence |
|---|---|
| 1. Expected schema and history | `status --db dev`: 0001 (08:30:23Z) and 0002 (09:50:02Z) applied, 0003 pending. `drift`: "No drift: pbe_dev matches db/schema-snapshot.txt (52 entries)". Every difference from `pbe_test` was an object **missing** from `pbe_dev` (150 entries); nothing changed |
| 2. Tests on PostgreSQL 18 (`pbe_test`) | Full Jest: 541 passed; the only 2 failures were the read-only `pbe_dev` checks expecting 0003 (by design, until step 5) |
| 3. Backup, verified | `backup --db dev`: `backups/pbe_dev-2026-10-17T14-40-17-296Z.dump`, 10,655 bytes, SHA-256 `b6a1d63a…1811c878`, 33 entries, 2 ledger rows. `restore-drill --db dev`: restored into a temporary database; schema identical (52), ledger identical (2), data identical; usable; **0003 applied cleanly to the restored copy (rehearsal)**. The drill's strict rule "no pending migrations" cannot hold before a migration, so it reported FAIL on that one rule and kept its temporary copy. The tool was **not** changed. The temporary copy `pbe_restore_check_d10da0c477` was removed with the approved `drop-disposable` command (it refuses anything else) |
| 4. Additive, data preserved | Phase `expand`; the runner's checks passed; 0 references to existing tables; every UPDATE or DELETE is inside a new function body and touches only new tables; existing data: 0 tenants, 2 ledger rows |
| 5. Applied | `migrate --db dev`: "applied 0003_identity_foundation.sql (31 ms)". Ledger 0001, 0002, 0003, **0 pending**; earlier entries unchanged. `drift`: matches the refreshed snapshot (202 entries) **and** `pbe_test` |

No existing database was deleted or reset. Disposable restore copies were removed with the approved `drop-disposable` command:
- the drill's own copy above;
- **four** `pbe_restore_check_*` copies (owned by the test-only restore role, ADR-020) that the restore-drill tests had kept during the failing runs before the email-check fix (§7.1).

Afterwards the server holds only `pbe_dev`, `pbe_test` and `postgres`. Fictional data only. `pbe_dev` holds **no user accounts** (§11).

## 7. Problems found and fixed

1. **pg_dump re-brackets combined CHECK expressions.** The restore drill reported the restored email check as different, because PostgreSQL printed the nested AND with different brackets after restore. Fix in the migration (before any persistent apply): three separate named checks, which restore identically. The comparison tool was not changed.
2. **Migration file corrupted by my own edit script.** A JavaScript replacement string containing `$'` (the same pitfall as in Stage 4) duplicated half the file. The runner refused it with a syntax error. Trimmed to the single correct copy (7 tables, 22 functions); all later edits use a method without `$` patterns. Only `pbe_test` was affected, and the tests rebuild it.
3. **Type generator lacked `inet`.** It correctly refused to guess. Added an explicit mapping (`pg` returns text), and moved `inet` from the "unsupported" to the "supported" test cases.
4. **Old tests encoded the old world:**
   - Stage 4 POSTs now need the web Origin.
   - "Wrong version" lists (`[1,2,3]`) became correct, so they are now derived (`[...SCHEMA_VERSIONS, 999]`).
   - A Stage 3 "all migrations" list (`[1,2]`) is now derived.
   - The menu now shows "Sign in".
   Each still checks the same thing.
5. **Throttle collisions in tests:** client addresses drawn from 250 values reused addresses that earlier runs had (correctly) blocked. They are now random IPv6 documentation addresses.
6. **Intermittent test failures:** two runs failed shortly after a code change; the cause was not captured. Two plausible weak spots were fixed:
   - 6-digit codes are now matched as whole numbers in the secrets-in-logs check (a substring could match unrelated digits; seen once during mutation M1);
   - the timing test now uses a warm-up and 5 samples, with separate users so no account hits the limit.
   Then **28 consecutive passing runs.** Recorded as a limitation (§12).
7. Smaller items:
   - an E2E helper that did not wait for sign-in to finish;
   - a 16-character test example meant to be 15;
   - two lint findings;
   - a circular import.

## 8. Mutation checks (S6-21)

M1–M5 each ran in a full disposable copy with one protection broken, running the API unit and database sign-in tests (65). M6 changed a database grant briefly. In an early M1 run, S6-13 also failed by chance (a 6-digit code matched unrelated digits). After the fix in §7.6, the M1 rerun failed only S6-5.

| Mutation | Detected by |
|---|---|
| M1 Session rotation disabled | S6-5 (the previous session kept working) |
| M2 TOTP replay check skipped | S6-10 (the replayed code was accepted) |
| M3 `HttpOnly` dropped from the cookie | S6-11 (unit and real HTTP) |
| M4 Password written into the security log | S6-13 (found in the security events) |
| M5 Same-origin check skipped | S6-12, all 4 cases |
| M6 `pbe_app` granted UPDATE on `audit.security_event` (in `pbe_test`; revoked straight after, 13/13 again) | S6-17 append-only test |

## 9. Database-permission evidence (S6-17; read-only query on `pbe_dev`)

| Table | `pbe_app` privileges |
|---|---|
| `platform.user_account`, `password_credential`, `user_session`, `mfa_totp_factor`, `mfa_recovery_code`, `auth_throttle` | **none** |
| `audit.security_event` | **INSERT only** (a trigger also refuses UPDATE, DELETE and TRUNCATE, even for the owner) |
| `platform.tenant` (Stage 3, unchanged) | SELECT (row-level security: own tenant only) |

`platform.auth_*` functions:
- 21 in total. All 21 are SECURITY DEFINER, owned by `pbe_owner`, with `search_path` pinned to `pg_catalog, pg_temp`, and executable by `pbe_app`. None is executable by PUBLIC.
- The test (13/13) proves:
  - `pbe_app` can run exactly these plus the two Stage 3 context functions;
  - a bulk SELECT on each identity table is refused;
  - no column privileges exist;
  - the only set-returning functions are the five single-key look-ups;
  - wildcard emails (`%`, `%@%`, empty) find nothing;
  - `pbe_app` can neither create a function nor grant itself access.
- **No bulk credential-reading route exists for the runtime role.**

## 10. Test results: the named tests (STAGE-06-PLAN.md §5)

| # | Test | Result |
|---|---|---|
| S6-1 | Correct sign-in (any email case); session; event | ✓ |
| S6-2 | Wrong password, unknown email and deactivated user: identical 401 body, no cookie; timing within 0.5–2× with a real hash on both | ✓ |
| S6-3 | 5 failures, then 429 even with the right password; 60 s, then 120 s after a further failure; expiry; counter cleared; same for unknown emails | ✓ |
| S6-4 | 20 failures from one address across accounts: 429 for that address only | ✓ |
| S6-5 | New session id at sign-in; the previous one refused; a planted token never adopted | ✓ |
| S6-6 | Idle and absolute expiry: 401, ended, event; lifetimes 1,800 s and 43,200 s | ✓ |
| S6-7 | Sign-out: cookie cleared and the same token refused | ✓ |
| S6-8 | Password change ends all sessions (the changer gets a fresh one); operator reset ends all (operator event; password never printed); passwords as arguments refused; weak passwords refused; deactivated user's session refused | ✓ |
| S6-9 | Required user must enrol first; enrolment confirmed only by a valid code; no signed-in routes before verification | ✓ |
| S6-10 | RFC 6238 vectors; ±1 step; replay refused; recovery code works once; wrong codes throttled | ✓ |
| S6-11 | `__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain (unit, real HTTP, real browser) | ✓ |
| S6-12 | No Origin, foreign Origin, cross-site fetch or form content type → 403, nothing changed | ✓ |
| S6-13 | No password, token, code, recovery code, MFA key or hash in logs, events or ordinary responses | ✓ |
| S6-14 | 15–128 characters, blocklist, email name, product name, repetition, control characters; NFKC | ✓ |
| S6-15 | Argon2id parameters; TOTP secret encrypted; recovery codes and tokens stored as hashes only | ✓ |
| S6-16 | UUIDv7 ids; case-variant duplicate email refused | ✓ |
| S6-17 | Database privileges (§9) | ✓ 13/13 |
| S6-18 | Session has no tenant and empty permissions; tenant rows invisible; `permission` routes stay 403; Stage 3 suites pass | ✓ |
| S6-19 | Browser: redirect to sign-in → sign in → MFA enrolment (QR, real code, 10 codes) → sign out → MFA sign-in → password change → new password and recovery code; generic error; reused code refused; no CSP violations | ✓ 6 tests |
| S6-20 | axe WCAG 2.1 A/AA: 0 violations on sign-in (empty and error), verification, enrolment (all steps), account and password pages; keyboard-only sign-in | ✓ |
| S6-21 | Mutation checks (§8) | ✓ |
| S6-22 | Regression: all earlier tests; `verify` 15/15; OpenAPI and typegen in sync; R-008 and Next.js reassessed | ✓ |
| S6-23 | Manual: owner creates a test user and signs in with MFA | **For the owner** (§11) |

**Totals:**
- Jest **543/543** (37 suites; Stage 5 had 457).
- Playwright **30/30** (Stage 5 had 22).
- 0 skipped.

## 11. Acceptance criteria (STAGE-06-PLAN.md §8)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | S6-1 to S6-22 pass; counts reported; nothing skipped | §10 | **PASS** |
| 2 | Password-hash parameter record | §4 | **PASS** |
| 3 | 0003 applied to `pbe_test` and, after a verified backup, to `pbe_dev`; drift, typegen and OpenAPI pass | §6; `verify` | **PASS** |
| 4 | 0 high/critical; guard passes; only approved dependencies | §4 | **PASS** |
| 5 | Tenant isolation and RLS suites unchanged and passing | S6-18; Stage 3 suites in 543/543 | **PASS** |
| 6 | Exclusions respected | §1, §3 | **PASS** |
| 7 | This report, with no claim of independent verification | This document | **PASS** |

**Owner's manual check (S6-23)**, with fictional details only:
1. Run `npm run user -- create --email owner.test@example.test --name "Owner Test (fictional)"`. Type a password of 15+ characters when asked; it is hidden and never shown.
2. Run `npm run dev` and open `http://localhost:3000`.
3. Choose **Sign in**.
4. Then **Account security → Set up an authenticator app**: scan the QR code and enter the code.
5. Save the recovery codes, sign out and sign in again.

The account lives only in `pbe_dev`. Do not reuse a real password.

## 12. Risks and limitations

| Risk | Status |
|---|---|
| R-001 migrator can act as database owner | **Open, production-blocking** |
| R-007 runtime role can set tenant **and user** context (widened) | **Open, production-blocking.** Stage 6 does not authorise anything by `app.user_id`; the identity functions take explicit keys |
| R-009 licence review | **Open, production-blocking** (no new items) |
| R-010 MFA key in `.env` (development only) | **Open, production-blocking.** Not production-ready |
| R-008 NestJS one major behind | Open, not production-blocking (`legacy` tag watched) |
| R-002 to R-006 | Unchanged |

**Limitations:**
- Throttling sees the address the local web server reports; behind other proxies this needs review (Stage 29).
- No self-service recovery (no email provider). Resets are operator-only until Stage 7 adds admin UI.
- The 21 function bodies are not inspected by the lexical migration checker (R-003). They are covered by the S6-17 tests and need human review.
- Two intermittent test failures happened before the robustness fixes; their exact cause was not captured (§7.6).
- Old ended sessions and throttle rows are not yet purged (retention, OD-12 / Stage 28).
- The Stage 5 limitation-statement wording is still "pending approval".

## 13. Recommendation

**PASS.** All seven acceptance criteria are met, and every named test from S6-1 to S6-22 was executed. The production-blocking risks stay open. The final decision is the owner's.

**Stage 7 has not been started. Nothing has been committed or pushed.**

## 14. Owner verdict (added 2026-10-17; §1–§13 above are unchanged)

- **Verdict:** **PASS**, given by the product owner on 2026-10-17, based on the coding agent's reported results.
- **Results relied on (as reported by the coding agent):**
  - 543 automated tests and 30 real-browser tests passed, none skipped;
  - `npm run verify` 15/15;
  - all seven acceptance criteria reported as PASS;
  - six deliberate security failures detected;
  - migration 0003 applied to `pbe_dev` after testing and a verified backup;
  - no existing database deleted; no commit or push.
- **Evidence qualification:** **these results have not been independently verified.** They were produced and reported by the coding agent only (R-006).
- **Limitations kept on record:**
  - **Intermittent test failures (§7.6, §12):** two early runs of `auth.db.spec.ts` failed and **the root cause was not captured**. Two test-robustness changes followed, after which 28 consecutive runs passed. That is evidence of stability after those changes, not proof of the original cause.
  - **Backup check (§6, step 3):** the backup itself was produced and verified. Restored schema, ledger and data were identical, the copy was usable, and 0003 applied to it. The restore drill reported FAIL on **one** rule only: "no pending migrations", which cannot hold for a backup taken *before* an update. That was **not** a backup or restore failure. The drill tool was not changed. A post-update drill (with nothing pending) has not been run since; it is recommended at the next opportunity.
- **Risks:** R-001, R-007 (widened to user context), R-009 and R-010 are still open and production-blocking. R-008 is reassessed every stage.
- **Next:** Stage 7 preparation only, in [STAGE-07-PLAN.md](../stage-plans/STAGE-07-PLAN.md). Implementation is not authorised.
