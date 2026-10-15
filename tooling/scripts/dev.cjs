'use strict';

// Starts the local development environment: API (rebuilt and restarted on change) + web app.
// Stop everything with Ctrl+C.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const api = path.join(root, 'apps', 'api');

for (const script of ['build:packages', 'build:api']) {
  const { status } = spawnSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}

const children = [
  spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    cwd: api,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'dist/main.js'], {
    cwd: api,
    stdio: 'inherit',
  }),
  spawn('npm', ['run', 'dev', '-w', '@pbe/web'], { cwd: root, stdio: 'inherit' }),
];

console.log(
  '\nPBE dev: web http://localhost:3000 · API http://127.0.0.1:4000/health/live · Ctrl+C to stop\n',
);

function stop() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
