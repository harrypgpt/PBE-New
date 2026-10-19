-- 0005_backup_read_access.sql
-- Purpose: read access for the dedicated backup login (pbe_backup), so pg_dump can copy every PBE
--          table, including those with forced row-level security (pbe_backup has BYPASSRLS).
-- Stage:   7A (STAGE-07A-BACKUP-REVIEW.md, design v2)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- PROPOSED: kept in db/migrations-proposed/ so that no tool applies it yet. It is moved into
-- db/migrations/ only in the separately authorised execution phase, AFTER the bootstrap has
-- created pbe_backup (GRANT to a missing role would fail).
--
-- Grants ONLY: USAGE on the five PBE schemas and SELECT on their tables and sequences, to
-- pbe_backup only. No write privileges, no CREATE, no function EXECUTE, nothing for any other
-- role, no default privileges (a backup would carry them and the restore role could not recreate
-- them). Later migrations that create tables must GRANT SELECT to pbe_backup; the conformance test
-- backupReadabilityViolations fails the build if one is missed.

GRANT USAGE ON SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
