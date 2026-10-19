# Stage 02 — PostgreSQL foundation and migration runner: completion report

> **Status (2026-10-17): Stage 2 APPROVED — PASS by the product owner (see §15).** The results were produced and reported by the coding agent and have **not been independently verified**. §14 has the final results, §13 the Stage 2.1 design and history.
> §1–§12 below are the original Stage 2 report, kept unchanged as history. The single-database decision they describe (ADR-019) was **superseded by ADR-020** in Stage 2.1.

Date: 2026-10-17   Authorised by owner on: 2026-10-17   Agent/model: Claude Code (Claude Opus 5.5)

> **Who verified what.** Every result in this report was produced by the coding agent unless marked otherwise. The only step performed by the owner was running `npm run db:bootstrap` (it needs the PostgreSQL administrator password); the agent did not see its terminal output and verified its effect afterwards through catalogue queries (§5). **No independent verification has been performed.**

## 1. Stage objective and authorised scope

**Objective (roadmap Stage 2):** connect to local PostgreSQL 18, create PBE's roles and database, build the SQL migration runner, apply a first migration that creates the schema skeleton only, and provide verified backups.

**Authorised by:** the owner's Stage 2 authorisation (2026-10-17), which approved OD-05 and OD-06. During the stage the owner changed one design point: **one database only, `pbe_dev`, for every stage** (ADR-019, §2). Everything below reflects that decision.

**Delivered:**
- An in-house TypeScript migration runner (`tooling/migrate/`) with `status`, `migrate`, `drift`, `snapshot`, `backup`, `verify-backup` and `clean-test-schemas` commands.
- Local bootstrap SQL and script for the three roles and the `pbe_dev` database, run by the owner.
- First migration `0001_schema_skeleton.sql`, applied to `pbe_dev`.
- 43 database integration tests on real PostgreSQL 18, plus 79 new unit tests.

**Not done (exclusions respected):** no Python, Prisma, ORM schema generation, SQLite or in-memory database; no business tables, science, ML, AI or authentication; no production changes; no Docker; nothing committed or pushed.

## 2. Decisions used and their approval status

| Decision | Status | Source |
|---|---|---|
| OD-05 → **ADR-017** PostgreSQL 18 | Approved (2026-10-16, re-confirmed 2026-10-17) | Owner |
| OD-06 → **ADR-018** In-house TypeScript migration runner | Approved 2026-10-17 | Owner: "OD-06, Option A … Approved." |
| **ADR-019** One project database, `pbe_dev`, for every stage | Decided by owner 2026-10-17 | Owner: "i need pbe_dev main only one tabel use so proper migration run for all stage code". The agent had recommended keeping three databases; the owner chose one. |
| Stage 1 verdict PASS | Recorded in STAGE-01.md (not independently verified) | Owner |

ADR-019 has **four accepted gaps**, recorded in ARCHITECTURE_DECISIONS.md and to be revisited no later than Stage 28:
1. Tests run inside the project database. Mitigation: tests write only in `zz_test_*` schemas (name-checked in code); only synthetic data until OD-12(a).
2. "Migrations build a correct database from empty" was proven once, by the first real apply to `pbe_dev`. It is not re-proven on every test run.
3. **Restoring a backup into a database is not tested.** Backups are proven complete and readable only (§7.3).
4. Drift is measured against a committed snapshot, not a fresh rebuild.

Other documents updated to match ADR-019: TESTING_AND_ACCEPTANCE_GATES.md §2, DATA_AND_DATABASE_DESIGN.md §8, DEPLOYMENT_AND_MIGRATION.md §2, and an amendment note on roadmap Stage 2.

Still open and needed next: **OD-07** (data-access layer) before Stage 3.

## 3. Files created or modified

**Migration runner** (`tooling/migrate/`, TypeScript, built to `tooling/migrate/dist/`, git-ignored):

| File | Purpose |
|---|---|
| `src/runner.ts` | Core runner: session safety checks, advisory lock, ledger, per-file transactions, no-transaction mode with invalid-index guard, `status` and `migrate` |
| `src/migration-files.ts` | Loads and validates files: naming, numbering, phase header, forbidden and destructive statements, SHA-256 |
| `src/sql-lexer.ts` | Masks comments, strings and dollar-quoted bodies for the lexical safety checks |
| `src/fingerprint.ts` | Catalogue fingerprint used by the drift check |
| `src/backup.ts` | `pg_dump` backup and archive verification |
| `src/config.ts` | Settings from `.env`; single database; test-schema name pattern |
| `src/errors.ts` | Error type with stable codes |
| `src/cli.ts` | Command-line interface (`npm run db -- <command>`) |
| `tsconfig.json`, `tsconfig.build.json`, `jest.config.cjs` | Build and unit-test configuration |
| `test/sql-lexer.spec.ts`, `test/migration-files.spec.ts`, `test/runner-logic.spec.ts` | Unit tests (no database) |

**Database** (`db/`):

| File | Purpose |
|---|---|
| `migrations/0001_schema_skeleton.sql` | First migration: schemas `app`, `platform`, `training`, `audit`; access rules |
| `migrations/README.md` | Rules for writing migrations |
| `schema-snapshot.txt` | Committed expected-schema fingerprint (31 entries), generated by `migrate` |
| `bootstrap/bootstrap-local.sql` | Admin SQL: roles and `pbe_dev` (run by the owner) |
| `bootstrap/teardown-local.sql` | Rollback: drops PBE databases and roles. **Never run.** |
| `bootstrap/README.md` | How to bootstrap |
| `manual/apply-0001-manually.sql` | Owner-requested manual `psql` route for 0001. **Not executed by anyone; untested.** |
| `tests/helpers.ts` | Test helpers; refuse any schema not named `zz_test_*` |
| `tests/runner.db.spec.ts`, `tests/no-transaction.db.spec.ts`, `tests/concurrency.db.spec.ts`, `tests/real-migrations.db.spec.ts` | Database integration tests |
| `tests/tsconfig.json`, `tests/jest.config.cjs` | Configuration |

**Tooling and root:**
- Created: `tooling/scripts/db-bootstrap.cjs` (bootstrap launcher), `tooling/scripts/lib/scram.cjs` (SCRAM-SHA-256 password hashes), `tooling/tests/db-bootstrap.test.cjs`, `.env.example`, `.gitattributes` (keeps migration bytes identical on every machine).
- Modified:
  - `package.json`: `pg` dependency and `db*` scripts; `build`/`typecheck` include the runner and tests.
  - `jest.config.cjs`: two new projects.
  - `tooling/scripts/verify.cjs`: two new steps.
  - `tooling/scripts/check-secrets.cjs` and its test: new SQL-password rule and psql-variable exemption.

