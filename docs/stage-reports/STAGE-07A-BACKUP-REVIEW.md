# Stage 07A — B-1 backup security review, v2 implementation and final review corrections

Phase A (inspection): 2026-10-17. Phase B (implementation, code and files only): 2026-10-17/18.
Phase C (final review corrections, code, files and throw-away tests only): 2026-10-18.
Reviewer and implementer: Claude Code (Claude Opus 5.5), the same agent that wrote the proposal. Requested by: owner.

> **Evidence qualification.** This is the coding agent's own review and testing of its own work. It is **not** independently verified (R-006). Every result below comes from a command listed here, run on this Mac against PostgreSQL 18.6.

## 0. Phase C summary (current) — revised verdict

**Revised verdict: BLOCKED — backup v2 is not yet ready for the execution phase.** Not independently verified. Two things block it:

1. **An unexpected change on the real server (§23).** Between 10:12 and about 10:55 IST today, a role `pbe_backup` with BYPASSRLS was created on the real PostgreSQL server. It has CONNECT on `pbe_dev` and `pbe_test`, and its sessions start read-only. I did not do this: creating such a role needs the administrator password, which none of my tools have, and my session log contains no administrator command. The role currently **cannot read any PBE data**: 0 of 9 tables in `pbe_dev`, and migration 0005 was never applied. Its password is not in `.env`. I have changed nothing. **Please confirm whether you, or someone with the administrator password, created it.**
2. **The real server's connection rules could not be reviewed (§18).** `pg_hba.conf` and its included files belong to the system `postgres` account (`Permission denied` for this user). I prepared a read-only inspection (`npm run db:inspect-connections`) that you run and that asks for the administrator password itself. It has not been run.

Everything else the review asked for is done and passed on private throw-away servers. The items, in brief (details in §16–§22):

