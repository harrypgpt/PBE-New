# PBE — Security, Privacy and Tenancy

> **Status:** Baseline v0.1, design intent. These controls are **not implemented yet**. Implementing them does **not** by itself make PBE certified or legally compliant with any regulation (GDPR, 21 CFR Part 11, EU GMP Annex 11, ISO 27001, SOC 2, etc.). Such claims need formal assessment (OD-016).

---

## 1. Threat model summary

| Threat | Primary controls |
|---|---|
| One tenant reads/modifies another tenant's data | App-layer tenant guard **and** PostgreSQL RLS (forced); composite tenant foreign keys; `security_invoker` views; 404-on-foreign; automated tests T-ISO-01 to T-ISO-14 (TESTING §5) |
| Compromised user account | MFA, session limits, lockout/rate limits, least-privilege roles, audit trail |
| Insider at platform operator | No default owner access to tenant content; break-glass with approval, time limit and audit; key access separated from DB access where hosting allows |
| Malicious file upload | Type allow-list, content sniffing, size limits, malware scanning (OD-027), parsing in a constrained worker, no execution of macros |
| Data exfiltration via logs/errors | Log redaction allow-list; generic error messages |
| Sponsor data leaks to an AI vendor | AI disabled by default; no external calls without an approved data-processing design plus tenant opt-in |
| Data in training without consent | Consent gate at dataset assembly; eligibility re-checked; audit |
| Tampering with results | Immutable runs, content hashes, hash-chained audit trail |
| Supply-chain risk | Minimal dependencies, lockfile, dependency audit in CI, pinned versions; TypeScript/Node-only toolchain with no install-time native builds (`node-gyp`/Python) (ADR-022) |

## 2. Authentication

- **Initial (proposed):** email + password (Argon2id hashing) + TOTP MFA, which tenants can make mandatory. Passwords are checked against length rules and a breached-password list where feasible.
- **Later:** OIDC/SAML single sign-on per tenant (OD-009).
- Sessions are server-side, rotated on login and privilege change, with idle and absolute time-outs (configurable), and can be revoked by the user and the tenant admin.

## 3. Authorization (RBAC with permissions)

- A platform-defined **permission catalogue**, e.g., `projects:read`, `projects:write`, `evidence:approve`, `datasetVersions:freeze`, `runs:create`, `reports:export`, `consent:manage`, `audit:read`, `users:manage`.
- **Roles** are tenant-configurable bundles of permissions. Default templates: Tenant Admin, Scientist, Reviewer, Viewer, Auditor.
- Assignments may be scoped to the tenant, a department or a project (OD-033: confirm scoping depth for v1).
- **Segregation of duties (configurable):** the user who entered or extracted a value may be prevented from approving it. Recommended default: ON for approval of extracted and external data.
- **Platform roles** (Owner, Operator) are a separate namespace and never grant tenant data access implicitly.

## 4. Tenant isolation and the owner's access model

- See ADR-004, ADR-021 and [DATA_AND_DATABASE_DESIGN.md](DATA_AND_DATABASE_DESIGN.md) §10. Isolation is proven by automated tests T-ISO-01 to T-ISO-14 ([TESTING_AND_ACCEPTANCE_GATES.md](TESTING_AND_ACCEPTANCE_GATES.md) §5). Any schema change that adds a tenant table without RLS fails T-ISO-01 automatically.
- **Owner access to tenant content: none by default.** The owner sees:
  - aggregate, non-identifying platform metrics,
  - the learning dashboard built **only** from consent-eligible, pseudonymised data,
  - technical traces without scientific content.
- **Break-glass** support access (OD-026) requires a tenant-admin approval or a documented emergency reason, is time-boxed, appears in the tenant's audit trail, and generates a notification to the tenant admin.

## 5. Encryption and key management

| Layer | Control |
|---|---|
| In transit | TLS 1.2+ (prefer 1.3) for all external traffic; TLS to the database in cloud deployments |
| At rest — database | Storage-level encryption provided by the managed database/disk |
| At rest — files | Envelope encryption: per-file data key (AES-256-GCM), wrapped by a per-tenant key-encryption key (KEK) in a KMS |
| Backups | Encrypted; keys separate from backup storage |
| Highly sensitive fields (optional) | Application-level field encryption for selected columns (decided per stage; it limits querying) |