**Docs:**
- `ARCHITECTURE_DECISIONS.md` (ADR-017 note, ADR-018, ADR-019), `OPEN_DECISIONS_REGISTER.md` (OD-05, OD-06 approved).
- `TESTING_AND_ACCEPTANCE_GATES.md`, `DATA_AND_DATABASE_DESIGN.md`, `DEPLOYMENT_AND_MIGRATION.md`, `IMPLEMENTATION_ROADMAP.md` (ADR-019 amendments).
- `STAGE-01.md` (owner verdict appended; evidence unchanged).

**Not in git (ignored):** `.env` (permissions 600, holds the two generated passwords), `backups/`, `tooling/migrate/dist/`.

## 4. Dependencies added

| Package | Version | Licence | Kind | Purpose |
|---|---|---|---|---|
| `pg` | 8.23.1 | MIT | runtime (root `dependencies`) | PostgreSQL driver for the runner (ADR-018) |
| `@types/pg` | 8.23.1 | MIT | dev | Type definitions |

Transitive packages pulled in by `pg`:
- `pg-pool` 3.14.0, `pg-protocol` 1.16.1, `pg-types` 2.2.0, `pg-connection-string` 2.14.1, `pgpass` 1.0.5, `postgres-array` 2.0.0, `postgres-bytea` 1.0.1, `postgres-date` 1.0.7, `postgres-interval` 1.2.0 — all MIT.
- `split2` 4.2.0 — ISC.
- `pg-cloudflare` 1.4.1 (optional) — MIT.

None has an install script (`npm install-scripts ls`: none unreviewed), and the dependency guard passes. Audit is unchanged from Stage 1: 20 moderate (the same dev-only `sprintf-js` chain), 0 high, 0 critical.

## 5. PostgreSQL environment

| Item | Observed |
|---|---|
| Server | PostgreSQL **18.6**, EDB installer, `/Library/PostgreSQL/18`, `localhost:5432` |
| Client tools | `psql`, `pg_dump`, `pg_restore`, `pg_config` 18.6 (not on PATH; PBE uses `PBE_PG_BIN`) |
| Disk encryption | FileVault **On** (checked by the agent with `fdesetup status`, read-only) |
| PBE databases | **`pbe_dev` only**, owner `pbe_owner`, ACL `{pbe_owner=CTc/pbe_owner, pbe_migrator=c/pbe_owner, pbe_app=c/pbe_owner}`: no PUBLIC access |
| Schemas in `pbe_dev` | `app`, `audit`, `pbe_meta`, `platform`, `training` (owner `pbe_owner`), plus `public` (no PUBLIC access) |
| Tables in `pbe_dev` | One: `pbe_meta.schema_migration`, the single migration history table for all stages |

Role attributes (catalogue query output, `pg_roles`):

```
rolname       super inherit createrole createdb canlogin replication bypassrls connlimit
pbe_app       false false   false      false    true     false       false     50
pbe_migrator  false true    false      false    true     false       false     10
pbe_owner     false false   false      false    false    false       false     -1
```

Schema access (`pg_namespace.nspacl`):

```
app       {pbe_owner=UC/pbe_owner,pbe_app=U/pbe_owner}
audit     {pbe_owner=UC/pbe_owner,pbe_app=U/pbe_owner}
pbe_meta  {pbe_owner=UC/pbe_owner,pbe_app=U/pbe_owner}
platform  {pbe_owner=UC/pbe_owner,pbe_app=U/pbe_owner}
training  {pbe_owner=UC/pbe_owner}                      (no access for pbe_app)
public    {pg_database_owner=UC/pg_database_owner}       (no PUBLIC access)
```

Migration history in `pbe_dev`:

```
version 1 | schema_skeleton | 2ef0d49407b2e0cc895f82900b54d5a3077be6900c8069808a722e5fbe7c7b27
        | expand | transactional | applied_by pbe_migrator | runner 1.0.0 | 2026-10-17T08:30:23Z
```

The checksum equals `shasum -a 256 db/migrations/0001_schema_skeleton.sql`.

**Database history during this stage:**
1. The owner's bootstrap first created `pbe_dev`, `pbe_test` and `pbe_restore_check`.
2. After ADR-019, the agent confirmed `pbe_test` and `pbe_restore_check` were empty (only `public`, 0 relations) and dropped them as `pbe_owner`: `DROP DATABASE pbe_test; DROP DATABASE pbe_restore_check;`.
3. The bootstrap SQL now creates `pbe_dev` only.

## 6. Commands actually executed

All on 2026-10-17, macOS arm64, Node 24.21.0, npm 11.19.0, from the project folder.

| # | Command | Result |
|---|---|---|
| 1 | `npm install --save-exact pg` / `--save-dev @types/pg` | Installed 8.23.1; tree valid |
| 2 | `npm run db:bootstrap` | **Run by the owner.** Effect verified by the agent (§5) |
| 3 | Agent script (as `pbe_owner`): check `pbe_test` and `pbe_restore_check` are empty, then `DROP DATABASE` both | Both empty; both dropped; only `pbe_dev` remains |
| 4 | `npm run db -- status` | `0001 pending … OK — 1 pending.` exit 0 |
| 5 | `npm run db -- migrate` | `applied 0001_schema_skeleton.sql (1 ms)`; snapshot refreshed (31 entries); exit 0 |
| 6 | `npm run db -- status` | `0001 applied … OK — 0 pending.` exit 0 |
| 7 | `npm run db -- migrate` (second time) | `Done: 0 applied, 1 already applied.` exit 0 |
| 8 | `npm run db -- drift` | `No drift: pbe_dev matches db/schema-snapshot.txt (31 entries).` exit 0 |
| 9 | `npx jest --selectProjects "database (PostgreSQL 18)"` (first run) | **42/42 FAILED** before any query: configuration bug (§10.1). Fixed. |
| 10 | Same, after the fix | **42/42 passed** (4 suites) |
| 11 | Leftover check in `pbe_dev` | 0 `zz_test_*` schemas, 0 invalid indexes, no drift |
| 12 | Mutation checks (§7.4) | All three mutations detected. One mutation run **created a table in `pbe_dev.public`**; removed; tests hardened (§10.2) |
| 13 | `npm run verify` (final) | **12/12 PASS**, 205/205 tests, exit 0 (§7.5) |
| 14 | `npm run db -- backup` | Backup written and verified (§7.3), exit 0 |

## 7. Test results

### 7.1 Totals (final run, Jest JSON report)

**205 tests: 205 passed, 0 failed, 0 skipped.** 16 suites.

