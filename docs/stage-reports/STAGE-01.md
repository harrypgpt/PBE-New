# Stage 1 — Repository Skeleton and Tooling — Completion Report

Date: 2026-10-15 Result: **PASS WITH WAIVERS** (one waiver requested: OD-041, development-only audit findings; see §8)

Authorised by the owner in PBE-01, with OD-001 (npm workspaces), OD-003 (Zod), OD-023 (git, local) and OD-028 (Jest) approved.

## 1. Scope delivered

- npm-workspaces monorepo: `apps/api` (NestJS), `apps/web` (Next.js + React), `packages/contracts` (Zod), `packages/science-core` (empty, reserved).
- Strict TypeScript, ESLint (with architecture rules), Prettier, Jest across all workspaces.
- `GET /health/live` (outside `/api/v1`, per API standards) and one web status page that calls it and validates the reply with the shared Zod contract.
- API configuration validated with Zod at startup; the app refuses to start on invalid configuration.
- OpenAPI 3.1 document generated from the Zod contracts and committed (`openapi/openapi.json`), with an up-to-date check.
- Toolchain policy check (no Python, no Prisma, no native builds) and a clean-install-without-Python check.
- Secret scan; `.gitignore` for dependencies, build output, `.env` files and local data.
- `npm run verify` (whole gate in one command) and `npm run dev`; owner README; `.env.example` files without secrets.

**Not delivered, by design:** database, schemas, authentication, scientific calculations, ML, AI or business features.

## 2. Files created / changed

