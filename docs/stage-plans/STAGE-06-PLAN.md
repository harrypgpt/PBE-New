# Stage 6 Plan — Authentication, sessions and MFA

Status: **Approved and authorised 2026-10-17** (all nine §11 decisions → ADR-026, ADR-027, ADR-022 amendment, R-010, R-007 widened). **Owner refinement: passwords 15–128 characters** (§6 said 12). **Implemented 2026-10-17. Results: [STAGE-06.md](../stage-reports/STAGE-06.md).**
Sources: [IMPLEMENTATION_ROADMAP.md, Stage 6](../IMPLEMENTATION_ROADMAP.md#stage-6--authentication-sessions-and-mfa), [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md) (F-1, F-3, F-5, F-6, F-8, F-9; D-3 to D-7), [SECURITY_PRIVACY_AND_TENANCY.md §3](../architecture/SECURITY_PRIVACY_AND_TENANCY.md#3-authentication-and-sessions-decided-under-od-08-by-stage-6), OD-08. Scope is **not** expanded. Points the roadmap leaves open are marked **[detail]**.

## 1. Objective (plain language)

People can sign in to PBE with an email address and password, stay signed in safely, sign out, change their password, and protect their account with an authenticator app (MFA).
- Each person has a unique, permanent user ID.
- Passwords are never stored, only a slow one-way hash. Common or leaked passwords are refused.
- Repeated wrong guesses slow the attacker down.
- Sessions expire, are replaced at sign-in, and end at once on sign-out or password change.
- Every sign-in event is recorded in a protected security log.

There is still no user administration screen, no roles, and no access to tenant data (Stage 7). Users are created and reset by an operator command on this Mac.

## 2. Prerequisites

| Item | Status |
|---|---|
| Stage 5 PASS | Approved 2026-10-17 (STAGE-05.md §14; not independently verified) |
| **OD-08** authentication and MFA strategy, with the security policy in §6 | **Open — owner approval needed** (§11) |
| Library choices (hashing, TOTP, QR code) | **Owner approval needed** (§9, §11) |
| **D-4** compromised-password screening method | **Owner approval needed** (§11) |
| **OD-31** (new) how the runtime role reaches identity data | **Owner approval needed** (§11) |
| Contract change: a new `authenticated` access kind (amends ADR-022) | **Owner approval needed** (§11) |
| Database | **Migration 0003** (additive). Tested on `pbe_test` first; applied to `pbe_dev` after a verified backup, as in Stage 3 |
| Administrator password | **Not expected.** The runner applies migrations as `pbe_migrator`. If any step turns out to need elevated rights, the exact SQL is shown for review first and nothing is run without approval |
| Email provider | **None.** Self-service password recovery waits for one (D-3); see §3 |

## 3. Scope (roadmap items 1–5 plus baseline items mapped to Stage 6)

| Item | Plan |
|---|---|
| **User accounts** (F-1) | `platform.user_account`: `id uuid` (PostgreSQL 18 `uuidv7()`, unique and never reused), email, display name, status (`active` / `deactivated`), `mfa_required`, timestamps. Email is unique ignoring case (`lower(email)` unique index). Users are platform-level, because one person may belong to several tenants; memberships arrive in Stage 7 |
| **Password sign-in** (F-1, F-5) | `POST /api/v1/auth/login`. Argon2id hash (§6). Wrong email and wrong password give the **same** answer and similar timing (a dummy hash is computed for unknown emails), so accounts cannot be discovered |
| **Server-side sessions** (F-5) | `platform.user_session`. The cookie holds a random 256-bit token; the database stores only its SHA-256. Idle and absolute timeouts (§6). Session **rotates** at sign-in, after MFA, and after a password change (no session fixation) |
| **Sign-out and revocation** (F-5, D-5) | `POST /api/v1/auth/logout` ends the session at once. Changing or resetting a password ends **all** that user's sessions (the one making the change gets a fresh one). A deactivated user's sessions are refused at the next request |
| **TOTP MFA** (F-5) | Enrolment (secret plus QR code and manual key; confirmed with a first code), verification at sign-in, 10 single-use recovery codes (stored hashed). Replay of a used code is refused. Secrets encrypted at rest (AES-256-GCM, Node built-in) |
| **MFA required** | Per-user flag `mfa_required`. A required user who has not enrolled can only enrol. Stage 7 sets this from roles (tenant admins, scientific reviewers, platform roles, SECURITY §3) |
| **Lockout, back-off and rate limiting** (F-5) | Kept in PostgreSQL (no Redis, ADR-007): per-account and per-client-address failure counters with growing delays (§6). Answers say "try again later" without revealing whether the account exists |
| **Compromised-password screening** (F-5, D-4) | Per the owner's D-4 decision. Recommended: an offline list of common and breached passwords shipped with PBE; no external calls |
| **Change password** | Signed-in users, with the current password. Applies the same policy and screening |
| **Secure reset** (F-3, D-3) | **Operator-initiated** in Stage 6: `npm run user -- reset-password <email>` asks for the new password in the terminal (hidden input, typed twice), never prints it, ends all sessions and logs a security event. Admin-initiated reset in the UI comes with user administration (Stage 7). Self-service reset by email needs an email provider (open gap, unchanged) |
| **Operator commands** | `npm run user -- create | reset-password | require-mfa | reset-mfa`. Passwords come only from a hidden terminal prompt, never from arguments, files or logs. Connects through the data-access layer as `pbe_app`. Writes to `pbe_dev` only when the owner runs it |
| **Security-event log** (F-7, D-6) | **New, separate** table `audit.security_event`: sign-in success and failure, lockout, sign-out, session expiry and revocation, password change and reset, MFA enrolment, verification failure and recovery-code use, operator actions. **Append-only:** `pbe_app` may INSERT only; UPDATE, DELETE and TRUNCATE are refused, including by a trigger. Never contains passwords, tokens, codes or secrets. The business audit trail stays a separate Stage 7 table |
| **CSRF protection** | `SameSite=Strict` cookie, same-origin only (ADR-025, no CORS). Every state-changing request must carry the PBE web `Origin` (and `Sec-Fetch-Site: same-origin` when the browser sends it) and a JSON body; otherwise 403 Problem Details |
| **Secure cookie flags** | `__Host-pbe_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`. Browsers accept `Secure` cookies on `http://localhost`, so local development keeps the production flags |
| **Contracts** | New routes in `packages/contracts`: `auth/login`, `auth/mfa/verify`, `auth/logout`, `session` (current user), `account/password`, `account/mfa/*`. New access kind `authenticated` (§11). The generated OpenAPI is updated |
| **Login UI** (web) | Pages: `/login`, `/login/mfa`, `/account/password`, `/account/mfa` (enrol and recovery codes), plus a sign-out button in the shell. Built from the Stage 5 components; accessibility-tested. The shell shows the signed-in user (D-7); tenant stays empty until Stage 7 |
| **User context for the web app** (D-7) | `GET /api/v1/session` returns user id, display name, MFA state and `permissions: []` (Stage 7 fills them). The web app treats it as presentation only (F-6) |
| **Tenant isolation** | Unchanged. A session identifies a **user**, never a tenant. No tenant data becomes reachable in Stage 6; tenant context is still set only by `withTenantTransaction` (Stage 3). All cross-tenant and RLS suites must still pass |

**Database migration 0003 (additive; `expand`):**
- `platform`: `user_account`, `password_credential`, `user_session`, `mfa_totp_factor`, `mfa_recovery_code`, `auth_throttle`.
- `audit`: `security_event`.
- Grants, RLS and the access functions (§11 OD-31). The tenant-table template and conformance checker are unchanged; these tables are platform-level and get their own privilege tests (S6-17).

**Dependencies (subject to §11; exact versions re-checked on implementation day):**
- `@node-rs/argon2` 2.2.2 (or Node's built-in `crypto.argon2`);
- `otpauth` 9.5.2;
- `qrcode` 1.5.4 plus `@types/qrcode`.
- Nothing else. Cookies, CSRF checks, rate limiting and AES-GCM use Node built-ins and in-house code.

## 4. Exclusions

- **No** tenant memberships, roles, permissions, departments, user-administration UI or deactivation UI (Stage 7). Every `permission` route stays 403.
- **No** Super Admin or Tenant Admin features (Stage 7, D-2).
- **No** SSO, self-sign-up, email or self-service password recovery.
- **No** business features and no tenant data.
- No change to existing tenant tables, policies or the Stage 3 gateway rules.

## 5. Test plan (each named; real PostgreSQL 18 `pbe_test`; browser tests on the production build)

| # | Test | Expected |
|---|---|---|
| S6-1 | Correct email and password, any letter case in the email | Signed in; new session; security event `login_succeeded` |
| S6-2 | Wrong password; unknown email; deactivated user | Identical 401 Problem Details; similar timing (unknown email still computes a hash); `login_failed` event; no hint which part was wrong |
| S6-3 | Lockout and back-off: repeated failures on one account and from one client address | Growing delays, then "try again later" (429); a correct password during lockout is still refused; the lock expires as configured; events logged |
| S6-4 | Rate limit across many accounts from one address (password spraying) | Address-level limit triggers |
| S6-5 | **Session fixation:** a session cookie set before sign-in | A **different** session id after sign-in and after MFA; the old one is invalid |
| S6-6 | Expired session: idle timeout; absolute timeout (clock controlled in tests) | 401; session marked expired; event logged |
| S6-7 | Sign-out | The same cookie is refused afterwards (server-side revocation, not just cookie deletion) |
| S6-8 | **Prompt revocation:** password change ends all other sessions; operator reset ends all sessions; deactivated user's session refused at the next request | Pass |
| S6-9 | MFA required: user flagged `mfa_required` without enrolment can only enrol; with enrolment, cannot reach `authenticated` routes before a valid code | Pass |
| S6-10 | TOTP: valid code accepted (±1 time step); wrong, expired or **replayed** code refused; RFC 6238 test vectors pass; recovery code works **once** | Pass |
| S6-11 | Cookie flags on every session cookie | `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain` |
| S6-12 | CSRF: state-changing request with a foreign or missing `Origin`, `Sec-Fetch-Site: cross-site`, or a form content type | 403; no state change |
| S6-13 | **Secrets never logged or returned:** sign-in, failures, MFA, reset and operator commands with captured logs, responses, security events and terminal output | No password, session token, TOTP code, recovery code, MFA secret or hash appears anywhere |
| S6-14 | Password policy and screening: too short, too long, on the compromised list, contains the email; Unicode normalised | Refused with a clear field message; accepted otherwise |
| S6-15 | Storage: hashes are Argon2id with the recorded parameters; TOTP secrets encrypted (no plaintext in the database); recovery codes and session tokens stored hashed | Pass |
| S6-16 | Unique user ids: duplicate email (differing only in case) refused; ids are UUIDs and never reused | Pass |
| S6-17 | Database privileges (real PostgreSQL): `pbe_app` cannot UPDATE, DELETE or TRUNCATE `audit.security_event`, and cannot read password hashes or MFA secrets in bulk (per OD-31); identity functions are owned by `pbe_owner` with a fixed `search_path`; migration 0003 passes runner, checksum, drift and typegen checks | Pass |
| S6-18 | Tenant isolation unchanged: all Stage 3 cross-tenant, RLS and conformance suites pass; a signed-in user still reaches no tenant data; `permission` routes stay 403 | Pass |
| S6-19 | **Browser E2E (Playwright):** sign in → enrol MFA (codes generated in the test) → sign out → sign in with MFA → change password; the shell shows the user; signed-out users are sent to `/login` | Pass |
| S6-20 | Accessibility: axe WCAG 2.1 A/AA, 0 violations on the new pages, including error states; keyboard-only sign-in works | 0 violations |
| S6-21 | Mutation checks (scratch copy): disable session rotation; skip the TOTP replay check; drop `HttpOnly`; log the password; skip the `Origin` check; let the runtime role UPDATE security events | The matching tests fail |
| S6-22 | Regression: all Stage 1–5 tests; full `npm run verify`; OpenAPI and typegen in sync; R-008 and Next.js reassessed | All pass |
| S6-23 | Manual (roadmap item 7): owner creates a test user with `npm run user -- create` on `pbe_dev`, signs in at `http://localhost:3000`, enrols MFA with an authenticator app, signs out and back in | Owner check |

## 6. Proposed security policy (part of OD-08; owner approval needed)

| Setting | Proposed value | Why |
|---|---|---|
| Password hash | **Argon2id**, memory 64 MiB, 3 passes, parallelism 1, 16-byte salt, 32-byte output. Parameters stored with each hash, so they can be raised later | Above the OWASP minimum (19 MiB, 2 passes). Measured about 66 ms per hash on this Mac (Node built-in, 2026-10-17) |
| Password length | 12 to 128 characters; any characters including spaces; Unicode normalised (NFKC); no forced character mixes or expiry | NIST SP 800-63B guidance |
| Screening | Refuse passwords on the compromised list, or containing the user's email or "pbe" | Baseline F-5 |
| Session idle timeout | 30 minutes (configurable) | — |
| Session absolute timeout | 12 hours (configurable) | — |
| Per-account back-off | After 5 failures, delays grow (1, 2, 4 … up to 15 minutes) | Slows guessing without permanent lock-outs that attackers could abuse |
| Per-address limit | 20 failed sign-ins per 10 minutes, then 429 | Password spraying |
| MFA | TOTP (SHA-1, 6 digits, 30 s, ±1 step), the setting authenticator apps support; 10 single-use recovery codes | Baseline F-5; SECURITY §3 |
| MFA secret encryption key | `PBE_MFA_ENCRYPTION_KEY` (32 random bytes) created by the bootstrap and kept in `.env` (permissions 600). **Development only:** production needs managed key storage (OD-28) | Proposed risk R-010 |
| Security events kept | Indefinitely until the retention decision (OD-12) | — |

## 7. Security implications

- Stage 6 is the **highest-risk module** in the roadmap. It is flagged for the external security review in Stage 28 (R-006).
- **No custom cryptography:** Argon2id and TOTP come from established implementations (§9). AES-GCM, random numbers and SHA-256 come from Node's built-in crypto.
- **No secrets at rest in readable form:** password hashes, hashed session tokens and recovery codes, encrypted TOTP secrets. Logs and the security-event table never hold credentials (S6-13).
- **Authorisation stays server-side** (F-6). Hiding UI is not access control. The API guard gains an "authenticated" check. Permission routes stay refused until Stage 7.
- **R-007 grows slightly:** `pbe_app` can also set `app.user_id`, the same weakness as `app.tenant_id`. Proposed: widen R-007's description; it stays production-blocking.
- **R-001, R-007 and R-009 remain open and production-blocking.** Proposed new **R-010** (MFA key in `.env`) is also production-blocking.
- **Personal data:** email, display name and the client address in security events. Fictional test users only until OD-12(a).

## 8. Acceptance criteria (roadmap item 8, made measurable)

1. S6-1 to S6-22 pass; counts reported; nothing skipped without explanation.
2. A **password-hash parameter record** (algorithm, memory, passes, parallelism, salt and output length, measured time) is in STAGE-06.md.
3. Migration 0003 applied to `pbe_test` and, after a verified backup, to `pbe_dev`; drift, typegen and OpenAPI checks pass.
4. `npm audit` shows 0 high or critical findings; the dependency guard passes; only the approved dependencies are added.
5. Tenant isolation and RLS suites pass unchanged (S6-18).
6. Exclusions respected (no roles, memberships, admin UI, SSO or email).
7. STAGE-06.md written with commands, results and per-criterion verdicts; no claim of independent verification.

## 9. Dependency findings (trial installs in a disposable copy, 2026-10-17; repository unchanged)

| Candidate | Packages added | Guard | Audit | Notes |
|---|---|---|---|---|
| Node built-in `crypto.argon2` (Node 24.21.0) | 0 | — | — | Works; no warning printed; about 66 ms at 64 MiB / 3 passes. Added in Node 24.7.0. **Its stability label could not be confirmed from official docs**; one secondary source calls it experimental |
| `@node-rs/argon2` 2.2.2 (MIT) | +2 | PASS (prebuilt binary, no install script) | 0 high/critical | Hash and verify worked (`$argon2id$v=19$m=65536,t=3,p=1`) |
| `argon2` 0.45.1 (MIT) | +6 | **FAIL** (install script with a node-gyp fallback, which needs Python; ADR-005) | 0 high/critical | **Rejected** |
| `hash-wasm` 4.12.0 (MIT) | +1 | PASS | 0 high/critical | WebAssembly; slower; not recommended |
| `otpauth` 9.5.2 (MIT) | +2 | PASS | 0 high/critical | Established TOTP library |
| In-house TOTP on Node HMAC | 0 | — | — | RFC 6238 test vectors reproduced (94287082, 07081804); it would still be our own protocol code |
| `qrcode` 1.5.4 (MIT) | +16 | PASS | 0 high/critical | Produces an SVG QR code (CSP-safe, no inline script) |

**R-008:** unchanged since Stage 5 (NestJS 11.2.7 `legacy`, 12.1.3 `latest` and ES-module-only, no advisories). Not production-blocking.

**Next.js:** 16.4.2 is still `latest`.

## 10. Rollback

- **Code:** revert to the Stage 5 state.
- **Database:** migration 0003 is additive. To undo it on `pbe_dev`, restore the pre-migration backup (verified before applying), or apply a reviewed forward migration that drops only the new identity tables. Sessions can be cleared safely at any time.
- No existing table or data is changed.

## 11. Decisions needed from the owner before implementation

1. **OD-08:** approve option A (in-house sign-in with server-side sessions in PostgreSQL, Argon2id and TOTP MFA; SSO later), **together with the security policy in §6**.
2. **Password hashing:**
   - Recommended: **`@node-rs/argon2` 2.2.2**. It is established, passes every gate and adds 2 packages.
   - Alternative: Node's built-in Argon2 (no new package), but its stability status is unconfirmed. It can replace the package later without re-hashing, because both use the standard format.
3. **TOTP:**
   - Recommended: **`otpauth` 9.5.2**, which honours OD-08's "established libraries, never custom cryptography".
   - Alternative: in-house code on Node's HMAC (no package; RFC vectors pass).
4. **QR code for MFA enrolment:**
   - Recommended: **`qrcode` 1.5.4** (+16 packages), so you can scan with an authenticator app. The manual key is always shown too.
   - Alternative: manual key entry only, with no package.
5. **D-4 compromised-password screening:**
   - Recommended: **offline list** of the most common and breached passwords, shipped with PBE (candidate source: the MIT-licensed SecLists common-password lists, verified at implementation). No data leaves the machine.
   - Alternative: an online check against an external breach service. Only a 5-character hash prefix is sent, but it is still an external call and needs a decision on what happens when the service is down.
6. **OD-31 (new): how the runtime role reaches identity data.**
   - Recommended:
     - the few look-ups needed **before** someone is signed in (find a login by email, find a session by token hash) use **narrow, reviewed database functions** owned by `pbe_owner`;
     - everything else is limited by RLS to the signed-in user (`app.user_id`);
     - `pbe_app` gets no bulk read of password hashes or MFA secrets.
   - Alternative: direct table grants (simpler, weaker).
7. **Contract change (amends ADR-022):** add the access kind **`authenticated`** for routes any signed-in user may call (sign-out, current session, own password and MFA). Default deny stays: every route still declares access.
8. **Risks:**
   - record **R-010** (MFA encryption key kept in `.env`, development only; production-blocking until managed key storage, OD-28);
   - widen **R-007** to cover `app.user_id`.
9. **Database:** confirm migration 0003 may be applied to `pbe_dev` after a verified backup (additive only), and that your manual check (S6-23) will create one test user there.

Unchanged and preserved: TypeScript only; Next.js + NestJS; PostgreSQL only; Kysely with the dedicated data-access layer; the in-house type generator; hand-written SQL migrations (no Prisma Migrate, no Python); shared Zod contracts; the dependency guard. R-001, R-007 and R-009 stay open and production-blocking; R-008 is reassessed.
