-- revert-pg-hba-pbe-backup.sql — PROPOSED undo of apply-pg-hba-pbe-backup.sql. NOT RUN on the real
-- server. Writes the dated copy back over pg_hba.conf, checks that PostgreSQL parses it, and
-- reloads. Run by the PostgreSQL administrator:
--   psql -h 127.0.0.1 -U postgres -d postgres -X -v stamp=<the same stamp> \
--        -f db/bootstrap/revert-pg-hba-pbe-backup.sql
-- The copy is kept (not deleted).
\set ON_ERROR_STOP 1
\pset pager off
SELECT set_config('pbe.hba_stamp', :'stamp', false);

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
  saved     text;
  problems  int;
BEGIN
  IF current_setting('pbe.hba_stamp') !~ '^[0-9]{8}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'stamp must look like 20261019-0930';
  END IF;
  IF pg_catalog.pg_stat_file(copy_path, true) IS NULL THEN
    RAISE EXCEPTION 'copy % not found; nothing changed', copy_path;
  END IF;
  saved := pg_catalog.pg_read_file(copy_path);
  PERFORM pg_temp.pbe_write_file(hba, saved);
  SELECT count(*) INTO problems FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL;
  IF problems > 0 THEN
    RAISE EXCEPTION 'the restored file has % parse errors; NOT reloaded (the running rules are unchanged)', problems;
  END IF;
  PERFORM pg_catalog.pg_reload_conf();
  RAISE NOTICE 'pg_hba.conf restored from % and configuration reloaded', copy_path;
END
$$;
