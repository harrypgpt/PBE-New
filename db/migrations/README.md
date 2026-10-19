# Migrations

Hand-written, numbered SQL files: the only source of truth for the database structure (ADR-004).
They are applied by the in-house runner (ADR-018): `npm run db -- migrate`.

Rules (enforced by the runner before anything is applied):

- Name: `NNNN_short_description.sql`, numbered from `0001` with no gaps or duplicates.
- Header: `-- pbe:phase expand`, `-- pbe:phase migrate` or `-- pbe:phase contract`.
- **Never edit a file after it has been applied anywhere.** Its SHA-256 checksum is in the ledger
  (`pbe_meta.schema_migration`); a changed, renamed or deleted file stops all further migrations.
  Put corrections in a new file.
- Each file runs in its own transaction together with its ledger row. Do not write BEGIN/COMMIT.
- Destructive statements (DROP, TRUNCATE, DELETE, ALTER … DROP/RENAME/TYPE) are allowed only in
  `contract` files, and those run only with `--allow-contract` after a verified backup.
- Schema-qualify every name (`app.project`, not `project`); search_path is `pg_catalog` only.
- Use `SET LOCAL`, never `SET`. No role, database or server-configuration statements.
- `-- pbe:no-transaction` is only for single statements that cannot run in a transaction
  (e.g. `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`). They must be re-runnable.

**Tenant-owned tables** (schema `app`) must follow [db/templates/tenant-table.sql](../templates/tenant-table.sql):
`tenant_id` with a foreign key to `platform.tenant`, primary key `(tenant_id, id)`, composite
foreign keys between tenant tables, row-level security **enabled and forced**, and one
`tenant_isolation` policy for `pbe_app`. The conformance test fails the build otherwise.
After adding a migration, run `npm run db -- typegen` so the API's database types stay current.

The safety checks are lexical, not a full SQL parser: statements inside dollar-quoted bodies
(`DO $$ … $$`, function bodies) are not inspected, so reviewers must read those carefully.
