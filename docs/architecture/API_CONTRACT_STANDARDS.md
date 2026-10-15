# PBE — API Contract Standards

> **Status:** Baseline v0.1. Applies to every endpoint from Stage 1 onward. A new endpoint that breaks these standards fails its stage gate.

---

## 1. Base and versioning

- Base path: `/api/v1`. Breaking changes require `/api/v2` alongside v1, with a deprecation window announced through the `Deprecation` and `Sunset` headers.
- **Non-breaking** changes (adding optional fields, new endpoints) stay within v1.
- **Breaking** changes include removing or renaming fields, changing types or meaning, and making optional fields required.
- Health endpoints sit outside versioning: `/health/live` and `/health/ready`. They return no tenant data.

## 2. Resource naming

- Plural, kebab-case nouns: `/api/v1/projects`, `/api/v1/dataset-versions`.
- Nesting is limited to one level of ownership: `/api/v1/projects/{projectId}/scenarios`.
- Actions that are not CRUD use `POST` to a verb sub-path, e.g., `POST /api/v1/dataset-versions/{id}/freeze`. The `:verb` suffix style is not used.
- Representative endpoints:

| Method & path | Purpose |
|---|---|
| `POST /api/v1/auth/login` · `POST /api/v1/auth/logout` · `GET /api/v1/me` | Authentication/session |
| `GET/POST /api/v1/projects` · `GET/PATCH /api/v1/projects/{id}` | Projects |
| `GET/POST /api/v1/projects/{id}/scenarios` | Scenarios |
| `POST /api/v1/scenarios/{id}/dataset-versions` | Create draft version |
| `POST /api/v1/dataset-versions/{id}/submit-for-review` · `/approve` · `/freeze` | Lifecycle |
| `POST /api/v1/files` (multipart) · `GET /api/v1/files/{id}/download` | Files |
| `POST /api/v1/files/{id}/extractions` | Start extraction |
| `GET /api/v1/dataset-versions/{id}/readiness` | Readiness/applicability preview (no run created) |
| `POST /api/v1/runs` · `GET /api/v1/runs/{id}` · `POST /api/v1/runs/{id}/reproduce` | Runs |
| `POST /api/v1/runs/{id}/reports` · `POST /api/v1/scenario-comparisons` | Reports |
| `GET/POST /api/v1/consent-grants` · `POST /api/v1/consent-grants/{id}/revoke` | Consent |
| `/api/v1/owner/...` | Owner console (platform role only, separate guard) |

## 3. Request and response format

- JSON (`application/json; charset=utf-8`), except for file upload (multipart) and downloads.
- Fields are `camelCase`. Enums are `UPPER_SNAKE_CASE`.
- Timestamps use ISO 8601 UTC (`2026-10-13T09:00:00Z`).
- **Scientific numbers are sent as strings** in decimal notation (e.g., `"0.9512"`) together with a `unit`, so binary floating point cannot change them. Display rounding happens in the UI only.
- A scientific value in a response is an object:

```json
{
  "value": "102.3",
  "unit": "ng/mL",
  "origin": "EXTRACTED",
  "reviewStatus": "APPROVED",
  "provenanceId": "0192f3c4-…",
  "raw": { "text": "102.3 ng/ml", "value": "102.3", "unit": "ng/ml" }
}
```

- Single resource: `{ "data": { ... } }`. Collection: `{ "data": [ ... ], "page": { ... } }`.
- Schemas are defined once in `packages/contracts` and used by both API validation and the web client (library: OD-003).

## 4. Validation

- Every request body, query and path parameter is validated at the controller boundary **before** any service code runs. Unknown properties are rejected (`whitelist` + `forbidNonWhitelisted` or the equivalent).
- Scientific validation (units, ranges, required combinations) happens in the domain layer and returns field-level errors.
- Validation never silently corrects input. For example, an unrecognised unit is an error, not a guess.

## 5. Error format

Errors use RFC 9457 *Problem Details* (`application/problem+json`):

