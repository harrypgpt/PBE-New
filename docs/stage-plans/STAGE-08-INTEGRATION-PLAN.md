# Stage 8 integration plan — backup login, connection rules, migrations 0005 and 0006

Status: **Executed 2026-10-18 (phases 0–8), owner-authorised**, with decision D-I1 = administrator backup first. Prepared for the order "PBE — Stage 8 Integration Readiness". The execution record is in [STAGE-08.md §11](../stage-reports/STAGE-08.md#11-integration-executed-2026-10-18). Phase 9 (owner check S8-12) is open.

Agent's own work, **not independently verified**. Every step on the real server needs the owner's separate authorisation (§7).

Sources:
- [STAGE-07A-BACKUP-REVIEW.md](../stage-reports/STAGE-07A-BACKUP-REVIEW.md) (B-1, design v2, §24);
- [INCIDENT-2026-10-18.md](../stage-reports/INCIDENT-2026-10-18.md) (`pbe_backup`);
- [STAGE-08.md](../stage-reports/STAGE-08.md);
- `db/migrations-proposed/0005_backup_read_access.sql` and `0006_projects_scenarios.sql`.

## 1. Goal

Reach the Stage 8 integration gate, which means:
- `pbe_dev` and `pbe_test` at migrations 0001–0006;
- a backup login that can back up every table;
- a verified backup before each change, and a tested way back;
- the 5 known backup failures resolved by fixing the cause, never by skipping tests.

## 2. Current state

### 2.1 Confirmed facts

Read-only checks on 2026-10-18 unless another source is named.

| # | Fact | Evidence |
|---|---|---|
| C1 | `pbe_dev` and `pbe_test` are both at migrations 0001–0004 | `pbe_meta.schema_migration`, read as `pbe_migrator` in a read-only transaction |
| C2 | `pbe_backup` exists: LOGIN, BYPASSRLS, not superuser, NOINHERIT, NOREPLICATION, connection limit 2, `default_transaction_read_only=on`; CONNECT on both databases; **0 table rights** in either database | `pg_roles`, `pg_db_role_setting`, `information_schema.table_privileges`, `pg_database` (inspection report) |
| C3 | `pbe_backup` was created by the interrupted run of `npm run db:bootstrap` at 10:39 IST. Its password is set but unknown to PBE (not in `.env`) | INCIDENT §6 (`pg_authid` transaction ids 48921–48924), §8 (server log) |
| C4 | The large-object/WAL revoke (bootstrap step 7) is **not** applied: `pbe_backup` can still run `lo_create` | `has_function_privilege`, both databases |
| C5 | **`pbe_dev` holds no user or organisation data.** `platform.user_account` (no row-level security) has 0 rows, read directly. PostgreSQL's counters show 0 rows ever inserted into every protected table; only catalogue seed rows exist (12 permissions, 6 templates, 11 template permissions, 4 ledger rows) | `count(*)`; `pg_stat_user_tables.n_tup_ins` |
| C6 | `pbe_test` holds test data only (5 organisations, 48 users); the tests rebuild it | `count(*)` |
| C7 | Connection rules **as loaded at 10:09 IST**: 6 rules, no included files, all `scram-sha-256` (socket for all; TCP 127.0.0.1 and ::1 for all; replication on the same three). No rule for any other address, so other computers are refused even though `listen_addresses = *`. `ssl = off`. Rules begin at line 113 of `/Library/PostgreSQL/18/data/pg_hba.conf` | `backups/connection-rules-2026-10-18T05-46-53-243Z.txt` (the owner-side `npm run db:inspect-connections` run at 11:16 IST) |
| C8 | **The server was restarted at 16:17 IST** (`pg_postmaster_start_time`), after the report in C7. The rules in force now are therefore unconfirmed | `pg_conf_load_time()`, `pg_postmaster_start_time()` |
| C9 | The last verified backup of `pbe_dev` is `backups/pbe_dev-2026-10-18T06-38-46-870Z.dump`, taken at **0003** before 0004 was applied (12:08 IST). Its restored copy was identical (202 schema entries, 9 tables, 0 data rows); the drill reported "not ok" only because 0004 was pending | `restore-drill-2026-10-18T06-38-47-223Z.json`; STAGE-07A.md §14 |
| C10 | **No complete backup of `pbe_dev` at 0004 can be made with the PBE logins today.** `pbe_backup` has no read rights (0005 not applied); `pbe_migrator` acting as `pbe_owner` is refused on forced row-level-security tables. Only the PostgreSQL administrator can make one | Reproduced on a throw-away server (§5, step 0); B-1 |
| C11 | The API accepts only ledgers 0001–0004 and 0001–0006. **At 0001–0005 it refuses to start**, so the API must be stopped between 0005 and 0006 | `schema-profiles.throwaway.db.spec.ts` (5/5) |
| C12 | Older backup files are readable by other local accounts (mode 644), and the partial `pbe_test` dump of 2026-10-17 is still present | `ls -la backups` (unchanged, STAGE-07A-BACKUP-REVIEW §13) |

### 2.2 Assumptions (not confirmed)

| # | Assumption | How it will be confirmed |
|---|---|---|
| A1 | The connection rules after the 16:17 restart are the same as in C7 | Phase 1: a new read-only inspection |
| A2 | `platform.tenant` in `pbe_dev` is empty. It has row-level security, so `pbe_migrator` sees 0 even if rows exist. Strongly indicated: there are no users, so no Super Admin could have created one, and the counters show 0 inserts. But the counters reset after a crash | Phase 2: the administrator backup's restored copy lists every table's row count |
| A3 | Nobody else changes the server during the window | The owner confirms; Phase 1 and the final checks would show a change |
| A4 | The owner's `npm run dev` is the only application using `pbe_dev` | The owner confirms; Phase 5 checks for open sessions |

## 3. Key findings for the plan

1. **The order must close the B-1 gap without breaking the "verified backup before every change" rule.** At 0004 only the administrator can back up `pbe_dev` (C10). Proposed: one **administrator backup** before any change (Phase 2), restored and checked with the new `compare-backups` command. Alternative, if the owner prefers not to use the administrator password for this: apply 0005 first, which only grants read rights and is undone with REVOKE. The existing 0003 backup (C9) plus C5 would then be the way back. **The owner chooses (§7, decision D-I1).**
2. **0005 and 0006 run in one maintenance window, with the application stopped** (C11). They are applied one after the other, with a backup between them.
3. **Rules must be re-confirmed first** (C8).
4. **The connection-rule change does not need the Mac's `sudo` password.** The administrator can run a reviewed script that has PostgreSQL write and check its own file, with a verified copy and an automatic undo on error (§6, rehearsed 5/5).
5. **The setup script works on today's state** (C2–C4). It keeps the role, gives it a new password stored only in `.env`, keeps the other three passwords, and applies the missing revoke (rehearsed 4/4).
6. **After 0006 reaches `pbe_test`, the database types are regenerated from it.** The accepted ledgers are now written out explicitly, and a test requires the generated types to match one of them, so this cannot silently change what the API accepts.

## 4. Proposed execution sequence (NOT run)

Stop at the first unexpected result. "Admin" means a step needing the PostgreSQL administrator password; see §7 for who runs it.

**Phase 0 — prerequisites.**
- The owner authorises the phases (§7) and decides D-I1.
- The working tree is preserved (no commit needed).
- Keep a copy of `db/schema-snapshot.txt` (the migrate step rewrites it):
  ```
  cp db/schema-snapshot.txt backups/schema-snapshot-before-0005.txt
  ```

**Phase 1 — read-only re-confirmation (admin, read-only).**
```
npm run db:inspect-connections
```
- Expected: the same 6 rules as C7, no included files, no parse errors.
- Compare with the 11:16 report. Any difference: stop and review.

**Phase 2 — pre-migration administrator backup of `pbe_dev` (admin, read-only on the database).**
```
umask 077
/Library/PostgreSQL/18/bin/pg_dump -h 127.0.0.1 -U postgres --format=custom \
  --file backups/pbe_dev-pre-0005-admin-<stamp>.dump pbe_dev
/Library/PostgreSQL/18/bin/pg_restore --list backups/pbe_dev-pre-0005-admin-<stamp>.dump > /dev/null
npm run db -- compare-backups --first backups/pbe_dev-pre-0005-admin-<stamp>.dump \
                              --second backups/pbe_dev-pre-0005-admin-<stamp>.dump
```
- Expected: the file decodes completely. The comparison restores it twice into temporary databases (as the restore role) and prints every table's row count. This confirms A2 and C5. It must print `BACKUPS HOLD THE SAME DATA`, and both temporary databases are dropped.
- `pbe_test` needs no backup: the tests rebuild it.

**Phase 3 — setup script (admin).**
```
npm run db:bootstrap
```
- Expected: 4 × `authentication scram-sha-256`, then "Bootstrap complete".
- `.env` gains `PBE_PG_BACKUP_PASSWORD`; the other passwords are unchanged.
- Check (read-only): `pbe_backup` attributes as in C2; `lo_create` revoked.

**Phase 4 — connection rules (admin).**
```
psql -h 127.0.0.1 -U postgres -d postgres -X -v stamp=<YYYYMMDD-HHMM> \
     -v lines_file=db/bootstrap/pg_hba-pbe-backup.conf -f db/bootstrap/apply-pg-hba-pbe-backup.sql
```
- Expected: "copy of the current file written and verified", then "pg_hba.conf updated … and configuration reloaded".
- The rule list shows the 6 `pbe_backup` lines first, then the 6 existing rules, with no errors.

**Phase 5 — maintenance window opens.**
- Stop `npm run dev`.
- Check that no application session remains:
  ```
  SELECT count(*) FROM pg_stat_activity WHERE datname = 'pbe_dev' AND usename = 'pbe_app'
  ```
  (read-only, as `pbe_migrator`). Expected: 0.

**Phase 6 — 0005 (agent).**
```
mv db/migrations-proposed/0005_backup_read_access.sql db/migrations/
npm run db -- migrate --db test
npm run db -- migrate --db dev
npm run db -- verify-backup-access
npm run db -- restore-drill --db dev
npm run db -- compare-backups --first backups/pbe_dev-pre-0005-admin-<stamp>.dump \
                              --second backups/pbe_dev-<drill stamp>.dump
```
Expected:
- each migrate applies `[5]`, and the runner's coverage check passes inside the transaction;
- `BACKUP ACCESS VERIFIED`: 27 matrix cells on the real server (30 on the throw-away server, which has one extra database to refuse), privilege audit and coverage clean in both databases;
- `RESTORE DRILL PASSED` (as `pbe_backup`);
- `BACKUPS HOLD THE SAME DATA`, with ledger `[1–4]` versus `[1–5]`. This proves the first backup-login backup holds exactly what the administrator backup held.

**Phase 7 — 0006 (agent).**
```
mv db/migrations-proposed/0006_projects_scenarios.sql db/migrations/
npm run db -- migrate --db test
npm run db -- migrate --db dev
npm run db -- typegen
npm run db -- restore-drill --db dev
npm run db -- verify-backup-access
```
Expected:
- each migrate applies `[6]`;
- typegen writes `SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6]` (an accepted profile, checked by test);
- `RESTORE DRILL PASSED`;
- `BACKUP ACCESS VERIFIED`.

**Phase 8 — tests and close of window (agent).**
Update the one real-server **detector** test ("no PBE role has BYPASSRLS; pbe_backup does not exist yet") to the new **exact** expected state:
- `pbe_backup` with the C2 attributes;
- read rights only in the PBE schemas;
- coverage clean.

The test stays strict and must pass for the right reason. Then:
```
npm test
npm run verify
npm run dev
```
Expected:
- the 4 backup-drill tests now pass (the backup login works);
- 0 failures in the full run;
- `verify` passes (drift: `pbe_dev` equals the new snapshot and the rebuilt `pbe_test`).
- The window closes when the application starts. Health returns ok at 0001–0006, and "Projects" appears for permitted users.

**Phase 9 — owner's manual check S8-12.**
- Create a project and two scenarios.
- See them on the dashboard.

**Phase 10 (optional, separate authorisation).**
- Restrict the older backup files to owner-only (`chmod 600`).
- Quarantine the partial `pbe_test` dump (STAGE-07A-BACKUP-REVIEW §13).

## 5. Verified now, on throw-away servers only

| Test (command: `npx jest --ci --selectProjects "database (PostgreSQL 18)" --testPathPatterns <name>`) | Result | Covers |
|---|---|---|
| `integration-0005-0006` | **10/10** | Rehearsal of phases 2 and 6–7, then recovery. **Step 0** (C10): the backup login and the migrator path both fail and leave no file. **Step 1:** the administrator backup is complete; its restored copy is identical. **Step 2:** 0005; coverage and privilege audit clean. **Step 3:** backup-login drill at 0005 passes. **Step 3b:** `compare-backups` proves the administrator backup and the first backup-login backup hold the same data. **Step 4:** 0006; existing Tenant Administrator role receives the project permissions; RLS conformance, coverage and audit clean. **Step 5:** with project data, the drill at 0006 passes, identical including policies, triggers and functions. **Step 5b:** `compare-backups` detects real differences. **Step 6:** archive trigger active. **Step 7:** full recovery to the pre-migration state (below) |
| `pg-hba-change` | **5/5** | Phase 4 and its undo, on a file shaped like the real one (tabs, quotes, blank lines): verified copy byte-identical; new file = reviewed lines + original; reloaded; backup login reaches only `pbe_dev`/`pbe_test`; other logins unaffected; a second apply refused; revert restores the original byte for byte; a faulty proposal is caught **before** reload, the original is written back, and the running rules are unchanged |
| `bootstrap-existing-backup-role` | **4/4** | Phase 3 on today's state (role present, unknown password, no revoke, no `.env` entry) |
| `schema-profiles` (database and API unit) | **5/5 and 2/2** | Start-up at 0001–0004 and 0001–0006 accepted; 0001–0005 and an unknown 0007 refused; health 503 if the ledger changes; profiles explicit |
| `projects-draft`, `projects-api`, `backup-v2`, `backup-credentials` | pass (in the full run) | Earlier evidence: 0006 rules, API, 30-cell connection matrix, credential lifecycle |

**Recovery (step 7), rehearsed:**
- stop sessions;
- `DROP DATABASE pbe_dev`;
- as administrator, `pg_restore --create --exit-on-error --dbname postgres <pre-migration admin dump>`.

Result:
- ledger back to `[1–4]`;
- every table identical to the pre-migration copy;
- database rights restored (the application connects);
- project tables gone;
- the backup login back to no read rights.

**Deliberate breaks:**

| Break | Caught by |
|---|---|
| 0006 without its backup-login grant | The runner rolled the migration back; 3 rehearsal tests failed |
| The apply script's pre-reload check disabled | The faulty-proposal test |
| The new "not available" check removed (previous order) | Its test |

Every broken file was restored byte-for-byte.

**Full regression** (final, with every spec above): Jest **812 passed, 5 failed** (the 5 known backup failures); browser tests **48/48**; OpenAPI, typegen and drift pass.

## 6. Recovery per phase

| Phase | If it fails or must be undone |
|---|---|
| 1–2 | Read-only; nothing to undo. A failed backup leaves no file |
| 3 | The setup script is idempotent; re-run it. A failed run changes no password (checked inside one transaction). The previous role state is in C2 |
| 4 | `psql … -v stamp=<same> -f db/bootstrap/revert-pg-hba-pbe-backup.sql` (rehearsed). The script undoes itself if the new file does not parse |
| 6 | Each migration is one transaction; a failure leaves nothing. To undo a completed 0005, apply a reviewed REVOKE, or do a full recovery. Move the file back to `db/migrations-proposed/` and restore the snapshot copy |
| 7 | **Full recovery** from the Phase 2 administrator backup (rehearsed above). Restore the snapshot copy and move both files back |
| 8 | Code-only changes; revert the files |

## 7. Actions requiring separate authorisation

| # | Action | Needs | Who can run it |
|---|---|---|---|
| D-I1 | **Decision:** administrator backup before 0005 (recommended), or 0005 first relying on C5, C9 and REVOKE | Owner decision | — |
| X1 | Phase 1 read-only inspection | Administrator password | The owner, or the agent using the stored administrator password file (`~/PBE-postgres-admin-password.txt`), if the owner explicitly authorises that use |
| X2 | Phase 2 administrator backup | Administrator password | As X1 |
| X3 | Phase 3 `npm run db:bootstrap` (changes passwords: new one for `pbe_backup`; re-asserts roles) | Administrator password | As X1 |
| X4 | Phase 4 connection-rule change and reload | Administrator password (no `sudo` with the proposed script) | As X1 |
| X5 | Phases 5–8: stop the app; apply 0005 and 0006 to `pbe_test` and **`pbe_dev`**; regenerate types; update the detector test; restart the app | Owner authorisation | Agent |
| X6 | Phase 10 file permissions and quarantine | Owner authorisation | Agent |
| X7 | In an emergency, the full recovery of §6 (drops and recreates `pbe_dev`) | Owner authorisation **at that time** | Agent with administrator password |

Not requested and not planned: any change to `listen_addresses` or SSL (pre-existing, affects all logins); deleting `pbe_backup`; deleting any backup.

## 8. Risks

| Risk | Rating | Mitigation |
|---|---|---|
| Rules changed during the 16:17 restart (A1) | Medium until Phase 1 | Phase 1 stops on any difference |
| A wrong `pg_hba.conf` locks out logins | Low | Pre-reload parse check with automatic restore; verified copy; revert script; the administrator's socket rule is unchanged |
| The backup login and backup files can read every organisation's data | Accepted for development; production-blocking until Stage 29 | Owner-only files and folder; login limited to this Mac and two databases |
| The administrator backup file contains everything | Low (no user data today, C5) | Owner-only (`umask 077`); kept until the window is closed and verified |
| API down during the window | Low | Short window; no users in `pbe_dev` |
| Server-log lines with old SCRAM verifiers (INCIDENT §8) | Low | Phase 3 replaces the `pbe_backup` password; the restore-role password stays (the setup script keeps `.env` passwords). Rotating it is possible later; not needed for this plan |
| R-001, R-007, R-009, R-010, R-011 | Open, production-blocking | Unchanged by this plan |

## 9. Remaining evidence needed to approve

1. **Phase 1 output** equal to the C7 rules (confirms A1).
2. **Phase 2 row counts** (confirms A2 and C5) and `BACKUPS HOLD THE SAME DATA` for the administrator backup.
3. The owner's answers to **D-I1, A3 and A4**.
4. Owner approval of the two new scripts (`apply-` and `revert-pg-hba-pbe-backup.sql`) and of the new `compare-backups` command, all rehearsed on throw-away servers only.

Everything else the plan relies on is confirmed (§2.1) or rehearsed (§5).
