-- 0006_projects_scenarios.sql
-- Purpose: projects, project departments and scenarios (Stage 8), project permissions and their
--          template-role assignments, department-based project visibility, archive protection.
-- Stage:   8 (STAGE-08-PLAN.md; decisions D8-1 to D8-8 approved 2026-10-18; ADR-030)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- PROPOSED, kept in db/migrations-proposed/ (no tool applies it). Order: after 0005 (backup read
-- access): from 0005 on the runner rolls back any migration that leaves data the backup login
-- cannot read, hence the SELECT grants to pbe_backup. Tested on throw-away servers only until the
-- backup prerequisites (B-1) are resolved.
--
-- Rules carried over from the Stage 3 template: tenant_id, composite keys, RLS enabled AND
-- forced, a permissive FOR ALL tenant policy for pbe_app, no PUBLIC rights, no TRUNCATE.
-- Department visibility (D8-6) is an ADDITIONAL RESTRICTIVE policy (combined with AND): a project
-- is visible when it has no departments, or the member belongs to one of them, or holds
-- tenant.allprojects.read, or an approved, unexpired break-glass grant is in use (read-only,
-- ADR-028). Scenarios inherit their project's visibility.
-- Checks are one per constraint (pg_dump re-brackets combined AND expressions).

-- 1. Permissions (D8-4, D8-6) and template roles (D8-5; Tenant Administrator keeps ALL tenant
--    permissions, so it can delegate them: an administrator can only grant what it holds).
INSERT INTO platform.permission (code, scope, read_only, description) VALUES
  ('tenant.projects.read',    'tenant', true,  'See projects and their scenarios (within department visibility)'),
  ('tenant.allprojects.read', 'tenant', true,  'See all projects of the organisation, whatever their departments'),
  ('tenant.projects.create',  'tenant', false, 'Create projects'),
  ('tenant.projects.manage',  'tenant', false, 'Change and archive projects; set their departments'),
  ('tenant.scenarios.manage', 'tenant', false, 'Add and change scenarios');

INSERT INTO platform.role_template_permission (template_key, permission) VALUES
  ('tenant_administrator', 'tenant.projects.read'),
  ('tenant_administrator', 'tenant.allprojects.read'),
  ('tenant_administrator', 'tenant.projects.create'),
  ('tenant_administrator', 'tenant.projects.manage'),
  ('tenant_administrator', 'tenant.scenarios.manage'),
  ('project_lead', 'tenant.projects.read'),
  ('project_lead', 'tenant.projects.create'),
  ('project_lead', 'tenant.projects.manage'),
  ('project_lead', 'tenant.scenarios.manage'),
  ('scientist', 'tenant.projects.read'),
  ('scientist', 'tenant.scenarios.manage'),
  ('qa_qc_reviewer', 'tenant.projects.read'),
  ('scientific_reviewer', 'tenant.projects.read'),
  ('viewer', 'tenant.projects.read');