### 5.1 Trust boundaries — honest statement
- Encryption at rest protects against stolen disks, backups and storage-level access. It does **not** protect against someone who controls both the running application and its key access.
- Platform operators with production KMS **and** application access could, in principle, decrypt tenant data. The design reduces this risk through separation of duties, break-glass procedures, audit and key-access logging. It does **not** eliminate it.
- Tenant-managed keys (BYOK/HYOK) could further reduce the risk. This is a future option (OD-025), and it also has operational consequences, such as data becoming unrecoverable if the tenant loses its key.
- In **local development**, keys sit in a local file and give **no** meaningful protection. Real or confidential sponsor data must not be used in local development unless the owner explicitly approves it (OD-034).

## 6. Secure file handling

- Allow-list by extension **and** detected content type. Size limits per type.
- Files are stored outside the web root under random storage keys. Download goes only through an authorised endpoint with `Content-Disposition: attachment`.
- Parsing happens in the worker, with time and memory limits. No macros, embedded scripts or external links are executed or followed. XML parsers have external entities disabled.
- Malware scanning hook: files stay `PENDING` and cannot be parsed until scanned `CLEAN` (scanner choice: OD-027). Development may use a documented "scanner unavailable → block or allow-with-warning" setting, which is **block** by default.

## 7. Safe exports

- Reports and exports are generated server-side from immutable runs and stored as artifacts with a hash.
- Each export carries tenant name, run IDs, generation time, user, the decision-support disclaimer and a limitations section.
- Export requires `reports:export` and is audited.
- CSV/XLSX exports are protected against formula injection: cells starting with `= + - @` are escaped.

## 8. AI provider data protection (L5)

No sponsor data may be sent to an external AI provider unless **all** of the following are true:
1. The owner has approved a written data-processing design: provider, region, retention, training opt-out, contractual terms.
2. The tenant has opted in, with a scope.
3. A redaction/minimisation policy is applied and logged per request.
4. Every call is recorded in the audit trail, with the payload category, not the payload content.

Until then, `NullAiProvider` is the only provider. A future *local* model option is acceptable under the same governance.

## 9. Privacy (GDPR-relevant controls)

PBE mainly handles **commercial confidential** scientific data. It may also hold **personal data**: user accounts and, potentially, subject-level clinical PK data, which must be pseudonymised *before* upload (OD-035).

| Control | Design |
|---|---|
| Data minimisation | Subject identifiers allowed only as sponsor pseudonyms; no names, dates of birth or contact details; upload validation warns about likely direct identifiers |
| Purpose limitation | Training use only via explicit, separate consent (§10) |
| Data subject rights (users) | Export and deletion of user account data; audit entries keep pseudonymous actor IDs |
| Retention | Configurable retention classes (OD-014); scheduled purge with audit |
| Erasure of immutable records | Crypto-shredding (destroy the wrapping keys) plus purge job; recorded in a tombstone register |
| Data residency | Tenant `data_residency_region`; future deployment per region (§11) |
| Processor/controller roles | To be defined contractually (OD-016) |
| Breach handling | Incident procedure documented before production (Stage S31) |

## 10. Training consent

- Consent is **separate** from the service terms. It is explicit, versioned, scoped (data categories, projects), time-bound where specified, and revocable.
- Each grant and revocation is an append-only `consent_events` entry with actor, time and policy version.
- **Eligibility check** at training-dataset assembly needs: an active grant covering the record's category and project, the record in a frozen Dataset Version, no legal hold or erasure flag, and outcome labels verified.
- **Revocation effect:** revoked data is excluded from all **future** training datasets. Whether a model already trained on the data must be retrained or retired is a policy decision (OD-013). The system records which model versions used which consent snapshot, so the policy can be enforced.
- The default is **no consent**. No tenant data is training-eligible unless opted in.

## 11. Deployment security (summary; details in DEPLOYMENT_AND_MIGRATION.md)

- Separate environments (dev, test, staging, production). Production data is never copied to lower environments.
- Least-privilege database roles (`pbe_app`, `pbe_migrator`, `pbe_readonly_report`).
- Security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors).
- Dependency and container scanning; a pre-production penetration test (Stage S31).

## 12. Auditability

Audit events must cover: authentication events, membership/role changes, data create/approve/reject/freeze, file upload/download, external fetch, run create/complete/reproduce, report export, consent changes, break-glass access, model promotion. Tenant users with `audit:read` can view and export their tenant's audit trail.
