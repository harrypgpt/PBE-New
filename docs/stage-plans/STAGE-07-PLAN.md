# Stage 7 Plan — Tenancy, roles, departments, platform owner, audit

Status: **Decisions approved 2026-10-17** (ADR-028, ADR-029; R-011 recorded). Owner settings: break-glass **max 1 hour, no automatic renewal**; tokens **max 4 hours**, delivered through a separate channel and never shown to administrators; no Scientific Reviewer or Support roles or accounts in Stage 7. **Split delivery: Stage 7A implemented on `pbe_test` 2026-10-17; results in [STAGE-07A.md](../stage-reports/STAGE-07A.md). The `pbe_dev` migration is BLOCKED pending owner decision B-1 (backup role). Stage 7B (screens) implemented 2026-10-18; results in [STAGE-07B.md](../stage-reports/STAGE-07B.md) (PASS WITH CONDITIONS: B-1, S7-19 owner check).**
Sources:
- [IMPLEMENTATION_ROADMAP.md, Stage 7](../IMPLEMENTATION_ROADMAP.md#stage-7--tenancy-roles-departments-platform-owner-audit) (roadmap items 1–12);
- [PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md](../PRODUCT_BASELINE_IDENTITY_ADMIN_UI.md) (F-2, F-3, F-4, F-6, F-7, F-9; D-2, D-3, D-5, D-6, D-7);
- [SECURITY_PRIVACY_AND_TENANCY.md §2, §4, §5, §7](../architecture/SECURITY_PRIVACY_AND_TENANCY.md);
- OD-26; ADR-021, ADR-022, ADR-026, ADR-027.

Scope is **not** expanded. Points the sources leave open are marked **[detail]** or listed as decisions (§11). Nothing here adds a product requirement.

## 1. Objective (plain language)

PBE becomes multi-organisation in practice:
- **Tenants:** the platform owner (**Super Admin**) creates and suspends customer organisations.
- **Memberships:** each organisation's **Tenant Admin** manages its own users, departments and roles. A user can belong to several organisations and works in one at a time.
- **Permissions:** what a user may do comes from roles. Roles are configurable per organisation and start from default templates. The API checks permissions on every request, and PostgreSQL keeps each organisation's rows apart.
- **Super Admin access:** no access to an organisation's data by default. A time-limited, organisation-approved, audited **break-glass** grant is the only way (OD-26).
- **Audit trail:** every administrative action is recorded in an append-only business audit trail, separate from the Stage 6 security log.

There are still no projects or scientific data (Stage 8 onward).

## 2. Prerequisites

| Item | Status |
|---|---|
| Stage 6 PASS | Approved 2026-10-17 (STAGE-06.md §14; not independently verified) |
| **OD-26** platform-owner access to tenant data (break-glass) | **Open — owner approval needed** (§11) |
| **D-2** Super Admin naming and powers | **Owner confirmation needed** (§11) |
| Other decisions listed in §11 | **Owner approval needed** |
| OD-12 (retention, legal) | Open; Stage 7 keeps **fictional data only** and does not set retention periods |
| Database | Migration **0004** (additive). Tested on `pbe_test` first; applied to `pbe_dev` only after a verified backup, as in Stage 6. Recommended: run a **post-update restore drill** (nothing pending) to close the Stage 6 note |
| Dependencies | **None expected.** Everything uses the existing NestJS, Kysely, Zod, Next.js and Stage 5 components |
| Administrator password | Not expected. If any step needs elevated rights, the exact SQL is shown for review first |

## 3. Scope (roadmap item 1, each part mapped)

| Roadmap item | Plan |
|---|---|
| **Tenants** | `platform.tenant` (Stage 3) is used as it is; its existing status values are `active` and `suspended`. Super Admin can create, rename, suspend and reactivate a tenant. Suspension ends that tenant's sessions' access at the next request |
| **Memberships** | `app.membership` (tenant table: `tenant_id`, `user_id`, `status` active/deactivated, timestamps). A user may hold memberships in several tenants (SECURITY §2). Deactivating a membership removes access to that tenant at the next request (D-5) |
| **Active-tenant selection** | The session records the **active tenant**, chosen after sign-in among the user's active memberships (`POST /api/v1/session/tenant`). Every tenant-scoped request runs in `withTenantTransaction(activeTenant, user)` (Stage 3), so RLS applies. Switching tenant rotates the session (privilege change). A user with one membership is placed in it automatically **[detail]** |
| **Departments** | `app.department` per tenant: name and description, editable by the Tenant Admin. A tenant starts with the default department list from SECURITY §4 as **templates only** (F-4). Membership ↔ department links. Departments **scoping project visibility** applies when projects exist (Stage 8); Stage 7 stores the link only |
| **Configurable roles and permissions** | **Permissions** are a fixed, versioned catalogue in `packages/contracts` (`area.action` names), because code enforces them. **Roles** are per-tenant, configurable bundles of permissions (`app.role`, `app.role_permission`, `app.membership_role`); create, rename, edit or delete by the Tenant Admin (F-4). **Default role templates** (`platform.role_template`) are copied into each new tenant and can be changed there. No role name is hard-coded in authorisation code: only permissions are checked |
| **Permission guards** | The Stage 4/6 guard enforces `permission` routes: active session + active tenant + active membership + the permission among the effective permissions (union of the member's roles). Checked **on every request** from the database, so a role change takes effect at once (D-5). UI hiding stays presentation only (F-6). `GET /api/v1/session` returns the active tenant and effective permissions (D-7) |
| **Platform roles, separate from tenant roles** | `platform.platform_role_assignment` (`user_id`, role ∈ `platform_owner`, `platform_scientific_reviewer`, `platform_support`; SECURITY §4). Platform routes check **platform permissions** (a separate catalogue section); tenant roles never grant them and platform roles never grant tenant permissions. Super Admin = `platform_owner` (D-2) |
| **Tenant Admin** | A default role template ("Tenant administrator") holding the tenant-administration permissions (users, departments, roles, audit viewing for own tenant). It is a configurable role like the others, but a tenant must always keep at least one active member holding the role-management permission (lock-out protection) **[detail]** |
| **User lifecycle (F-3)** | Within a tenant, the Tenant Admin can: create a user account (or add an existing user by email) as a member; assign and remove roles and departments; deactivate and reactivate the membership; start an **admin-initiated password reset** (§11.4); require MFA. Deactivating a user's **last** active membership does not delete the account; platform-level account deactivation is a Super Admin action **[detail]**. Every change is audited. Ending access is immediate at the next request (D-5) |
| **MFA for privileged roles** | SECURITY §3 requires MFA for tenant admins, scientific reviewers and platform roles. Holding an administrative permission or any platform role sets `mfa_required` (Stage 6 flow enforces enrolment) |
| **Break-glass (OD-26)** | `platform.break_glass_grant`: requested by a Super Admin with a written reason; **approved by a Tenant Admin of that tenant**; time-limited (§11.1); read-only; revocable; every request, approval, use and expiry is audited in **both** the tenant's audit trail and the security log. Without an active grant, platform roles see **no** tenant rows (RLS) |
| **Append-only business audit trail (F-7, D-6)** | `audit.audit_event` (`tenant_id` nullable for platform events, actor user, active tenant, action, target type and id, before/after **digests** (not raw data), request id, time). INSERT-only for `pbe_app`; a trigger refuses UPDATE, DELETE and TRUNCATE (as `audit.security_event`). Written **in the same transaction** as the change it records, so a change without its audit row cannot commit. Security events (logins, revocations, permission changes, break-glass) continue in the Stage 6 log. Reading and search are Stage 28 (roadmap exclusion) |
| **Authorisation matrix definition file** (roadmap task) | `packages/contracts/src/authorisation-matrix.ts`: permission catalogue, default role templates and, for every route, the permission it requires. The tests are generated from it (S7-1). It is published in STAGE-07.md (roadmap item 11) |
| **Separation-of-duties configuration** (roadmap task) | A per-tenant setting (`app.tenant_setting`), defaulting to "self-approval not allowed", with the rule from SECURITY §4. **Enforcement** applies when approvals exist (dataset approval, Stage 9); Stage 7 stores and audits the setting only |
| **Admin UI** (roadmap item 2) | Tenant Admin pages: members (list, add, deactivate, reactivate, reset password, require MFA), roles (create and edit permissions), departments. Super Admin pages: tenants (list, create, suspend), break-glass requests. A tenant switcher in the shell (D-7). Built on Stage 5 components (data table, forms, status labels, notices) and accessibility-tested |
| **Operator command** | `npm run user -- grant-platform-role` / `revoke-platform-role` to make the first Super Admin. Hidden input rules as in Stage 6 |

**Database migration 0004 (additive, `expand`):**
- `app` schema, all following the tenant-table template with RLS forced: `membership`, `department`, `membership_department`, `role`, `role_permission`, `membership_role`, `tenant_setting`.
- `platform`: `platform_role_assignment`, `role_template`, `role_template_permission`, `break_glass_grant`.
- `audit`: `audit_event`.
- New look-ups follow ADR-027: narrow, reviewed functions where a query must cross tenants (for example, "which tenants is this user a member of", run before a tenant is chosen). No bulk path.
- The conformance check must pass for **every** new `app` table (roadmap item 8).

## 4. Exclusions

- No audit **search or viewing** UI beyond the admin pages' own confirmations (Stage 28); no SSO (roadmap item 3).
- No projects, datasets or scientific data (Stage 8 onward). Department visibility rules and separation of duties are stored, not yet applied to any data.
- No email invitations or self-service recovery (no email provider; D-3 unchanged).
- No tenant deletion or data retention periods (OD-12, Stage 28).
- No change to the Stage 6 password, session or MFA rules.

## 5. Test plan (each named; real PostgreSQL 18 `pbe_test`; browser tests on the production build)

| # | Test | Expected |
|---|---|---|
| S7-1 | **Authorisation matrix:** for every route and for members holding each default role, with none, and with a custom role, the API allows exactly what the matrix says (generated from the definition file) | Pass |
| S7-2 | **Cross-tenant suite** for every new resource (memberships, departments, roles, role assignments, settings, audit rows): a Tenant Admin of tenant A cannot read, create, change or delete B's, by id or by listing; ids from B give 404, not 403 **[detail]** | Pass |
| S7-3 | RLS conformance passes for all new `app` tables; composite foreign keys include `tenant_id` | Pass |
| S7-4 | Active tenant: choosing a tenant without an active membership is refused; switching rotates the session; requests without an active tenant cannot reach tenant routes | Pass |
| S7-5 | **Prompt revocation (D-5):** removing a role, deactivating a membership, suspending a tenant or deactivating a user takes effect at the next request; admin-initiated reset ends that user's sessions | Pass |
| S7-6 | **Platform vs tenant separation:** Super Admin without a grant sees **no** tenant rows (API and RLS); tenant roles cannot call platform routes; platform roles do not grant tenant permissions | Pass |
| S7-7 | **Break-glass:** needs a reason and a Tenant Admin approval; read-only; expires on time (test clock control); revocable; request, approval, use and expiry all audited | Pass |
| S7-8 | **Audit trail:** each administrative action writes exactly one audit row in the same transaction; a failed action writes none; rows hold digests, not secrets or raw data; `pbe_app` cannot UPDATE, DELETE or TRUNCATE (and the owner is stopped by the trigger) | Pass |
| S7-9 | **Configurable catalogue (F-4):** a tenant can rename, add and remove roles and departments; the templates are only a starting point; no authorisation code checks a role name (static check: no role-name strings in guard code) | Pass |
| S7-10 | **Lock-out protection:** the last holder of role management cannot remove it from themselves or be deactivated | Pass |
| S7-11 | MFA required for administrative and platform roles: granting one sets the requirement; the user must enrol at the next sign-in | Pass |
| S7-12 | **Least privilege in the database:** effective `pbe_app` privileges on every new table and function match the plan; no bulk cross-tenant path (as S6-17) | Pass |
| S7-13 | Separation-of-duties setting: stored per tenant, default "not allowed", change audited | Pass |
| S7-14 | **Browser E2E:** Super Admin creates two fictional tenants with a Tenant Admin each; each admin adds a member and a role; the members see only their own tenant; the tenant switcher works for a user in both | Pass |
| S7-15 | Accessibility: axe WCAG 2.1 A/AA, 0 violations on every new page, including errors; keyboard-only member management | 0 violations |
| S7-16 | Secrets and data hygiene: audit rows, security events, logs and responses contain no passwords, tokens, reset codes or other tenants' identifiers | Pass |
| S7-17 | Mutation checks (scratch copy): bypass the permission check; drop a tenant policy; let platform roles read tenant rows without a grant; skip break-glass expiry; skip the audit insert; allow audit UPDATE | The matching tests fail |
| S7-18 | Regression: all earlier tests; `verify`; OpenAPI and typegen in sync; R-008 and Next.js reassessed | Pass |
| S7-19 | Manual (roadmap item 7): owner creates two fictional tenants and confirms that users in one cannot see the other | Owner check |

## 6. Security design and implications

- **Three layers of tenant isolation:**
  1. The API permission guard (per request, from the database).
  2. `withTenantTransaction` with the session's active tenant.
  3. PostgreSQL RLS, forced, on every `app` table.
- **R-007 grows in importance:** from Stage 7 RLS really depends on `app.tenant_id`, which `pbe_app` could set itself. The safeguards stay as they are: the gateway, the lint rule and parameterised SQL. R-007 stays **open and production-blocking**, and its Stage 28 mitigation is unchanged.
- **Least privilege:**
  - Tenant Admin is a configurable role, not a superuser.
  - Platform roles and tenant roles never mix.
  - Super Admin has no default tenant-data access.
  - Database grants per table.
- **Auditability:** the business audit trail is written in the same transaction as the change and is append-only. Security events stay separate (D-6). Neither holds secrets.
- **Personal data:** names, emails and memberships. Fictional data only until OD-12(a).
- **R-001, R-007, R-009 and R-010 remain open and production-blocking.** R-008 is reassessed.

## 7. Acceptance criteria (roadmap item 8, made measurable)

1. S7-1 to S7-18 pass; counts reported; nothing skipped without explanation.
2. RLS conformance passes for **all** new tables (roadmap item 8).
3. The authorisation matrix is published in STAGE-07.md and is the source of S7-1 (roadmap item 11).
4. Migration 0004 applied to `pbe_test`, then to `pbe_dev` only after a verified backup and passing tests; drift, typegen and OpenAPI pass.
5. 0 high or critical audit findings; dependency guard passes; no new dependency unless approved.
6. Exclusions respected (§4).
7. STAGE-07.md with commands, results and per-criterion verdicts; no claim of independent verification.

## 8. Size and delivery note

Stage 7 is the largest stage so far: about 12 tables, a permission guard, break-glass, an audit trail and two admin areas.

**Option:** deliver it in two authorised parts, without changing the scope:
- **7A** — data model, permissions, guard, active tenant, audit trail and break-glass, all through the API, with tests S7-1 to S7-13, S7-16 and S7-17;
- **7B** — admin UI and browser tests (S7-14, S7-15), plus the manual check.

Each part would have its own report. This is offered for your convenience; the default is one stage (§11.8).

## 9. Rollback

- **Code:** revert to the Stage 6 state.
- **Database:** migration 0004 is additive. Restore the pre-migration `pbe_dev` backup, or apply a reviewed forward migration that drops only the new objects.
- No existing table or data is changed.

## 10. Requirements traceability (no new requirements)

| Baseline | Where in this plan |
|---|---|
| F-2 Super Admin and Tenant Admin; D-2 | §3 platform roles, Tenant Admin; §11.2 |
| F-3 user lifecycle; D-3 | §3 user lifecycle; §11.4 |
| F-4 configurable departments, roles and permissions | §3; S7-9 |
| F-6 server and database authorisation | §3 guards; §6; S7-1, S7-2, S7-6 |
| F-7, D-6 three log streams | §3 audit trail; S7-8 |
| F-9, D-8 release-gate suites | S7-1, S7-2, S7-5, S7-8 join the standing suites |
| D-5 prompt revocation | S7-5 |
| D-7 user context for the web app | §3 session and tenant switcher |

## 11. Decisions needed from the owner before implementation

1. **OD-26 break-glass:** approve option A.
   - No default access.
   - Access only with a written reason and approval by a Tenant Admin of that tenant.
   - Read-only, revocable, fully audited.
   - **Proposed maximum duration: 4 hours** (your choice).
   - The "contract-defined emergency" variant (access without tenant approval) is **not** proposed for Stage 7.
2. **D-2:** confirm that **Super Admin = the `platform_owner` platform role**, with no default tenant-data access. Confirm whether other platform roles (`platform_scientific_reviewer`, `platform_support`) are created now as roles without tenant access (recommended), or later.
3. **Tenant onboarding:** SECURITY §5 says the platform owner does not manage tenant users. Recommended exception, recorded in the security document if approved: when creating a tenant, the Super Admin names its **first Tenant Admin** (an existing or new user). After that, only that tenant's admins manage its users.
4. **Admin-initiated password reset and first sign-in without email (D-3):**
   - Recommended: the Tenant Admin generates a **one-time code**: shown once, valid for 24 hours, single use, stored only as a hash.
   - The admin gives the code to the user by another channel.
   - The user enters it on a reset page and chooses their own password under the Stage 6 policy.
   - All sessions end; every step is audited.
   - The same flow sets a new user's first password, so admins never choose or see passwords.
5. **Permission catalogue fixed in code, roles configurable:** approve that *permissions* are a versioned list in the contracts (code enforces them), while roles, role contents and departments are fully configurable per tenant (F-4).
6. **Default role templates (names editable per tenant):**
   - Tenant administrator;
   - Project lead;
   - Scientist (R&D/formulation);
   - QA/QC reviewer;
   - Scientific reviewer;
   - Viewer (directors).
   Their permissions are listed in the matrix. Until Stage 8 most permissions concern administration only. Approve the list, or supply yours.
7. **Super Admin bootstrap:** confirm the first Super Admin is made with the operator command (`npm run user -- grant-platform-role`) on this Mac, for a fictional account.
8. **Delivery:** one Stage 7 (default), or two parts 7A and 7B (§8).

Unchanged and preserved: TypeScript only; Next.js + NestJS; PostgreSQL only; Kysely with the dedicated data-access layer; the in-house type generator; hand-written SQL migrations (no Prisma Migrate, no Python); shared Zod contracts; the dependency guard. R-001, R-007, R-009 and R-010 stay open and production-blocking; R-008 is reassessed.