```json
{
  "type": "https://pbe.local/problems/validation-error",
  "title": "Validation failed",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "detail": "2 fields are invalid.",
  "requestId": "req_01J…",
  "errors": [
    { "path": "dissolutionPoints[3].unit", "code": "UNIT_UNKNOWN", "message": "Unit 'mg%' is not recognised." }
  ]
}
```

| Status | Use |
|---|---|
| 400 | Malformed request |
| 401 | Not authenticated |
| 403 | Authenticated but not permitted |
| 404 | Not found **or not visible to this tenant**. Never reveal whether another tenant's resource exists |
| 409 | Conflict (stale `row_version`, invalid state transition, frozen resource) |
| 412 | Missing or failed `If-Match` precondition |
| 413 / 415 | File too large / unsupported type |
| 422 | Semantic or scientific validation failure |
| 429 | Rate limited (with `Retry-After`) |
| 500 | Unexpected error. Generic message plus requestId; no stack traces or data |

Error messages must **never** include scientific values, file contents, SQL or secrets.

## 6. Authentication and authorization

- Browser clients authenticate with a **server-side session** stored in an `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`) cookie, with CSRF protection on state-changing requests. Future machine-to-machine access uses scoped API tokens (OD-009).
- Every endpoint declares a required permission (e.g., `runs:create`) with a decorator. The default is **deny**: an endpoint without a declared permission fails a CI check.
- Owner endpoints (`/api/v1/owner/**`) require a platform role and are checked by a separate guard. Tenant roles can never satisfy them.

## 7. Tenant-scoped access

- The active tenant is resolved from the authenticated session (the user picks among their memberships), **never** from the request body.
- The tenant context is applied to each database transaction (`SET LOCAL app.tenant_id`) by shared infrastructure, not by each developer.
- Every repository query on tenant data runs inside that context. Integration tests prove that cross-tenant reads return 404 and cross-tenant writes fail.

## 8. Pagination, filtering, sorting

- **Cursor pagination** by default: `?limit=50&cursor=…`; the maximum limit is 200. The response is `page: { nextCursor, limit }`.
- Filtering: `?filter[status]=FROZEN&filter[createdAt][gte]=2026-01-01`. Only fields on a per-endpoint allow-list may be filtered.
- Sorting: `?sort=-createdAt,name`. Only allow-listed fields are accepted.

## 9. Rate limits

- Per-user and per-IP limits for auth endpoints (login, password reset, MFA).
- Per-tenant limits for expensive operations (runs, extractions, report generation, fetch requests).
- Limits are configuration. Initial values are set in Stage 3 and Stage 16. Local in-process limiting is enough for a single instance. A shared store is needed only for multiple instances (deployment stage).

## 10. Idempotency

- `POST` operations that create runs, start extractions, generate reports, freeze versions, upload files or fetch external data **require** an `Idempotency-Key` header (UUID).
- The server stores key + user + tenant + request hash + response for 24 h (configurable). Same key and same body returns the stored response. Same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`.
- Updates use optimistic concurrency: `ETag` / `If-Match`, based on `row_version`.

## 11. Long-running operations

Asynchronous operations return `202 Accepted` with `{ data: { id, status: "QUEUED" } }` and `Location`. Clients poll `GET` (later: server-sent events). Status values are documented per resource.

## 12. API documentation

- An OpenAPI 3.1 document is generated from code and served at `/api/docs` in non-production environments only.
- CI fails if the generated spec differs from the committed `openapi.json` without a matching change note.
- Each endpoint documents its permission, idempotency requirement, error codes and an example.

## 13. Logging

- Use structured JSON logs with `requestId`, `tenantId` (an ID, not a name), `userId`, route template, status and duration.
- **Never log:** request or response bodies, scientific values, file names or contents, formulation details, tokens, passwords, cookies or keys.
- Redaction is enforced by a logger serializer allow-list, and tests feed known secrets and assert that they never appear in log output.

## 14. Configuration and secrets

- Configuration comes from environment variables validated at startup against a typed schema. The app refuses to start when configuration is invalid.
- Secrets are never committed. `.env.example` lists names only. Production secrets come from a secret manager (OD-015).
- A secret-scanning check runs in CI.
