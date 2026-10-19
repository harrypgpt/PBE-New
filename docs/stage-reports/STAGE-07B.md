# Stage 07B — Administration screens: completion report

Date: 2026-10-18   Authorised by owner: "Resume delivery and advance the product" (2026-10-18; Stage 7 split into 7A/7B approved 2026-10-17)   Agent/model: Claude Code (Claude Opus 5.5)

> **Evidence qualification.** Every result here comes from the coding agent's own runs on this Mac. **Nothing has been independently verified** (R-006). Nothing here claims production readiness.

## 1. Summary

**Recommendation: PASS WITH CONDITIONS** for Stage 7B (the administration screens). The conditions are not Stage 7B code:
- **B-1:** backups of `pbe_dev` cannot read the protected tables until the backup login is set up;
- **S7-19:** the owner's manual check is still to do (§6).

Built on the Stage 7A API without any change to it: the website now has organisation and platform administration.
- **Everyone signed in:** an **Organisation** page to choose the organisation to work in, or leave it.
- **Tenant administrators:** **Members**, **Roles**, **Departments**, **Organisation settings** (separation of duties; break-glass approvals).
- **Super Admin:** **All organisations** (create with a first administrator, suspend, reactivate) and **Break-glass access** (request, start, end).
- **Public:** **Set your password**, for the one-time activation and reset links (ADR-029).

**Tests:**
- Web component tests **108/108** (14 new);
- browser tests **38/38** (8 new: S7-14, S7-15 and break-glass);
- full Jest **675 passed, 5 failed** (the 5 known B-1 and `pbe_backup` items, §5).

Four deliberate breaks of the web code were each caught by the right browser test.

## 2. What was built

| Page (address) | Who sees it (presentation only, F-6) | What it does |
|---|---|---|
| Organisation (`/organisation`) | Anyone signed in | Lists the user's active organisations, marks the current one, "Work in …" (the API issues a new session), "Leave this organisation" or "End break-glass access" |
| Members (`/admin/members`) | `tenant.members.read`; controls with `.manage`, `roles.manage`, `departments.manage` | List with role and department names; add a member; per member: deactivate or reactivate, start a password reset, set roles, set departments |
| Roles (`/admin/roles`) | `tenant.roles.read`; editing with `.manage` | List with permissions in plain words; create, edit, delete. Permissions are chosen from the fixed catalogue. Template roles are marked as starting points; names carry no power |
| Departments (`/admin/departments`) | `tenant.departments.read`; editing with `.manage` | List, add, edit, delete |
| Organisation settings (`/admin/settings`) | `tenant.settings.read`; break-glass with `tenant.breakglass.approve` | Separation of duties (default "not allowed"); break-glass requests with stated purpose: approve (one hour, read-only), reject, revoke |
| All organisations (`/platform/organisations`) | `platform.tenants.read` / `.manage` | Registry (no customer data); create with a first Tenant Administrator; suspend, reactivate |
| Break-glass access (`/platform/break-glass`) | `platform.breakglass.request` | Request with a written purpose; start read-only access once approved; end it |
| Set your password (`/account/set-password`) | Public (the one-time link is the credential) | Reads the token from the `#` part of the link (never sent to a server by the browser) and **removes it from the address bar at once**; the person chooses their own password under the Stage 6 policy |

**Across all pages:**
- **Break-glass warning:** while a Super Admin uses break-glass, every page shows "Break-glass access: read-only" with the end time.
- **Navigation:** the "Administration" placeholder was replaced by links, each shown only with its permission. Projects, Evidence, Results and Audit trail remain "Planned".
- **No secrets in the browser:** one-time links are never shown to administrators. Messages say a link "was sent through the separate delivery channel; you never see it".
- **Plain-language errors:** the API's own explanations are shown, for example "Choose an organisation first." or the last-administrator rule. Never technical text.
- **Accessible patterns:**
  - labelled fields, an error summary that takes focus, captions on tables;
  - management panels that move focus to their heading;
  - destructive actions confirmed **in the page** (no browser pop-up), with focus moved to the question;
  - checkbox groups in a `fieldset` with a `legend`.

## 3. Files

**Created:**
- pages: `apps/web/app/organisation/page.tsx`, `app/admin/{members,roles,departments,settings}/page.tsx`, `app/platform/{organisations,break-glass}/page.tsx`, `app/account/set-password/page.tsx`;
- components: `apps/web/src/admin/` (`OrganisationSwitcher`, `MembersManager`, `RolesManager`, `DepartmentsManager`, `SettingsManager`, `PlatformOrganisations`, `PlatformBreakGlass`, `ConfirmButton`, `OutcomeNotice`, `NoAccess`, `messages.ts`, `useLoad.ts`, `page-session.ts`, `admin.module.css`), `apps/web/src/auth/SetPasswordForm.tsx`;
- tests: `apps/web/test/admin.spec.tsx`, `apps/web/e2e/admin.e2e.ts`;
- this report.

**Changed:**