| Suite | Tests | Needs DB |
|---|---|---|
| `db/tests/runner.db.spec.ts` | 20 | yes |
| `db/tests/real-migrations.db.spec.ts` | 19 | yes |
| `db/tests/no-transaction.db.spec.ts` | 3 | yes |
| `db/tests/concurrency.db.spec.ts` | 1 | yes (two OS processes) |
| `tooling/migrate/test/migration-files.spec.ts` | 54 | no |
| `tooling/migrate/test/runner-logic.spec.ts` | 12 | no |
| `tooling/migrate/test/sql-lexer.spec.ts` | 7 | no |
| `tooling/tests/db-bootstrap.test.cjs` | 6 | no |
| `tooling/tests/check-secrets.test.cjs` | 13 (+3 this stage) | no |
| Stage 1 suites (unchanged) | 70 | no |

### 7.2 Required behaviours (Stage 2 prompt §4) and the tests that prove them

All on real PostgreSQL 18 unless marked "unit".

| Required behaviour | Test(s) | Result |
|---|---|---|
| First-time execution | `status on a fresh database lists everything as pending and creates nothing`; `applies all files in order, records checksums, and objects are owned by pbe_owner`; real `0001` applied to `pbe_dev` (command 5) | Pass |
| Repeated execution without duplicates | `a second run applies nothing and leaves the ledger untouched; a new file applies alone`; real: `a further run applies nothing` | Pass |
| Checksum mismatch detection | `detects a modified applied file, applies nothing, and recovers when the original is restored`; also renamed, deleted-last and deleted-middle file tests | Pass |
| Concurrency protection | `two simultaneous runs apply each migration exactly once` (2 sessions); `two separate processes started together apply each migration exactly once` (2 OS processes, overlap asserted); `gives up with LOCK_TIMEOUT while another session holds the lock` | Pass |
| Failure during migration | `rolls back the failing file completely, keeps earlier files, skips later ones, releases the lock` (error names the file, `SQLSTATE 42P01 at line 4`) | Pass |
| Recovery after failure | Same test: corrected unapplied file → applies 2 and 3; `survives the runner connection being killed mid-migration (simulated crash)`: backend terminated (`57P01`), nothing partial kept, lock released, re-run succeeds | Pass |
| Migration history consistency | Ledger versions, names and checksums asserted after every scenario; `status` reports `ok` after recovery; real ledger equals the files | Pass |
| Transaction behaviour and rollback | Rollback test above; **new:** `commits a migration and its ledger row together: if the ledger insert fails, the migration is rolled back`; `CREATE INDEX CONCURRENTLY` without the directive fails (`25001`) and is rolled back | Pass |
| Documented undo and recovery procedures | Restore an edited applied file from git (checksum test); fix an unapplied failed file and re-run (failure test); invalid index after a failed no-transaction migration → drop, fix data, re-run (`a failed concurrent index leaves an INVALID index; the runner refuses to record a re-run until it is repaired`) | Pass |
| Unsafe operations rejected | Before the DB is touched: numbering gap, duplicate version, role statement, transaction control, destructive statement outside contract phase (DB tests) plus 40+ unit cases. On the DB: contract migration refused without `--allow-contract` (nothing applied, even earlier pending files); unqualified names fail (`search_path = pg_catalog`); runtime role `pbe_app` cannot run the runner (`42501`). **Superuser refusal: unit level only** (no superuser credentials are available to the tests). | Pass |
| Runtime role cannot run DDL (roadmap) | `pbe_app cannot …` × 8 (create schema / table in app, public, training / temp table / write ledger / drop schema / SET ROLE pbe_owner), all `42501`; can only read the ledger | Pass |
| Drift check (roadmap) | `two schemas built from the same migrations are identical; a manual change is detected`; `pbe_dev matches the committed schema snapshot`; `verify` drift step | Pass |

### 7.3 Backup evidence

`npm run db -- backup`, exit 0:

```
Backup written: backups/pbe_dev-2026-10-17T08-38-00-170Z.dump (6077 bytes, sha256 cdc3672e1fdbe727a1275e9d5846104b7e3ea7c880f169eeea48f89504919ce8)
Archive decoded with pg_restore: 19 table-of-contents entries.
  schemas: match (app, audit, pbe_meta, platform, training)
  ledger rows: live 1, archive 1 — match
  rows pbe_meta.schema_migration: live 1, archive 1
BACKUP VERIFIED (archive complete and readable; a restore into a database is not tested — ADR-019)
```

Supporting tests:
- `the archive decodes completely and matches pbe_dev` (with a 500-row probe table: live 500, archive 500).
- `the check is not vacuous` (one row added after the backup → reported as 501 vs 500).
- `a damaged archive is rejected` (truncated file → `pg_restore` failure).

**Not done: restoring the archive into a database.** ADR-019 gap 3.

### 7.4 Mutation checks (are the database tests meaningful?)

Each check used a full copy of the project in a temporary folder. One runner protection was broken, and only the scratch-schema tests were run.

| Mutation | Tests that failed (as they should) |
|---|---|
| M1: checksum comparison disabled | `detects a modified applied file …` (1 of 19) |
| M2: advisory lock replaced by "always locked" | `two simultaneous runs …`, `gives up with LOCK_TIMEOUT …`, `two separate processes …` (3 of 43) |
| M3: per-file `BEGIN` removed | `runs migrations with search_path = pg_catalog …`, `commits a migration and its ledger row together …` (2 of 20) |

The first M2 attempt left unreachable code that TypeScript refused to compile, so no tests ran ("0/0"). It was redone with a valid mutation. The first M3 attempt exposed a test gap and an incident (§10.2).

### 7.5 Final `npm run verify` (exit 0)

```
PASS  Toolchain (Node/npm versions)  (0.0s)
PASS  Lockfile matches installed tree  (0.2s)
PASS  Dependency guard (Python/Prisma/SQLite/…)  (0.0s)
PASS  Secret scan  (0.0s)
PASS  Formatting (Prettier)  (0.3s)
PASS  Lint + module boundaries (ESLint)  (0.5s)
PASS  Type-check (all workspaces)  (0.7s)
PASS  Build (all workspaces)  (0.5s)
PASS  Migration integrity (pbe_dev ledger vs files)  (0.1s)
PASS  Tests (Jest, all projects)  (3.7s)
PASS  Schema drift (pbe_dev vs db/schema-snapshot.txt)  (0.1s)
PASS  Dependency audit (high/critical)  (0.6s)
12/12 checks passed.
```

## 8. Test totals

