-- PROPOSED v2 — NOT EXECUTED. Replaces proposed-stage-07a-backup-roles.sql (v1), which the
-- review rejected (STAGE-07A-BACKUP-REVIEW.md §5). For owner approval before ANY execution.
-- Part 1 must be run by the PostgreSQL ADMINISTRATOR (only a superuser can grant BYPASSRLS),
-- through `npm run db:bootstrap` (administrator password typed in the terminal, never in chat;
-- the backup password is random, sent only as a SCRAM verifier, and written only to .env, 600).

-- ============ Part 1 (administrator; would be appended to bootstrap-local.sql) ============
\getenv backup_verifier PBE_BACKUP_VERIFIER

SELECT 'CREATE ROLE pbe_backup LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_backup') \gexec
-- Dedicated backup identity: the ONLY PBE role with BYPASSRLS. No memberships (NOINHERIT and
-- nothing granted to it), cannot create databases or roles, no replication, at most 2 sessions.
ALTER ROLE pbe_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE pbe_backup PASSWORD :'backup_verifier';
-- Defence in depth only (a session could change it); the real control is having no write grants.
ALTER ROLE pbe_backup SET default_transaction_read_only = on;
-- May connect to the two PBE databases (both already REVOKE ALL FROM PUBLIC).
GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;
-- NOT granted: pg_read_all_data (cluster-wide: it would also read every other database the role
-- can reach, e.g. "postgres", which allows PUBLIC to connect).
-- NOT changed: pbe_restore_drill stays NOBYPASSRLS (row-level security is restored after the
-- data, in pg_dump's post-data section, so restoring does not need a bypass).

-- ============ Part 2 (a normal, reviewed migration: 0005_backup_read_access.sql) ============
-- -- pbe:phase expand
-- GRANT USAGE ON SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
-- GRANT SELECT ON ALL TABLES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
-- GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
-- (No default privileges: a backup would carry an ALTER DEFAULT PRIVILEGES entry for pbe_owner
--  that the restore role may not recreate. Instead every later migration that creates a table
--  grants SELECT to pbe_backup, and a conformance test fails if any table is not readable by it.)

-- ============ Part 3 (administrator; server configuration, pg_hba.conf) ====================
-- PostgreSQL lets PUBLIC connect to "postgres" and "template1" by default. To make the backup
-- login connect ONLY to pbe_dev and pbe_test, these lines go ABOVE the existing host/local lines
-- in pg_hba.conf (first match wins), followed by a configuration reload:
--   host   pbe_dev,pbe_test  pbe_backup  127.0.0.1/32  scram-sha-256
--   host   pbe_dev,pbe_test  pbe_backup  ::1/128       scram-sha-256
--   host   all               pbe_backup  all           reject
--   local  all               pbe_backup                reject
