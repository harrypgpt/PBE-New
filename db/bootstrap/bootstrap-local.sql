-- PBE local database bootstrap. LOCAL DEVELOPMENT ONLY — never run against production.
--
-- Run it only through `npm run db:bootstrap`, which:
--   * reuses the passwords already in .env (or generates random ones) and turns them into
--     SCRAM-SHA-256 verifiers locally, so plain passwords are never sent, printed or logged;
--   * passes only the verifiers to this script (environment variables read with \getenv);
--   * lets psql prompt you for the administrator password in your own terminal;
--   * writes the plain passwords to the git-ignored .env file (permissions 600).
--
-- What it does (all as the PostgreSQL administrator you log in as, normally "postgres"):
--   1. checks the server is PostgreSQL 18 (ADR-017);
--   2. creates five PBE roles if missing, and (re)asserts their attributes;
--   3. sets the four login passwords (one transaction, checked, never logged or echoed);
--   4. lets pbe_migrator act as pbe_owner;
--   5. creates pbe_dev and pbe_test if missing, owned by pbe_owner (ADR-020);
--   6. limits who may connect to them;
--   7. closes two write paths PostgreSQL leaves open to every login (large objects, WAL messages);
--   8. prints the resulting roles and databases.
-- It never drops anything and never touches other roles or databases. Re-running it is safe:
-- existing databases and their data are left as they are, and existing passwords are kept.

\set ON_ERROR_STOP on
\set ECHO none
\pset pager off
\getenv migrator_verifier PBE_MIGRATOR_VERIFIER
\getenv app_verifier PBE_APP_VERIFIER
\getenv restore_verifier PBE_RESTORE_VERIFIER
\getenv backup_verifier PBE_BACKUP_VERIFIER
-- All four verifiers must be supplied (by npm run db:bootstrap); otherwise stop before any change.
\if :{?migrator_verifier}
\else
DO $$ BEGIN RAISE EXCEPTION 'PBE_MIGRATOR_VERIFIER not set: run this only through npm run db:bootstrap'; END $$;
\endif
\if :{?app_verifier}
\else
DO $$ BEGIN RAISE EXCEPTION 'PBE_APP_VERIFIER not set: run this only through npm run db:bootstrap'; END $$;
\endif
\if :{?restore_verifier}
\else
DO $$ BEGIN RAISE EXCEPTION 'PBE_RESTORE_VERIFIER not set: run this only through npm run db:bootstrap'; END $$;
\endif
\if :{?backup_verifier}
\else
DO $$ BEGIN RAISE EXCEPTION 'PBE_BACKUP_VERIFIER not set: run this only through npm run db:bootstrap'; END $$;
\endif

-- 1. PostgreSQL 18 only.
DO $$
BEGIN
  IF current_setting('server_version_num')::int / 10000 <> 18 THEN
    RAISE EXCEPTION 'PBE requires PostgreSQL 18; this server is %', current_setting('server_version');
  END IF;
END
$$;

-- 2. Roles (cluster-wide). Created only if missing.
--    pbe_owner         owns all PBE schemas, objects and databases; cannot log in; cannot
--                      create databases.
--    pbe_migrator      logs in to run migrations and backups; may act as pbe_owner.
--    pbe_app           the future API runtime role; owns nothing; no DDL; no BYPASSRLS.
--    pbe_restore_drill TEST-ONLY login (ADR-020). The only role that may create databases, so
--                      the restore drill can make and drop its own temporary database. It is NOT
--                      a member of pbe_owner and is not granted access to pbe_dev, so PostgreSQL
--                      itself prevents it from reading or dropping pbe_dev or pbe_test: a role can
--                      drop only databases it owns.
--    pbe_backup        READ-ONLY backup login (Stage 7A, STAGE-07A-BACKUP-REVIEW.md). The ONLY PBE
--                      role with BYPASSRLS, because pg_dump cannot copy tables with forced
--                      row-level security otherwise. No memberships, cannot create databases or
--                      roles; reads PBE schemas only (grants in migration 0005); may connect only
--                      to pbe_dev and pbe_test (plus the pg_hba.conf rule, see README).
SELECT 'CREATE ROLE pbe_owner NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_owner') \gexec
SELECT 'CREATE ROLE pbe_migrator LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_migrator') \gexec
SELECT 'CREATE ROLE pbe_app LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_app') \gexec
SELECT 'CREATE ROLE pbe_restore_drill LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_restore_drill') \gexec
SELECT 'CREATE ROLE pbe_backup LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pbe_backup') \gexec

ALTER ROLE pbe_owner         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE pbe_migrator      LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT   NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
ALTER ROLE pbe_app           LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 50;
ALTER ROLE pbe_restore_drill LOGIN   NOSUPERUSER CREATEDB   NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
ALTER ROLE pbe_backup        LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS   CONNECTION LIMIT 2;
-- Defence in depth only (a session could change it): the real control is having no write grants.
ALTER ROLE pbe_backup SET default_transaction_read_only = on;