| | Count |
|---|---|
| Total tests | 205 |
| Passed | 205 |
| Failed (final run) | 0 |
| Skipped | 0 |
| Failures found and fixed during the stage | 1 configuration bug (42 DB tests failed at set-up), 1 secret-scanner false positive, 2 lint errors (§10) |

## 9. Known limitations and unresolved decisions

- **ADR-019 gaps 1–4** (§2), above all: no restore into a database has been tested.
- **Superuser refusal** is tested at unit level only.
- **Safety checks are lexical, not a SQL parser.** Statements inside dollar-quoted bodies (`DO $$…$$`, function bodies) are not inspected. Reviewers must read those. The checks can produce false positives (fail-safe).
- **`db/manual/apply-0001-manually.sql`** was never executed. 0001 was applied by the runner.
- **The invalid-index guard** looks at all user schemas in `pbe_dev`. A leftover invalid index anywhere blocks the recording of no-transaction migrations, by design.
- **`npm run verify` needs local PostgreSQL** and `.env` from Stage 2 onward. Without them, the database steps fail.
- **The roadmap said "0001 creates `pbe_meta`".** In practice the runner creates `pbe_meta` and its ledger table (they must exist before 0001 can be recorded), and 0001 creates the other schemas.
- **One unexplained timing:** in one `verify` run the lint step took 207 s. Re-run alone and in the final `verify` it took 0.5 s over the same 48 files. The cause was not identified; possibly the machine was paused.
- **Unresolved:** OD-07 (needed for Stage 3); formal acceptance of the 20 moderate audit findings; GitHub repository privacy (nothing pushed).

## 10. Security and recovery considerations, problems and fixes

**Security properties in place (tested where marked):**
- **Least-privilege roles.** `pbe_app` and `pbe_migrator` are not superusers and have no BYPASSRLS, CREATEDB or CREATEROLE (catalogue-tested). `pbe_app` owns nothing and cannot run DDL (tested).
- **Runner refusals.** It refuses superuser and BYPASSRLS sessions (unit), and any server that is not PostgreSQL 18 (unit). It forces `search_path = pg_catalog` (tested).
- **Passwords.** The two role passwords are random. Only SCRAM-SHA-256 hashes were sent to PostgreSQL. Plain passwords are only in `.env` (git-ignored, permissions 600, checked). No PBE tool prints them; `pg_dump` receives them through a temporary 0600 password file.
- **Secret scan improved:** it now detects literal SQL passwords (tested).

**Problems found, fixes, reruns:**
1. **All 42 database tests failed on the first run.** The configuration loaded `.env` into `process.env`, which Jest's per-test sandbox does not see. Fix: `.env` is now parsed directly (`util.parseEnv`). Rerun: 42/42 passed.
2. **Incident: a mutation test wrote into `pbe_dev`.** With `BEGIN` removed (M3), the "unqualified names" test really created an empty table, `public.unqualified_table`, owned by `pbe_owner`, in `pbe_dev`. The drift check detected it immediately. The agent dropped it (0 rows), and drift was clean again. This is ADR-019 gap 1 occurring in practice.
   - Fix: that test now uses a uniquely named table and always removes it.
   - Re-run of M3: tests failed as intended and nothing was left behind (0 tables in `public`, no drift).
3. **Test gap found by M3.** Nothing proved that a migration and its history row commit together. A new test makes the history insert fail and checks the migration is rolled back. It catches M3.
4. **Runner hole found during design.** A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index that a re-run with `IF NOT EXISTS` would silently accept. The runner now refuses to record a no-transaction migration while any invalid index exists (tested).
5. **Secret-scanner false positive.** `PASSWORD :'…'` (a psql variable) was flagged. It is now exempt in `.sql` files only, and SQL password literals are newly detected (both tested).
6. Two ESLint `no-redeclare` errors (`crypto`) were fixed. A `sed` word-boundary mistake that would have used the wrong `crypto` object was caught and fixed before any run.

**Recovery procedures and their evidence:**

| Situation | Procedure | Tested? |
|---|---|---|
| A migration fails | It is rolled back completely; fix the (unapplied) file and re-run | Yes |
| Runner crashes or is killed mid-migration | Nothing partial is kept, the lock is released, re-run | Yes |
| An applied file was edited | Runner refuses; restore the original from git; put changes in a new file | Yes |
| A no-transaction migration failed | Drop the INVALID index, fix the cause, re-run | Yes |
| Two runs at once | Second waits or times out; each migration applied once | Yes |
| Destructive change | Needs a `contract` file plus `--allow-contract`, after a verified backup | Refusal tested; backup step is procedural |
| Need to undo all local DB work | `db/bootstrap/teardown-local.sql` (owner-run) | **No.** Never run (destructive) |
| Restore from backup | `pg_restore` into a database | **No.** ADR-019 gap 3 |
| Leftover test schemas after an interrupted run | `npm run db -- clean-test-schemas` | No (no leftovers occurred) |

## 11. Acceptance criteria

Roadmap Stage 2 criteria, as amended by ADR-019:

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | All tests pass on PostgreSQL 18 | §7.1: 205/205, of which 43 on PostgreSQL 18.6 | **PASS** |
| 2 | Backup file restored and row counts and ledger matched (evidence quoted) | §7.3: backup made and verified by full archive decode (counts and ledger match). **No restore into a database** (ADR-019) | **NOT MET as written.** Met only in the reduced form the owner accepted with ADR-019. Needs explicit owner acceptance |
| 3 | `pbe_app` is not superuser, not owner, has no BYPASSRLS (catalogue output quoted) | §5 role table; test `pbe_app is not superuser … owns nothing` | **PASS** |
| 4 | Fresh apply; idempotent re-run; modified-file and missing-file rejection; numbering gap rejection | §7.2 | **PASS** |
| 5 | Concurrent runners (two processes) apply once | `concurrency.db.spec.ts` | **PASS** |
| 6 | Failing migration rolls back and leaves the ledger consistent | §7.2 | **PASS** |
| 7 | Runtime role cannot run DDL | §7.2 (8 tests) | **PASS** |
| 8 | Drift check | §7.2; verify step | **PASS** (against a snapshot, ADR-019 gap 4) |
| 9 | Prompt §4 list (first run … unsafe operations rejected) | §7.2, all rows | **PASS** (superuser refusal unit-level only) |
| 10 | Exclusions respected (no Python, Prisma, ORM schema generation, SQLite, business features, production changes, Docker, commit or push) | §1, §3, dependency guard | **PASS** |

Success categories achieved:
- **Build:** yes.
- **Automated tests:** yes.
- **Security verification:** partial, Stage 2 scope only (roles, privileges, secrets).
- **Scientific verification, model validation, production readiness:** not applicable and not claimed.