| File | Change |
|---|---|
| `apps/web/src/ui/forms.tsx`, `forms.module.css` | New `TextArea` and `CheckboxGroup` (fieldset + legend; option hints linked as descriptions, not part of the name) |
| `apps/web/src/session/session.ts`, `server-session.ts` | Session carries the active organisation's id and the break-glass end time |
| `apps/web/src/ui/AppShell.tsx`, `shell.module.css` | Break-glass warning on every page |
| `apps/web/src/navigation.ts` | Administration links with their permissions |
| `apps/web/e2e/api-server.ts` | Per-run settings for the test API (private outbox folder); database settings cannot be overridden (always `pbe_test`) |
| `apps/web/test/shell.spec.tsx`, `auth.spec.tsx` | Two Stage 5 expectations updated **on purpose**: signed-in users now also see "Organisation"; and "no permission-declared links" was replaced by a **stricter** rule: every declared permission must be in the fixed catalogue, and no template role name or key may appear in the navigation |

**No change** to the API, contracts, database, migrations or dependencies.

## 4. Tests (named; real PostgreSQL 18 `pbe_test`; production web build)

| Plan test | Browser test (`admin.e2e.ts`) | Result |
|---|---|---|
| **S7-14** | The Super Admin creates two fictional organisations with first administrators. Each administrator activates the account with the one-time link, sets up an authenticator app, chooses the organisation, creates a role, adds members and gives the role. A member of A sees only A (B is not listed; B's people are not in the member list; the roles page is refused). A member of both switches between A and B and sees each organisation's own people; "Leave" clears the context | **Pass** |
| S7-14 (tokens) | The link's token is removed from the address bar; a used link cannot be used again | **Pass** |
| S7-7 in the browser | Request with purpose → the Tenant Administrator approves → the Super Admin starts access → the warning appears on every page → member list visible, **no** management controls (read-only) → end access → warning gone | **Pass** |
| **S7-15** accessibility | axe-core WCAG 2.1 A/AA: **0 violations** on every new page, including the error state of the empty create form, a member panel open, the set-password page and the break-glass warning | **Pass** |
| **S7-15** keyboard only | Add a member and give a role using only Tab, typing, Space and Enter; focus moves to the member panel heading | **Pass** |
| Content Security Policy | No CSP violation on any administration page | **Pass** |

**Component tests (`admin.spec.tsx`, 14):**
- navigation visibility per permission;
- plain-language errors (API detail only for 400/403/409; never server text);
- the break-glass warning;
- "choose an organisation first";
- the set-password token handling and form;
- the confirm button (focus, cancel);
- the switcher;
- members: reader sees no controls; adding says the link went to the separate channel; roles sent as ids; the lock-out refusal is shown in plain words.

**A real defect found by the tests and fixed:** checkbox hints were inside the label, so assistive technology announced "Lab managerFictional". Hints are now separate descriptions.

**Deliberate breaks** (web code broken on purpose, site rebuilt, file restored byte-for-byte; the final runs used unmodified code):

| Broken on purpose | Caught by |
|---|---|
| W1 token left in the address bar | S7-14 one-time link test |
| W2 break-glass warning removed | S7-7 browser test |
| W3 checkbox labels not linked to their boxes | S7-14 role test (no accessible name) |
| W4 management controls shown to read-only members | S7-14 "member sees only their own organisation" |

The first attempts at W1 and W2 did not compile and were redone with breaks that compile; the results above are from those runs.

## 5. Commands executed and results (2026-10-18)

| Command | Database | Result |
|---|---|---|
| `npm run lint`, `format:check`, `typecheck`, `build`, `check:secrets`, `check:deps` | — | All passed |
| `npm test` (run 1) | `pbe_test`, throw-away servers, `pbe_dev` read-only | 674 passed, 6 failed: the 5 known items, plus `no-transaction` "CREATE INDEX CONCURRENTLY" timed out (that file took 168 s) |
| `npx jest … no-transaction` (alone) | `pbe_test` | **3/3 in 0.3 s.** That index build waits for every other open transaction; something else was holding pbe_test during run 1 (pgAdmin had been connected to it). Not reproduced; that code path is unchanged |
| `npm test` (run 2, the record) | same | **675 passed, 5 failed** (680), 0 "did not exit". The 5: four `real-migrations` restore drills (B-1: `pg_dump … row-level security policy for table "department"`) and `backup-tool` "pbe_backup does not exist yet" (the role created on 2026-10-18, INCIDENT-2026-10-18.md) |
| `npm run test:e2e` | `pbe_test` (own API) | **38/38** |
| OpenAPI check / migration status / typegen check / drift | — / `pbe_dev` read-only / `pbe_test` / `pbe_dev` read-only | 41 routes in sync / 0 pending / up to date / **no drift** (490 entries) |
| `npm audit --audit-level=high` | — | 0 high/critical (20 moderate, R-004) |

`npm run verify` as a whole was not run; it would stop on the 5 known Jest failures.

## 6. Acceptance criteria (STAGE-07-PLAN.md §7, applied to 7B)

| # | Criterion | Result |
|---|---|---|
| 1 | Named tests pass | **S7-14, S7-15: pass.** Full suite: only the 5 known B-1 / `pbe_backup` failures |
| 2 | RLS conformance | Unchanged (7A): pass |
| 3 | Authorisation matrix | Unchanged (STAGE-07A.md §7); the screens show controls by the same permissions |
| 4 | 0004 on `pbe_test`, then `pbe_dev` after a verified backup | Done 2026-10-18 (STAGE-07A.md §14) |
| 5 | 0 high/critical; no new dependency | **Pass** |
| 6 | Exclusions respected | **Pass:** no audit-search screen, no projects, no email delivery |
| 7 | Report, no claim of independent verification | **Pass** |
| — | **S7-19** owner's manual check (two fictional organisations, users of one cannot see the other) | **Not done.** Owner check. The S7-14 browser test performs the same steps automatically as evidence; the owner decides whether that is enough |

## 7. Risks and limitations

- **Open, production-blocking:** R-001, R-007, R-009, R-010, R-011 (no verified delivery channel for one-time links; development outbox only).
- **B-1** (backups of `pbe_dev` cannot read the protected tables) and the `pbe_backup` follow-ups (INCIDENT-2026-10-18.md §5) remain.
- **Design tokens are still placeholders** (D-1): the TechyPharma-inspired design system is not in the repository.
- Lists have no filtering, sorting or paging yet; fine for current sizes, needed with real data.
- Dates are shown in UTC (stated on screen); local time zones are a later decision.
- The empty grey box in development mode (STAGE-07A.md §14) is not investigated.
- R-008 (NestJS 11 `legacy` tag): unchanged.

Stage 8 has **not** been started. Nothing has been committed or pushed.

## 8. Closure review (2026-10-18)

Owner's order "Stage 7B Review Closure and Stage 8 Preparation". Agent's own review, **not independently verified**.

**Verdict: PASS WITH CONDITIONS.** The suite is **not fully green** (5 known failures below).

| Question | Finding | Evidence |
|---|---|---|
| Does the two-organisation browser test exercise the real backend? | **Yes.** There is no mocking or request interception in `admin.e2e.ts`. Every screen calls the real API, which uses PostgreSQL `pbe_test` with forced row-level security. **Added this review:** checks that bypass the screens and call the API directly. A member of A asking to switch to B gets **404** (same as an unknown organisation). Without the permission, `GET /tenant/roles` gets **403** and `POST /tenant/members` gets **403** | `admin.e2e.ts` 9/9; database-level isolation in `tenancy-access.db.spec.ts` (S7-2: B's rows invisible and unwritable with A's context) 36/36 |
| Is emergency read-only access enforced by the backend, expiring and audited? | **Yes**, at three layers: the access check refuses writes; the database function refuses use of an expired grant; PostgreSQL runs the request in a read-only transaction. **Added this review:** a direct write under break-glass gets **403 "Break-glass access is read-only."** | Browser: S7-7 test. Backend (re-run, 36/36): purpose required, approver only, read-only, one organisation, audited; expiry after one hour with a controlled clock (refused, marked expired, audited, no renewal); PostgreSQL read-only transaction. **Limitation:** expiry is not shown in the browser (it would need a one-hour wait); it is proven by the backend tests |
| Is the one-time token removed from the URL and never logged? | **Removed:** the page strips `#token=…` with `history.replaceState` as soon as it loads, before any user action. The browser test checks the address straight after load, and the entry is replaced, so Back does not show it. **Never sent to a server:** browsers do not transmit the `#` part. **Never logged:** the API does not log request bodies (S4-5), and the S7-16 hygiene test passes. **Added this review:** every token delivered during the browser run is absent from the API's complete log output | `admin.e2e.ts` "one-time tokens never appear in the API logs"; `tenancy-access` S7-16. **Limitation:** the web server's own output is not captured by the test; it never receives the fragment |

**The 5 known failures** (full Jest run 2, 675 passed / 680):

| # | Test | Cause |
|---|---|---|
| 1 | `real-migrations` › backup → verify artifact → restore → identical → usable → dropped | B-1: `pg_dump: … query would be affected by row-level security policy for table "department"`; no backup login yet |
| 2 | `real-migrations` › restored values match exactly … | same |
| 3 | `real-migrations` › a failed verification keeps the temporary database … | same |
| 4 | `real-migrations` › a damaged archive is rejected | depends on the backup file that test 1 cannot create (`ENOENT … manual.dump`) |
| 5 | `backup-tool` › no PBE role has BYPASSRLS; pbe_backup does not exist yet | detects the `pbe_backup` role created on 2026-10-18 (INCIDENT-2026-10-18.md); left failing on purpose |

**Remaining release conditions:**
- B-1 backup login;
- confirmation of how to handle `pbe_backup` (incident §5);
- S7-19 owner check;
- before production:
  - R-011 (a verified delivery channel for one-time links);
  - D-1 (design tokens);
  - R-001, R-007, R-009, R-010 (open, production-blocking).
