'use strict';

// Runs the full Stage-gate check locally (TESTING_AND_ACCEPTANCE_GATES §3) and prints a summary.
// Every step runs even if an earlier one fails, so one run shows all problems.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const STEPS = [
  ['Build shared packages', 'build:packages'],
  ['TypeScript checks', 'typecheck'],
  ['Lint', 'lint'],
  ['Formatting', 'format:check'],
  ['Jest tests', 'test'],
  ['Backend production build', 'build:api'],
  ['Frontend production build', 'build:web'],
  ['OpenAPI up to date', 'openapi:check'],
  ['Toolchain policy (no Python/Prisma)', 'check:toolchain'],
  ['Clean install without Python', 'check:toolchain:install'],
  ['Secret scan', 'check:secrets'],
];

const results = [];
for (const [label, script] of STEPS) {
  console.log(`\n===== ${label} (npm run ${script}) =====`);
  const started = Date.now();
  const { status } = spawnSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
  results.push({ label, ok: status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log('\n===== Verification summary =====');
for (const { label, ok, seconds } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)} ${seconds}s`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} step(s) FAILED.` : '\nAll steps PASSED.');
process.exit(failed ? 1 : 0);
