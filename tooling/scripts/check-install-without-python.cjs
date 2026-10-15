'use strict';

// Proves that a clean `npm ci` succeeds with NO Python interpreter reachable (ADR-022).
// It copies the manifests and lockfile into a temporary directory, builds a PATH that contains
// every system tool except python*/pip*, confirms Python is really unreachable, then installs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-no-python-'));
const shim = path.join(work, 'bin');
const project = path.join(work, 'project');
fs.mkdirSync(shim);
fs.mkdirSync(project);

const SOURCE_DIRS = [
  path.dirname(process.execPath),
  ...(process.env.PATH || '').split(path.delimiter),
];
const HIDDEN = /^(python|pip|py$|pydoc|idle|2to3)/i;
let linked = 0;
for (const dir of SOURCE_DIRS) {
  if (!dir || !fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (HIDDEN.test(name)) continue;
    const target = path.join(shim, name);
    if (fs.existsSync(target)) continue; // first PATH entry wins, as in a normal shell
    fs.symlinkSync(path.join(dir, name), target);
    linked += 1;
  }
}

const env = { ...process.env, PATH: shim };
for (const key of Object.keys(env)) {
  if (/^(npm_config_python|PYTHON)/i.test(key)) delete env[key];
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { env, encoding: 'utf8', ...options });
}

const probe = run('/bin/sh', ['-c', 'command -v python3 || command -v python || echo NONE']);
if (probe.stdout.trim() !== 'NONE') {
  console.error(`Could not hide Python (found ${probe.stdout.trim()}). Check FAILED.`);
  process.exit(1);
}
console.log(`Python hidden: PATH has ${linked} tools, none named python*/pip*.`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const rel of ['package.json', 'package-lock.json', '.npmrc']) {
  fs.copyFileSync(path.join(root, rel), path.join(project, rel));
}
for (const ws of manifest.workspaces) {
  fs.mkdirSync(path.join(project, ws), { recursive: true });
  fs.copyFileSync(path.join(root, ws, 'package.json'), path.join(project, ws, 'package.json'));
}

console.log(`Running clean "npm ci" in ${project} ...`);
const install = run('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], {
  cwd: project,
  stdio: 'inherit',
});
fs.rmSync(work, { recursive: true, force: true });

if (install.status !== 0) {
  console.error(`Clean install without Python FAILED (exit ${install.status}).`);
  process.exit(1);
}
console.log('Clean install without Python PASSED.');
