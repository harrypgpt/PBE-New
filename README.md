# PBE — Predictive Bioequivalence Engine

Decision-support software for pre-pivotal bioequivalence risk assessment. PBE never guarantees
bioequivalence and never replaces a required regulatory study.

**Current state: Stage 1 (repository foundation).** There are no application features yet.
Start with [docs/architecture/MASTER_ARCHITECTURE.md](docs/architecture/MASTER_ARCHITECTURE.md)
and the stage plan in [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md).

## Requirements

| Tool    | Supported version                                             |
| ------- | ------------------------------------------------------------- |
| Node.js | **24.21.0** (pinned in `.nvmrc`; any 24.x ≥ 24.21.0 accepted) |
| npm     | 11 or newer (11.19.0 tested)                                  |

No Python, Docker or database is needed for Stage 1.

## Clean install and verification

From the project folder:

```sh
npm ci            # installs exactly what package-lock.json records
npm run verify    # runs every check and prints a PASS/FAIL summary
```

`npm ci` deletes any existing `node_modules` folder and reinstalls from the lockfile, so it is
the reproducible install. Use `npm install <package>` only when a stage adds an approved
dependency; that updates the lockfile.

Install scripts are controlled by `allowScripts` in `package.json`. The two packages that
ship install scripts (`@parcel/watcher`, `unrs-resolver`) are denied: prebuilt binaries are
used instead, so nothing is compiled and Python is never invoked.

## Commands

| Command                   | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `npm run verify`          | All checks below, in order, with a summary                            |
| `npm run check:toolchain` | Node.js and npm versions match the pinned toolchain                   |
| `npm run check:lockfile`  | Installed packages match `package-lock.json`                          |
| `npm run check:deps`      | Rejects Python, Prisma, schema-sync tools, SQLite/in-memory databases |
| `npm run check:secrets`   | Scans committable files for credentials (prints locations only)       |
| `npm run format:check`    | Prettier formatting check (`npm run format` fixes it)                 |
| `npm run lint`            | ESLint, including module-boundary and science-core purity rules       |
| `npm run typecheck`       | TypeScript strict type-check of every workspace                       |
| `npm run build`           | Compiles every workspace to `dist/`                                   |
| `npm test`                | Jest tests for every workspace and the guardrail self-tests           |
| `npm run audit:deps`      | `npm audit`; fails on high or critical advisories                     |
| `npm run licenses`        | Lists dependency licences (informational)                             |

## Layout

```
apps/web               user interface (Next.js from Stage 5)
apps/api               API server (NestJS from Stage 4)
packages/contracts     shared API schemas (Zod from Stage 4)
packages/science-core  pure scientific functions (no I/O, clock or randomness)
tooling/               guard scripts and their self-tests
docs/                  architecture, roadmap and stage reports
```

## Rules that the tooling enforces

- PostgreSQL is the only database. No SQLite or in-memory substitutes (ADR-003).
- No Python anywhere (ADR-005). No Prisma or ORM schema synchronisation (ADR-006).
- Workspaces may only depend on each other in the allowed direction (MODULE_BOUNDARIES.md §2).
- Secrets never go in the repository. `.env` files are git-ignored; only `.env.example` is committed.
