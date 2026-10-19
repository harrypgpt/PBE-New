-- READ-ONLY inspection of the server's connection configuration (STAGE-07A-BACKUP-REVIEW.md §16).
-- Run only through `npm run db:inspect-connections` (administrator password typed into psql's
-- own prompt). Changes nothing: everything runs inside a READ ONLY transaction.
--
-- Shows, in the order PostgreSQL applies them, every pg_hba.conf rule INCLUDING rules that come
-- from "include", "include_if_exists" and "include_dir" files (file_name / line_number), plus
-- any line PostgreSQL could not parse (error). Options that could hold a secret (for example an
-- LDAP bind password or a RADIUS secret) are masked. Note: pg_hba_file_rules shows the files as
-- they are NOW on disk; if they were edited without a reload, the running server still uses the
-- previous version (compare the file times below with pg_conf_load_time()).

\set ON_ERROR_STOP on
\pset pager off
\pset null '∅'
BEGIN READ ONLY;

SELECT current_setting('server_version') AS server_version,
       pg_catalog.pg_conf_load_time() AS configuration_loaded_at,
       current_setting('hba_file') AS hba_file,
       current_setting('ident_file') AS ident_file,
       current_setting('config_file') AS config_file;

SELECT name, setting, sourcefile, sourceline
  FROM pg_catalog.pg_settings
 WHERE name IN ('listen_addresses', 'port', 'unix_socket_directories', 'unix_socket_group',
                'unix_socket_permissions', 'ssl', 'password_encryption', 'scram_iterations',
                'log_statement', 'log_connections', 'log_min_error_statement',
                'authentication_timeout', 'max_connections')
 ORDER BY name;

SELECT (pg_catalog.pg_stat_file(current_setting('hba_file'))).modification AS hba_file_modified;

SELECT rule_number, file_name, line_number, type, database, user_name, address, netmask,
       auth_method,
       CASE WHEN array_to_string(options, ',') ~* '(passw|secret|key)' THEN '{masked}'
            ELSE options::text END AS options,
       error
  FROM pg_catalog.pg_hba_file_rules
 ORDER BY rule_number NULLS LAST, file_name, line_number;

SELECT map_number, file_name, line_number, map_name, sys_name, pg_username, error
  FROM pg_catalog.pg_ident_file_mappings
 ORDER BY map_number NULLS LAST, file_name, line_number;

SELECT datname, datallowconn, pg_catalog.array_to_string(datacl, ' ') AS access
  FROM pg_catalog.pg_database ORDER BY datname;

COMMIT;
