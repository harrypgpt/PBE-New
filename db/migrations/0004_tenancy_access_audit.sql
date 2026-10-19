-- 0004_tenancy_access_audit.sql
-- Purpose: tenant memberships, departments, configurable roles and permissions, platform roles,
--          break-glass grants, one-time activation/reset tokens, active-tenant session context
--          and the append-only business audit trail.
-- Stage:   7A (STAGE-07-PLAN.md §3; ADR-028, ADR-029; ADR-021, ADR-027)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- Additive only: new tables, functions, policies, triggers, privileges, two new nullable columns
-- on platform.user_session and seed rows for the fixed permission catalogue and role templates.
--
-- ACCESS MODEL
--  * app.* tables follow db/templates/tenant-table.sql: RLS enabled AND forced, one tenant policy
--    for pbe_app. All tenant work runs as pbe_app inside withTenantTransaction.
--  * Two extra SELECT-only policies let a signed-in user see THEIR OWN memberships (and those
--    tenants' names) across tenants, and only when NO tenant context is set (choosing a tenant).
--  * platform.* identity/access tables: no table privileges for pbe_app; reviewed SECURITY DEFINER
--    functions acting on one key each (ADR-027). Platform-role grants are NOT executable by pbe_app:
--    only the operator (pbe_owner via pbe_migrator) can create a Super Admin.
--  * audit.audit_event: INSERT-only for pbe_app (own tenant, or no tenant); a trigger refuses
--    UPDATE, DELETE and TRUNCATE for everyone.
-- Function bodies are dollar-quoted and not inspected by the lexical checks (R-003): review them.

-- 1. Fixed permission catalogue (mirrors packages/contracts/src/authorisation.ts; a test compares).
CREATE TABLE platform.permission (
  code        text    PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z]+)+$'),
  scope       text    NOT NULL CHECK (scope IN ('tenant', 'platform')),
  read_only   boolean NOT NULL,
  description text    NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  CONSTRAINT permission_code_matches_scope CHECK (starts_with(code, scope || '.'))
);
COMMENT ON TABLE platform.permission IS 'Fixed permission catalogue (ADR-029). Changed only by migrations.';
INSERT INTO platform.permission (code, scope, read_only, description) VALUES
  ('tenant.members.read',       'tenant',   true,  'See the organisation''s members, their roles and departments'),
  ('tenant.members.manage',     'tenant',   false, 'Add, deactivate and reactivate members; start password resets'),
  ('tenant.roles.read',         'tenant',   true,  'See roles and the permission catalogue'),
  ('tenant.roles.manage',       'tenant',   false, 'Create, change and delete roles; assign roles to members'),
  ('tenant.departments.read',   'tenant',   true,  'See departments'),
  ('tenant.departments.manage', 'tenant',   false, 'Create, change and delete departments; assign members to them'),
  ('tenant.settings.read',      'tenant',   true,  'See organisation settings'),
  ('tenant.settings.manage',    'tenant',   false, 'Change organisation settings (e.g. separation of duties)'),
  ('tenant.breakglass.approve', 'tenant',   false, 'Approve, reject or revoke Super Admin break-glass access'),
  ('platform.tenants.read',     'platform', true,  'List organisations (registry only, no customer data)'),
  ('platform.tenants.manage',   'platform', false, 'Create, suspend and reactivate organisations; nominate the first Tenant Administrator'),
  ('platform.breakglass.request','platform', false, 'Request, enter and revoke break-glass access');

