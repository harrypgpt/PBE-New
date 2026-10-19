# Stage 5 Plan — Web foundation

Status: **Approved and authorised 2026-10-17** (OD-24 → ADR-024, OD-30 → ADR-025, R-009 recorded, browser download and placeholder tokens approved). **Implemented 2026-10-17. Results: [STAGE-05.md](../stage-reports/STAGE-05.md).** Originally prepared 2026-10-17. Needs OD-24 and the new OD-30 approved first (§10). Updated the same day with the owner's mandatory product baseline (§3a; [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md)).
Source: [IMPLEMENTATION_ROADMAP.md, Stage 5](../IMPLEMENTATION_ROADMAP.md#stage-5--web-foundation). Scope is **not** expanded. Points where the roadmap leaves a detail open are marked **[detail]**.

## 1. Objective (plain language)

Turn `apps/web` into a running Next.js website at `http://localhost:3000`. It is a page frame (header, navigation skeleton, main area), plus a status page that asks the API whether the system and database are healthy. It contains the reusable building blocks every later screen will use:
- form fields with mandatory markers and validation messages;
- a progress indicator;
- loading and error states;
- the **limitation statement** that scientific screens must always show.

Browser security rules (security headers, including a content security policy) are switched on and tested. One command starts the website and the API together. There is still no login and no real data.

## 2. Prerequisites

| Item | Status |
|---|---|
| Stage 4 PASS | Approved 2026-10-17 (STAGE-04.md §12; not independently verified) |
| **OD-24** UI component and styling approach | **Open — owner approval needed** (§10, option evidence in §8) |
| **OD-30** Next.js version and how the browser reaches the API (new) | **Open — owner approval needed** (§10) |
| ADR-001 Next.js, ADR-015 Jest + React Testing Library + Playwright | Already approved; Playwright and React Testing Library are installed for the first time here, as ADR-015 foresaw |
| Playwright browser | A one-off Chromium download by `npx playwright install chromium`, stored in the user cache folder (`~/Library/Caches/ms-playwright`), **outside the project**. No administrator password. Not present today |
| Database | **No migration.** End-to-end tests use `pbe_test` through the existing API as `pbe_app`. `pbe_dev` is used only for the owner's manual check (read-only health query) |
| Administrator password | **Not needed** |

## 3. Scope (roadmap items 1, 2, 5, 9, nothing added)

| Roadmap item | Plan |
|---|---|
| Next.js app shell | `apps/web/app/` (App Router): root layout with `lang`, page title, a **skip-to-content link**, header, navigation skeleton (placeholder entries only, no data), `<main>` landmark, footer. Port **3000** on `127.0.0.1` **[detail]** |
| Typed API client using contracts | `apps/web/src/api/client.ts`: one function `callRoute(contract, input)` that uses the **same Zod route contracts** as the API (ADR-022). It validates the request before sending and the response after receiving. A Problem Details reply becomes a typed error. **An unexpected response shape is treated as an error and never displayed raw**. Raw error text, stack or status internals never reach the screen |
| Error and loading states | `app/error.tsx`, `app/not-found.tsx`, `app/loading.tsx`, and components `<LoadingState>` and `<ErrorState>` (plain-language message plus the request id for support; no technical detail) |
| Accessible form primitives | `<Field>`, `<TextInput>`, `<NumberInput>`, `<Select>`, `<Checkbox>`, `<ErrorSummary>`. Built on **native HTML elements**: label linked to input, a visible **mandatory marker** with `aria-required`, validation message linked by `aria-describedby`, `aria-invalid`, and a focusable error summary. Validation messages follow one pattern (API_CONTRACT_STANDARDS field paths) |
| Limitation-statement component | `<LimitationStatement>`. It **refuses to render empty** (a missing or blank statement is a programming error caught by tests), cannot be collapsed or hidden by props, and uses a consistent, accessible "note" region. Wording is supplied by callers; Stage 5 shows only a placeholder example on the status page |
| Progress indicator | `<ProgressIndicator>` (steps or percentage) with correct ARIA progress semantics; no fake progress |
| Health status page | `/status` (also linked from the home page). Calls `GET /api/v1/health` through the typed client and shows "API and database: available" or "unavailable" with the request id. No version numbers, hostnames or error text |
| Browser → API routing | **[OD-30]** Same origin: the browser only talks to `localhost:3000`. Next.js forwards `/api/v1/*` to the API at `127.0.0.1:3001`. **CORS stays closed on the API**, and the Stage 6 session cookie will be first-party |
| Security headers baseline (item 9) | On every web response: a **nonce-based Content Security Policy** (no `unsafe-inline`, no `unsafe-eval` in the production build; `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy` (camera, microphone and geolocation off), `Cross-Origin-Opener-Policy: same-origin`, no `X-Powered-By`. HSTS is not sent on plain-http localhost; it is a deployment item (Stage 29). Development mode needs `unsafe-eval` for live reload; this is allowed **only** under `next dev`, and the tests run against the production build |
| Privacy | Next.js anonymous telemetry **disabled** (`NEXT_TELEMETRY_DISABLED=1` in every script). No analytics, fonts or scripts from other sites. Built-in image optimisation is switched off (`images.unoptimized`), so the image library is never loaded (§8) |
| One command starts web and API | `npm run dev`: an in-house script (`tooling/scripts/dev.cjs`, no new package) builds, starts the API and the website, prefixes their output, and stops both on Ctrl+C or if either one fails |
| `packages/contracts` additions | Additive only, if needed by the client (for example, a helper that builds a route URL). No change to existing contracts, so `openapi/openapi.json` stays unchanged |

**Dependencies (exact versions; re-checked on the day of implementation and reported):**
- `apps/web`: `next` 16.4.2, `react` 19.3.1, `react-dom` 19.3.1, plus the existing `@pbe/contracts` and `zod` 4.6.7.
- dev: `@types/react` 19.3.0, `@types/react-dom` 19.3.0, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `jest-environment-jsdom` 30.5.2, `@playwright/test` 1.64.1, `@axe-core/playwright` 4.14.0.
- UI library: **per OD-24** (recommended option adds **none** in Stage 5; §8).
- Nothing else. No `concurrently`, `eslint-config-next`, CSS framework or font package.

**Tooling changes:**
- Jest: the `apps/web` project gains a `jsdom` environment for `*.spec.tsx` component tests, using `ts-jest` as today (ADR-015 unchanged).
- Playwright: E2E and accessibility tests live in `apps/web/e2e/`, with their own runner as ADR-015 foresaw.
- `verify` gains one step: **"Web E2E smoke and accessibility (Playwright, real PostgreSQL `pbe_test`)"**.
- ESLint covers `.tsx`. The existing boundary rule is extended: `apps/web` may import only `@pbe/contracts`, never `apps/api`, `science-core`, `pg` or `kysely` (MODULE_BOUNDARIES.md).
- The secret scan and dependency guard are **unchanged**.

## 3a. Product baseline additions (owner, 2026-10-17)

The owner's mandatory baseline ([PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md), B5-1 to B5-5) applies to Stage 5. It is met **within** the roadmap scope above (shell, UI conventions as components, accessible form primitives). No login, user management, authentication service or identity table is added.

| Baseline | Plan |
|---|---|
| Design tokens (B5-2) | `apps/web/src/ui/tokens.css`: CSS custom properties for colour (text, surfaces, brand, and status colours for success, warning, error and info), typography scale, spacing scale, radius, focus ring and breakpoints. **Components use tokens only**; a check fails on hard-coded colour values in component styles. **Token values are neutral placeholders until the TechyPharma-inspired design system reference is supplied** (dependency D-1). They are clearly marked and meet WCAG AA contrast |
| Component patterns (B5-2) | In addition to §3: `<DataTable>` (caption, column headers with `scope`, an empty state, a loading state, responsive overflow; no data source yet); `<StatusLabel>` (text **and** colour, never colour alone); `<Notice>` for success, info, warning and error feedback (polite or assertive live region); `<Button>`. Each is shown on the test-only component showcase page |
| Future identity compatibility (B5-1, B5-3, D-7) | `<AppShell>` takes an **optional** `session` input (user display name, active tenant, effective permissions). With no session (all of Stage 5) it shows a neutral, signed-out frame. Navigation is **data-driven**: each entry may declare a `permission` (same `area.action` format as the API contracts). `<IfPermitted>` and the navigation hide entries the session lacks. A tenant name slot is ready for tenant-aware navigation. No role names are hard-coded |
| "Hiding is not authorisation" (F-6) | `<IfPermitted>` is documented and tested as **presentation only**. Every action it hides is still refused by the API guard (Stage 4 default deny). In Stage 5, all permission-declared navigation entries are hidden because there is no session |
| Limitation statement (B5-4) | As §3, plus: the shell reserves a permanent limitation-statement area, which pages with scientific content must fill. A page cannot remove it. Placeholder wording until scientific wording is approved |
| Responsive layout (F-10) | The shell, tables and forms work from phone width (360 px) to desktop with no horizontal page scroll. Checked in the E2E tests at two viewport sizes |

## 4. Exclusions (roadmap item 3, plus existing boundaries)

- **No login**, sessions, users, cookies or CSRF tokens (Stage 6). **No user-management features, authentication services or identity-related database tables** (baseline B5-5; Stages 6–7).
- **No real data pages:** no projects, datasets or results. Navigation entries are inert placeholders.
- No scientific calculation in the browser (MODULE_BOUNDARIES.md: the UI never computes scientific results).
- No database migration and no data change. No direct database access from `apps/web`.
- No CORS on the API. No change to API behaviour except what same-origin forwarding needs (expected: none).
- No component library beyond the OD-24 decision. No analytics, external fonts or CDNs.
- No production deployment or HTTPS set-up (Stage 29).

## 5. Test plan (roadmap item 6, each named; real PostgreSQL where the database is involved)

| # | Test | Expected |
|---|---|---|
| S5-1 | Component tests (Jest + React Testing Library): shell landmarks and skip link; each form primitive (label association, mandatory marker plus `aria-required`, linked validation message, `aria-invalid`, error summary focus); progress indicator semantics; loading and error states show no technical detail | Pass |
| S5-2 | `<LimitationStatement>`: renders the given text in a "note" region; **refuses empty or blank text**; no prop can hide it | Pass |
| S5-3 | Typed API client (unit, fake `fetch`): valid health response accepted; **unexpected extra field or wrong shape rejected**; Problem Details mapped to a typed error with request id; network failure gives a safe error; invalid request input is never sent | Pass |
| S5-4 | Module boundaries: lint fails if `apps/web` imports `apps/api`, `science-core`, `pg` or `kysely` (added to the existing lint-boundary tests) | Pass |
| S5-5 | **E2E smoke (Playwright, real browser):** browser → web (production build) → API → **real PostgreSQL** (`pbe_test`, as `pbe_app`): `/status` shows "available"; the response carries an `X-Request-Id` | Pass |
| S5-6 | E2E failure path: API started against an unreachable database, or not running: `/status` shows "unavailable" in plain language; **no host, port, SQL or error text** on the page | Pass |
| S5-7 | **Automated accessibility (axe-core in the real browser)** on home, `/status`, a component showcase page **[detail: test-only page, excluded from the production build]** and the 404 page: **0 violations** for WCAG 2.1 A and AA rules | 0 violations |
| S5-8 | Keyboard: skip link moves focus to `<main>`; every interactive element is reachable by Tab, in a logical order, with a visible focus indicator | Pass |
| S5-9 | **Security headers** on every web response (pages, 404, static files) from the production build: the full list in §3; a **new nonce per request**; no `unsafe-inline` or `unsafe-eval` | Pass |
| S5-10 | **CSP is enforced**, not just sent: pages load with **no CSP violations** in the browser console; an injected inline script is **blocked** | Pass |
| S5-11 | Same-origin routing: `/api/v1/health` through `localhost:3000` reaches the API; the API sends **no** `Access-Control-Allow-Origin`; an unknown `/api/v1/...` path returns the API's Problem Details 404 | Pass |
| S5-12 | No secrets in the browser: the built browser bundle and HTML contain no `PBE_PG_*` names or values, no `.env` contents, no server-only modules; telemetry disabled in every script | Pass |
| S5-13 | One command: `npm run dev` starts both; web `/status` shows "available"; Ctrl+C stops both, with no process left running | Pass |
| S5-14 | Manual (roadmap item 7): owner runs `npm run dev`, opens `http://localhost:3000`, sees the frame and "API and database: available" | Owner check |
| S5-15 | Mutation checks (scratch copy): remove the CSP header; break a label association; let `<LimitationStatement>` render empty; skip response validation in the client; let an error page show the raw error | The matching tests fail |
| S5-16 | Regression: all 371 Stage 1–4 tests; full `npm run verify` with the new E2E step | All pass |
| S5-17 | Design tokens (baseline B5-2): every component style uses tokens; a hard-coded colour in a component style fails the check; token text and background pairs meet WCAG AA contrast | Pass |
| S5-18 | Permission-aware components (B5-3, F-6): with no session, every permission-declared navigation entry and `<IfPermitted>` child is hidden; with a test session holding `project.read`, only matching entries show; the API still answers a permission route with 403 `ACCESS_DENIED` regardless of the UI | Pass |
| S5-19 | Baseline patterns: `<DataTable>` (caption, header scope, empty and loading states), `<StatusLabel>` (text present, not colour alone), `<Notice>` (correct live region) pass component and axe tests; the limitation-statement area is present on every shell page | Pass |
| S5-20 | Responsive: home, `/status` and the showcase at 360 px and 1280 px wide show no horizontal page scroll and no clipped controls | Pass |

Screenshots of home and `/status` are captured by Playwright for the report (roadmap item 11), if capture works on this Mac.

## 6. Security implications

- **Content security policy and headers** are the main browser defence against injected scripts. They are enforced from day one and tested in a real browser (S5-9, S5-10, S5-15).
- **Same-origin routing** keeps CORS closed and makes the Stage 6 session cookie first-party (`SameSite=Strict` becomes possible) (S5-11).
- **Next.js request middleware is never used as a security boundary.** All access decisions stay in the API guard (Stage 4 default-deny). Middleware is used only to set headers and the CSP nonce. This avoids the class of bugs where middleware checks are bypassed.
- **No secrets in the browser:** the website holds no database credentials and has no `NEXT_PUBLIC_*` variables (S5-12).
- **Error hygiene** continues in the UI: users see plain language and a request id, never internals (S5-3, S5-6).
- **Privacy:** telemetry off; no third-party requests (the CSP blocks them).
- **Supply chain:** about 75 new packages (§8), mostly test tools. Next.js has a history of security advisories, so its version is checked at every stage alongside R-008 (OD-30 condition).
- **Database:** no change. **R-001 and R-007 remain open and production-blocking.** R-008 is reassessed (RISK_REGISTER.md).

## 7. Acceptance criteria (roadmap item 8, made measurable)

1. S5-1 to S5-13 and S5-15 to S5-20 pass. Counts reported; nothing skipped without explanation.
2. **One command** (`npm run dev`) starts web and API together and stops both (S5-13).
3. The security header baseline, including an enforced nonce-based CSP, is configured and tested on the production build (S5-9, S5-10).
4. Automated accessibility checks report **0 violations** on every Stage 5 page (S5-7), and the keyboard test passes (S5-8).
5. `npm audit` shows 0 high or critical findings; the dependency guard passes; only the dependencies in §3 (and OD-24's choice) are added.
6. The product baseline B5-1 to B5-5 is met (§3a), with design tokens still marked as placeholders if D-1 is not supplied.
7. Exclusions respected: no login, no user management, no identity tables, no data pages, no migration or data change, no CORS, `openapi/openapi.json` unchanged.
8. STAGE-05.md written with commands, results, screenshots if captured, and a PASS/FAIL recommendation per criterion; no claim of independent verification.

## 8. Dependency findings (trial install in a disposable copy)

All trials ran on 2026-10-17 in a throw-away copy of the project in the agent's scratch folder. **The repository was not changed.**

**Core packages and test tools** (`next` 16.4.2, `react` and `react-dom` 19.3.1, and the dev tools in §3):

| Check | Result |
|---|---|
| Packages added | 75 (Next.js and React alone: 17) |
| Dependency guard | PASS |
| `npm ls --all` | exit 0 |
| Install scripts | **No new ones** (only the two already denied in `allowScripts`) |
| `npm audit` | **0 high, 0 critical**, 20 moderate (the existing dev-only chain, R-004) |
| Module format | Next.js, React, Testing Library and jsdom load as CommonJS; a React component test ran under the **existing** Jest + ts-jest set-up (1/1 passed) |
| Next.js build | A minimal App Router page built successfully with `next build` on Node 24.21.0 |
| Release dates | `next` 16.4.2 was released 2026-10-15; `react` 19.3.1 2026-10-14; `@playwright/test` 1.64.1 2026-10-14. All are recent, so they are re-checked on the implementation day |

**Licences needing attention** (everything else is MIT, ISC, Apache-2.0, BSD or similar permissive):
- `@img/sharp-libvips-darwin-arm64` (**LGPL-3.0-or-later**): a native image library pulled in by Next.js's **optional** `sharp` package. PBE switches image optimisation off, so it is never loaded. It is still installed.
- `axe-core`, `@axe-core/playwright` (**MPL-2.0**): test-only, used unmodified.
- `caniuse-lite` (**CC-BY-4.0**): build-time browser data.
- From Stage 4: `busboy` and `streamsearch` (no licence field).

These are flagged for a licence review before any commercial release. **This is not legal advice, and the agent does not decide it.** It is proposed as risk R-009 (§10).

**OD-24 options** (each trialled with Next.js and React; counts include their 17 packages):

| Option | Packages | Guard / audit | Notes |
|---|---|---|---|
| A — Headless accessible primitives (Radix) + CSS Modules (built into Next.js) | `radix-ui` 1.8.1: 90 (+73). Individual `@radix-ui/react-*` packages, added only when needed, are far fewer | PASS / 0 high | MIT, CommonJS. No styling runtime, so it suits the strict CSP. Most design freedom; more hand-built styling |
| B1 — Complete library: MUI | `@mui/material` 9.5.0 + Emotion: 68 (+51) | PASS / 0 high | MIT, CommonJS. Emotion injects styles at run time, so the CSP must pass a nonce to the styling engine |
| B2 — Complete library: Mantine | `@mantine/core` 9.7.2 + hooks: 36 (+19) | PASS / 0 high | MIT, CommonJS. Ships plain CSS files; CSP compatibility of its provider to be confirmed if chosen |
| C — Hand-built only | 0 | — | No new supply chain. Complex widgets (dialogs, menus, comboboxes) are hard to make fully accessible by hand |

**R-008 reassessment** (Stage 5 preparation; logged in RISK_REGISTER.md):
- npm now tags NestJS 11.2.7 as `legacy` and 12.1.3 as `latest`. There has been no 11.x release since 2026-09-30.
- 12.1.3 is still ES-module-only.
- The repository audit shows 0 high or critical findings and none in NestJS or Express.
- **Still not production-blocking.** The `legacy` tag is a watch item.

## 9. Rollback

Code-only stage. Revert `apps/web`, the tooling and configuration changes, and `package.json` / `package-lock.json` to the Stage 4 state. No database change to undo. The Playwright browser in the user cache folder can be left or removed (`npx playwright uninstall`); it does not affect the project.

## 10. Decisions needed from the owner before implementation

1. **OD-24 — UI component and styling approach.** Recommendation: **Option A in its minimal form.**
   - Stage 5 builds its primitives on native HTML and CSS Modules, so **no UI package is added now**.
   - Individual Radix primitives (MIT, accessible) are added later, one at a time, only when a stage needs a complex widget. Each addition goes through the dependency guard and audit.
   - Reason: the smallest supply chain, the best fit with a strict content security policy, and full control over a clear, regulated-science look.
   - Trade-off: more styling work than a complete library. Option B2 (Mantine) is the lightest complete library if speed matters more.
   - A short visual comparison can be produced on request before you decide.
2. **OD-30 — Next.js version and browser-to-API routing (new).** Recommendation: **Next.js 16.4.2 (latest stable), with same-origin forwarding of `/api/v1/*` to the API and CORS kept closed.**
   - The alternatives are: the browser calling the API directly on port 3001 with a CORS allow-list; or Next.js server routes re-implementing each API call (duplicates logic).
   - Condition, like R-008: Next.js support and advisories are reassessed at every stage, and the version is updated only through the dependency gates.
3. **Proposed new risk R-009 — third-party licence review outstanding** (§8). Recommendation: record it now; **production-blocking until a licence review is done before any commercial release.**
4. **Design system reference (baseline D-1).** The baseline requires the agreed TechyPharma-inspired design system, but **no copy is in the repository**. Please supply it: for example a style guide, a brand document, or a list of colours and fonts, plus confirmation that PBE may use it. Without it, Stage 5 uses clearly marked neutral placeholder values, which can be swapped later without changing components. The agent will not invent brand values.
5. **Playwright browser download.** Confirm the one-off Chromium download into your user cache folder (outside the project), needed for the E2E and accessibility tests that ADR-015 requires.

Unchanged and preserved: TypeScript only; Next.js + NestJS; PostgreSQL only; Kysely with the dedicated data-access layer; the in-house type generator; hand-written SQL migrations (no Prisma Migrate, no Python); shared Zod contracts; the dependency guard. R-001 and R-007 stay open and production-blocking.
