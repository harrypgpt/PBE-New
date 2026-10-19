'use strict';
// `npm run dev` — starts the API and the website together for local development
// (STAGE-05-PLAN.md §3). Ctrl+C stops both; if either one stops, the other is stopped too.
// The API reads its settings from .env (as `npm run dev:api` does) and connects to pbe_dev as
// pbe_app; the website runs `next dev` and forwards /api/v1 to the API (ADR-025).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..', '..');
const bin = (name) => path.join(rootDir, 'node_modules', '.bin', name);

if (!fs.existsSync(path.join(rootDir, '.env'))) {
  console.error('dev: .env is missing. Run `npm run db:bootstrap` first (STAGE-02.md).');
  process.exit(1);
}

for (const workspace of ['@pbe/contracts', '@pbe/api']) {
  const built = spawnSync('npm', ['run', 'build', '-w', workspace, '--silent'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (built.status !== 0) {
    console.error(`dev: building ${workspace} failed.`);
    process.exit(1);
  }
}

const children = [];
let stopping = false;

function prefixed(stream, label) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`[${label}] ${line}\n`);
  });
}

function start(label, cmd, args, options) {
  const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixed(child.stdout, label);
  prefixed(child.stderr, label);
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`dev: ${label} stopped (${signal ?? `exit ${code}`}); stopping everything.`);
      stopAll(1);
    }
  });
  children.push(child);
  return child;
}

function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  let remaining = children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (remaining.length === 0) process.exit(exitCode);
  for (const child of remaining) {
    child.once('exit', () => {
      remaining = remaining.filter((c) => c !== child);
      if (remaining.length === 0) process.exit(exitCode);
    });
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of remaining) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 5000).unref();
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

start('api', process.execPath, ['--env-file=.env', 'apps/api/dist/main.js'], { cwd: rootDir });
start('web', bin('next'), ['dev', '--hostname', '127.0.0.1', '--port', '3000'], {
  cwd: path.join(rootDir, 'apps', 'web'),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
console.log('dev: starting… open http://localhost:3000 (Ctrl+C stops the website and the API).');