-- 2. Editable starting role templates (copied into each new tenant; names are not security controls).
CREATE TABLE platform.role_template (
  key         text    PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{1,40}$'),
  name        text    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text    NOT NULL,
  position    integer NOT NULL UNIQUE
);
CREATE TABLE platform.role_template_permission (
  template_key text NOT NULL REFERENCES platform.role_template (key),
  permission   text NOT NULL REFERENCES platform.permission (code)
               CONSTRAINT role_template_permission_tenant_scope CHECK (starts_with(permission, 'tenant.')),
  PRIMARY KEY (template_key, permission)
);
INSERT INTO platform.role_template (key, name, description, position) VALUES
  ('tenant_administrator', 'Tenant Administrator', 'Manages the organisation''s members, roles, departments, settings and break-glass approvals.', 1),
  ('project_lead',         'Project Lead',         'Leads projects (project permissions arrive in Stage 8).', 2),
  ('scientist',            'Scientist',            'R&D / formulation work (permissions arrive with scientific features).', 3),
  ('qa_qc_reviewer',       'QA/QC Reviewer',       'Quality review (permissions arrive with review features).', 4),
  ('scientific_reviewer',  'Scientific Reviewer',  'Scientific review within the organisation (permissions arrive with review features).', 5),
  ('viewer',               'Viewer',               'Read-only access (permissions arrive with data features).', 6);
INSERT INTO platform.role_template_permission (template_key, permission)
SELECT 'tenant_administrator', code FROM platform.permission WHERE scope = 'tenant';
INSERT INTO platform.role_template_permission (template_key, permission) VALUES
  ('project_lead', 'tenant.members.read'),
  ('project_lead', 'tenant.departments.read');

-- 3. Tenant tables (template rules: tenant_id, composite keys, RLS enabled and forced).
CREATE TABLE app.membership (
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id),
  id         uuid        NOT NULL DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES platform.user_account (id),
  -- The organisation's own record of the member (pbe_app cannot read platform.user_account,
  -- ADR-027), protected by this table's row-level security.
  email        text      NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  display_name text      NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX membership_by_user ON app.membership (user_id);

