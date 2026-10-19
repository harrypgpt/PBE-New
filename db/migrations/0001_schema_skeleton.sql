-- 0001_schema_skeleton.sql
-- Purpose: create the empty PBE schema skeleton (no tables) and its access rules.
-- Stage:   2 (DATA_AND_DATABASE_DESIGN.md §2)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- The migration runner creates the pbe_meta schema and its ledger table before this file runs.
-- Objects are created as pbe_owner (the runner sets that role); search_path is pg_catalog only,
-- so every name below is schema-qualified.

-- The default "public" schema is not used by PBE: no one but its owner may use it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA app;
COMMENT ON SCHEMA app IS 'Tenant-scoped application data. Row-level security is enforced from Stage 3.';

CREATE SCHEMA platform;
COMMENT ON SCHEMA platform IS 'Platform-level data: tenant registry, platform users, methods, rulesets, models, consent policies.';

CREATE SCHEMA training;
COMMENT ON SCHEMA training IS 'Consented, eligibility-reviewed training data (C6). No runtime access until Stage 24.';

CREATE SCHEMA audit;
COMMENT ON SCHEMA audit IS 'Append-only audit events.';

-- New schemas grant nothing to PUBLIC; state it explicitly for reviewers.
REVOKE ALL ON SCHEMA app, platform, training, audit FROM PUBLIC;

-- The runtime role may look up objects in these schemas. Table privileges are granted
-- table by table in later migrations (least privilege). No access to "training".
GRANT USAGE ON SCHEMA app, platform, audit TO pbe_app;

-- The API checks the ledger version at start-up (Stage 4), so it may read, never write, the ledger.
GRANT USAGE ON SCHEMA pbe_meta TO pbe_app;
GRANT SELECT ON pbe_meta.schema_migration TO pbe_app;
