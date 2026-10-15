# PBE — Predictive Bioequivalence Engine

Decision-support software for assessing the risk of a future pivotal bioequivalence study.
PBE outputs do not establish bioequivalence and do not replace any required regulatory study.

**Current state: Stage 1 (repository skeleton).** There are no scientific, prediction, login,
database or business features yet. See [the roadmap](docs/IMPLEMENTATION_ROADMAP.md).

## What is in this repository

| Folder                  | Contents                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| `apps/api`              | Backend (NestJS). Currently only `GET /health/live`.              |
| `apps/web`              | Frontend (Next.js + React). Currently one status page.            |
| `packages/contracts`    | Shared API schemas (Zod), used by both the API and the web app.   |
| `packages/science-core` | Reserved for scientific methods. Intentionally empty.             |
| `tooling`               | Lint rules, checks (toolchain, secrets), scripts and their tests. |
| `openapi/openapi.json`  | API documentation, generated from the shared schemas.             |
| `docs/`                 | Architecture documents, roadmap and stage reports.                |

## Requirements

- Node.js 24 or newer (`node -v`) and npm 11 or newer (`npm -v`).
- No database is needed yet (PostgreSQL arrives in Stage 2).
- No Python is needed or used (ADR-022).

## Everyday commands

Run these from the project folder.

| Command                                 | What it does                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run setup`                         | Installs exactly the locked dependency versions (`npm ci`). Run once after downloading.                        |
| `npm run dev`                           | Starts the API (http://127.0.0.1:4000/health/live) and the web app (http://localhost:3000). Ctrl+C stops both. |
| `npm run verify`                        | Runs **every** check of the stage gate and prints a PASS/FAIL summary. Takes a few minutes.                    |
| `npm test`                              | Runs all automated tests.                                                                                      |
| `npm run build`                         | Production builds of the shared packages, the API and the web app.                                             |
| `npm run lint` · `npm run format:check` | Code-rule and formatting checks. `npm run format` fixes formatting.                                            |
| `npm run typecheck`                     | TypeScript type checks for all workspaces.                                                                     |
| `npm run openapi:generate`              | Regenerates `openapi/openapi.json` after a contract change.                                                    |
| `npm run check:toolchain`               | Fails if Python, Prisma or unapproved native-build dependencies appear.                                        |
| `npm run check:toolchain:install`       | Proves a clean install works with no Python available.                                                         |
| `npm run check:secrets`                 | Scans the repository for credentials and forbidden files (e.g. `.env`).                                        |

## Local settings

Copy the examples and adjust if needed. The copies are git-ignored and must never be committed.

```sh
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

The examples contain no secrets. Defaults work without copying them.

## Rules that the checks enforce

- PostgreSQL will be the only database. Prisma and Prisma Migrate are not used (ADR-021).
- TypeScript only. No Python anywhere, including indirect native builds (ADR-022).
- Backend modules follow the tiers in `docs/architecture/MODULE_BOUNDARIES.md`
  (`tooling/module-boundaries.json`, lint rule `pbe/module-boundaries`).
- `packages/science-core` must stay free of I/O, clock access and unseeded randomness (ADR-008).
- The web app never imports backend code, and vice versa.