## 12. Recommended next step

**Recommended verdict: PASS, conditional on the owner explicitly accepting ADR-019 gap 3** (a backup restore into a database is not tested until a second database is allowed, by Stage 28 at the latest). If the owner does not accept that gap, the verdict is **FAIL on criterion 2**. The fix would be to allow one temporary restore database, created and dropped by the check itself, which needs a further owner decision. The final decision is the owner's.

Before Stage 3, the owner should:
1. Review this report and the files listed in §3, especially `db/migrations/0001_schema_skeleton.sql` and `db/bootstrap/bootstrap-local.sql`.
2. Decide PASS or FAIL, including the ADR-019 gap 3 acceptance.
3. Decide OD-07 (data-access layer; recommended option B: `pg` plus the Kysely query builder).

**How an independent reviewer can reproduce the checks** (needs this machine's PostgreSQL 18 and `.env`):

```sh
npm ci
npm run db -- status          # 0001 applied, 0 pending
npm run db -- drift           # no drift
npm run test:db               # 43 database tests on PostgreSQL 18
npm run db -- backup          # backup + archive verification
npm run verify                # 12 checks
```

To see it in pgAdmin: Servers → PostgreSQL 18 → Databases → `pbe_dev` → Schemas → `pbe_meta` → Tables → `schema_migration`.

Proposed Stage 3 prompt (not to be started without authorisation):

> I have reviewed STAGE-02. Verdict: PASS. I accept ADR-019 gap 3 (no restore-into-database test until Stage 28). I approve OD-07 option B (pg + Kysely, types generated from the migrated database, raw SQL allowed). Record it as an ADR.
> Authorise **Stage 3 — Data-access layer, tenant context and RLS harness** as defined in `docs/IMPLEMENTATION_ROADMAP.md`, using the single database `pbe_dev` (ADR-019) and new numbered migrations only. Inspect the workspace first, implement only Stage 3 scope, run all tests on PostgreSQL 18, write `docs/stage-reports/STAGE-03.md`, recommend PASS/FAIL per criterion, then stop. Do not commit or push.


---

## 13. Stage 2.1 — Corrective work (database separation, restore verification, safety tests)

Date: 2026-10-17. Requested by the owner because Stage 2 was not approved. **Every result below was produced by the coding agent; nothing has been independently verified.**

### 13.1 Plain-language summary

- **What is finished:**
  - The code and tests for separate `pbe_dev` and `pbe_test` databases, and for a real backup-restore drill into a temporary database that is created and then deleted.
  - The superuser-refusal and teardown tests. These ran successfully on a private, throw-away copy of PostgreSQL that the tests create and delete, so your real server was never touched.
- **What is not done yet:** the tests that need `pbe_test` and the restore drill **have not run**, because `pbe_test` does not exist yet. Creating it needs your PostgreSQL administrator password, so you must run one command: `npm run db:bootstrap` (§13.8).
- **`pbe_dev`** was never changed. It still holds migration 0001 and has no drift.

### 13.2 Security review requested by the owner

Read-only catalogue queries on the real server (2026-10-17):

```
pg_auth_members: pbe_migrator → member of pbe_owner, inherit_option = true, set_option = true, admin_option = false
pg_database:     pbe_dev owner pbe_owner — pbe_migrator has owner rights = true
                 postgres owner postgres — pbe_migrator has owner rights = false
                 (pbe_test did not exist)
```

**How `pbe_migrator` acts as `pbe_owner`:** it is a member with INHERIT (it automatically has `pbe_owner`'s privileges) and SET (it can `SET ROLE pbe_owner`). The runner uses SET so that migrations create objects owned by `pbe_owner`.

**Findings:**
1. **Pre-existing risk (not new).** Because `pbe_owner` owns `pbe_dev`, the `pbe_migrator` login could technically `DROP DATABASE pbe_dev`.
   - Mitigations today: no PBE command does so; migration files cannot contain `DROP DATABASE` (runner check); passwords exist only in `.env`.
   - This is enforced by PBE's code, **not by PostgreSQL**. Recorded as a residual risk with a recommended fix for later (§13.7).
2. **My first Stage 2.1 draft would have widened this.** Giving `CREATEDB` to `pbe_owner` would have let `pbe_migrator` create any number of databases. It was **withdrawn before being applied** (the bootstrap had not been re-run; the server still shows `pbe_owner` with `rolcreatedb = false`).

**Safest practical design adopted (ADR-020, revised):**
- `pbe_owner`, `pbe_migrator` and `pbe_app`: **no** `CREATEDB`. Unchanged from today.
- New test-only login **`pbe_restore_drill`**: the **only** role with `CREATEDB`.
  - Not a member of any PBE role; no superuser; no `BYPASSRLS`; at most 5 connections.
  - May connect only to `pbe_test`, with no schema or table access there. Cannot connect to `pbe_dev`.
  - PostgreSQL allows a role to drop only databases it owns, so this role **cannot drop `pbe_dev` or `pbe_test`**. This is enforced by the server itself, and tested (§13.5).
  - PBE code adds a second, independent check: only names matching `pbe_restore_check_<10 hex>` are ever created or dropped.
- Restores use `pg_restore --no-owner`, so the temporary copy is owned by `pbe_restore_drill`. The comparison maps that one role name back to `pbe_owner`; everything else must match exactly.
- **Credentials:** `npm run db:bootstrap` now **keeps the passwords already in `.env`**. Only the new role gets a new random password.

### 13.3 Files changed in Stage 2.1

| File | Change |
|---|---|
| `db/bootstrap/bootstrap-local.sql` | Also creates `pbe_test` (only if missing) and the `pbe_restore_drill` role; `pbe_owner` stays without `CREATEDB`; `pbe_dev` and its data untouched |
| `db/bootstrap/teardown-local.sql` | Rewritten: **never drops `pbe_dev`**. Drops temporary restore databases and `pbe_test`. Drops roles only once `pbe_dev` has been removed by hand. |
| `tooling/scripts/db-bootstrap.cjs` | Reuses existing `.env` passwords; handles the third login; checks all three logins |
| `tooling/migrate/src/config.ts` | Two databases (`dev`, `test`), restore role, temporary-database name pattern |
| `tooling/migrate/src/backup.ts` | Restore drill: backup → decode → create temporary database → restore → compare schema, ledger, row counts and row contents (MD5 per table) → usability → drop. Kept on failure for diagnosis. |
| `tooling/migrate/src/cli.ts` | `--db dev|test`; `restore-drill`; `drop-disposable`; `drift` checks the snapshot **and** a fresh `pbe_test` |
| `db/tests/helpers.ts` | Tests connect only to `*_test`; `pbe_dev` read only inside `READ ONLY` transactions; throw-away PostgreSQL helper |
| `db/tests/real-migrations.db.spec.ts` | Rebuilds `pbe_test` from empty; read-only `pbe_dev` checks; role boundary tests; restore drill tests |
| `db/tests/throwaway-server.db.spec.ts` | **New:** superuser, BYPASSRLS, bootstrap, restore-role and teardown tests on a private throw-away server |
| `tooling/tests/db-bootstrap.test.cjs` | Password-reuse tests |
| `docs/architecture/*`, `IMPLEMENTATION_ROADMAP.md`, `.env.example`, `db/bootstrap/README.md` | ADR-020 (supersedes ADR-019), privilege review, residual risk |

No dependencies were added. No database was created, changed or dropped on the real server during Stage 2.1.

### 13.4 Commands executed (2026-10-17, coding agent)

| Command | Result |
|---|---|
| Read-only catalogue queries (databases, roles, memberships, ledger) | §13.2. `pbe_test` absent; `pbe_dev` intact |
| `npm run db -- status` / `drift` (before changes) | 0001 applied, 0 pending, no drift |
| Trial of a throw-away instance: `initdb` → `pg_ctl start` (socket only) → query → `pg_ctl stop` → delete | PostgreSQL 18.6, no TCP, superuser present; folder removed; real server still accepting connections |
| `npx jest … --testPathPatterns throwaway-server` | **10/10 passed** |
| `npx jest --selectProjects tooling --testPathPatterns db-bootstrap` | 8/8 passed |
| Type-check, ESLint, Prettier, secret scan, dependency guard | All passed |
| `npm run verify` | **10/12 passed.** The 2 failures (tests and drift) are caused by the missing `pbe_test` (§13.6) |

### 13.5 Checks that PASSED (actually executed)

- **Unit and tooling tests (no database):** 164/164.
- **Throw-away PostgreSQL 18 tests** (private instance; the real server was not touched): 10/10.
  - Precondition: the connected role really is a superuser.
  - **Runner refuses a real superuser** (`UNSAFE_SESSION`) and creates nothing (`pbe_meta` absent).
  - Runner refuses a non-superuser with `BYPASSRLS`.
  - Control: an ordinary role **is** accepted, so the refusals are specific.
  - Bootstrap creates the four roles and both databases, is safe to run twice, and the attributes are exactly as designed (only `pbe_restore_drill` has `CREATEDB`).
  - A second bootstrap leaves data in `pbe_dev` untouched.
  - **PostgreSQL itself** stops `pbe_restore_drill` from dropping `pbe_dev` or `pbe_test`, connecting to `pbe_dev`, or acting as `pbe_owner`. It *can* create and drop its own database.
  - `pbe_migrator` cannot create a database, even as `pbe_owner` (`42501`).
  - **Teardown never drops `pbe_dev`.** It removed `pbe_test` and a temporary database, kept a look-alike and an unrelated database, stopped, and kept the roles while `pbe_dev` existed. Data in `pbe_dev` survived.
  - Teardown removes the roles only after `pbe_dev` was removed by hand.
- **Static checks:** type-check, lint and module boundaries, formatting, secret scan, dependency guard, lockfile, toolchain, audit (0 high or critical).
- **`pbe_dev` checks:** migration integrity, read-only.

### 13.6 Checks NOT YET RUN (need `pbe_test`, which needs the owner's bootstrap)

**58 database tests in 4 files could not run:**

| File | Tests |
|---|---|
| `real-migrations.db.spec.ts` | 34 |
| `runner.db.spec.ts` | 20 |
| `no-transaction.db.spec.ts` | 3 |
| `concurrency.db.spec.ts` | 1 |

Cause, from the Jest JSON report:
- 52 failed with `database "pbe_test" does not exist`.
- 5 failed with SQLSTATE `3D000` (PostgreSQL's code for "database does not exist").
- 1, the two-process concurrency test, failed because its child processes returned an error that the test does not print. Very likely the same cause, but **not confirmed** until it runs.

These include, and so have **not** been demonstrated yet:
- the **restore drill** on the defined fixture;
- the damaged-archive and "verification failure keeps the database" tests;
- the real-server role boundary tests;
- the drift check against a freshly rebuilt `pbe_test`;
- every migration-runner integration test re-run in `pbe_test`.

### 13.7 Remaining risks and limitations

1. **Residual risk:** the `pbe_migrator` login could technically drop `pbe_dev` (§13.2). Recommended hardening, for an owner decision by Stage 28: a separate database-owner role that `pbe_migrator` is not a member of. Not done now, because it changes ownership of the existing database and needs its own reviewed migration plan.
2. `pbe_restore_drill` can create databases with any name (but cannot read or drop anyone else's). Local development only; its password exists only in `.env`.
3. The safety checks on migration files are lexical, not a full SQL parser (unchanged from Stage 2).
4. Throw-away-server tests need `initdb` and `pg_ctl` from the local PostgreSQL 18 install.

### 13.8 Next step for the owner (plain English)

**Why your password is needed:** creating the `pbe_test` database and the new test-only login is something only the PostgreSQL administrator account is allowed to do. PBE never sees or stores that password.

**The single command**, in the VS Code terminal (menu **Terminal → New Terminal**):

```sh
npm run db:bootstrap
```

1. It lists what it will do and asks you to type `yes`.
2. psql then shows `Password for user postgres:`. Type the password you use for the PostgreSQL server in pgAdmin. Nothing appears while you type; that is normal. Press Enter. The password stays on your computer; do not paste it into the chat.
3. **Expected confirmation:**
   - two small tables listing the PBE roles and the databases `pbe_dev` and `pbe_test`;
   - then `existing password kept` for `pbe_migrator` and `pbe_app`;
   - three `login check: … connected to pbe_test` lines;
   - and finally `Bootstrap complete.`

Then tell the coding agent it has finished. The agent will then:
- run the 58 remaining database tests and the restore drill;
- run `npm run verify`;
- complete §13.9 with the actual results;
- stop for your review.

### 13.9 Outstanding acceptance criteria

| Criterion | Status |
|---|---|
| `pbe_dev` and `pbe_test` separate; `pbe_dev` never dropped, recreated or reset | **Partly met.** `pbe_dev` untouched (PASS). `pbe_test` creation prepared and tested on a throw-away server; **not yet created on the real server**. |
| Temporary restore database created and removed by a controlled procedure | Procedure built; tested on the throw-away server for the role's limits. **Restore drill NOT YET RUN on the real server.** |
| Backup → verify artifact → restore → verify schema, ledger and fixture data → usable → clean up | **NOT YET RUN** |
| Runner refuses unauthorised superuser execution (safe set-up) | **PASS** (throw-away server, real superuser) |
| Teardown tested only on a disposable database; refuses to target `pbe_dev` | **PASS** (throw-away server) |
| Rerun all migration-runner and database integration tests | **NOT YET RUN** (58 need `pbe_test`) |
| Full verification command | **Run: 10/12.** The 2 failures are due to the missing `pbe_test`. Must be re-run. |

*This table records the state before the owner's bootstrap. The final status is in §14.4.*


---

## 14. Stage 2.1 — Final verification (after the owner ran `npm run db:bootstrap`)

Date: 2026-10-17.
- **Who ran what:** the owner ran `npm run db:bootstrap`, typing the administrator password only into psql. Every other command and result below is the coding agent's.
- **Independent verification:** none has taken place.

### 14.1 State after the bootstrap (read-only checks)

**`pbe_dev` is intact:**
- Same ledger row as before: version 1, `schema_skeleton`, checksum `2ef0d494…7b27`, applied 2026-10-17T08:30:23.484Z by `pbe_migrator`.
- Same schemas: `app`, `audit`, `pbe_meta`, `platform`, `public`, `training`.
- Same database ACL: `{pbe_owner=CTc/pbe_owner, pbe_migrator=c/pbe_owner, pbe_app=c/pbe_owner}`.
- `status`: OK, 0 pending. No drift.

**`pbe_test` exists:**
- Owner `pbe_owner`. ACL: `{pbe_owner=CTc/pbe_owner, pbe_migrator=c/pbe_owner, pbe_app=c/pbe_owner, pbe_restore_drill=c/pbe_owner}`.
- Databases on the server: `pbe_dev`, `pbe_test`, `postgres`.

**Roles match the approved design:**

```
rolname            super inherit createrole createdb canlogin replication bypassrls connlimit
pbe_app            false false   false      false    true     false       false     50
pbe_migrator       false true    false      false    true     false       false     10
pbe_owner          false false   false      false    false    false       false     -1
pbe_restore_drill  false false   false      true     true     false       false      5
```

**Memberships:**
- Exactly one: `pbe_migrator → pbe_owner` (inherit true, set true, admin false).
- `pbe_restore_drill` is a member of nothing.

**Credentials:**
- `.env` permissions are 600.
- The existing `pbe_migrator` password still works; the checks above used it.
- A new `pbe_restore_drill` password was added to `.env`. It is not printed anywhere.

### 14.2 Problems found and fixed during final verification

1. **Two restore tests failed on the first run (66/68 passed).** The restored copy's `training` schema showed an empty privilege list (`∅`) where the source had the explicit `{pbe_owner=UC/pbe_owner}`.
   - Both mean "owner only" in PostgreSQL. `pg_dump` does not write out a privilege list equal to the default, so the textual comparison was too literal.
   - **Fix:** the fingerprint now compares **effective** privileges. An empty list is replaced by PostgreSQL's own `acldefault()` for schemas, tables, sequences and functions. Column privileges, which have no default form, are still compared as stored.
   - **Not weakened, and proven by a test:** granting `USAGE ON SCHEMA training TO pbe_app` in the restored copy is reported as a difference.
   - The committed `db/schema-snapshot.txt` did not need to change: the new-format fingerprint of `pbe_dev` (read-only) was identical to it, 31 of 31 lines.
2. **A temporary database was left behind by that first failed run.** `pbe_restore_check_9c9d7b45d5` was kept on purpose for diagnosis, but the test stopped at the failed assertion without cleaning up.
   - Inspection showed: owner `pbe_restore_drill`, the 1,003 fixture rows, and `training` ACL `null`. That is the diagnostic evidence of problem 1.
   - It was removed with the controlled command `npm run db -- drop-disposable --database pbe_restore_check_9c9d7b45d5`. In the same session, that command refused `pbe_dev` (`UNSAFE_TARGET`).
   - **Fix:** both drill tests now drop their temporary database in a `finally` block, so a failing drill can no longer leak one. No temporary database or `zz_*` schema remained after the final runs.
3. **Test strengthened:** the "restored data" test now also compares the awkward fixture values one by one, not only through the content checksum (§14.3).

### 14.3 Restore drill results (actually executed)

**A. Automated drill on a defined fixture** (`real-migrations.db.spec.ts`), on the real server.
- **Source:** `pbe_test` freshly rebuilt from the migrations, plus fixture table `zz_fixture_restore.sample` (1,003 rows).
- **Rows 1–3 deliberately contain:**
  - a single quote, a tab, a line break and a backslash;
  - the unicode text `µg/mL · ±5% · 日本語 · émulsion`;
  - an empty string;
  - NULLs in every nullable column;
  - an exact decimal `1234.5678`;
  - timestamps with time zones;
  - JSON;
  - binary bytes `00 ff 10` and an empty (not NULL) binary value.
- **Rows 4–1003** are generated, with binary MD5 values.

| Step | Result |
|---|---|
| `pg_dump` custom-format backup (test-scratch schemas excluded) | Archive created, starts with `PGDMP`, SHA-256 recorded |
| Archive verification: decode every byte with `pg_restore` | TOC contains `app`, `audit`, `pbe_meta`, `platform`, `training` and the fixture schema; ledger rows > 0 |
| Create temporary database as `pbe_restore_drill` | `pbe_restore_check_<10 hex>`, no PUBLIC access |
| `pg_restore --no-owner --single-transaction --exit-on-error` | Completed |
| Schema fingerprint (owner mapped back to `pbe_owner`) | Identical, 0 differences |
| Migration ledger | Identical, including `applied_at` |
| Fixture table | 1,003 → 1,003 rows; content MD5 identical |
| Value-by-value check of rows 1–3 | Identical (text bytes, NULLs, `0.0000`, empty binary `''`, `00ff10`) |
| Usable | Runner status OK, 0 pending, migrate applied 0, write and read inside a rolled-back transaction OK |
| Clean-up | Temporary database dropped; `pbe_dev` and `pbe_test` still exist |
| Changed value, same row count, in a copy | Detected (`contentEqual: false`) |
| Changed privilege in a copy | Detected (fingerprint difference on `schema training`) |
| Verification failure (fixture left out of the backup) | Detected; temporary database **kept** for diagnosis, then dropped by name |
| Damaged (half-length) archive | Rejected by `pg_restore` |

**B. Command-line drill:** `npm run db -- restore-drill` (source `pbe_test`, PBE schemas), exit 0:

```
backup: backups/pbe_test-2026-10-17T09-22-12-503Z.dump (6142 bytes, sha256 1840babaa25ac513bf9e571246ce735669af029584e00b15248d1c087fae25b2)
archive: 19 TOC entries, 1 ledger rows
created temporary database pbe_restore_check_3898c410df
pg_restore completed
comparison: identical
dropped temporary database pbe_restore_check_3898c410df
  schema: identical (31 entries); ledger: identical (1 rows)
  pbe_meta.schema_migration: rows 1 → 1, contents identical
  usable: status ok, 0 pending, migrate applied 0, write/read ok
  temporary database dropped
RESTORE DRILL PASSED
```

### 14.4 Final test totals and verification

**`npm run verify` (final): 12/12 PASS, exit 0.** The checks: toolchain, lockfile, dependency guard, secret scan, formatting, lint and boundaries, type-check, build, migration integrity of `pbe_dev`, tests, schema drift (`pbe_dev` against the snapshot **and** against freshly rebuilt `pbe_test`), and audit (0 high or critical).

**Tests: 232 run, 232 passed, 0 failed, 0 skipped** (17 suites).

| Group | Suites | Tests | Ran against |
|---|---|---|---|
| Database integration | `runner` 20, `real-migrations` 34, `no-transaction` 3, `concurrency` (two OS processes) 1 | **58** | Real PostgreSQL 18.6: `pbe_test`; `pbe_dev` read-only; temporary restore databases |
| Throw-away server | `throwaway-server` | **10** | Private PostgreSQL 18.6 instance created and deleted by the test |
| No database | migration files 54, runner logic 12, lexer 7, guards and tooling 83, workspaces 8 | **164** | — |

**Commands executed in this final step**, in order:
1. Read-only catalogue checks (§14.1).
2. `npm run db -- status`, then the same with `--db test`.
3. `npx jest --selectProjects "database (PostgreSQL 18)"`: 66/68, then fixed (§14.2).
4. A read-only comparison of old and new fingerprints.
5. `npx jest … database` again: 68/68.
6. `npx jest … --testPathPatterns real-migrations`: 34/34, after strengthening.
7. `npm run db -- restore-drill`.
8. A read-only inspection of the leftover.
9. `npm run db -- drop-disposable --database pbe_restore_check_9c9d7b45d5`, then `npm run db -- drop-disposable --database pbe_dev` (refused, exit 1).
10. `npm run db -- status` and `drift`.
11. `npm run verify` (12/12) and `npx jest --json` (232/232).
12. A final leftover check: only `pbe_dev`, `pbe_test`, `postgres`; 0 `zz_*` schemas; no throw-away folders.

### 14.5 Outstanding acceptance criteria — final status

| Criterion | Evidence | Result |
|---|---|---|
| `pbe_dev` and `pbe_test` separate; `pbe_dev` never dropped, recreated or reset; data intact | §14.1 (ledger row, schemas, ACL unchanged; no drift) | **PASS** |
| Temporary restore database created and removed by a controlled procedure | §14.3: created and dropped as `pbe_restore_drill`; PostgreSQL itself prevents that role from dropping `pbe_dev` or `pbe_test` (tests) | **PASS** |
| Consistent backup → artifact verified → restored → schema, ledger and fixture data verified (special characters, line breaks, empty values, binary) → usable → only the temporary database cleaned up | §14.3 A and B | **PASS** |
| Diagnostics preserved on failure | Failure test keeps the database; the real failure in §14.2 kept its copy and allowed diagnosis | **PASS** |
| Runner refuses unauthorised superuser execution (safe set-up) | Throw-away server, real superuser | **PASS** |
| Teardown tested only on a disposable database; refuses to target `pbe_dev` | Throw-away server tests; teardown script contains no `DROP DATABASE pbe_dev` | **PASS** |
| All migration-runner and database integration tests re-run | 58/58 plus 10/10 | **PASS** |
| Full verification command | 12/12 | **PASS** |
| Original Stage 2 criteria (§11), including criterion 2 "backup restored and row counts and ledger matched" | Now met by an actual restore (§14.3) | **PASS** (previously not met) |

### 14.6 Unresolved risks and limitations

1. **Residual (pre-existing) risk:** `pbe_migrator` can act as `pbe_owner`, which owns `pbe_dev`, so that login could technically drop `pbe_dev`. Only PBE's code prevents it, not the server. Recommended hardening for an owner decision by Stage 28: a separate database-owner role. See ADR-020.
2. `pbe_restore_drill` can create databases with any name (it cannot read or drop others'). Local and test use only. Its password exists only in `.env`.
3. The safety checks on migration files are lexical, not a full SQL parser. Statements inside `DO $$…$$` and function bodies are not inspected.
4. The throw-away-server tests need `initdb` and `pg_ctl` from the local PostgreSQL 18 install. Tests run on macOS arm64 only.
5. `db/manual/apply-0001-manually.sql` has never been executed (0001 was applied by the runner).
6. Audit: 20 moderate, dev-only findings, unchanged since Stage 1, not yet formally accepted by the owner. GitHub repository privacy is still unconfirmed; nothing has been pushed.
7. Backups in `backups/` (git-ignored) contain only test or empty data. They are not rotated or encrypted beyond FileVault; the full backup policy is OD-14 and OD-28.

### 14.7 Final recommendation

**PASS (recommended).** Every Stage 2 and Stage 2.1 acceptance criterion is met with real evidence from the local PostgreSQL 18 server. The two failures found in this step were fixed without weakening any check, and the reruns pass. The final decision is the owner's.

**Before Stage 3, the owner should:**
1. Record a Stage 2 verdict.
2. Decide whether to accept residual risk 1 until Stage 28.
3. Approve OD-07 (data-access layer).


---

## 15. Owner verdict (added 2026-10-17; §1–§14 above are unchanged)

- **Verdict:** **PASS**, given by the product owner on 2026-10-17, based on the coding agent's reported results (§14).
- **Evidence qualification:** every test result, command output and restore-drill result in this report was produced and reported by the coding agent. **No independent verification has been performed.** The only owner-executed step was `npm run db:bootstrap`.
- **Accepted conditions recorded with the verdict:**
  - The migrator-ownership risk (§14.6 item 1) is **not** accepted for production. It is tracked as **R-001** in [RISK_REGISTER.md](../architecture/RISK_REGISTER.md), with production-blocking status and mitigation required by Stage 28.
  - OD-07 was approved at the same time and recorded as ADR-021.
- **Still open from earlier stages:** formal acceptance of the 20 moderate dev-only audit findings (R-004); GitHub repository privacy (R-005).
