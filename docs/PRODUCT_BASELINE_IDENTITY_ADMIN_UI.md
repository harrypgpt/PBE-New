# Product Baseline — Identity, Administration and UI/UX Compatibility

Status: **Mandatory product baseline**, set by the owner on 2026-10-17. Preserve it throughout development.
This document records the requirements and maps each one to its stage in the existing roadmap. **The staged roadmap is unchanged**: nothing is moved earlier, no dates are set, and no later stage is started. Where the current architecture documents do not yet cover a requirement, the gap is listed as a dependency for that stage's plan (§4).

## 1. Stage 5 responsibilities (owner, 2026-10-17)

| ID | Requirement | Where addressed |
|---|---|---|
| B5-1 | Build reusable, accessible UI foundations that support future authentication, user administration, configurable roles and permissions, audit screens and guided workflows | [STAGE-05-PLAN.md §3a](stage-plans/STAGE-05-PLAN.md#3a-product-baseline-additions-owner-2026-10-17) |
| B5-2 | Consistent design tokens and component patterns for colours, typography, spacing, tables, forms, mandatory-field indicators, progress, status labels, loading, errors and success feedback | STAGE-05-PLAN.md §3a |
| B5-3 | Components compatible with a future authenticated-user context, tenant-aware navigation, role-dependent menus and permission-controlled actions | STAGE-05-PLAN.md §3a |
| B5-4 | The scientific limitation statement stays permanently visible and never empty | STAGE-05-PLAN.md §3 and §3a; tests S5-2 and S5-19 |
| B5-5 | **No** login, user-management features, authentication services or identity-related database tables in Stage 5. The Stage 5 scope does not change | STAGE-05-PLAN.md §4 |

## 2. Mandatory requirements for future stages (owner, 2026-10-17)

| ID | Requirement | Roadmap stage(s) | Already in the architecture? |
|---|---|---|---|
| F-1 | Unique user ids and secure password-based authentication | 6 | Yes (SECURITY §3, OD-08) |
| F-2 | Super Admin and tenant-scoped Tenant Admin administration | 7 | Partly: platform owner and tenant admin (SECURITY §5). "Super Admin" is the owner's name for the platform-level administrator (dependency D-2) |
| F-3 | User creation, deactivation, role assignment, permission management and secure password resets | 6 (accounts, resets), 7 (administration) | Partly: Stage 6 has admin-driven reset only, because no email provider is chosen (D-3) |
| F-4 | Configurable departments, roles and permissions; the role catalogue is **not hard-coded** | 7 | Roles yes (SECURITY §4). Departments: the list in SECURITY §4 is **default templates only**, editable per tenant (clarified there) |
| F-5 | Secure password hashing, compromised-password screening, rate limiting, secure recovery, session expiry, prompt revocation and MFA according to the approved security policy | 6, 7 | Hashing, rate limiting, expiry and MFA yes. **Compromised-password screening and prompt revocation are new** (D-4, D-5) |
| F-6 | Authorisation enforced on the server and in the database where applicable; **hiding UI controls is not authorisation** | 4 (default deny, done), 5 (UI rule), 7 | Yes: API guard (ADR-022), RLS (Stage 3). Stage 5 adds a UI rule and test (S5-18) |
| F-7 | A comprehensive, filterable **business audit trail**, separate **security-event logs** and **technical logs**, with access controls and protection against unauthorised alteration or deletion | 6 (security events start), 7 (audit recording), 28 (search UI, tamper evidence) | Partly: one `audit.audit_event` table is planned (SECURITY §7). **Three separate streams are new** (D-6) |
| F-8 | Never log passwords, tokens, authentication secrets or unnecessary confidential data | Every stage | Yes: Stage 4 redaction (tested) |
| F-9 | Security tests for tenant boundaries, role permissions, authentication, session revocation and audit completeness are **release-gate requirements** | 6, 7, 28, 29 | Added to [TESTING_AND_ACCEPTANCE_GATES.md §5](architecture/TESTING_AND_ACCEPTANCE_GATES.md#5-gate-rules) (rule 7) |
| F-10 | Enterprise-quality, responsive, accessible UI/UX consistent with the agreed **TechyPharma-inspired design system** | 5 onward | **The design system is not in the repository** (D-1) |

## 3. Interpretation rules

- These requirements add to the architecture documents; they never weaken them. Where both apply, the stricter rule wins.
- The roles, permissions and departments named anywhere in the documentation are **default templates**, not a fixed catalogue (F-4).
- A UI that hides a button is a convenience only. Every protected action is checked by the API guard and, for tenant data, by PostgreSQL RLS (F-6).

### Stage 8 application (2026-10-18, ADR-030)
- **F-4:** the five project permissions join the fixed catalogue; templates receive them as defaults only, and every organisation can change its roles. Departments now also scope project visibility (D8-6).
- **F-6:** project buttons and the "Projects" menu entry follow the session's permissions as a convenience only. The API refuses the same requests, and PostgreSQL row-level security hides other organisations' projects and department-restricted projects (tested with direct API requests).
- **F-7:** every project and scenario change writes one business audit row in the same transaction (digests, no product data).
- **F-4 (decision closure):** the Tenant Administrator template holds all five project permissions by default, so a new organisation can delegate them; delegation stays limited to permissions the delegator holds.
- **Known limitation (owner decision, 2026-10-18):** there is **no screen to edit a project** in Stage 8. A project's details can be changed only through the API (`PUT /api/v1/projects/:projectId`, scope checked again, audited). Users see the details read-only; scenario descriptions can be edited on screen.
- **Capability reporting:** on a database without the projects migration, the "Projects" menu entry is not shown and project addresses answer "not available on this database yet".
- **F-10 / B5-2:** the dashboard, wizard and project pages reuse the Stage 5/7B components; axe reports 0 WCAG 2.1 AA violations, and a project can be created with the keyboard only.

## 4. Architectural dependencies to address in the stage plans

| ID | Dependency | Stage plan that must resolve it |
|---|---|---|
| D-1 | **TechyPharma-inspired design system: source needed.** No specification (colours, typography, spacing, logo rules) exists in the repository. The agent will not invent one. Stage 5 builds the token structure, with clearly marked neutral placeholder values until the reference is supplied. The placeholders meet the WCAG AA contrast rules. Approval of the reference must also confirm it may be used (brand and licence) | **Stage 5** (input needed before or during implementation) |
| D-2 | **Super Admin naming and powers.** Map "Super Admin" to the platform-level administrator. It still has **no default access to tenant data** (OD-26 break-glass only), unless the owner decides otherwise | Stage 7 (with OD-26) |
| D-3 | **Secure password reset and recovery.** Stage 6 provides an admin-initiated reset: a one-time, time-limited token; all sessions revoked; audited. Self-service recovery needs an email provider (not yet chosen) and is added when one is approved | Stage 6 (OD-08) |
| D-4 | **Compromised-password screening.** Choose between an offline list of breached-password hashes shipped with the app and an online range query to an external service (sends a hash prefix off the machine, which is a privacy decision). Recorded as a sub-decision of OD-08 | Stage 6 (OD-08) |
| D-5 | **Prompt session revocation.** Deactivation, role change, password reset or an admin action must end sessions at the next request (server-side sessions make this possible). Tests are needed in Stage 6 (own sessions) and Stage 7 (admin-driven) | Stages 6 and 7 |
| D-6 | **Three log streams.** (a) The business audit trail (append-only, filterable, tenant-scoped). (b) Security events (logins, failures, lockouts, MFA, resets, revocations, permission changes, break-glass), with separate access rights. (c) Technical logs (Stage 4 JSON logs, redacted). (a) and (b) are protected against alteration and deletion by the runtime role. Stage 28 evaluates tamper evidence | Stage 6 (security events start), Stage 7 (audit design), Stage 28 (search, tamper evidence) |
| D-7 | **Permission-aware UI contract.** The web app receives the current user's context (user, active tenant, effective permissions) from the API in Stage 6–7. Stage 5 components accept it as optional input, so they need no rewrite later | Stage 5 (component interfaces), Stages 6–7 (data) |
| D-8 | **Release gate.** The security suites named in F-9 must pass before any release (TESTING_AND_ACCEPTANCE_GATES.md §5 rule 7) | Stages 28 and 29 |