Created: all files under `apps/`, `packages/`, `tooling/`, `openapi/`, plus the root files `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.mjs`, `jest.config.js`, `README.md`, `.gitignore`, `.npmrc`, `.nvmrc`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`, and this report.

Changed (documentation only, recording decisions; no architecture decision altered):

- `docs/architecture/OPEN_DECISIONS_REGISTER.md`: OD-001/003/023/028 closed as approved; decision log updated; new open items OD-039, OD-040, OD-041.
- `docs/architecture/ARCHITECTURE_DECISIONS.md`: ADR-002 status Proposed → Accepted (OD-001 approved); revision history v0.3.

## 3. Acceptance criteria — evidence

| #   | Criterion (roadmap S1)                                    | Evidence                                                                                                                                                                                                                               | Result |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `npm install` and `npm run verify` succeed from a fresh clone | `git clone` of commit `7976b25` into a new folder → `npm ci` (515 packages, exit 0) → `npm run verify`: 11/11 steps PASS, exit 0                                                                                                     | PASS   |
| 2   | `GET /health/live` returns 200 (integration test)         | `apps/api/test/health.e2e.spec.ts` (real HTTP server): 200, JSON, body matches contract; also manual run of the built API: `HTTP/1.1 200 OK`, `{"status":"ok","service":"pbe-api"}`                                                    | PASS   |
| 3   | A lint test proves an illegal cross-tier import fails     | `tooling/tests/lint-boundaries.spec.cjs` runs the real ESLint CLI and config: upward, unlisted same-tier and unregistered-module imports fail; allowed imports pass (13 tests)                                                          | PASS   |
| 4   | The OpenAPI spec is generated and committed               | `openapi/openapi.json` (OpenAPI 3.1, generated from Zod); `npm run openapi:check` PASS; 6 contract tests incl. "only references components that exist"                                                                                | PASS   |
| 5   | The secret scan runs and passes                           | `npm run check:secrets`: 82 files scanned, PASS. Negative control: a planted fake AWS key made it FAIL (exit 1) and reported file/line/pattern only                                                                                     | PASS   |
| 6   | Toolchain policy: no Python, no Prisma, `npm ci` without Python, no node-gyp builds | `npm run check:toolchain` PASS (589 lockfile entries). `npm run check:toolchain:install`: Python removed from PATH (1291 tools linked, none python*/pip*), clean `npm ci` PASS. Negative control: planted `.py` and `.prisma` files made it FAIL | PASS   |

Standard stage gate (TESTING_AND_ACCEPTANCE_GATES §3): items 1–4, 7 (no science yet: not applicable), 8 (toolchain part), 9, 10, 11 met. Items 5, 6 and the schema-change part of 8 start at Stages 2–5. Item 12 (owner authorisation of Stage 2) is pending.

## 4. Commands executed and actual results

| Check                         | Command                           | Actual result                                                                        |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| Dependency installation       | `npm install`                     | exit 0, 515 packages added                                                           |
| Shared packages build         | `npm run build:packages`          | exit 0                                                                               |
| TypeScript checks             | `npm run typecheck`               | exit 0 (contracts, science-core, api, web)                                           |
| Lint                          | `npm run lint`                    | exit 0, 0 errors, 0 warnings                                                         |
| Formatting                    | `npm run format:check`            | exit 0 (after fixes; see §6)                                                         |
| Jest                          | `npm test`                        | 9/9 suites, 84/84 tests passed, 0 failed, 0 skipped                                  |
| Backend production build      | `npm run build:api`               | exit 0                                                                               |
| Frontend production build     | `npm run build:web`               | exit 0, Next.js 16.4.0 (Turbopack); `/` server-rendered on demand                    |
| OpenAPI                       | `npm run openapi:check`           | PASS                                                                                 |
| Toolchain policy              | `npm run check:toolchain`         | PASS                                                                                 |
| Install without Python        | `npm run check:toolchain:install` | PASS                                                                                 |
| Secret scan                   | `npm run check:secrets`           | PASS                                                                                 |
| Full gate                     | `npm run verify`                  | 11/11 PASS, exit 0 (final run after all fixes)                                       |
| Fresh clone                   | `git clone` → `npm ci` → `verify` | 11/11 PASS, exit 0                                                                   |
| Runtime smoke (built apps)    | `node dist/main.js` + `next start` | API 200; `/api/v1/health/live` 404; web shows "API reachable", then "API not reachable" after the API stops |
| Dev command                   | `npm run dev`, then Ctrl+C        | both apps up in ~4 s; web "API reachable"; all processes stopped; tree left clean     |
| Dependency audit              | `npm audit` / `npm audit --omit=dev` | 24 findings (20 moderate, 4 high), **all development-only**; production: 0 (see §6) |

## 5. Test totals

| Project              | Suites | Passed | Failed |
| -------------------- | ------ | ------ | ------ |
| tooling              | 3      | 40     | 0      |
| packages/contracts   | 3      | 25     | 0      |
| apps/api             | 2      | 14     | 0      |
| apps/web             | 1      | 5      | 0      |
| **Total**            | **9**  | **84** | **0**  |

Zod validation tests with valid and invalid inputs: 19 contract-schema tests (health response, problem details) and 10 API-configuration tests. The web health-check tests also validate replies through the shared schema.

## 6. Problems found during the stage and how they were resolved

1. **Formatting check failed** on first run (15 files). Fixed with Prettier; formatting and lint re-run: PASS.
2. **4 of 81 tests failed** on first run:
   - OpenAPI generation produced broken `#/$defs/...` references inside components. **Real bug.** Fixed by registering schemas in a contracts registry so references point to `#/components/schemas/...`; a test now checks every `$ref` resolves.
   - Relative imports between apps (e.g. web → `../../../api/...`) were **not caught** by name-based lint patterns. **Real gap.** Fixed with a new path-resolving rule `pbe/no-cross-app-imports`.
   - The secret scanner reported an Anthropic-style key twice (two patterns overlapped). Fixed.
   Full Jest suite re-run: 84/84 PASS.
3. **`next dev` created an untracked `apps/web/AGENTS.md`** on every run (a Next.js 16 feature that writes notes for AI coding tools). Disabled with `agentRules: false` in `apps/web/next.config.ts`; generated file removed; dev run and full verify re-run: PASS, tree clean.

## 7. Dependency changes and reasons

All versions pinned exactly (`save-exact`). Lockfile committed.