| Item | Result (agent's own tests; throw-away servers unless stated) |
|---|---|
| 1. Credential lifecycle | **PASS.** The real `npm run db:bootstrap` script was run end to end on a throw-away server: random password → SCRAM verifier checked before use → stored exactly as given (checked inside one transaction, otherwise everything is rolled back) → `.env` written atomically, owner-only → login over IPv4 and IPv6 with SCRAM-SHA-256. Neither the password nor the verifier appears in the script output or the server log, even with **every statement logged**. Clear-text password requests are refused before the password is sent. 15/15 tests |
| 2. Connection configuration | **PARTIAL.** Throw-away server: 30/30 matrix cells as required, using the proposed lines verbatim (§18). Real server: only the settings visible without administrator rights were reviewed; the rule order and included files are **not reviewed** (blocked, see above) |
| 3. Least privilege | **PASS, with three findings fixed or detected (§19).** Catalogue-wide audit: 0 violations. 39 direct attempts and 12 internally guarded built-ins: all refused. New: two write paths open to *every* login by default are closed by the bootstrap; replication is rejected explicitly; changes a role may make to itself are detected |
| 4. 0005 and future schemas | **PASS (§20).** Migrations from 0005 on are **rolled back** if they leave anything unreadable for the backup login. Backups and drills refuse unreadable tables, unlisted PBE schemas, large objects and default privileges. Incomplete files are never promoted (4 failure modes simulated) |
| 5. Backup/restore end to end | **PASS (§21).** Non-empty forced-RLS tables in two organisations: counts, checksums, joins, foreign keys (all valid), RLS enabled and forced, and policies all identical. Missing rows and unreadable tables fail |
| 6. This report | Updated |

Each control was also **mutation-checked**: I broke it on purpose, and the tests failed. All 11 controls detected (§22).

What Phase C did **not** do (as instructed):
- `npm run db:bootstrap` was not run against the real server;
- no real role, permission or `pg_hba.conf` was changed;
- no migration was applied to `pbe_test` or `pbe_dev` beyond the existing test rebuild of `pbe_test` (still at 0004);
- no database was created or deleted on the real server, apart from the temporary restore-test databases the existing tests create and drop;
- no backup was deleted, moved or cleaned up;
- nothing was committed or pushed;
- Stage 7B and Stage 8 were not started.

## 0B. Phase B summary (record)

**Recommendation at the time: PASS for this phase (code, migration file, tests, documentation), not independently verified.** B-1 itself stays **BLOCKED** until the separately authorised execution phase (§14) has been run.

What this phase did **not** do (as instructed):
- `npm run db:bootstrap` was **not** run; no role, permission, password or server setting was changed;
- migration 0005 was **not** applied anywhere: it sits in `db/migrations-proposed/`, which no tool reads;
- `pg_hba.conf` of the real server was **not** touched;
- no database was created, deleted or migrated on the real server (`pbe_dev` is still at 0003, `pbe_test` at 0004);
- no backup file was deleted, moved, overwritten or opened for its contents;
- nothing was committed or pushed; Stage 7B and Stage 8 were not started.

How v2 was proven without touching the real server: a **private, throw-away PostgreSQL 18.6 server** (temporary folder, local socket only, deleted after the test) ran the **real** bootstrap SQL, the real migrations 0001–0004 plus the proposed 0005, and real rows in forced-RLS tables (§11).

**Disclosure.** During Phase B I ran `node -e 'require("./tooling/scripts/db-bootstrap.cjs")'` as a syntax check. That loads the bootstrap script. I then verified that nothing was executed: the script's main routine runs only when started directly (it is guarded), `.env` was last changed at 18:23 on 2026-10-17 (before this phase) and has no backup entries, and the real server's roles and database rights are unchanged (§12). I should not have used that command; a plain syntax check (`node --check`) would have been enough.

## 1. Phase A verdict (record)

**BLOCKED: the proposed SQL (v1) must not be run as written.** It breaks two of your requirements:
1. it gives an RLS bypass to a second role;
2. its read grant works in every database the login can reach, including the non-PBE `postgres` database.

Phase A also found three defects in the backup tooling (§5, F-4 to F-6). They are fixed in Phase B (§10).

The **revised design (v2)** is in [db/bootstrap/proposed-stage-07a-backup-roles-v2.sql](../../db/bootstrap/proposed-stage-07a-backup-roles-v2.sql) (reference) and is now implemented in the bootstrap files and migration 0005, **not executed** on the real server.

## 2. Files inspected and commands run

| What | How |
|---|---|
| Proposed SQL v1 | `db/bootstrap/proposed-stage-07a-backup-roles.sql` (read in full) |
| Bootstrap | `db/bootstrap/bootstrap-local.sql`, `tooling/scripts/db-bootstrap.cjs` (roles, attributes, SCRAM verifiers, database rights) |
| Backup and restore tooling | `tooling/migrate/src/backup.ts` (`backupDatabase`, `restoreInto`, `compareDatabases`, `restoreDrill`), `tooling/migrate/src/cli.ts` |
| Schema and policies | `db/migrations/0001`–`0004`, `db/templates/tenant-table.sql`, `tooling/migrate/src/conformance.ts` |
| Decisions and risks | ADR-020, ADR-021, ADR-027–ADR-029; RISK_REGISTER (R-001, R-002, R-007, R-011); STAGE-07A.md §6 |
| Catalogue (read-only) | Server version; `pg_database.datacl`; PBE roles and attributes; `pg_auth_members`; schema ACLs; `pg_default_acl`; tables and functions with PUBLIC rights; extensions; forced-RLS tables; sequences and large objects (`pbe_dev` and `pbe_test`) |
| Backup behaviour | `pg_dump --schema-only` of `pbe_test` (as today: `pbe_migrator`, `--role=pbe_owner`), then `pg_restore -l` and `--section=pre-data|post-data`, and `pg_restore -f -` to read the SQL order |
| Existing artifacts | `ls -la backups/`; `pg_restore -l` on `backups/pbe_test-2026-10-17T16-03-36-182Z.dump` |

**Key observed facts:**
- PostgreSQL **18.6**.
- `pbe_dev`, `pbe_test`: `REVOKE ALL … FROM PUBLIC` is in effect. Only named roles may connect; no TEMP for PUBLIC.
- `postgres`: access list is NULL, i.e. PostgreSQL's default, where **PUBLIC may CONNECT and create TEMP objects**.
- `template1`: PUBLIC may CONNECT.
- Only `postgres` has BYPASSRLS. No PBE role has CREATEROLE. The only PBE membership is `pbe_migrator` in `pbe_owner`.
- No default privileges; no PBE table, sequence or function is available to PUBLIC; only the `plpgsql` extension; no sequences or large objects; `public` schema: CREATE only for the database owner.
- `pbe_test` has 7 forced-RLS tables (the `app.*` tables from 0004). `pbe_dev` has none yet (it is at 0003).
- **pg_dump places all 9 "ROW SECURITY" entries in the post-data section**, after `TABLE DATA`; policies are post-data too.
- `restoreInto` uses `--no-owner` but keeps ACLs. `backupDatabase` uses `--role=pbe_owner` and writes straight to the final file name.
- Backup files are `-rw-r--r--` (644) in a `drwxr-xr-x` (755) folder.

## 3. The SQL in v1 and what each statement does

| Statement | Privilege implication | Assessment |
|---|---|---|
| `CREATE ROLE pbe_backup LOGIN` (if missing) | New login | Needed |
| `ALTER ROLE pbe_backup … NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2` | Row-level security never applies to this role. Role attributes such as BYPASSRLS are **not** passed on through membership | BYPASSRLS needed (§4). `INHERIT` only serves `pg_read_all_data`, which is rejected |
| Password statement (a psql variable holding a SCRAM verifier; see the .sql file) | SCRAM verifier from the bootstrap; the plain password never reaches the server, output or logs | Acceptable (existing pattern) |
| `GRANT pg_read_all_data TO pbe_backup` | SELECT on **every** table, view and sequence and USAGE on **every** schema, **in every database of the cluster**. Combined with BYPASSRLS, it reads everything it can connect to | **Rejected (F-2)** |
| `GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup` | Allows connecting to the two PBE databases | Needed; but **not sufficient** to keep it out of `postgres` and `template1` (F-3) |
| `ALTER ROLE pbe_restore_drill BYPASSRLS` | A second role gets the bypass | **Rejected (F-1)**, and unnecessary |

## 4. PostgreSQL behaviour (why a normal grant is not enough)

- For tables with **forced** row-level security, the owner is also subject to it. `pg_dump` sets `row_security = off`. With that setting, any role still subject to RLS gets an **error** ("query would be affected by row-level security policy"), not a partial copy. This is what blocked Stage 7A.
- A SELECT grant alone is therefore insufficient. A dump that **succeeds** needs `BYPASSRLS` on the reading role.
- The only alternative, dumping with row-level security **on**, would silently copy **zero rows** for those tables, because no policy matches a backup role. That alternative is excluded.
- **Restore does not need a bypass:** table data is loaded before row-level security is enabled and forced (post-data). So the test-only restore role can stay NOBYPASSRLS.

## 5. Findings (threat and least-privilege analysis)

| # | Finding | Severity | Required change |
|---|---|---|---|
| F-1 | v1 gives BYPASSRLS to `pbe_restore_drill` as well. Breaks "bypass only for the backup identity"; and unnecessary (§4) | High | Remove; restore role stays NOBYPASSRLS |
| F-2 | `pg_read_all_data` is cluster-wide. With BYPASSRLS, `pbe_backup` could read **any** data in **any** database it reaches, including non-PBE data in `postgres` | High | Replace with explicit, per-database grants on PBE schemas only (migration 0005), with a conformance test that every PBE table is readable by `pbe_backup` |
| F-3 | PostgreSQL defaults let PUBLIC connect to `postgres` and `template1` (and create TEMP objects in `postgres`). Database grants alone cannot meet "connects only to `pbe_dev` and `pbe_test`" | Medium | Server rule in `pg_hba.conf`: allow `pbe_backup` only to `pbe_dev` and `pbe_test`, reject everything else (administrator step). The same pre-existing default affects `pbe_app` and `pbe_migrator`: recorded as an observation, not changed here |
| F-4 | **Silent empty comparison in the restore drill.** It reads rows as the owner (source: `SET ROLE pbe_owner`; copy: the restore role, which owns the copy). For forced-RLS tables the owner sees **0 rows without error**, so source 0 = copy 0 → "identical", even if data were missing. Not triggered yet (those tables are empty and not in `pbe_dev`), but it would hide exactly the failure you asked about | High | The drill reads the source as `pbe_backup` with `row_security = off`. It reads the copy with `row_security = off` inside a transaction that temporarily sets `NO FORCE ROW LEVEL SECURITY` on the copy's forced tables and is then **rolled back**, so the copy is unchanged. Add a test with rows in a forced-RLS table that must arrive with the same count and checksum |
| F-5 | **A failed backup leaves a misleading partial file.** `backups/pbe_test-2026-10-17T16-03-36-182Z.dump` (121 KB, from my failed run in Stage 7A) lists 23 data entries but is incomplete | Medium | Write to a temporary name; rename only after success and a full archive check; delete on failure. The existing partial file should be removed (with your approval) or renamed `*.INCOMPLETE` |
| F-6 | Backup files and folder are readable by other local users (644 / 755). They contain password hashes, encrypted MFA secrets, token hashes and personal data | Medium | Folder 700, files 600, set by the tool; existing files corrected |
| F-7 | `pg_dump` currently runs as `pbe_migrator` with `--role=pbe_owner` | Info | Switch backups to `pbe_backup` without `--role` (`pbe_backup` is not a member of `pbe_owner` and cannot become it) |
| F-8 | Default privileges would make every restore fail: a backup would carry `ALTER DEFAULT PRIVILEGES FOR ROLE pbe_owner`, which the restore role may not recreate | Info | No default privileges; explicit grants per migration plus the conformance test (F-2) |

**Escalation and leakage paths checked for `pbe_backup` under v2:**
- **Write or create:** no write grants on any PBE object. No CREATE on `public` (database owner only) or on PBE schemas. No TEMP in PBE databases (revoked from PUBLIC). `default_transaction_read_only = on` as an extra layer, not the main control.
- **Become privileged:** NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION. Not a member of any role; no ADMIN option; cannot be granted to others (no PBE role has CREATEROLE). Owns nothing, so it cannot ALTER or GRANT anything.
- **Functions:** no PBE function is executable by PUBLIC (verified), and none is granted to `pbe_backup`, so the SECURITY DEFINER functions are out of reach. Built-in dangerous functions (`pg_read_file`, `COPY … PROGRAM`, large-object import) need superuser or predefined roles it does not have.
- **Schema, sequence and table access:** USAGE on the five PBE schemas and SELECT on their tables and sequences only, in `pbe_dev` and `pbe_test` only.
- **Other databases:** no grants anywhere else. With the `pg_hba.conf` rule it cannot connect elsewhere at all.
- **Credentials:**
  - random password, sent to the server only as a SCRAM verifier, stored only in the git-ignored `.env` (600), never printed or logged;
  - nothing hard-coded or committed;
  - the administrator password is typed only in the terminal prompt.
- **Inherent exposure:** whoever holds the backup password, or a backup file, can read **all** PBE data, as with any backup:
  - Argon2id password hashes (slow to attack);
  - MFA secrets encrypted with a key that is **not** in the database (R-010);
  - irreversible token hashes;
  - personal data.

  Proposed new risk: **"Backup identity and backup files expose all organisations' data"**, production-blocking until production backup handling (encryption, storage, access) is designed in Stage 29.
- **Application and migration logins:** unchanged. `pbe_app` stays NOBYPASSRLS (checked at API start-up); `pbe_migrator` gets nothing new.
- **Restore role:** unchanged (NOBYPASSRLS; CONNECT only to `pbe_test`; owns only its temporary copies; cannot modify `pbe_dev` or `pbe_test`).
- **Existing RLS:** not weakened. `FORCE` stays on every `app` table. Empty-table backups are excluded: the backup errors rather than copying nothing (§4), and F-4 makes the drill fail loudly instead of comparing 0 with 0.

## 6. Revised design v2 (requirements check)

| Your requirement | v2 |
|---|---|
| Dedicated backup login, minimum permissions to read and back up all required tables | `pbe_backup`; USAGE plus SELECT on PBE schemas, tables and sequences only; BYPASSRLS (needed, §4) |
| RLS bypass only for this identity | Yes; restore role stays NOBYPASSRLS |
| Application and migration logins unchanged | Yes |
| Connects only to `pbe_dev` and `pbe_test` | Database CONNECT on those two **plus** the `pg_hba.conf` rule (F-3) |
| Cannot write, create objects, grant, or become privileged | Yes (§5) |
| Test-only restore role separate; cannot modify the original databases | Yes, unchanged |
| No credentials hard-coded, printed, logged, committed or shared | Yes (bootstrap verifier pattern) |
| RLS not weakened; no incomplete or empty backups | Yes; plus F-4, F-5 and F-6 fixes |

**Exact SQL:**
- **Part 1, administrator, through the bootstrap:**
  ```sql
  CREATE ROLE pbe_backup LOGIN;   -- only if it does not exist
  ALTER ROLE pbe_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
  ALTER ROLE pbe_backup SET default_transaction_read_only = on;
  GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup;
  -- plus the password, set from a random value as a SCRAM verifier (see the .sql file)
  ```
- **Part 2, migration `0005_backup_read_access.sql`:**
  ```sql
  GRANT USAGE ON SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
  GRANT SELECT ON ALL TABLES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
  ```
- **Part 3, administrator, `pg_hba.conf`:** the four lines in the v2 file, above the existing rules, then a reload.

**Tool changes (agent, after approval):**
- bootstrap gains the `pbe_backup` entry (random password to `.env`; `PBE_PG_BACKUP_USER` and `PBE_PG_BACKUP_PASSWORD`);
- backups run as `pbe_backup` without `--role` (F-7);
- atomic write and clean-up (F-5); permissions 700/600 (F-6);
- loud drill comparison with a forced-RLS fixture test (F-4);
- conformance test "every PBE table readable by `pbe_backup`" (F-2).

## 7. Phase B: files changed

| File | Change |
|---|---|
| `tooling/migrate/src/backup.ts` | Atomic backup: writes to `<name>.partial-<random>` (created owner-only, 600), checks the whole archive can be read, then renames to the final name; deletes the temporary file on any failure; refuses to overwrite an existing backup; folder 700, file 600. New `readTableContents`: reads with row security **off**, so a reader that cannot bypass RLS gets an **error**, never a silent zero; on the restored copy (owned by the restore role) it lifts FORCE inside a transaction that is always rolled back. `compareDatabases` and `restoreDrill` use it; `dumpRole` is now explicit (none for `pbe_backup`) |
| `tooling/migrate/src/config.ts` | New login kind `backup` (`PBE_PG_BACKUP_USER`, default `pbe_backup`; `PBE_PG_BACKUP_PASSWORD`) |
| `tooling/migrate/src/cli.ts` | `backup` and `restore-drill` use `pbe_backup` with no role switch when its password is configured; otherwise they print a note and use the old path (which fails on forced-RLS tables, leaving no file) |
| `tooling/migrate/src/conformance.ts` | `BACKUP_SCHEMAS` and `backupReadabilityViolations`: lists every PBE schema, table or sequence the backup login cannot read |
| `db/bootstrap/bootstrap-local.sql` | Creates `pbe_backup` (v2 Part 1): `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 2`, sessions read-only by default, password from a SCRAM verifier, `CONNECT` on `pbe_dev` and `pbe_test` only. **Not run** |
| `tooling/scripts/db-bootstrap.cjs` | Generates the backup login's random password and writes it to `.env` (same pattern as the other logins). **Not run** |
| `db/bootstrap/teardown-local.sql` | Also removes `pbe_backup` (local teardown script; not run) |
| `db/migrations-proposed/0005_backup_read_access.sql` | **New**, not applied (§8) |
| `db/bootstrap/pg_hba-pbe-backup.conf` | **New**, proposed connection rule (§9), not applied |
| `.env.example` | Documents the two new variables (placeholders only, no secrets) |
| `db/tests/backup-tool.db.spec.ts` | **New**, 12 tests on the real `pbe_test`, no permission change |
| `db/tests/backup-v2.throwaway.db.spec.ts` | **New**, 28 tests on a throw-away server |
| `db/tests/throwaway-server.db.spec.ts` | Bootstrap test now also expects `pbe_backup` and its attributes |
| `db/tests/real-migrations.db.spec.ts` | The two existing restore-drill tests state the old path explicitly (until the backup login exists) |
| `docs/stage-reports/STAGE-07A-BACKUP-REVIEW.md` | This report |

## 8. Migration 0005: contents and privilege implications

Exactly three statements (checked by a test):
```sql
GRANT USAGE ON SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, platform, audit, training, pbe_meta TO pbe_backup;
```
- **Grants only reading**, only to `pbe_backup`, only in the database where it runs (`pbe_dev`, `pbe_test`). Nothing for `pbe_app`, `pbe_migrator`, `pbe_owner` or the restore role.
- No write, CREATE, function EXECUTE or default privileges. Not `pg_read_all_data` (that would reach every database).
- Combined with BYPASSRLS, `pbe_backup` reads **every row of every PBE table, across all organisations**. This is necessary for a complete backup and is the main residual risk (§13).
- "ALL TABLES" covers tables existing at the time. Each later migration that adds a table must grant SELECT to `pbe_backup`; the readability check reports any table that was missed (tested in §11).
- It must be applied only **after** the bootstrap has created `pbe_backup`, otherwise it fails (the migration is all-or-nothing, so nothing would change).
- Passes the migration rules (`expand` phase).

## 9. Connection restriction (prepared, not applied)

`db/bootstrap/pg_hba-pbe-backup.conf` holds four lines that go **above** the existing lines of the server's `pg_hba.conf`:
- allow `pbe_backup` to `pbe_dev` and `pbe_test` from this Mac only (password, SCRAM);
- reject `pbe_backup` everywhere else (network and local socket).

**Reload or restart:** a configuration **reload** (`SELECT pg_reload_conf();`, or `pg_ctl reload`) is enough; **no restart** is needed. The bootstrap needs neither. Other logins are not affected by these lines (tested).

## 10. Backup-tool verification (real server, no permission change): 12/12 passed

`db/tests/backup-tool.db.spec.ts`, on the real `pbe_test`, using only the existing logins and temporary `zz_test_*` schemas:

| Check | Result |
|---|---|
| Successful backup: only the final file exists, file 600, folder 700, archive fully readable | Pass |
| **Failed backup** (forced-RLS tables, no bypass role): error, and the folder is **empty** (no final and no partial file) | Pass |
| Existing backup file is never overwritten | Pass |
| Hazard shown: the owner silently sees 0 rows in a forced-RLS table holding 3 rows | Pass (hazard reproduced) |
| Fixed reader sees all 3 rows on an owned copy and leaves the table forced | Pass |
| A reader that cannot bypass RLS gets an **error**, not 0 | Pass |
| 3 rows vs 2 rows: count and checksum differ (missing data detected) | Pass |
| Readability check reports unreadable tables and a missing role | Pass |
| Real server today: no PBE role has BYPASSRLS; `pbe_backup` does not exist | Pass |
| 0005 contains exactly the 3 grants, passes migration rules, is **not** in `db/migrations` | Pass |
| Bootstrap: BYPASSRLS only for `pbe_backup`; restore role NOBYPASSRLS; no `pg_read_all_data` | Pass |
| Proposed pg_hba lines allow only `pbe_dev`, `pbe_test`; reject everything else | Pass |

## 11. v2 end to end on a throw-away server: 28/28 passed

`db/tests/backup-v2.throwaway.db.spec.ts`. Setup: real bootstrap SQL (all five roles), migrations 0001–0005, a fictional organisation with 3 departments, a setting and an audit event written as `pbe_app` with tenant context (forced-RLS tables).

| Area | Checks | Result |
|---|---|---|
| Roles | `pbe_backup` is the only non-superuser with BYPASSRLS; `pbe_app`, `pbe_migrator`, `pbe_owner`, `pbe_restore_drill` do not have it. `pbe_backup`: no memberships, no members, cannot create databases or roles, no replication, max 2 sessions | Pass |
| Readability | No unreadable table, sequence or schema in `pbe_dev` or `pbe_test`; a new table without the grant **is reported**; `pbe_backup` sees all 3 protected rows while the owner sees 0 | Pass |
| Cannot write, create, grant, escalate | With its read-only default switched **off** (to prove the privileges are the real control): INSERT, UPDATE, DELETE, TRUNCATE, CREATE TABLE (PBE schema and `public`), CREATE TEMP TABLE, SET ROLE `pbe_owner`, CREATE ROLE, CREATE DATABASE, ALTER ROLE, running the reviewed sign-in function and the operator function: **all refused** (13 checks). GRANT: PostgreSQL only **warns** ("no privileges were granted") and the check confirms nothing was granted. Its sessions start read-only | Pass |
| Unrelated data | Cannot read an unrelated schema in `pbe_dev`; cannot read a table in `postgres` even while it can still connect there | Pass |
| Unauthorised databases | With the connection rule: `postgres` and `template1` **rejected**; `pbe_dev`, `pbe_test` accepted; `pbe_app` unaffected | Pass (see limitation below) |
| Backup | As `pbe_backup`, no role switch: succeeds, file 600, archive contains all 3 protected rows, no stray files | Pass |
| Old path | `pbe_migrator` as owner: fails loudly and leaves **no** file | Pass |
| Restore drill | Full drill with the restore role **without** any bypass: ok, temporary database removed, 3 = 3 rows with equal checksums | Pass |
| Missing rows | One protected row removed from the restored copy: verification **fails** (3 vs 2, checksum differs) | Pass |
| Restore role | Cannot connect to `pbe_dev`; cannot write `pbe_test` tables | Pass |

**Limitations of this evidence:**
- The throw-away server accepts only local-socket connections without passwords, so the connection rule was tested in its local-socket form (`local … reject`). The network (`host …`) lines and SCRAM passwords are tested only on the real server in §14.
- One test failure during development: the GRANT test first expected an error; PostgreSQL issues a warning instead. The test now checks the effect (nothing granted). Another test first left an unrelated schema behind, which made the later backups fail **correctly** (pg_dump refuses what it cannot read); the test now removes it.

## 12. Full test run and checks (exact results)

| Command | Result |
|---|---|
| `npm test` | **613 passed, 6 failed** (619 tests, 40 suites; 39 suites passed) |
| `npm run lint` | Passed (0 warnings) |
| `npm run format:check` | Passed (after formatting `tooling/migrate/src/backup.ts`) |
| `npm run typecheck` | Passed |
| `npm run check:secrets` | Passed |
| Focused DB run: tenancy-access 34/34, backup-v2 28/28, throwaway-server 14/14, backup-tool 12/12 | **88/88 passed** |

The 6 failures are all in `db/tests/real-migrations.db.spec.ts` and are the **expected, known** ones:
- 2 × "pbe_dev read-only checks": `pbe_dev` is still at 0003, 0004 pending, by instruction;
- 4 × "backup and restore drill" on `pbe_test`: pg_dump cannot copy forced-RLS tables until `pbe_backup` exists. This is B-1 itself.

They should pass after §14 steps 1–6.

Real server after all tests (read-only check): PBE roles `pbe_app`, `pbe_migrator`, `pbe_owner`, `pbe_restore_drill`, none with BYPASSRLS; no `pbe_backup`; databases `pbe_dev`, `pbe_test`, `postgres`; `.env` unchanged (last modified 2026-10-17 18:23, no backup entries).

## 13. Existing partial backup (F-5)

Checked using the file listing and the archive's table of contents and read check only. **Contents were not displayed, copied or restored.**

| Item | Value |
|---|---|
| Path | `backups/pbe_test-2026-10-17T16-03-36-182Z.dump` |
| Size | 121,621 bytes; permissions `-rw-r--r--` (readable by other local users) |
| Status | **Incomplete.** Table of contents lists 48 tables and 23 data entries, but reading the whole archive fails: "could not read from input file: end of file". Created by the failed Stage 7A backup |
| Only usable backup? | **No.** The other 6 backups in `backups/` read completely, including `pbe_dev-2026-10-17T15-48-56-434Z.dump` (52,163 bytes, the latest `pbe_dev` backup). `pbe_test` is rebuilt by the tests anyway |

**Recommended procedure (needs your approval; not done):**
1. Create `backups/quarantine/` with owner-only access (700).
2. Move the file there, renamed `pbe_test-2026-10-17T16-03-36-182Z.dump.INCOMPLETE`, owner-only (600). The new tool never picks it up as a backup.
3. Delete it after Stage 7A is accepted. It holds only fictional test data, but it should not stay readable by other users.
4. At the same time, set the `backups/` folder to 700 and the other backup files to 600 (F-6).

## 14. Exact commands for the next, separately authorised execution phase

> **Superseded by §24** (Phase C added a read-only inspection step, the bootstrap hardening and the access verification command).

**Not run.** Each step depends on the one before; stop if any fails.

1. **You**, in Terminal (types the administrator password into psql's own prompt; never into the chat):
   ```
   npm run db:bootstrap
   ```
   Creates `pbe_backup` and writes its random password to `.env`. Other roles keep their settings.
2. **Administrator step** (connection rule, §9). The agent shows you one copy-paste command and its exact content; it asks for your Mac password. It inserts the four lines of `db/bootstrap/pg_hba-pbe-backup.conf` at the top of the server's `pg_hba.conf`, keeps a dated copy of the original, then runs `SELECT pg_reload_conf();`. Reload only; no restart. If you prefer not to change this file, record F-3 as an accepted local limitation.
3. **Agent:** move `db/migrations-proposed/0005_backup_read_access.sql` to `db/migrations/` and update the schema snapshot.
4. **Agent:** `npm run db -- migrate --db test`, then the full tests (`npm test`). Expected: only the 2 pbe_dev checks still fail.
5. **Agent** (before touching `pbe_dev`): `npm run db -- backup --db dev` and `npm run db -- restore-drill --db dev`, both as `pbe_backup`.
6. **Agent:** `npm run db -- migrate --db dev` (0004 and 0005), then `npm run db -- restore-drill --db dev` again (now with forced-RLS tables), then `npm test` and `npm run verify`. Expected: all pass.
7. **Agent, with your approval:** quarantine the partial file and correct the permissions (§13).
8. **Agent:** connect to `postgres` as `pbe_backup` (must be rejected) and confirm the real server's role attributes, then update this report and STAGE-07A.md for your review.

## 15. Risks

| Risk | Status |
|---|---|
| R-001, R-007, R-009, R-010, R-011 | **Open, production-blocking** (unchanged) |
| R-002 (restore role can create databases) | Unchanged; v2 deliberately gives it **no** bypass |
| R-008 (NestJS 11 `legacy` tag) | Watched (unchanged) |
| **Proposed new risk:** backup identity and backup files expose all organisations' data | To be recorded in the risk register in the execution phase; production-blocking until production backup handling (encryption, storage, access) is designed in Stage 29 |
| B-1 (backups cannot read forced-RLS tables) | **Still open**: fixed in code and proven on a throw-away server, not yet on the real server (§14) |
| Partial backup file | Incomplete, readable by other local users; quarantine awaiting approval (§13) |
| Backup files and folder permissions (644/755) | New backups are 600/700; existing files awaiting correction (§13) |
| Connection rule not tested over the network form | Covered by §14 step 8 |
| Every future migration must grant SELECT to `pbe_backup` | Enforced by the readability check once 0005 is in `db/migrations` |

Stage 7B and Stage 8 have **not** been started. Nothing has been committed or pushed. No database role, permission or server setting was changed.


---

# Phase C — final review corrections (2026-10-18)

## 16. Phase C: files changed

| File | Change |
|---|---|
| `tooling/scripts/lib/scram.cjs` | `parseScramVerifier` (strict PostgreSQL format, ≥4096 iterations, ≥16-byte salt) and `verifierMatchesPassword` (recomputes and compares in constant time) |
| `tooling/scripts/db-bootstrap.cjs` | Each verifier is validated before psql runs. `.env` is written as a new owner-only file and renamed into place. The login check requires SCRAM-SHA-256 for all four logins (it reads `system_user`, i.e. the method the server actually used). pbe_backup is now listed in the summary. `PBE_BOOTSTRAP_ENV_FILE` lets the test use a temporary `.env` |
| `db/bootstrap/bootstrap-local.sql` | Stops before any change if a verifier is missing. Passwords are set in one transaction with statement logging off for that session only, errors shown without statement text, and a check that each verifier was stored as given (else rollback). New step 7 closes large-object creation and WAL messages in `pbe_dev` and `pbe_test`. The pager is off. **Not run on the real server** |
| `db/bootstrap/pg_hba-pbe-backup.conf` | Two more lines: replication connections are rejected explicitly (TCP and socket). **Not applied** |
| `db/bootstrap/inspect-connection-rules.sql`, `tooling/scripts/db-inspect-connections.cjs`, `package.json` | **New** read-only inspection `npm run db:inspect-connections`. **Not run on the real server** |
| `db/bootstrap/README.md` | pbe_backup role; connection rule; the new commands |
| `tooling/migrate/src/conformance.ts` | `backupCoverageViolations` (readability, unlisted PBE schemas, large objects, default privileges); `backupPrivilegeAudit` (catalogue-wide least-privilege audit); lists of dangerous and internally guarded built-ins |
| `tooling/migrate/src/runner.ts` | From version 5 on, on the real ledger, each migration must leave full backup coverage or it is rolled back. Failure details are kept |
| `tooling/migrate/src/backup.ts` | libpq tools require SCRAM-SHA-256 whenever a password is used (`PGREQUIREAUTH`). The restore drill runs a coverage gate before any backup |
| `tooling/migrate/src/access-matrix.ts` | **New**: the real-connection matrix (§18) |
| `tooling/migrate/src/cli.ts` | `backup` and `restore-drill` run the coverage gate with the backup login. **New** `verify-backup-access` command for the execution phase |
| `db/tests/helpers.ts` | Throw-away server can listen on 127.0.0.1/::1 with extra settings; `setHba`; real SCRAM credentials for bootstrap tests |
| `db/tests/backup-credentials.throwaway.db.spec.ts` | **New**, 15 tests (§17, §18) |
| `db/tests/backup-v2.throwaway.db.spec.ts` | Extended to 44 tests (§19–§21) |
| `db/tests/backup-tool.db.spec.ts`, `db/tests/throwaway-server.db.spec.ts`, `tooling/tests/db-bootstrap.test.cjs` | Updated: replication lines; schema-list consistency; real verifiers; 3 new unit tests |

## 17. Item 1: backup credential lifecycle

| Step | How | Evidence (backup-credentials.throwaway.db.spec.ts unless stated) |
|---|---|---|
| Generate | 32 random bytes from the operating system's secure generator, base64url (43 characters). An existing usable password in `.env` is kept on re-runs | 4 distinct 43-character passwords; re-run keeps all 4 (`existing password kept` ×4) |
| Make the verifier | Computed on this Mac (RFC 5802/7677): PBKDF2-SHA-256, 4096 iterations, 16-byte random salt. Only the verifier goes to PostgreSQL | Unit tests: format; RFC derivation written out step by step; never contains the password |
| Validate for PostgreSQL 18 | Before sending: strict PostgreSQL stored format, and recomputed from the password. On the server, inside the password transaction: each stored secret must equal the verifier sent. A malformed one would be hashed again as a plain password, silently breaking the login. On mismatch everything is rolled back | Stored secrets parse with 4096 iterations and match the `.env` passwords. Server: `password_encryption = scram-sha-256`, `scram_iterations = 4096` (also on the real server). A malformed verifier → script fails, **no password changed**. A missing verifier → stops before any change |
| Deliver to the client | The plain password lives only in `.env` (owner-only, git-ignored, replaced atomically). Tools read it from there; pg_dump and pg_restore get it through a temporary owner-only password file that is deleted afterwards. libpq is told to accept **only** SCRAM-SHA-256 | `.env` mode 600, no temporary file left. Login over IPv4 and IPv6: `system_user = scram-sha-256:pbe_backup`. Wrong password refused. When the server asks for a clear-text password, the backup tool refuses **before** sending it, and no file is left |
| Never exposed | Not printed, logged, committed or put in reports. Statement logging is off for the password statements only. psql shows errors without statement text. psql runs with `-X` (no personal settings) and echo off | Throw-away server with `log_statement=all`, `log_connections=on`: neither any password nor any verifier is in the script output or the server log; no `ALTER ROLE … PASSWORD` is logged. Logging **was** active for the rest of the script (the `GRANT CONNECT … TO pbe_backup` line is in the log). Secret scan PASS |

Known limitations:
- **PostgreSQL lets any login change its own password.** Tested: backups then **fail closed** (error, no file), and re-running the bootstrap restores the login.
- The verifiers pass from the bootstrap script to psql as environment variables of that one process. On macOS only the same user or an administrator can read another process's environment.
- The network connection on this Mac is not encrypted (`ssl = off` on the real server). SCRAM protects the password itself; the data travels unencrypted over the loopback interface only.
- The Node.js database client used for row comparisons cannot be told "SCRAM only". The connection rule's `scram-sha-256` method is the control there.

## 18. Item 2: connection configuration and verification matrix

**Real server: what could be reviewed without administrator rights** (read-only queries as `pbe_migrator`, plus file listings):

| Setting | Observed | Meaning |
|---|---|---|
| `listen_addresses` | `*` (TCP on all interfaces, IPv4 and IPv6, port 5432) | Reachable from the local network, not only from this Mac. The proposed lines allow pbe_backup only from 127.0.0.1 and ::1 and reject every other address |
| Unix socket | `/tmp/.s.PGSQL.5432`, permissions `srwxrwxrwx` (`unix_socket_permissions = 0777`); no `/var/run/postgresql` | Any local account can reach the socket; the proposed `local … reject` lines refuse pbe_backup there |
| `ssl` | `off` | See §17 limitations |
| `password_encryption`, `scram_iterations` | `scram-sha-256`, `4096` | Matches the verifiers |
| Existing logins | `pbe_migrator`, `pbe_app`, `pbe_restore_drill` all authenticate with `scram-sha-256` over `::1` | Current rules use SCRAM for these |
| `log_statement`, `log_min_error_statement`, `logging_collector` | `none`, `error`, `on` | The bootstrap's session settings protect the password statements even if this changes |
| `hba_file`, `config_file`, `unix_socket_directories`, `pg_hba.conf` itself | **Not visible** (need administrator rights; files are `postgres`-owned, `Permission denied`) | Rule order and included files **not reviewed: BLOCKED** |

Read-only inspection prepared: `npm run db:inspect-connections` runs [inspect-connection-rules.sql](../../db/bootstrap/inspect-connection-rules.sql) inside `BEGIN READ ONLY`. It shows:
- every rule in the order PostgreSQL applies it, with its file and line, including `include`, `include_if_exists` and `include_dir` files;
- any line that cannot be parsed;
- options that could hold a secret, masked;
- when the configuration was last loaded, compared with the file's time.

It was tested on a throw-away server. The report goes to `backups/connection-rules-<time>.txt` (owner-only, git-ignored).

**Finding (new): replication.** pg_hba.conf's `all` does not match replication connections. Typical installations have `host replication all …` rules, so without explicit lines pbe_backup would match those and be stopped only by its NOREPLICATION attribute. Two `replication … reject` lines were added (§16).

**Verification matrix: throw-away server, the proposed lines verbatim at the top, real SCRAM passwords, real connection attempts** (`npm run db -- verify-backup-access` runs the same matrix on the real server in the execution phase):

| pbe_backup → | TCP IPv4 127.0.0.1 | TCP IPv6 ::1 | Local socket |
|---|---|---|---|
| `pbe_dev` | **allowed** (scram-sha-256) | **allowed** (scram-sha-256) | rejected by pg_hba.conf |
| `pbe_test` | **allowed** (scram-sha-256) | **allowed** (scram-sha-256) | rejected by pg_hba.conf |
| `postgres` | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| `template1` | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| `template0` | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| another existing database (`zz_other`) | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| a database that does not exist | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| physical replication | rejected by pg_hba.conf | rejected by pg_hba.conf | rejected by pg_hba.conf |
| logical replication to `pbe_dev` / `pbe_test` | refused: "permission denied to start WAL sender" (no REPLICATION attribute)¹ | same¹ | rejected by pg_hba.conf |

¹ Logical replication is matched in pg_hba.conf by database name, so it passes the allow line; the role attribute refuses it.

- **30/30 cells as required.** Every refusal message comes from the server, e.g. `pg_hba.conf rejects connection for host "::1", user "pbe_backup", database "postgres"`.
- **Without** the lines, the same login reached `postgres` and `template1` over IPv4 and IPv6 (test "WITHOUT the rule"). This shows the rule is what closes them.
- Other logins are unaffected (`pbe_app`: scram-sha-256).
- The proposed lines go **above every existing line**, including `include` lines, then a **reload**. No restart is needed (the throw-away tests use `pg_reload_conf()` only).

## 19. Item 3: least privilege for pbe_backup

**Catalogue-wide audit** (`backupPrivilegeAudit`, run in `pbe_dev` and `pbe_test` of the throw-away server after the v2 bootstrap and 0005): **0 violations** in both. It checks:
- attributes: no superuser, CREATEROLE, CREATEDB, REPLICATION or INHERIT; BYPASSRLS; LOGIN;
- no other non-superuser role with BYPASSRLS;
- no memberships either way;
- read-only default present, and no other role settings;
- owns nothing (incl. default-privilege entries and databases);
- no CREATE or TEMPORARY on the database; no CREATE on any schema; no USAGE outside the five PBE schemas (and `public`);
- no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any table, view or foreign table, including column-level rights;
- no sequence USAGE or UPDATE; no SELECT outside the PBE schemas; no owner-rights views;
- no EXECUTE on any non-system function (incl. SECURITY DEFINER), nor on any of 30 dangerous built-ins;
- no foreign-server or foreign-data-wrapper usage, tablespace CREATE, parameter SET or ALTER SYSTEM, or large-object UPDATE.

Connectable by database rights alone: `pbe_dev`, `pbe_test`, `postgres`, `template1`. That is PostgreSQL's default for the last two, which is why the pg_hba.conf lines are needed (§18).

The audit is not vacuous: 8 planted violations were each reported, and the audit was clean again afterwards.

**Direct attempts as pbe_backup, with its read-only default switched OFF** (so the privileges themselves are tested): all **refused**.
- Write data: INSERT, UPDATE, DELETE, TRUNCATE, UPDATE with RLS bypassed, deleting migration-ledger rows, row locks (FOR SHARE / KEY SHARE), table locks above read level.
- Change structure: ALTER, DROP, ADD COLUMN, OWNER TO, COMMENT, CREATE STATISTICS, REINDEX.
- Disable protections: DISABLE / NO FORCE ROW LEVEL SECURITY; DROP, ALTER or CREATE POLICY.
- Create objects: tables (PBE schema, `public`, temporary), functions, schemas, publications, roles, databases.
- Grant: GRANT passes nothing on (PostgreSQL only warns; the test checks nothing was granted).
- Escalate: SET ROLE pbe_owner, GRANT pbe_owner, ALTER ROLE CREATEDB or CONNECTION LIMIT, COMMENT ON ROLE, `session_replication_role`, ALTER SYSTEM, ALTER DATABASE.
- Server files and programs: COPY to a file or program, `pg_read_file`, `pg_ls_dir`, `lo_import`.
- Server state: `pg_switch_wal`, `pg_reload_conf`, `pg_stat_reset`.
- PBE functions: the reviewed sign-in and operator functions.

**Findings in this phase:**

| # | Finding | Status |
|---|---|---|
| F-9 | PostgreSQL lets **every** login create large objects (stored data), and write logical-decoding messages into the WAL (allowed even in a read-only transaction). For pbe_backup the first was blocked only by its read-only default, which a session can switch off. Probe on a scratch server: both worked | **Closed by the bootstrap** (REVOKE on 5 built-ins in `pbe_dev` and `pbe_test`). Tested: refused afterwards. A dump and a restore by the non-administrator restore role still work (PostgreSQL only warns about the REVOKE it cannot repeat). PBE uses neither function. This also closes them for `pbe_app` |
| F-10 | 12 built-ins PostgreSQL lets PUBLIC run check permission inside them: large-object writes need rights on that object; replication-slot functions need REPLICATION; collation import needs CREATE on the schema | **Proven refused** against a real large object owned by the administrator, which stayed unchanged |
| F-11 | PostgreSQL lets any role change **its own** settings (incl. removing its read-only default), its own password, and its own default privileges. None is an escalation, and they cannot be prevented in PostgreSQL 18 | **Detected.** The audit reports the settings and default privileges; the coverage gate refuses the backup and the drill; a changed password makes backups fail closed (§17) |
| F-12 | Replication connections are not covered by `all` in pg_hba.conf | **Fixed** in the proposed lines (§18) |

Remaining by design, possible for every login and changing no stored data:
- advisory locks, which could delay a migration (the runner then times out safely);
- NOTIFY;
- holding a read lock during a dump, which delays schema changes for its duration;
- at most 2 sessions.

## 20. Item 4: migration 0005 and future-schema conformance

- **Required objects readable:** after 0005, no unreadable PBE table, sequence or schema in `pbe_dev` or `pbe_test`. pbe_backup reads every row of forced-RLS tables (3 of 3), while the owner sees 0.
- **Omitted objects make backups fail:**
  - an unreadable table → the coverage check names it; pg_dump **fails and leaves no file**; the row comparison fails with "permission denied"; the drill refuses before backing anything up;
  - a PBE-owned schema outside the backup list (even if readable) → reported, drill refused;
  - an unexpected large object → reported;
  - default privileges → reported, drill refused.
- **New migrations cannot silently omit the grant:**
  - From version 5 on, on the real ledger, the runner checks coverage **inside each migration's transaction**. Tested: a fixture `0006` adding a table **without** the grant was **rolled back**, with the table absent and the ledger still at 5. With `GRANT SELECT … TO pbe_backup` it applied and coverage was clean.
  - Mutation check: 0005 without its table grant was itself rolled back by the runner.
  - Until 0005 is moved into `db/migrations`, no real migration reaches version 5, so nothing changes for the real databases yet.
- **Incomplete artifacts are never promoted:** a stand-in pg_dump simulated 4 failure modes: a truncated file reported as success, an empty file reported as success, a complete file with an error exit, and a killed process. Each time:
  - the call failed;
  - nothing appeared under the final name;
  - no partial file was left;
  - an earlier backup in the same folder was byte-identical afterwards.

  A control run with the same stand-in and no failure produced a normal, complete backup.

## 21. Item 5: complete backup and restore on an isolated server

Throw-away server, real bootstrap, migrations 0001–0005. Fictional data in forced-RLS tables, written as `pbe_app` with organisation context:
- 2 organisations;
- 3 departments;
- 2 roles, with 2 role-permission rows on a composite foreign-key chain;
- 2 settings rows;
- 1 audit event.

| Check | Result |
|---|---|
| Full drill as pbe_backup (no role switch), restore by the restore role **without any bypass**, coverage gate on | ok; temporary database dropped; `platform.tenant` 2=2, `app.role` 2=2, `app.role_permission` 2=2, `app.tenant_setting` 2=2, `app.department` 3=3, `audit.audit_event` 1=1, contents identical |
| Restored copy vs source, read by different roles | Identical: organisations, departments per organisation, role→permission joins incl. permission scope, counts, audit actions, 0 orphan rows; all foreign keys present and **validated**; RLS **enabled and forced** on all 7 `app` tables; policies identical |
| Missing protected row in the copy | Verification **fails** (3 vs 2 rows, checksum differs) |
| Unreadable table | Backup **fails**, no file; comparison fails; drill refuses (§20) |
| Restore role on the originals | Cannot connect to `pbe_dev`; cannot write `pbe_test` |
| Backup file | Owner-only (600), folder 700 |

## 22. Test results, mutation checks and limitations (exact)

| Command | Result |
|---|---|
| `npm test` | **646 passed, 7 failed** (653 tests; 41 suites, 39 passed) |
| Focused run: `backup-v2` 44/44, `backup-credentials` 15/15, `throwaway-server` 14/14, `tenancy-access` 34/34, `backup-tool` 11/12 | See failures below |
| `npx jest --selectProjects tooling` | 98/98 (incl. 3 new verifier tests) |
| `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run check:secrets` | All passed (format after formatting 2 new files) |

The 7 failures:
- **1 new, real:** `backup-tool` "no PBE role has BYPASSRLS; pbe_backup does not exist yet". It detected the unexpected real-server role (§23). I left the test unchanged on purpose.
- **6 known** (same as Phase B, `real-migrations`):
  - 2 × pbe_dev checks, because pbe_dev is still at 0003, by instruction;
  - 4 × restore drill on pbe_test, which still uses the old path because `.env` has no backup password. This is B-1 itself.

**Mutation checks.** Each control was deliberately broken, the tests run, and the file restored byte-for-byte (verified). **11 of 11 detected:**

| Broken on purpose | Detected by |
|---|---|
| M1 no log suppression for password statements | "neither a password nor a verifier appears … server log" |
| M2 no stored-as-given check | malformed-verifier test (and 12 more) |
| M3 no SCRAM-only requirement | "clear-text password … refuses BEFORE sending it" |
| M4 no socket reject line | matrix test |
| M5 0005 without its table grant | runner rolled 0005 back (all v2 tests stop in setup) |
| M6 runner skips the coverage rule | "migration … WITHOUT the grant is rolled back" |
| M7 file promoted without the archive check | truncated and empty simulations |
| M8 audit list misses `lo_create` | planted-violation test |
| M9 bootstrap without the large-object/WAL revoke | direct-attempts test, audit, coverage (8 tests) |
| M10 `.env` written readable by others | `.env` mode test |
| M11 drill skips its coverage gate | 3 coverage tests |

The first attempts at M3, M5 and M9 broke the file rather than the control. They were redone precisely; the results above are from the precise runs.

**Limitations:**
- Everything in §17–§21 ran on throw-away servers, not on the real server. The command `verify-backup-access` is built from the tested parts but was not run end to end (it needs the backup login's password).
- The throw-away servers had only the connection rules the tests wrote; the real server's rules are not reviewed (§18).
- Probes on scratch servers used separate temporary folders and ports, and were removed afterwards. One probe hung on psql's pager and was stopped; its server was shut down.
- The agent's own work and tests, **not independently verified** (R-006).

## 23. Unexpected change on the real server (evidence)

All checks were read-only (`BEGIN READ ONLY`, as `pbe_migrator`).

| Fact | Evidence |
|---|---|
| Role `pbe_backup` exists: LOGIN, **BYPASSRLS**, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, connection limit 2, `default_transaction_read_only=on` | `pg_roles`, `pg_db_role_setting` |
| CONNECT on `pbe_dev` and `pbe_test` | `pg_database.datacl`: `pbe_backup=c/pbe_owner` on both |
| Created after 10:12 IST on 2026-10-18 | My read-only check at about 10:15 IST showed no such role, and `backup-tool` passed then. The role's internal ID (71157) is higher than every table rebuilt in pbe_test at 10:12:33 (max 69932). It was first seen by the test run at about 10:55 IST |
| No PBE data readable by it | 0 of 9 tables in pbe_dev; no schema usage; migration 0005 not applied (pbe_dev ledger 1–3, pbe_test 1–4) |
| Bootstrap step 7 (large-object/WAL revoke) **not** applied | `lo_create` still has PostgreSQL's default rights in pbe_dev and pbe_test |
| Its password is unknown to PBE | `.env` unchanged (last modified 2026-10-17 18:23, no backup entries). Whether a password is set at all cannot be seen without administrator rights |
| Existing logins unaffected | migrator, app and restore all log in with scram-sha-256 |
| Backup files untouched | Same 8 files, sizes and permissions as before |

**Not caused by the agent, as far as I can determine:**
- Creating a BYPASSRLS role needs administrator rights. The agent has no administrator password.
- A search of this session's command log for `npm run db:bootstrap`, `-U postgres`, `PBE_PG_ADMIN` and `db-bootstrap.cjs` found only file edits and reads, no execution.
- The throw-away servers use private folders and ports 55000–59000 (real server: 5432). Each run's output shows its own address.

The shell history of this user account shows `npm run db:bootstrap` (twice) and `psql -U postgres -f bootstrap-local.sql`. Those files were last written on 2026-10-17 at 19:18, before the change; an open terminal usually writes its history only when it closes.

The observed state matches exactly the "Part 1" SQL listed in §6 of this report. It does **not** match a completed run of either bootstrap version: that would have updated `.env` and, for the current version, applied step 7. A test showed psql reuses the typed administrator password at step 7, so the current bootstrap would not have stopped there. **This needs your confirmation; I have not changed anything.**

Effect on the plan: none on the design. The execution phase starts with `npm run db:bootstrap`, which keeps this role, re-asserts its attributes, gives it a new random password (stored in `.env`) and applies step 7.

## 24. Exact commands for the next, separately authorised execution phase (supersedes §14)

**Not run.** Stop at the first failure.

0. **You:** confirm whether you created `pbe_backup` on the real server (§23).
1. **You** (read-only; psql asks for the administrator password itself):
   ```
   npm run db:inspect-connections
   ```
   **Agent:** reviews the report (rule order, included files, existing replication rules, `listen_addresses = *`) and confirms where the lines go.
2. **You:**
   ```
   npm run db:bootstrap
   ```
   Expected: four `authentication scram-sha-256` login checks and "Bootstrap complete". The administrator password is typed only into psql's prompt.
3. **Administrator step:**
   - put the 6 lines of `db/bootstrap/pg_hba-pbe-backup.conf` above every existing line of the file named in step 1's report, keeping a dated copy of the original;
   - then `SELECT pg_reload_conf();` (reload, no restart).

   The agent will show you the exact command and content first.
4. **Agent:** move `db/migrations-proposed/0005_backup_read_access.sql` into `db/migrations/`, then `npm run db -- migrate --db test` and `npm test`. Expected: only the 2 pbe_dev checks fail, plus the `backup-tool` state test, which is then updated to the new expected state.
5. **Agent:** `npm run db -- verify-backup-access`. Expected: `BACKUP ACCESS VERIFIED` (30 matrix cells on the real server, audit and coverage clean in both databases).
6. **Agent** (before touching pbe_dev): `npm run db -- backup --db dev` and `npm run db -- restore-drill --db dev`.
7. **Agent:** `npm run db -- migrate --db dev` (0004 and 0005), then `npm run db -- restore-drill --db dev`, `npm run db -- verify-backup-access`, `npm test`, `npm run verify`.
8. **With your approval:** quarantine the partial file and correct the backup permissions (§13).

## 25. Risks (Phase C)

| Risk | Status |
|---|---|
| R-001, R-007, R-009, R-010, R-011 | **Open, production-blocking** (unchanged) |
| R-002 (restore role can create databases) | Unchanged; the restore role still has no bypass |
| R-008 (NestJS 11 `legacy` tag) | Watched (unchanged) |
| Proposed: backup identity and backup files expose all organisations' data | Still to be recorded in the execution phase; production-blocking until Stage 29 |
| B-1 | **Still open** |
| **Unexplained real-server change (pbe_backup present)** | **New, blocks the execution phase** until you confirm (§23). Current exposure: none to PBE data; it can connect to `postgres` and `template1` because pg_hba.conf has no rule yet; password unknown |
| Real server connection rules not reviewed | Blocks; read-only inspection prepared (§18) |
| Server listens on all network interfaces (`listen_addresses = *`), SSL off | Observation, pre-existing; affects all logins, not only pbe_backup; for review with step 1's report |
| PostgreSQL lets a login change its own settings, password or default privileges | Cannot be prevented; detected (§19 F-11) |
| Advisory locks, NOTIFY, read locks during a dump | Available to every login, change no data; accepted |
| Partial backup file, backup permissions | Unchanged, awaiting approval (§13) |

Stage 7B and Stage 8 have **not** been started. Nothing has been committed or pushed. No real database role, permission or server setting was changed by the agent.

> **Correction (2026-10-18, incident review):** §23 argued that the current bootstrap "would not have stopped" at step 7 because psql reuses the password. The file in use at 10:39 was the **Phase B version**, which had no step 7 and no `\connect`. A run of that version that stopped after psql and before writing `.env` fits the evidence best. See [INCIDENT-2026-10-18.md](INCIDENT-2026-10-18.md) §2.
