# Stage 4 Plan — API foundation

Status: **Approved and authorised 2026-10-17.** OD-02 → ADR-022 and OD-29 → ADR-023 approved; R-008 recorded. **Implemented 2026-10-17. Results: [STAGE-04.md](../stage-reports/STAGE-04.md).**
Source: [IMPLEMENTATION_ROADMAP.md, Stage 4](../IMPLEMENTATION_ROADMAP.md#stage-4--api-foundation) and [API_CONTRACT_STANDARDS.md](../architecture/API_CONTRACT_STANDARDS.md). Scope is **not** expanded. Points where the roadmap leaves a detail open are marked **[detail]**.

## 1. Objective (plain language)

Turn `apps/api` into a running NestJS server with a single, safe "front door" (`/api/v1`). Every request and response is checked against shared definitions. Every error has the same safe shape. Logs never contain secrets or scientific data. A health page reports whether the database is reachable and at the expected migration version. Every route must declare who may call it. There are still no logins, users or business features.

## 2. Prerequisites

| Item | Status |
|---|---|
| Stage 3 PASS | Approved 2026-10-17 (STAGE-03.md §13; not independently verified) |
| **OD-02** shared schema validation and API documentation | **Open — owner approval needed.** Refined recommendation in the register: Zod 4 in `packages/contracts`, in-house validation pipe, in-house OpenAPI 3.1 from Zod's native JSON Schema, no extra dependency |
| **OD-29** NestJS version and HTTP adapter (new) | **Open — owner approval needed.** Recommendation: NestJS **11.2.7 + Express** (§6) |
| ADR-015 Jest | Unchanged by the recommendation (NestJS 11 runs under the existing Jest set-up) |
| Database | No migration is planned. The health check uses the Stage 3 data-access layer as `pbe_app` (it already has SELECT on the ledger) |
| Administrator password | **Not needed** |

## 3. Scope (roadmap items 1–5, nothing added)

| Roadmap item | Plan |
|---|---|
| NestJS application with `/api/v1` | `apps/api/src/main.ts` (bootstrap), `app.module.ts`. Global prefix `api/v1`. Express adapter. Listens on `PBE_API_PORT` (default **3001**) **[detail]** on `127.0.0.1` |
| Configuration validation | `config` module: a Zod schema for all environment variables, checked at start-up. Invalid or missing values stop start-up with a clear message that **never prints values** |
| Zod validation pipe | In-house pipe: strict objects (unknown fields → 400), field-level errors. Responses are validated in dev and test (a mismatch is a test failure) |
| Problem-Details errors | One global exception filter: RFC 9457 shape `{type, title, status, code, detail, requestId, errors?}`. **No stack traces, SQL, driver messages or other tenants' ids** in responses. Unknown route → 404. Unexpected error → 500 with a generic message |
| Structured, redacted logging | In-house JSON logger (NestJS `LoggerService`), no extra dependency. Fields: timestamp, level, requestId, method, route, status, duration. A redaction list covers passwords, tokens, cookies, authorisation headers, connection strings, `PBE_PG_*` values and request/response bodies, which are never logged |
| Request ids | Accept an incoming `X-Request-Id` only if it is a well-formed UUID, otherwise generate one. Echo it in the response header and in every Problem Details body and log line |
| Health endpoint | `GET /api/v1/health`. Checks the database through the data-access layer (`SELECT 1`) and that the migration ledger matches the expected schema version. 200 `{status:"ok"}` or 503 Problem Details. Reveals no version numbers, hostnames or errors to callers; details go to logs |
| Default-deny permission decorator | Every route must carry `@RequirePermission(…)` or an explicit `@PublicRoute('reason')`. A guard rejects (403) any route without one. A start-up check and a test fail if any route lacks a declaration. Only `health` is public in Stage 4 |
| OpenAPI generation | `openapi/openapi.json` (OpenAPI 3.1) assembled from the route contracts in `packages/contracts`, committed. A test fails if it differs from a fresh generation. A `verify` step is added |
| Start-up refuses on ledger mismatch | **[detail]** The type generator also emits `SCHEMA_VERSIONS` (the migration versions it was generated from) into `database-types.ts`, already checked by `typegen --check`. At start-up the API compares this with the ledger. Any difference, or an unsafe runtime role (`assertSafeRuntimeRole`, Stage 3), stops start-up |
| `packages/contracts` | `problem-details.ts`, `health.ts`, `request-id.ts`, and the route-contract registry used by the API and the OpenAPI generator |

**Dependencies (subject to OD-02 and OD-29):**
- `apps/api`: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` (11.2.7), `reflect-metadata`, `rxjs`, `zod`.
- dev: `@nestjs/testing` 11.2.7.
- `packages/contracts`: `zod`.
- Nothing else. HTTP tests use Node 24's built-in `fetch` against a real listening server, so no supertest.
- TypeScript: `experimentalDecorators` and `emitDecoratorMetadata` for `apps/api` only.
- Lint: `packages/contracts` may import only `zod`, as today.

## 4. Exclusions (roadmap item 3, plus existing roadmap boundaries)

- **No authentication**, users or sessions (Stage 6). The permission decorator exists, but there are no permissions to grant yet.
- **No domain modules** or business endpoints.
- No rate limiting (Stage 6). No CORS (the web app arrives in Stage 5; CORS stays closed until then).
- No security-header middleware dependency. Basic headers (`X-Content-Type-Options: nosniff`, no `X-Powered-By`) are set without a package; the full header policy is Stage 5 and Stage 28.
- No new database objects or migrations. No changes to `pbe_dev` data.
- No Swagger UI. The OpenAPI file is generated; viewing it is optional and outside this stage.

## 5. Test plan (roadmap item 6, each named; real PostgreSQL where a database is involved)

| # | Test | Expected |
|---|---|---|
| S4-1 | Config: each required variable missing; invalid port; invalid database name | Start-up refused; message names the variable, **never its value** |
| S4-2 | Invalid request body or query (wrong type, missing field, **unknown extra field**) | 400 Problem Details with field paths; `code: VALIDATION_FAILED` |
| S4-3 | Unknown route; wrong method | 404 / 405 Problem Details (same shape) |
| S4-4 | Unexpected exception in a handler | 500 Problem Details, generic text; **no stack, SQL or driver text** in the body; details only in the log |
| S4-5 | Log redaction: requests carrying a password, token, cookie, authorisation header, connection string and an evidence-like body | **None of the values appear** in captured log output; request id and route do |
| S4-6 | Request id: valid incoming id echoed; malformed id replaced; id present in header, Problem Details and log | Pass |
| S4-7 | OpenAPI in sync: regenerate in memory and compare with the committed `openapi/openapi.json` | Identical; a deliberately stale copy fails |
| S4-8 | Default deny: a test controller route without a permission declaration | Rejected by the start-up check, and by the guard (403) if forced to run |
| S4-9 | Health against **real PostgreSQL** (`pbe_test`, as `pbe_app`) | 200 `{status:"ok"}`, validated against the contract |
| S4-10 | Health when the database is unreachable (wrong port), or the ledger differs from `SCHEMA_VERSIONS` | 503 Problem Details; no internal detail in the body |
| S4-11 | **Start-up refuses** on ledger mismatch, and on an unsafe runtime role (fixture configuration) | The process does not start; a clear log reason |
| S4-12 | Response contract enforcement: a handler returning an extra or missing field (fixture) | Test fails (500 in dev/test) |
| S4-13 | Manual (roadmap item 7): owner opens `http://localhost:3001/api/v1/health` after `npm run dev:api` | Shows `{"status":"ok"}` |
| S4-14 | Mutation checks (scratch copy): remove the redaction rule; remove the default-deny guard; let the filter pass through raw errors | The matching tests fail |
| S4-15 | Regression: every Stage 1–3 test; full `npm run verify` (plus a new "OpenAPI in sync" step) | All pass |

## 6. Security implications

- **Error hygiene:** one filter for every error, so stack traces, SQL and driver messages never reach callers (S4-4, S4-14).
- **Log hygiene:** redaction is tested with real secret-shaped values. Bodies are never logged. The `.env` passwords never appear (S4-5).
- **Mass assignment:** strict schemas reject unknown fields (S4-2).
- **Default deny:** a route without a declared permission cannot be served (S4-8). This is the foundation for Stage 6–7 authorisation.
- **Database:** the API still connects only as `pbe_app` through the Stage 3 gateway and refuses to start with an unsafe role or a schema mismatch (S4-11). **R-001 and R-007 are unchanged and remain production-blocking.**
- **Dependencies:** NestJS 11 is one major behind (OD-29). Proposed as new risk R-008 if approved; re-evaluated every stage. The audit gate stays at "no high or critical".

## 7. Acceptance criteria (roadmap item 8, made measurable)

1. S4-1 to S4-12, S4-14 and S4-15 pass. Counts reported; nothing skipped without explanation.
2. The generated OpenAPI file is committed and in sync (S4-7; `verify` step).
3. The audit shows 0 high or critical findings, the dependency guard passes, and only the dependencies listed in §3 are added.
4. Health runs against real PostgreSQL 18 through the data-access layer as `pbe_app`.
5. Exclusions respected: no authentication, domain modules, migrations or data changes.
6. STAGE-04.md written with commands, results, and a PASS/FAIL recommendation per criterion; no claim of independent verification.

## 8. Rollback

Code-only stage. Revert `apps/api`, `packages/contracts`, `openapi/` and the configuration files to the Stage 3 state. No database change to undo.

## 9. Decisions needed from the owner before implementation

1. **OD-02:** approve option A as refined (Zod 4 in `packages/contracts`, in-house validation pipe, in-house OpenAPI 3.1 from Zod; no extra dependency).
2. **OD-29:** approve option A (NestJS 11.2.7 + Express), with "one major behind" tracked as risk R-008.
