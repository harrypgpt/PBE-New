-- apply-pg-hba-pbe-backup.sql — PROPOSED (STAGE-08-INTEGRATION-PLAN.md, phase 4). NOT RUN on the real
-- server. Puts the reviewed lines of pg_hba-pbe-backup.conf ABOVE every existing line of the
-- server's pg_hba.conf, then reloads the configuration. Run by the PostgreSQL ADMINISTRATOR
-- (superuser) with psql; no operating-system password (sudo) is needed, because the server writes
-- its own file. Rehearsed on throw-away servers (db/tests/pg-hba-change.throwaway.db.spec.ts).
--
-- Usage (psql asks for the administrator password itself):
--   psql -h 127.0.0.1 -U postgres -d postgres -X \
--        -v stamp=<YYYYMMDD-HHMM> -v lines_file=db/bootstrap/pg_hba-pbe-backup.conf \
--        -f db/bootstrap/apply-pg-hba-pbe-backup.sql
--
-- Safety:
--  1. Refuses if the lines are already present, or if the copy name already exists.
--  2. Writes a dated COPY of the current file next to it (pg_hba.conf.pre-pbe-backup-<stamp>) and
--     reads it back: it must equal the original byte for byte.
--  3. Writes the new file and reads it back: it must equal "lines + original" byte for byte.
--  4. Asks PostgreSQL to parse the NEW file (pg_hba_file_rules) BEFORE reloading: on any error,
--     or if the first rules are not the expected pbe_backup lines, the ORIGINAL is written back
--     and the script stops. The running server is never reloaded with a faulty file.
--  5. Only then: pg_reload_conf() (a reload; no restart). Other logins are not affected.
-- Undo: revert-pg-hba-pbe-backup.sql with the same stamp.
\set ON_ERROR_STOP 1
\pset pager off
\set lines `cat :lines_file`
SELECT set_config('pbe.hba_lines', :'lines' || E'\n', false),
       set_config('pbe.hba_stamp', :'stamp', false);

-- Writes `content` to `path` exactly (one row per line; CSV with unused quote and delimiter
-- characters, so tabs, backslashes and quotes are written unchanged), then reads it back.
CREATE FUNCTION pg_temp.pbe_write_file(p_path text, p_content text) RETURNS void
  LANGUAGE plpgsql AS $f$
BEGIN
  IF right(p_content, 1) <> E'\n' THEN
    RAISE EXCEPTION 'content must end with a newline';
  END IF;
  EXECUTE format(
    $q$COPY (SELECT NULLIF(l, '') FROM unnest(string_to_array(%L, E'\n')) WITH ORDINALITY AS t(l, n) ORDER BY n)
         TO %L WITH (FORMAT csv, DELIMITER E'\x02', QUOTE E'\x01')$q$,
    left(p_content, -1), p_path);
  IF pg_catalog.pg_read_file(p_path) IS DISTINCT FROM p_content THEN
    RAISE EXCEPTION 'the file written to % differs from the intended content', p_path;
  END IF;
END
$f$;

DO $$
DECLARE
  hba       text := current_setting('hba_file');
  copy_path text := current_setting('hba_file') || '.pre-pbe-backup-' || current_setting('pbe.hba_stamp');
  original  text := pg_catalog.pg_read_file(current_setting('hba_file'));
  proposal  text := current_setting('pbe.hba_lines');
  problems  int;
  first_six text[];
BEGIN
  IF current_setting('pbe.hba_stamp') !~ '^[0-9]{8}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'stamp must look like 20261019-0930';
  END IF;
  IF original ~ '(^|\n)\s*(host|local)\s+\S+\s+pbe_backup\s' THEN
    RAISE EXCEPTION 'pg_hba.conf already has pbe_backup lines; nothing changed';
  END IF;
  IF pg_catalog.pg_stat_file(copy_path, true) IS NOT NULL THEN
    RAISE EXCEPTION 'copy % already exists; choose another stamp', copy_path;
  END IF;
  IF right(original, 1) <> E'\n' THEN
    original := original || E'\n';  -- a missing final newline is added (the only change made)
  END IF;

  PERFORM pg_temp.pbe_write_file(copy_path, original);
  RAISE NOTICE 'copy of the current file written and verified: %', copy_path;

  PERFORM pg_temp.pbe_write_file(hba, proposal || original);
  SELECT count(*) INTO problems FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL;
  SELECT array_agg(type || ' ' || array_to_string(database, ',') || ' ' || array_to_string(user_name, ',')
                   || ' ' || coalesce(address, '') || ' ' || auth_method ORDER BY rule_number)
    INTO first_six FROM pg_catalog.pg_hba_file_rules WHERE rule_number <= 6;
  IF problems > 0 OR first_six IS DISTINCT FROM ARRAY[
       'host pbe_dev,pbe_test pbe_backup 127.0.0.1 scram-sha-256',
       'host pbe_dev,pbe_test pbe_backup ::1 scram-sha-256',
       'host all pbe_backup all reject',
       'host replication pbe_backup all reject',
       'local all pbe_backup  reject',
       'local replication pbe_backup  reject'] THEN
    PERFORM pg_temp.pbe_write_file(hba, original);
    RAISE EXCEPTION 'the new file did not parse as expected (% errors; first rules %); the original was written back, nothing reloaded',
      problems, first_six;
  END IF;
  PERFORM pg_catalog.pg_reload_conf();
  RAISE NOTICE 'pg_hba.conf updated (% new lines on top) and configuration reloaded', 6;
END
$$;

SELECT rule_number, type, database, user_name, address, auth_method, error
  FROM pg_catalog.pg_hba_file_rules ORDER BY rule_number;
