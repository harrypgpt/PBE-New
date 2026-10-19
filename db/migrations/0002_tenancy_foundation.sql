-- 0002_tenancy_foundation.sql
-- Purpose: tenant registry and the tenant-context functions used by row-level security (RLS).
-- Stage:   3 (STAGE-03-PLAN.md §3.2; DATA_AND_DATABASE_DESIGN.md §4; ADR-021)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- Additive only: creates one table, two functions, privileges and one policy. Nothing is
-- dropped, renamed or rewritten. Objects are created as pbe_owner by the runner.

-- 1. Tenant context, read from transaction-local settings set by the data-access layer
--    (withTenantTransaction → set_config(..., true)). Unset or empty → NULL, so policies match
--    no rows ("fail closed"). A malformed value raises an error instead of matching anything.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $fn$;
COMMENT ON FUNCTION app.current_tenant_id() IS 'Tenant of the current transaction (NULL if unset). Used by RLS policies.';

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $fn$;
COMMENT ON FUNCTION app.current_user_id() IS 'Acting user of the current transaction (NULL if unset).';

-- New functions are executable by PUBLIC by default; restrict them to the runtime role.
REVOKE ALL ON FUNCTION app.current_tenant_id(), app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO pbe_app;

-- 2. Tenant registry (one row per customer organisation). Fictional data only until OD-12(a).
CREATE TABLE platform.tenant (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.tenant IS 'Tenant registry. pbe_app may read only its own row (RLS); rows are managed by administrative tooling.';

-- 3. Access: the runtime role may only READ, and only its own tenant's row.
--    RLS is enabled but not forced (STAGE-03-PLAN.md §6.3): the owner (migrations and
--    administrative tooling) manages rows; pbe_app is never the owner, so RLS always applies to it.
REVOKE ALL ON platform.tenant FROM PUBLIC;
GRANT SELECT ON platform.tenant TO pbe_app;
ALTER TABLE platform.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_read ON platform.tenant
  FOR SELECT TO pbe_app
  USING (id = app.current_tenant_id());
