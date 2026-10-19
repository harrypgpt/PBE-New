-- TEMPLATE for tenant-owned tables (STAGE-03-PLAN.md §3.3). NOT a migration; never applied as is.
-- Future migrations copy this pattern for every table in schema "app". The Stage 3 tests build
-- their temporary fixture tables from exactly this text ({schema} is replaced by a zz_test_*
-- schema), and the RLS conformance check (tooling/migrate/src/conformance.ts) enforces it.
--
-- Rules:
--  * tenant_id uuid NOT NULL, referencing platform.tenant;
--  * primary key (tenant_id, id); child tables reference (tenant_id, parent_id), so a row can
--    never point at another tenant's row;
--  * row-level security ENABLED and FORCED;
--  * one FOR ALL policy for pbe_app using app.current_tenant_id() in USING and WITH CHECK;
--  * no privileges for PUBLIC; only the needed privileges for pbe_app (never TRUNCATE).

CREATE TABLE {schema}.project (
  tenant_id uuid NOT NULL REFERENCES platform.tenant (id),
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE {schema}.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE {schema}.project FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON {schema}.project
  FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON {schema}.project FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {schema}.project TO pbe_app;

CREATE TABLE {schema}.scenario (
  tenant_id  uuid NOT NULL REFERENCES platform.tenant (id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  code       text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES {schema}.project (tenant_id, id)
);
ALTER TABLE {schema}.scenario ENABLE ROW LEVEL SECURITY;
ALTER TABLE {schema}.scenario FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON {schema}.scenario
  FOR ALL TO pbe_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON {schema}.scenario FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {schema}.scenario TO pbe_app;
