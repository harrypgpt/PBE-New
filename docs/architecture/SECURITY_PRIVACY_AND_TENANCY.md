# Security, Privacy and Tenancy

Status: Draft for product-owner review, MA-00, 2026-10-16.
**Important:** these are technical controls. They do **not** by themselves make PBE compliant with GDPR or any other law, or certified to any standard. Legal questions are listed in §11 and need qualified legal review (OD-12).

## 1. Threat model summary

| Threat | Main controls |
|---|---|
| Sponsor A sees sponsor B's data | App-level tenant guards + RLS (forced) + tenant-aware composite FKs + conformance tests + cross-tenant tests every stage |
| Stolen or guessed credentials | Strong password hashing, MFA (required for privileged roles), rate limiting, session rotation (OD-08) |
| Insider or platform-operator overreach | Platform owner has no default tenant-data access; break-glass grants are time-limited, tenant-approved and audited (OD-26) |
| Confidential data leaking via logs, errors or AI | Log redaction tests; Problem-Details errors without internals; AI disabled by default and fenced (ADR-009) |
| Tampering with approved evidence or results | Immutability triggers, content hashes, append-only audit |
| Malicious uploads | Type allow-list, size limits, parsing in a constrained worker, no macro execution, files never served inline as active content |
| Supply-chain compromise | Pinned lockfile, dependency review, audit checks, minimal dependencies |
| Data loss | Backups, tested restores, forward-only migrations with pre-contract backups |

## 2. Tenancy model
- **Shared database, shared schema, `tenant_id` on every tenant row**, enforced by RLS. This is the simplest model that supports many customers on one PostgreSQL.
- A user can belong to more than one tenant (for example, a consultant). They act in exactly one active tenant per request.
- The design does not prevent moving a large customer to a dedicated database later (same schema, same migrations).

## 3. Authentication and sessions (decided under OD-08 by Stage 6)
- Passwords use a modern memory-hard hash (e.g. Argon2id; the parameters are recorded in the decision).
- Server-side sessions are stored in PostgreSQL. Cookies are `HttpOnly` and `Secure`. Sessions have an idle timeout and an absolute timeout, both configurable. Session id rotation happens at login and on privilege change.
- MFA: TOTP recommended as the first factor type, required for tenant admins, scientific reviewers and platform roles. Enterprise SSO (OIDC/SAML) is designed for and added when a customer needs it.
- Account lockout and back-off on repeated failures, with audit events.

## 4. Authorisation, roles and departments
- Permission-based: roles are named bundles of permissions. Roles are configurable per tenant. Departments group users and can scope project visibility. The departments listed here (project management, QA, R&D/formulation, QC, scientific review, directors, admin) and all named roles are **default templates only**: departments, roles and permissions are configurable, and the catalogue is never hard-coded (owner baseline, [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md) F-4).
- Default role templates are provided. Tenant admins may adjust them within the limits the platform allows.
- **Separation of duties:** the person who submits a dataset version for approval cannot also approve it, unless the tenant explicitly allows self-approval for that role. Any self-approval is audited.
- **Platform roles** (`platform_owner`, `platform_scientific_reviewer`, `platform_support`) are a separate set, held in the `platform` schema, and are not tenant roles.

## 5. Platform owner vs tenant administrators
| | Platform owner | Tenant admin |
|---|---|---|
| Create or suspend tenants | Yes | No |
| Manage tenant users and roles | No (except emergency suspension, and nominating the **first** Tenant Admin of a new tenant: an onboarding exception, ADR-029) | Yes, own tenant only |
| Read tenant evidence and results | **No by default.** Only through break-glass (OD-26). | Yes, per their roles |
| Approve methods, rulesets, models | Yes, together with the platform scientific reviewer | No |
| See model internals and owner-level traceability | Yes | No (sponsor view, OD-27) |

## 6. Encryption and key management
- **In transit:** TLS for every non-localhost connection, including API ↔ PostgreSQL in SaaS.
- **At rest (local):** rely on full-disk encryption (macOS FileVault). Stage 2 records whether it is on. This is a note for the owner, not a check the agent can always perform.
- **At rest (SaaS):** managed database and object-storage encryption, plus application-level encryption for stored files with keys from a managed KMS (OD-28).
- Secrets are never committed. Environment-specific secrets live in the deployment's secret store. Key rotation procedure is documented by Stage 29.
- Administrative access: named accounts, MFA, least privilege, audited. No shared superuser use in normal operation.

## 7. Audit logging
- Append-only `audit.audit_event`. The runtime role has INSERT only. Stage 28 evaluates tamper-evidence (hash chaining).
- Recorded: authentication events, role changes, project/scenario/dataset changes, reviews and approvals, run creation, report downloads, exports, consent changes, break-glass use, model and ruleset approvals.
- Owner baseline (F-7, D-6): the business audit trail, security-event logs and technical logs are **three separate streams** with their own access rights. The first two are protected against alteration or deletion. Design in Stages 6–7; see [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md).
- Searchable by authorised roles (tenant auditors see their own tenant; platform auditors see platform events). Search arrives in Stage 28. Recording starts in Stage 7.

## 8. No participant-level data
- The schema contains no tables for individual subjects (ADR-012). PK evidence is summary-level only: for example GMR, CI bounds, ISCV estimate, number of subjects and design.
- Ingestion checks flag uploads that look like subject-level data, such as per-subject concentration tables or subject identifiers. Such files are blocked from extraction, and the uploader is told why. Detection is heuristic and cannot be guaranteed. User guidance and terms of use must also state the rule (OD-12).

## 9. Training consent (C6)
- Consent is **separate** from product use, **explicit**, **versioned** (`consent_policy_version`), and recorded per tenant with who, when, which version and which scope.
- Default is **no consent**. Without valid consent and an eligibility review, no tenant data enters `training` (enforced by the module and by grants).
- Withdrawal is recorded. Its effect on existing models (retraining or exclusion) is a legal and policy decision under OD-12. The architecture keeps per-case lineage so that the effect can be applied.

## 10. Files, exports, retention and deletion
- Uploaded files are stored by checksum under tenant-scoped keys, never served from a public path, and downloaded through authorised API endpoints with audit.
- Exports (reports, data downloads) are audited. They carry a watermark or footer with tenant, user, time and the limitation statement.
- Retention classes are configurable per tenant (OD-12). Deletion is a documented procedure that covers database rows, files and backups (backups expire by schedule). Approved records under audit hold are protected from deletion until the hold is released.

## 11. Legal and regulatory questions for qualified review (OD-12)
1. The legal role of PBE and the sponsor under GDPR (processor or controller) for each data type.
2. Whether any data PBE stores is personal data (user accounts are; evidence normally should not be).
3. Data-processing agreement terms, sub-processors and international transfer mechanisms.
4. Wording, scope and withdrawal effects of training consent.
5. Retention periods and audit-hold rules, including any GxP expectations customers may have.
6. Whether PBE's outputs or claims could bring it under any software-as-medical-device or other regulatory regime. The current assumption is "decision support, not a regulated device", and that is **unverified**.
7. Terms-of-use disclaimers about prediction limitations.
