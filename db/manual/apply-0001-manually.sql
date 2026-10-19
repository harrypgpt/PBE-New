-- Manual alternative to `npm run db -- migrate` for migration 0001 (owner request, Stage 2).
-- Produces exactly what the runner produces: same ledger table, same ownership (pbe_owner),
-- same search_path, and a ledger row with the file's real SHA-256 checksum.
--
-- Run from the project folder, against pbe_dev (never pbe_test: the tests rebuild it):
--
--   /Library/PostgreSQL/18/bin/psql -h localhost -U postgres -d pbe_dev -X -1 \
--     -v ON_ERROR_STOP=1 \
--     -v checksum="$(shasum -a 256 db/migrations/0001_schema_skeleton.sql | cut -d' ' -f1)" \
--     -f db/manual/apply-0001-manually.sql
--
-- -1 runs everything below in ONE transaction: on any error nothing is kept.
-- Requires the roles and database from `npm run db:bootstrap`.
-- Afterwards run `npm run db -- snapshot` so the drift check knows the expected schema.
-- Keep the ledger definition below identical to ensureLedger() in tooling/migrate/src/runner.ts.

SET LOCAL ROLE pbe_owner;
SET LOCAL search_path = pg_catalog, pg_temp;

CREATE SCHEMA IF NOT EXISTS pbe_meta;
CREATE TABLE IF NOT EXISTS pbe_meta.schema_migration (
  version         integer     PRIMARY KEY CHECK (version > 0),
  name            text        NOT NULL,
  checksum_sha256 text        NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  phase           text        NOT NULL CHECK (phase IN ('expand', 'migrate', 'contract')),
  transactional   boolean     NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  applied_by      text        NOT NULL DEFAULT session_user,
  execution_ms    integer     NOT NULL CHECK (execution_ms >= 0),
  runner_version  text        NOT NULL
);
COMMENT ON TABLE pbe_meta.schema_migration IS 'PBE migration ledger. Written only by the migration runner (ADR-018).';

-- The migration itself, included unchanged from the repository.
\ir ../migrations/0001_schema_skeleton.sql

INSERT INTO pbe_meta.schema_migration
  (version, name, checksum_sha256, phase, transactional, execution_ms, runner_version)
VALUES (1, 'schema_skeleton', :'checksum', 'expand', true, 0, 'manual-psql');

SELECT version, name, checksum_sha256, applied_by, applied_at FROM pbe_meta.schema_migration;