-- Existing organisations: roles still linked to a template receive the new template permissions
-- (additions only; nothing is removed). app.role and app.role_permission force RLS even for their
-- owner, so FORCE is lifted for this statement and restored within this same transaction.
ALTER TABLE app.role NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permission NO FORCE ROW LEVEL SECURITY;
INSERT INTO app.role_permission (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, t.permission
  FROM app.role r
  JOIN platform.role_template_permission t ON t.template_key = r.template_key
 WHERE t.permission IN ('tenant.projects.read', 'tenant.allprojects.read', 'tenant.projects.create',
                        'tenant.projects.manage', 'tenant.scenarios.manage')
ON CONFLICT DO NOTHING;
ALTER TABLE app.role FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permission FORCE ROW LEVEL SECURITY;

-- 2. Tables (D8-3; dose metadata deferred to Stage 9).
CREATE TABLE app.project (
  tenant_id                uuid        NOT NULL REFERENCES platform.tenant (id),
  id                       uuid        NOT NULL DEFAULT uuidv7(),
  name                     text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  molecule                 text        NOT NULL CHECK (char_length(molecule) BETWEEN 1 AND 200),
  strength_value           numeric     NOT NULL
                           CONSTRAINT project_strength_positive CHECK (strength_value > 0)
                           CONSTRAINT project_strength_limit CHECK (strength_value <= 1000000),
  strength_unit            text        NOT NULL CHECK (strength_unit IN ('mg', 'g', 'µg')),
  dosage_form              text        NOT NULL CHECK (dosage_form ~ '^[a-z_]{1,64}$'),
  route                    text        NOT NULL CHECK (route ~ '^[a-z_]{1,64}$'),
  release_type             text        NOT NULL CHECK (release_type ~ '^[a-z_]{1,64}$'),
  product_flags            text[]      NOT NULL DEFAULT '{}',
  scope_status             text        NOT NULL CHECK (scope_status IN ('supported', 'unsupported')),
  scope_reasons            text[]      NOT NULL DEFAULT '{}',
  scope_vocabulary_version text        NOT NULL CHECK (char_length(scope_vocabulary_version) BETWEEN 1 AND 64),
  status                   text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- D8-7: next scenario number, taken with UPDATE … RETURNING (row lock): never reused.
  next_scenario_number     integer     NOT NULL DEFAULT 1 CHECK (next_scenario_number >= 1),
  created_by_membership    uuid        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_unsupported_has_reason
    CHECK (scope_status <> 'unsupported' OR cardinality(scope_reasons) > 0),
  CONSTRAINT project_supported_has_no_reason
    CHECK (scope_status <> 'supported' OR cardinality(scope_reasons) = 0),
  FOREIGN KEY (tenant_id, created_by_membership) REFERENCES app.membership (tenant_id, id)
);
CREATE INDEX project_tenant_status ON app.project (tenant_id, status);

CREATE TABLE app.project_department (
  tenant_id     uuid NOT NULL REFERENCES platform.tenant (id),
  project_id    uuid NOT NULL,
  department_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, project_id, department_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES app.project (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.department (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX project_department_by_department ON app.project_department (tenant_id, department_id);

CREATE TABLE app.scenario (
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id),
  id                    uuid        NOT NULL DEFAULT uuidv7(),
  project_id            uuid        NOT NULL,
  code                  text        NOT NULL CHECK (code ~ '^F[0-9]{3,}$'),
  description           text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_by_membership uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT scenario_code_unique_per_project UNIQUE (tenant_id, project_id, code),
  FOREIGN KEY (tenant_id, project_id) REFERENCES app.project (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_membership) REFERENCES app.membership (tenant_id, id)
);

-- 3. Archive protection (D8-8): an archived project, its departments and its scenarios can no
--    longer change, whoever asks (defence in depth behind the API).
CREATE FUNCTION app.project_archived_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'project' THEN
    IF OLD.status = 'archived' THEN
      RAISE EXCEPTION 'project % is archived and can no longer be changed', OLD.id
        USING ERRCODE = 'P0001', HINT = 'pbe:project_archived';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM app.project p
              WHERE p.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
                AND p.id = COALESCE(NEW.project_id, OLD.project_id)
                AND p.status = 'archived') THEN
    RAISE EXCEPTION 'project % is archived and can no longer be changed', COALESCE(NEW.project_id, OLD.project_id)
      USING ERRCODE = 'P0001', HINT = 'pbe:project_archived';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION app.project_archived_guard() FROM PUBLIC;
CREATE TRIGGER project_archived_guard BEFORE UPDATE ON app.project
  FOR EACH ROW EXECUTE FUNCTION app.project_archived_guard();
CREATE TRIGGER scenario_archived_guard BEFORE INSERT OR UPDATE ON app.scenario
  FOR EACH ROW EXECUTE FUNCTION app.project_archived_guard();
CREATE TRIGGER project_department_archived_guard BEFORE INSERT OR DELETE ON app.project_department
  FOR EACH ROW EXECUTE FUNCTION app.project_archived_guard();

-- 4. Visibility (D8-6).
-- Reviewed SECURITY DEFINER function (ADR-027 pattern): is an approved, unexpired break-glass grant
-- in use by THIS transaction's user for THIS transaction's tenant? No parameters: it reads only
-- the transaction's own context, so it cannot be used to ask about anyone else.
CREATE FUNCTION platform.access_breakglass_active_here() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.break_glass_grant g
     WHERE g.tenant_id = app.current_tenant_id()
       AND g.requested_by = app.current_user_id()
       AND g.status = 'approved'
       AND g.expires_at > now())
$$;
REVOKE ALL ON FUNCTION platform.access_breakglass_active_here() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.access_breakglass_active_here() TO pbe_app;

-- Invoker function: runs with the caller's rights and row-level security.
CREATE FUNCTION app.project_visible(p_tenant uuid, p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM app.project_department pd
                      WHERE pd.tenant_id = p_tenant AND pd.project_id = p_project)
      OR EXISTS (SELECT 1
                   FROM app.project_department pd
                   JOIN app.membership_department md
                     ON md.tenant_id = pd.tenant_id AND md.department_id = pd.department_id
                   JOIN app.membership m
                     ON m.tenant_id = md.tenant_id AND m.id = md.membership_id
                  WHERE pd.tenant_id = p_tenant AND pd.project_id = p_project
                    AND m.user_id = app.current_user_id() AND m.status = 'active')
      OR EXISTS (SELECT 1
                   FROM app.membership m
                   JOIN app.membership_role mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
                   JOIN app.role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                  WHERE m.tenant_id = p_tenant AND m.user_id = app.current_user_id()
                    AND m.status = 'active' AND rp.permission = 'tenant.allprojects.read')
      OR platform.access_breakglass_active_here()
$$;
REVOKE ALL ON FUNCTION app.project_visible(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_visible(uuid, uuid) TO pbe_app;

-- 5. Row-level security.
ALTER TABLE app.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_department ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_department FORCE ROW LEVEL SECURITY;
ALTER TABLE app.scenario ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scenario FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.project FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.project_department FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.scenario FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY department_visibility ON app.project AS RESTRICTIVE FOR ALL TO pbe_app
  USING (app.project_visible(tenant_id, id));
CREATE POLICY project_visibility ON app.scenario AS RESTRICTIVE FOR ALL TO pbe_app
  USING (EXISTS (SELECT 1 FROM app.project p WHERE p.tenant_id = scenario.tenant_id AND p.id = scenario.project_id));

-- 6. Privileges. No DELETE on projects or scenarios (archived, kept for the audit history).
REVOKE ALL ON app.project, app.project_department, app.scenario FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.project, app.scenario TO pbe_app;
GRANT SELECT, INSERT, DELETE ON app.project_department TO pbe_app;
-- Backup coverage (migration 0005 rule).
GRANT SELECT ON app.project, app.project_department, app.scenario TO pbe_backup;