-- 3. Login passwords, supplied as SCRAM-SHA-256 verifiers (not plain text).
--    The statements carrying them must reach neither the server log nor the terminal: statement
--    logging is switched off for THIS SESSION ONLY (the administrator is a superuser; nothing is
--    changed in the server configuration), and psql shows errors without the statement text.
--    All four are set in one transaction and then checked: PostgreSQL must have stored each
--    verifier exactly as given (a malformed one would be hashed again as a plain password and the
--    login would silently stop working). Otherwise everything is rolled back: every login keeps
--    its previous password and .env is not changed.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = panic;
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN;
ALTER ROLE pbe_migrator PASSWORD :'migrator_verifier';
ALTER ROLE pbe_app      PASSWORD :'app_verifier';
ALTER ROLE pbe_restore_drill PASSWORD :'restore_verifier';
ALTER ROLE pbe_backup   PASSWORD :'backup_verifier';
SELECT count(*) = 4 AS verifiers_stored
  FROM pg_catalog.pg_authid
 WHERE (rolname, rolpassword) IN (('pbe_migrator', :'migrator_verifier'),
                                  ('pbe_app', :'app_verifier'),
                                  ('pbe_restore_drill', :'restore_verifier'),
                                  ('pbe_backup', :'backup_verifier')) \gset
\if :verifiers_stored
COMMIT;
\else
ROLLBACK;
DO $$ BEGIN RAISE EXCEPTION 'PostgreSQL did not store the SCRAM verifiers as given; no password was changed'; END $$;
\endif
RESET log_statement;
RESET log_min_duration_statement;
RESET log_min_error_statement;
\set VERBOSITY default
\set SHOW_CONTEXT errors

-- 4. pbe_migrator may SET ROLE pbe_owner, so objects it creates are owned by pbe_owner.
GRANT pbe_owner TO pbe_migrator WITH INHERIT TRUE, SET TRUE;

-- 5. Databases, owned by pbe_owner. (CREATE DATABASE cannot run inside a transaction;
--    \gexec runs each statement on its own.) Existing databases are never touched.
--    pbe_dev   development data
--    pbe_test  rebuilt by the automated tests; never holds real data
SELECT 'CREATE DATABASE pbe_dev OWNER pbe_owner TEMPLATE template0 ENCODING ''UTF8'''
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = 'pbe_dev') \gexec
SELECT 'CREATE DATABASE pbe_test OWNER pbe_owner TEMPLATE template0 ENCODING ''UTF8'''
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = 'pbe_test') \gexec

-- 6. Connection rights: nobody by default; only pbe_migrator and pbe_app may connect.
REVOKE ALL ON DATABASE pbe_dev, pbe_test FROM PUBLIC;
GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_migrator, pbe_app;
-- The restore role may connect only to pbe_test (from where it creates its temporary databases);
-- it is granted no schema or table access there.
GRANT CONNECT ON DATABASE pbe_test TO pbe_restore_drill;
-- The backup login may connect to the two PBE databases only (it gets no CONNECT anywhere else;
-- PostgreSQL's default PUBLIC access to "postgres" and "template1" is closed by pg_hba.conf).
GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;

-- 7. Two write paths that PostgreSQL leaves open to EVERY login by default
--    (STAGE-07A-BACKUP-REVIEW.md F-9): creating large objects (blocked for pbe_backup only by its
--    read-only default, which a session can switch off) and writing logical-decoding messages
--    into the WAL (allowed even in a read-only transaction). PBE uses neither. These are rights
--    on built-in functions, kept per database, so they are closed in each PBE database. The
--    restore drill still works: a restore role cannot repeat this REVOKE and PostgreSQL only
--    warns, and temporary copies are dropped afterwards.
\connect pbe_dev
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid), pg_catalog.lo_creat(integer),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.pg_logical_emit_message(boolean, text, text, boolean),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea, boolean) FROM PUBLIC;
\connect pbe_test
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid), pg_catalog.lo_creat(integer),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.pg_logical_emit_message(boolean, text, text, boolean),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea, boolean) FROM PUBLIC;
\connect postgres

-- 8. Report.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
       rolbypassrls, rolconnlimit
  FROM pg_catalog.pg_roles WHERE rolname IN ('pbe_owner', 'pbe_migrator', 'pbe_app', 'pbe_restore_drill', 'pbe_backup') ORDER BY rolname;
SELECT datname, pg_catalog.pg_get_userbyid(datdba) AS owner, datacl
  FROM pg_catalog.pg_database WHERE datname IN ('pbe_dev', 'pbe_test') ORDER BY datname;