CREATE TABLE app.department (
  tenant_id   uuid        NOT NULL REFERENCES platform.tenant (id),
  id          uuid        NOT NULL DEFAULT uuidv7(),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX department_name_unique_ci ON app.department (tenant_id, lower(name));

CREATE TABLE app.membership_department (
  tenant_id     uuid NOT NULL REFERENCES platform.tenant (id),
  membership_id uuid NOT NULL,
  department_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, department_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES app.membership (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.department (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.role (
  tenant_id    uuid        NOT NULL REFERENCES platform.tenant (id),
  id           uuid        NOT NULL DEFAULT uuidv7(),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  template_key text        REFERENCES platform.role_template (key),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX role_name_unique_ci ON app.role (tenant_id, lower(name));

CREATE TABLE app.role_permission (
  tenant_id  uuid NOT NULL REFERENCES platform.tenant (id),
  role_id    uuid NOT NULL,
  permission text NOT NULL REFERENCES platform.permission (code)
             CONSTRAINT role_permission_tenant_scope CHECK (starts_with(permission, 'tenant.')),
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.role (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.membership_role (
  tenant_id     uuid NOT NULL REFERENCES platform.tenant (id),
  membership_id uuid NOT NULL,
  role_id       uuid NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES app.membership (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.role (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.tenant_setting (
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id),
  id                    uuid        NOT NULL DEFAULT uuidv7(),
  self_approval_allowed boolean     NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

ALTER TABLE app.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership FORCE ROW LEVEL SECURITY;
ALTER TABLE app.department ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.department FORCE ROW LEVEL SECURITY;
ALTER TABLE app.membership_department ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_department FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_permission FORCE ROW LEVEL SECURITY;
ALTER TABLE app.membership_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_role FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_setting FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.membership FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.department FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.membership_department FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.role FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.role_permission FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.membership_role FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.tenant_setting FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Choosing a tenant: with NO tenant context, a user sees only their own memberships, and the
-- names of tenants they actively belong to. Inside a tenant context only tenant_isolation applies.
CREATE POLICY own_memberships_without_tenant ON app.membership FOR SELECT TO pbe_app
  USING (app.current_tenant_id() IS NULL AND user_id = app.current_user_id());
CREATE POLICY member_tenants_without_tenant ON platform.tenant FOR SELECT TO pbe_app
  USING (app.current_tenant_id() IS NULL AND EXISTS (
    SELECT 1 FROM app.membership m
     WHERE m.tenant_id = platform.tenant.id AND m.user_id = app.current_user_id() AND m.status = 'active'));

REVOKE ALL ON app.membership, app.department, app.membership_department, app.role,
  app.role_permission, app.membership_role, app.tenant_setting FROM PUBLIC;
-- Least privilege: memberships are deactivated, never deleted (history); settings rows are
-- created with the tenant and only updated afterwards.
GRANT SELECT, INSERT, UPDATE ON app.membership TO pbe_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.department, app.membership_department, app.role,
  app.role_permission, app.membership_role TO pbe_app;
GRANT SELECT, INSERT, UPDATE ON app.tenant_setting TO pbe_app;
REVOKE ALL ON platform.permission, platform.role_template, platform.role_template_permission FROM PUBLIC;
GRANT SELECT ON platform.permission, platform.role_template, platform.role_template_permission TO pbe_app;

-- 4. Platform roles (Super Admin = platform_owner; ADR-029). Other platform roles are documented
--    for later stages and deliberately not allowed yet.
CREATE TABLE platform.platform_role_assignment (
  user_id    uuid        NOT NULL REFERENCES platform.user_account (id),
  role       text        NOT NULL CHECK (role IN ('platform_owner')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
REVOKE ALL ON platform.platform_role_assignment FROM PUBLIC;

-- 5. Break-glass grants (ADR-028): read-only, one tenant, one purpose, at most one hour.
CREATE TABLE platform.break_glass_grant (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid        NOT NULL REFERENCES platform.tenant (id),
  requested_by uuid        NOT NULL REFERENCES platform.user_account (id),
  purpose      text        NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 1000),
  status       text        NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested', 'approved', 'rejected', 'revoked', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid        REFERENCES platform.user_account (id),
  decided_at   timestamptz,
  expires_at   timestamptz,
  ended_at     timestamptz,
  CONSTRAINT break_glass_max_one_hour CHECK (expires_at IS NULL OR (decided_at IS NOT NULL AND expires_at <= decided_at + interval '1 hour')),
  CONSTRAINT break_glass_approval_complete CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT break_glass_not_self_approved CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX break_glass_by_tenant ON platform.break_glass_grant (tenant_id, requested_at);
REVOKE ALL ON platform.break_glass_grant FROM PUBLIC;

-- 6. One-time activation and password-reset tokens (ADR-029): hash only, single use, max 4 hours.
CREATE TABLE platform.user_token (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid        NOT NULL REFERENCES platform.user_account (id),
  purpose     text        NOT NULL CHECK (purpose IN ('activation', 'password_reset')),
  token_hash  bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  tenant_id   uuid        REFERENCES platform.tenant (id),
  created_by  uuid        REFERENCES platform.user_account (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  CONSTRAINT user_token_max_four_hours CHECK (expires_at > created_at AND expires_at <= created_at + interval '4 hours')
);
CREATE INDEX user_token_open_by_user ON platform.user_token (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
REVOKE ALL ON platform.user_token FROM PUBLIC;

-- 7. Active-tenant context on sessions (two new nullable columns; nothing existing changes).
ALTER TABLE platform.user_session ADD COLUMN active_tenant_id uuid REFERENCES platform.tenant (id);
ALTER TABLE platform.user_session ADD COLUMN break_glass_grant_id uuid REFERENCES platform.break_glass_grant (id);

-- 8. Business audit trail (D-6): separate from security events and technical logs.
CREATE TABLE audit.audit_event (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  tenant_id     uuid        REFERENCES platform.tenant (id),
  actor_user_id uuid        REFERENCES platform.user_account (id),
  actor_kind    text        NOT NULL CHECK (actor_kind IN ('member', 'platform', 'break_glass', 'operator', 'self')),
  action        text        NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  target_type   text        NOT NULL CHECK (target_type ~ '^[a-z_]{1,40}$'),
  target_id     uuid,
  before_digest bytea       CHECK (before_digest IS NULL OR octet_length(before_digest) = 32),
  after_digest  bytea       CHECK (after_digest IS NULL OR octet_length(after_digest) = 32),
  request_id    uuid,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX audit_event_by_tenant_time ON audit.audit_event (tenant_id, occurred_at);
COMMENT ON TABLE audit.audit_event IS 'Append-only business audit trail. Digests, not raw data; never secrets.';

CREATE FUNCTION audit.audit_event_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  RAISE EXCEPTION 'audit.audit_event is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION audit.audit_event_append_only() FROM PUBLIC;
CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.audit_event_append_only();
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.audit_event_append_only();

ALTER TABLE audit.audit_event ENABLE ROW LEVEL SECURITY;
-- pbe_app may only append rows for the tenant of its current context (or, with no tenant
-- context, rows that belong to no tenant). It cannot read the trail (search is Stage 28).
CREATE POLICY append_own_tenant ON audit.audit_event FOR INSERT TO pbe_app
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app.current_tenant_id());
REVOKE ALL ON audit.audit_event FROM PUBLIC;
GRANT INSERT ON audit.audit_event TO pbe_app;

-- 9. Reviewed functions (SECURITY DEFINER, owner pbe_owner, pinned search_path).

-- 9.1 Platform roles of ONE user (read by the API guard).
CREATE FUNCTION platform.access_platform_roles(p_user_id uuid) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT role FROM platform.platform_role_assignment WHERE user_id = p_user_id ORDER BY role $fn$;

-- 9.2 Operator only (NOT executable by pbe_app): grant or revoke a platform role, with audit.
CREATE FUNCTION platform.operator_platform_role_set(p_user_id uuid, p_role text, p_grant boolean)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_changed boolean;
BEGIN
  IF p_grant THEN
    INSERT INTO platform.platform_role_assignment (user_id, role) VALUES (p_user_id, p_role)
    ON CONFLICT DO NOTHING;
    v_changed := FOUND;
    UPDATE platform.user_account SET mfa_required = true, updated_at = now() WHERE id = p_user_id;
  ELSE
    DELETE FROM platform.platform_role_assignment WHERE user_id = p_user_id AND role = p_role;
    v_changed := FOUND;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, detail)
  VALUES (NULL, NULL, 'operator', CASE WHEN p_grant THEN 'platform.role_granted' ELSE 'platform.role_revoked' END,
          'user', p_user_id, jsonb_build_object('role', p_role, 'changed', v_changed));
  INSERT INTO audit.security_event (event_type, outcome, user_id, actor, detail)
  VALUES (CASE WHEN p_grant THEN 'platform_role_granted' ELSE 'platform_role_revoked' END, 'success',
          p_user_id, 'operator', jsonb_build_object('role', p_role, 'changed', v_changed));
  RETURN v_changed;
END
$fn$;

-- Internal helper: raise unless the actor holds platform_owner (defence in depth; the API guard
-- checks first).
CREATE FUNCTION platform.access_require_platform_owner(p_actor uuid) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.platform_role_assignment
                  WHERE user_id = p_actor AND role = 'platform_owner') THEN
    RAISE EXCEPTION 'platform owner role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$fn$;

-- 9.3 Tenant registry for the Super Admin (metadata only; no customer data).
CREATE FUNCTION platform.admin_tenant_list(p_actor uuid)
  RETURNS TABLE (id uuid, slug text, display_name text, status text, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  PERFORM platform.access_require_platform_owner(p_actor);
  RETURN QUERY SELECT t.id, t.slug, t.display_name, t.status, t.created_at
                 FROM platform.tenant t ORDER BY t.created_at, t.id;
END
$fn$;

-- Creates the tenant row (the API then initialises it in the SAME transaction, as pbe_app,
-- under that tenant's context: roles, departments, settings and the first Tenant Administrator).
CREATE FUNCTION platform.admin_tenant_create(p_actor uuid, p_id uuid, p_slug text, p_name text, p_request_id uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  PERFORM platform.access_require_platform_owner(p_actor);
  INSERT INTO platform.tenant (id, slug, display_name) VALUES (p_id, p_slug, p_name);
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id, detail)
  VALUES (p_id, p_actor, 'platform', 'tenant.created', 'tenant', p_id, p_request_id, jsonb_build_object('slug', p_slug));
END
$fn$;

CREATE FUNCTION platform.admin_tenant_set_status(p_actor uuid, p_tenant uuid, p_status text, p_request_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  PERFORM platform.access_require_platform_owner(p_actor);
  UPDATE platform.tenant SET status = p_status WHERE id = p_tenant AND status <> p_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id)
  VALUES (p_tenant, p_actor, 'platform',
          CASE p_status WHEN 'suspended' THEN 'tenant.suspended' ELSE 'tenant.reactivated' END,
          'tenant', p_tenant, p_request_id);
  RETURN true;
END
$fn$;

-- 9.4 Break-glass (ADR-028).
CREATE FUNCTION platform.breakglass_request(p_actor uuid, p_tenant uuid, p_purpose text, p_request_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_id uuid;
BEGIN
  PERFORM platform.access_require_platform_owner(p_actor);
  IF NOT EXISTS (SELECT 1 FROM platform.tenant WHERE id = p_tenant) THEN
    RETURN NULL;
  END IF;
  INSERT INTO platform.break_glass_grant (tenant_id, requested_by, purpose)
  VALUES (p_tenant, p_actor, p_purpose) RETURNING id INTO v_id;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id, detail)
  VALUES (p_tenant, p_actor, 'platform', 'breakglass.requested', 'break_glass_grant', v_id, p_request_id,
          jsonb_build_object('purpose', p_purpose));
  RETURN v_id;
END
$fn$;

-- Expires an approved grant whose time is up (audited once), then reports its state.
CREATE FUNCTION platform.breakglass_refresh(p_grant uuid)
  RETURNS TABLE (id uuid, tenant_id uuid, requested_by uuid, purpose text, status text,
                 requested_at timestamptz, decided_at timestamptz, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
#variable_conflict use_column
DECLARE
  g platform.break_glass_grant%ROWTYPE;
BEGIN
  SELECT * INTO g FROM platform.break_glass_grant WHERE id = p_grant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF g.status = 'approved' AND now() >= g.expires_at THEN
    UPDATE platform.break_glass_grant SET status = 'expired', ended_at = g.expires_at WHERE id = g.id;
    INSERT INTO audit.audit_event (tenant_id, actor_kind, action, target_type, target_id)
    VALUES (g.tenant_id, 'platform', 'breakglass.expired', 'break_glass_grant', g.id);
    INSERT INTO audit.security_event (event_type, outcome, user_id, actor, detail)
    VALUES ('break_glass_expired', 'info', g.requested_by, 'system', jsonb_build_object('tenant', g.tenant_id));
    g.status := 'expired';
  END IF;
  RETURN QUERY SELECT g.id, g.tenant_id, g.requested_by, g.purpose, g.status, g.requested_at, g.decided_at, g.expires_at;
END
$fn$;

-- Grants of ONE tenant (for its approvers; the API guard checks the permission in that tenant).
CREATE FUNCTION platform.breakglass_list_for_tenant(p_tenant uuid)
  RETURNS TABLE (id uuid, tenant_id uuid, requested_by uuid, purpose text, status text,
                 requested_at timestamptz, decided_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT g.id, g.tenant_id, g.requested_by, g.purpose,
           CASE WHEN g.status = 'approved' AND now() >= g.expires_at THEN 'expired' ELSE g.status END,
           g.requested_at, g.decided_at, g.expires_at
      FROM platform.break_glass_grant g WHERE g.tenant_id = p_tenant ORDER BY g.requested_at DESC
  $fn$;

-- Requests made by ONE Super Admin.
CREATE FUNCTION platform.breakglass_list_for_requester(p_actor uuid)
  RETURNS TABLE (id uuid, tenant_id uuid, requested_by uuid, purpose text, status text,
                 requested_at timestamptz, decided_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT g.id, g.tenant_id, g.requested_by, g.purpose,
           CASE WHEN g.status = 'approved' AND now() >= g.expires_at THEN 'expired' ELSE g.status END,
           g.requested_at, g.decided_at, g.expires_at
      FROM platform.break_glass_grant g WHERE g.requested_by = p_actor ORDER BY g.requested_at DESC
  $fn$;

-- Approve or reject a REQUESTED grant of p_tenant (approver = a Tenant Admin of that tenant,
-- checked by the API guard; never the requester). Approval starts the one-hour window.
CREATE FUNCTION platform.breakglass_decide(p_grant uuid, p_tenant uuid, p_actor uuid, p_approve boolean, p_request_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  UPDATE platform.break_glass_grant
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = p_actor, decided_at = now(),
         expires_at = CASE WHEN p_approve THEN now() + interval '1 hour' END,
         ended_at = CASE WHEN p_approve THEN NULL ELSE now() END
   WHERE id = p_grant AND tenant_id = p_tenant AND status = 'requested' AND requested_by <> p_actor;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id)
  VALUES (p_tenant, p_actor, 'member', CASE WHEN p_approve THEN 'breakglass.approved' ELSE 'breakglass.rejected' END,
          'break_glass_grant', p_grant, p_request_id);
  RETURN true;
END
$fn$;

-- Revoke an approved (or requested) grant: by an approver of its tenant, or by its requester.
CREATE FUNCTION platform.breakglass_revoke(p_grant uuid, p_actor uuid, p_tenant uuid, p_request_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  UPDATE platform.break_glass_grant SET status = 'revoked', ended_at = now()
   WHERE id = p_grant AND status IN ('requested', 'approved')
     AND (tenant_id = p_tenant OR (p_tenant IS NULL AND requested_by = p_actor))
  RETURNING tenant_id INTO v_tenant;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE platform.user_session SET break_glass_grant_id = NULL, active_tenant_id = NULL
   WHERE break_glass_grant_id = p_grant;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id)
  VALUES (v_tenant, p_actor, CASE WHEN p_tenant IS NULL THEN 'platform' ELSE 'member' END,
          'breakglass.revoked', 'break_glass_grant', p_grant, p_request_id);
  RETURN true;
END
$fn$;

-- Records one use of a valid grant (audit + security event), before the read-only work runs.
CREATE FUNCTION platform.breakglass_record_use(p_grant uuid, p_actor uuid, p_operation text, p_request_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  g platform.break_glass_grant%ROWTYPE;
BEGIN
  SELECT * INTO g FROM platform.break_glass_grant WHERE id = p_grant;
  IF NOT FOUND OR g.status <> 'approved' OR now() >= g.expires_at OR g.requested_by <> p_actor THEN
    RETURN false;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, request_id, detail)
  VALUES (g.tenant_id, p_actor, 'break_glass', 'breakglass.used', 'break_glass_grant', g.id, p_request_id,
          jsonb_build_object('operation', p_operation));
  INSERT INTO audit.security_event (event_type, outcome, user_id, request_id, actor, detail)
  VALUES ('break_glass_used', 'success', p_actor, p_request_id, 'user',
          jsonb_build_object('tenant', g.tenant_id, 'operation', p_operation));
  RETURN true;
END
$fn$;

-- 9.5 Session context: active tenant or break-glass grant of ONE session.
CREATE FUNCTION platform.auth_session_context(p_session_id uuid)
  RETURNS TABLE (active_tenant_id uuid, break_glass_grant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT active_tenant_id, break_glass_grant_id FROM platform.user_session
     WHERE id = p_session_id AND ended_at IS NULL
  $fn$;

-- Sets the context of a session the API has just issued. Membership (for a tenant) is checked by
-- the API as pbe_app under RLS before calling; a grant must be valid and belong to the user.
CREATE FUNCTION platform.auth_session_set_context(p_session_id uuid, p_tenant uuid, p_grant uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM platform.user_session WHERE id = p_session_id AND ended_at IS NULL;
  IF NOT FOUND OR (p_tenant IS NOT NULL AND p_grant IS NOT NULL) THEN
    RETURN false;
  END IF;
  IF p_grant IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM platform.break_glass_grant g
        WHERE g.id = p_grant AND g.requested_by = v_user AND g.status = 'approved' AND now() < g.expires_at) THEN
    RETURN false;
  END IF;
  UPDATE platform.user_session SET active_tenant_id = p_tenant, break_glass_grant_id = p_grant
   WHERE id = p_session_id;
  RETURN true;
END
$fn$;

-- 9.6 One-time tokens (ADR-029).
CREATE FUNCTION platform.token_issue(p_user uuid, p_purpose text, p_hash bytea, p_ttl_seconds integer,
                                     p_tenant uuid, p_actor uuid)
  RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_expires timestamptz;
BEGIN
  IF p_ttl_seconds NOT BETWEEN 60 AND 14400 THEN
    RAISE EXCEPTION 'token lifetime out of range';
  END IF;
  -- Only the newest token of a purpose is valid.
  UPDATE platform.user_token SET revoked_at = now()
   WHERE user_id = p_user AND purpose = p_purpose AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO platform.user_token (user_id, purpose, token_hash, tenant_id, created_by, expires_at)
  VALUES (p_user, p_purpose, p_hash, p_tenant, p_actor, now() + make_interval(secs => p_ttl_seconds))
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$fn$;

-- Looks up ONE token WITHOUT using it (so the password rules can be checked first).
CREATE FUNCTION platform.token_lookup(p_hash bytea)
  RETURNS TABLE (user_id uuid, purpose text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT t.user_id, t.purpose FROM platform.user_token t JOIN platform.user_account u ON u.id = t.user_id
     WHERE t.token_hash = p_hash AND t.used_at IS NULL AND t.revoked_at IS NULL
       AND t.expires_at > now() AND u.status = 'active'
  $fn$;

-- Redeems ONE token: valid, unused, unexpired, unrevoked, active user. Marks it used atomically.
CREATE FUNCTION platform.token_redeem(p_hash bytea)
  RETURNS TABLE (user_id uuid, purpose text, tenant_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.user_token t SET used_at = now()
      FROM platform.user_account u
     WHERE t.token_hash = p_hash AND t.used_at IS NULL AND t.revoked_at IS NULL
       AND t.expires_at > now() AND u.id = t.user_id AND u.status = 'active'
    RETURNING t.user_id, t.purpose, t.tenant_id
  $fn$;

-- 10. Function privileges.
REVOKE ALL ON FUNCTION
  platform.access_platform_roles(uuid),
  platform.operator_platform_role_set(uuid, text, boolean),
  platform.access_require_platform_owner(uuid),
  platform.admin_tenant_list(uuid),
  platform.admin_tenant_create(uuid, uuid, text, text, uuid),
  platform.admin_tenant_set_status(uuid, uuid, text, uuid),
  platform.breakglass_request(uuid, uuid, text, uuid),
  platform.breakglass_refresh(uuid),
  platform.breakglass_list_for_tenant(uuid),
  platform.breakglass_list_for_requester(uuid),
  platform.breakglass_decide(uuid, uuid, uuid, boolean, uuid),
  platform.breakglass_revoke(uuid, uuid, uuid, uuid),
  platform.breakglass_record_use(uuid, uuid, text, uuid),
  platform.auth_session_context(uuid),
  platform.auth_session_set_context(uuid, uuid, uuid),
  platform.token_issue(uuid, text, bytea, integer, uuid, uuid),
  platform.token_lookup(bytea),
  platform.token_redeem(bytea),
  audit.audit_event_append_only()
FROM PUBLIC;
-- pbe_app: everything except the operator-only platform-role function and the internal helper.
GRANT EXECUTE ON FUNCTION
  platform.access_platform_roles(uuid),
  platform.admin_tenant_list(uuid),
  platform.admin_tenant_create(uuid, uuid, text, text, uuid),
  platform.admin_tenant_set_status(uuid, uuid, text, uuid),
  platform.breakglass_request(uuid, uuid, text, uuid),
  platform.breakglass_refresh(uuid),
  platform.breakglass_list_for_tenant(uuid),
  platform.breakglass_list_for_requester(uuid),
  platform.breakglass_decide(uuid, uuid, uuid, boolean, uuid),
  platform.breakglass_revoke(uuid, uuid, uuid, uuid),
  platform.breakglass_record_use(uuid, uuid, text, uuid),
  platform.auth_session_context(uuid),
  platform.auth_session_set_context(uuid, uuid, uuid),
  platform.token_issue(uuid, text, bytea, integer, uuid, uuid),
  platform.token_lookup(bytea),
  platform.token_redeem(bytea)
TO pbe_app;
