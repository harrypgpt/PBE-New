# API Contract Standards

Status: Draft for product-owner review, MA-00, 2026-10-16.
Confirmed: ADR-002 (NestJS, versioned REST), R-02 (Zod). Open: OD-02 (how schemas are shared and turned into documentation), OD-08 (authentication).

## 1. Versioning and URLs
- Base path: `/api/v1`. A breaking change requires `/api/v2` for the affected resources. The old version stays until a documented deprecation date.
- Resources are plural nouns and nested no more than two levels deep: `/api/v1/projects/{projectId}/scenarios`.
- Actions that are not CRUD use a sub-resource verb: `POST /api/v1/dataset-versions/{id}/approve`.
- Identifiers are UUIDs. A tenant id never appears in the URL. Tenant context comes from the session plus the active-tenant selection, and is checked by the server.

## 2. Schemas and validation
- Every request body, query and path parameter, and every response body has a Zod schema in `packages/contracts`.
- Requests are validated at the controller boundary. Invalid requests get `400` with field-level details.
- Responses are validated in development and test environments. A mismatch fails the test. Production may log mismatches instead of failing; that is decided in Stage 4.
- Unknown request fields are rejected (strict objects). This prevents mass-assignment.
- Numbers with units are always sent as `{ value, unit }`. A bare number is never sent where a unit applies.
- Dates use ISO 8601 UTC strings.

## 3. Error responses
All errors use one shape, based on RFC 9457 "Problem Details":

```json
{
  "type": "https://pbe.local/problems/validation-error",
  "title": "Validation failed",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "2 fields are invalid.",
  "requestId": "…",
  "errors": [{ "path": "strength.unit", "message": "Unit is required." }]
}
```

- `code` is a stable machine-readable value listed in `packages/contracts`.
- Errors never include stack traces, SQL, other tenants' identifiers or confidential values.
- `404` is returned, rather than `403`, when revealing a resource's existence would leak cross-tenant information.

## 4. Authentication and authorisation
- Session cookie: `HttpOnly`, `Secure` (outside localhost), `SameSite=Lax` or stricter, with rotation on login and privilege change. CSRF protection applies to state-changing requests. Details depend on OD-08.
- Every route declares the permission it needs. Default deny: a route without a declared permission fails a Stage 4 test.
- Resource-level checks confirm that the resource belongs to the active tenant, in addition to RLS.

## 5. Lists: pagination, filtering, sorting
- Cursor pagination: `?limit=` (default 25, max 100) and `?cursor=`. The response has the form `{ items, nextCursor }`.
- Filters and sort fields are explicit per endpoint (allow-listed). `?sort=-updatedAt` sorts in descending order.
- No free-form query languages.

## 6. Idempotency
- These requests accept an `Idempotency-Key` header: creating prediction runs, approvals, uploads, report generation, and any request that triggers a job.
- Keys are stored for each tenant and user with a hash of the request. A repeated key with the same request returns the original response. A repeated key with a different request returns `409`.

## 7. Rate limiting
- Per-user and per-IP limits on authentication endpoints from Stage 6.
- Per-tenant limits on expensive operations (runs, simulations, uploads, retrieval) from the stage that adds them.
- Implemented in-process with PostgreSQL-backed counters where state must be shared. No Redis (ADR-008). Revisit only through a documented need.

## 8. API documentation
- OpenAPI 3.1 is generated from the Zod contracts (OD-02). It is not hand-maintained separately.
- A test fails if the committed OpenAPI file differs from the generated one.

## 9. Structured logging
- JSON logs with: timestamp, level, requestId, route, status, duration, tenantId (internal id), userId (internal id).
- **Never logged:** passwords, tokens, session ids, evidence values, file contents, extracted text, formulation details, consent free text. A redaction list plus tests enforce this from Stage 4.
- Audit events (who did what) are stored in `audit.audit_event`, not only in logs.

## 10. Configuration and secrets
- All configuration comes from environment variables, validated by a Zod schema at start-up. Invalid configuration stops start-up with a clear message.
- `.env` files are git-ignored. Only `.env.example` with placeholder values is committed.
- A secret scan runs in `verify` from Stage 1.

## 11. Dependency and supply-chain checks
- Lockfile committed; `npm ci` used for reproducible installs.
- Each new dependency is listed in the stage report with its purpose, licence, maintenance status and alternatives considered.
- `npm audit` (or an approved equivalent) runs in `verify`. High or critical findings must be resolved or explicitly accepted by the owner, with a reason.
- Install scripts of new packages are reviewed. Exact versions are pinned.

## 12. Testing levels (summary)
Unit, integration (real PostgreSQL), API contract, end-to-end (browser), security and scientific regression. See [TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md).
