'use strict';
// `npm run verify` — runs every check in order, continues after failures so the
// summary shows the full picture, and exits non-zero if any check failed.
// Later stages add steps here (TESTING_AND_ACCEPTANCE_GATES.md §4).
// From Stage 2 the database steps need local PostgreSQL 18 set up with `npm run db:bootstrap`.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..', '..');
const env = {
  ...process.env,
  PATH: `${path.join(rootDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`,
};

const STEPS = [
  {
    name: 'Toolchain (Node/npm versions)',
    cmd: 'node',
    args: ['tooling/scripts/check-toolchain.cjs'],
  },
  { name: 'Lockfile matches installed tree', cmd: 'npm', args: ['ls', '--all'], quiet: true },
  {
    name: 'Dependency guard (Python/Prisma/SQLite/…)',
    cmd: 'node',
    args: ['tooling/scripts/check-dependencies.cjs'],
  },
  { name: 'Secret scan', cmd: 'node', args: ['tooling/scripts/check-secrets.cjs'] },
  { name: 'Formatting (Prettier)', cmd: 'prettier', args: ['--check', '.'], quiet: true },
  { name: 'Lint + module boundaries (ESLint)', cmd: 'eslint', args: ['.', '--max-warnings=0'] },
  {
    name: 'Type-check (all workspaces)',
    cmd: 'npm',
    args: ['run', 'typecheck', '--workspaces', '--silent'],
  },
  {
    name: 'Build (all workspaces)',
    cmd: 'npm',
    args: ['run', 'build', '--workspaces', '--silent'],
  },
  {
    name: 'OpenAPI document in sync with contracts (ADR-022)',
    cmd: 'node',
    args: ['tooling/scripts/openapi.cjs', '--check'],
  },
  {
    name: 'Migration integrity (pbe_dev ledger vs files)',
    cmd: 'node',
    args: ['tooling/migrate/dist/cli.js', 'status'],
  },
  { name: 'Tests (Jest, all projects)', cmd: 'jest', args: ['--ci'] },
  {
    name: 'Web E2E: smoke, security headers, accessibility (Playwright, real PostgreSQL pbe_test)',
    cmd: 'npm',
    args: ['run', 'test:e2e', '--silent'],
  },
  {
    name: 'Database types up to date (typegen --check, ADR-021)',
    cmd: 'node',
    args: ['tooling/migrate/dist/cli.js', 'typegen', '--check'],
  },
  {
    name: 'Schema drift (pbe_dev vs snapshot and vs freshly rebuilt pbe_test)',
    cmd: 'node',
    args: ['tooling/migrate/dist/cli.js', 'drift'],
  },
  {
    name: 'Dependency audit (high/critical)',
    cmd: 'npm',
    args: ['audit', '--audit-level=high'],
    quiet: true,
  },
];

const results = [];
for (const step of STEPS) {
  console.log(`\n▶ ${step.name}`);
  const started = Date.now();
  const run = spawnSync(step.cmd, step.args, {
    cwd: rootDir,
    env,
    encoding: 'utf8',
    stdio: step.quiet ? 'pipe' : 'inherit',
  });
  const ok = run.status === 0;
  if (step.quiet) {
    const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
    const lines = output.split('\n');
    // Quiet steps print only a short tail on success, everything on failure.
    console.log(ok ? lines.slice(-3).join('\n') : output);
  }
  if (run.error) console.error(`  could not start: ${run.error.message}`);
  if (!ok && !run.error)
    console.error(
      `  step ended with exit code ${run.status}${run.signal ? `, signal ${run.signal}` : ''}`,
    );
  results.push({ name: step.name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log('\n================ verify summary ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.seconds}s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  `------------------------------------------------\n${results.length - failed}/${results.length} checks passed.`,
);
process.exitCode = failed === 0 ? 0 : 1;