| Package                                         | Where          | Why                                                                                                     |
| ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `typescript` 6.0.3                              | root (dev)     | Compiler. **6.0.3, not 7.x**: TypeScript 7 is a native Go binary (excluded by ADR-022); 6.0.3 is the latest JavaScript release and is supported by ts-jest and typescript-eslint |
| `jest` 30.5.2, `ts-jest` 29.4.14, `@types/jest` | root (dev)     | Approved test runner (OD-028); ts-jest runs TypeScript tests                                              |
| `eslint` 10.12.0, `@eslint/js`, `typescript-eslint` | root (dev) | Linting incl. architecture rules                                                                         |
| `@next/eslint-plugin-next`, `eslint-plugin-react-hooks` | root (dev) | Next.js and React correctness rules (chosen instead of the much larger `eslint-config-next`)            |
| `prettier` 3.9.10                               | root (dev)     | Formatting                                                                                              |
| `@types/node` 24.19.2                           | root (dev)     | Matches the Node 24 runtime                                                                             |
| `zod` 4.6.7                                     | contracts, api | Approved schema library (OD-003); also produces the OpenAPI schemas (no extra OpenAPI library)          |
| `@nestjs/common`, `/core`, `/platform-express` 11.2.7, `reflect-metadata`, `rxjs`; `@nestjs/testing` (dev) | api | Backend framework. **11.2.7, not 12.x**: NestJS 12 is ESM-only and Jest supports ESM only experimentally (OD-039) |
| `next` 16.4.0, `react`/`react-dom` 19.3.0, `@types/react(-dom)` | web | Frontend framework                                                                          |

Deliberately **not** added: Nest CLI, supertest (tests use Node's built-in `fetch`), dotenv (Node's `--env-file-if-exists`), concurrently (small `dev.cjs`), any OpenAPI generator, gitleaks or other secret scanners (small in-house scanner), `globals`, `eslint-config-next`.

Install scripts: two transitive Jest dependencies declare them (`@parcel/watcher`, `unrs-resolver`). Neither compiles anything by default; both use prebuilt binaries. They are allow-listed with reasons in `tooling/toolchain-allowlist.json`. npm 11 does not run them (not approved via allowScripts), and they are not needed.

## 8. Known issues, limitations and waivers

- **OD-041 (waiver requested):** `npm audit` reports 24 findings from two root advisories, `braces` ≤3.0.3 (high) and `sprintf-js` ≤1.1.3 (moderate), both denial-of-service on attacker-controlled patterns/format strings. They reach the project only through **development tools** (ESLint Next plugin, Jest). **No patched versions exist**, so overrides cannot fix them. `npm audit --omit=dev`: **0 findings**. Proposed waiver: until Stage 3, re-checked at every gate.
- The secret scanner is pattern-based. It catches common credential formats but is not exhaustive and does not replace review.
- Criterion 1 was run on a local `git clone`; no network clone was performed.
- `npm run dev` and the web build scripts set `NEXT_TELEMETRY_DISABLED=1` using macOS/Linux shell syntax; Windows would need a different syntax.
- Cosmetic: NestJS logs the health controller under `/api/v1/health` at startup, but the route actually served is `/health/live` (verified: `/api/v1/health/live` returns 404).
- **Git:** this session did not create any commit. A commit `7976b25 Initial PBE project architecture` (author `harrypgpt`) already exists, and a remote `origin` (`https://github.com/harrypgpt/PBE-New.git`) is configured; no local sign of a push. Please confirm the GitHub repository is private. Uncommitted after this stage: `apps/web/next.config.ts`, the two register/ADR edits, and this report.

## 9. Decisions made / new open decisions

- Closed (owner, PBE-01): OD-001, OD-003, OD-023, OD-028.
- New, awaiting owner decision:
  - **OD-039:** stay on NestJS 11 for now (used in Stage 1) vs. move to ESM-only NestJS 12.
  - **OD-040:** `evidence → science` in MODULE_BOUNDARIES.md points upward (tier 3 → tier 4). Encoded as an explicit labelled exception in `tooling/module-boundaries.json` pending decision; recommended fix is for `evidence` to call `packages/science-core` directly.
  - **OD-041:** waiver for development-only audit findings.

## 10. Recommended next stage

Stage 2 (Database baseline, migrations, backup/restore) after the owner reviews this report. It is blocked by OD-002, OD-004 and OD-037, and by OD-038 for applying migrations beyond local/test. PostgreSQL is not yet installed on this machine.
