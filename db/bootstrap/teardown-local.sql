-- PBE local TEARDOWN. LOCAL ONLY. Never run by any PBE command; the owner runs it by hand,
-- as the PostgreSQL administrator, after reviewing it:
--
--   /Library/PostgreSQL/18/bin/psql -h localhost -U postgres -d postgres -X -f db/bootstrap/teardown-local.sql
--
-- It NEVER drops pbe_dev (ADR-020). It removes only what can be rebuilt:
--   1. temporary restore databases (pbe_restore_check_<10 hex>) left by a failed drill;
--   2. pbe_test (rebuilt by the tests; holds no real data);
--   3. the PBE roles — but only if pbe_dev no longer exists. While pbe_dev exists it stops
--      here and keeps the roles, because pbe_owner still owns pbe_dev.
-- Removing pbe_dev itself is a deliberate, separate, manual decision and is not scripted.
-- Its behaviour is tested only against a throw-away PostgreSQL instance (db/tests).

\set ON_ERROR_STOP on

-- 1. Temporary restore databases (exact name pattern only).
SELECT format('DROP DATABASE %I', datname)
  FROM pg_catalog.pg_database
 WHERE datname ~ '^pbe_restore_check_[0-9a-f]{10}$' \gexec

-- 2. The test database.
DROP DATABASE IF EXISTS pbe_test WITH (FORCE);

-- 3. Roles, only when pbe_dev is gone.
SELECT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = 'pbe_dev') AS dev_exists \gset
\if :dev_exists
  \echo 'TEARDOWN STOPPED: pbe_dev exists and is never dropped by this script. PBE roles were kept.'
  \quit
\endif

DROP ROLE IF EXISTS pbe_backup;
DROP ROLE IF EXISTS pbe_restore_drill;
DROP ROLE IF EXISTS pbe_app;
DROP ROLE IF EXISTS pbe_migrator;
DROP ROLE IF EXISTS pbe_owner;
\echo 'TEARDOWN COMPLETE: pbe_test, temporary restore databases and PBE roles removed.'
