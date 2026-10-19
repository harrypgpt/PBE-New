-- PROPOSED — NOT EXECUTED. For owner review (STAGE-07A.md §6, decision B-1).
-- Must be run by the PostgreSQL ADMINISTRATOR (superuser), because only a superuser can grant
-- BYPASSRLS. The coding agent will NOT run it, and will not ask for the administrator password in
-- the chat. After approval it would be added to db/bootstrap/bootstrap-local.sql and applied with
-- `npm run db:bootstrap`, which asks for the password in the terminal (hidden) and writes the new
-- role's random password only to .env (permissions 600).
--
-- WHY: Stage 7A adds the first real tenant tables. Stage 3 requires them to FORCE row-level
-- security (so even their owner is subject to it). pg_dump therefore refuses to copy them unless
-- it runs as a role that bypasses row-level security; no PBE role can today, so backups of any
-- database with migration 0004 fail ("query would be affected by row-level security policy").
-- Restoring such tables (COPY FROM) has the same requirement.
--
-- WHAT IT CHANGES:
--  1. A new, dedicated, READ-ONLY backup login. It can read every table (that is what a backup
--     is), cannot write anything, owns nothing, cannot create databases or roles, and may connect
--     only to pbe_dev and pbe_test.
--  2. The existing TEST-ONLY restore role (connects only to pbe_test and its own temporary
--     databases, ADR-020) may load row-level-secured tables into those temporary databases.
--
-- Nothing else changes. pbe_app keeps NOBYPASSRLS (checked at API start-up).

-- 1. Read-only backup role.
SELECT 'CREATE ROLE pbe_backup LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pbe_backup') \gexec
ALTER ROLE pbe_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE pbe_backup PASSWORD :'backup_verifier';
GRANT pg_read_all_data TO pbe_backup;
GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;

-- 2. Test-only restore role: may restore row-level-secured tables into its temporary databases.
ALTER ROLE pbe_restore_drill BYPASSRLS;
