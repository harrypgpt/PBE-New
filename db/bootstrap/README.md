# Local database bootstrap

One-time set-up of PBE's local PostgreSQL 18 roles and databases (ADR-020). It needs
administrator rights, so the **product owner** runs it:

```sh
npm run db:bootstrap
```

- psql asks for the PostgreSQL administrator password (user `postgres` unless
  `PBE_PG_ADMIN_USER` is set). Type it there; it is never stored or shown.
- Passwords already in `.env` are kept; missing ones are generated at random. Only SCRAM-SHA-256
  verifiers are sent to PostgreSQL; passwords live only in the git-ignored `.env` (permissions 600).
- Safe to re-run: nothing is dropped, existing data is kept, existing passwords keep working.

| Role                | Can log in | Purpose                                                                                                                                                                                                                                     |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pbe_owner`         | no         | Owns every PBE schema, object and database. Cannot create databases.                                                                                                                                                                        |
| `pbe_migrator`      | yes        | Runs migrations and backups; may act as `pbe_owner`. Cannot create databases.                                                                                                                                                               |
| `pbe_app`           | yes        | Future API runtime role: no DDL, owns nothing, no `BYPASSRLS`.                                                                                                                                                                              |
| `pbe_restore_drill` | yes        | **Test-only.** The only role that may create databases (temporary restore copies). Not a member of any PBE role; cannot connect to `pbe_dev`; can drop only databases it owns.                                                              |
| `pbe_backup`        | yes        | **Read-only backup login** (Stage 7A). The only PBE role with `BYPASSRLS`; no memberships; read grants come from migration 0005; sessions start read-only; connects only to `pbe_dev`/`pbe_test` once the `pg_hba.conf` lines are in place. |

| Database                  | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `pbe_dev`                 | Development. Tests never write to it.                           |
| `pbe_test`                | Automated tests; rebuilt from the migrations on every test run  |
| `pbe_restore_check_<hex>` | Temporary: created and dropped by `npm run db -- restore-drill` |

[teardown-local.sql](teardown-local.sql) removes `pbe_test`, temporary restore databases and,
only once `pbe_dev` has been removed by hand, the roles. It never drops `pbe_dev` and is never
run by PBE.

## Backup login: connection rule and checks (Stage 7A, STAGE-07A-BACKUP-REVIEW.md)

- `npm run db:inspect-connections` — **read-only**: lists the server's active connection rules in
  order (including included files) into `backups/connection-rules-<time>.txt` (owner-only).
  psql asks for the administrator password; nothing is changed.
- [pg_hba-pbe-backup.conf](pg_hba-pbe-backup.conf) — the lines the administrator puts **above**
  every existing line of `pg_hba.conf`, followed by a configuration reload (no restart).
- `npm run db -- verify-backup-access` — real connection attempts as `pbe_backup` over TCP IPv4,
  TCP IPv6 and the local socket, to every database and as replication, plus the least-privilege
  audit and the backup-coverage check in `pbe_dev` and `pbe_test` (read-only).
- The bootstrap also closes two write paths PostgreSQL leaves open to every login in the PBE
  databases (creating large objects, writing logical-decoding messages to the WAL).
- [apply-pg-hba-pbe-backup.sql](apply-pg-hba-pbe-backup.sql) / [revert-pg-hba-pbe-backup.sql](revert-pg-hba-pbe-backup.sql)
  — **proposed, not run on the real server** (STAGE-08-INTEGRATION-PLAN.md, phase 4). Run by the
  administrator with psql: writes a verified dated copy of `pg_hba.conf`, puts the lines above on
  top, checks that PostgreSQL parses the new file **before** reloading (otherwise writes the
  original back), then reloads. No `sudo` needed. The revert script restores the copy.
- `npm run db -- compare-backups --first <file> --second <file>` — restores two backup files into
  temporary databases (restore role) and compares every table's data; used to show that a backup
  taken after a grants-only migration holds the same data as one taken before it.
