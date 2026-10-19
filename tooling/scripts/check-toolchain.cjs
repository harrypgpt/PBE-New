'use strict';
// Toolchain check (ADR-016). Node.js must be the pinned major (24) and at least the exact
// version in .nvmrc; package.json "engines" must agree with .nvmrc; npm must be >= 11.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REQUIRED_NPM_MAJOR = 11;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Pure evaluation so it can be tested with any versions. Returns a list of problems. */
function evaluateToolchain({ nodeVersion, npmVersion, nvmrc, enginesNode }) {
  const problems = [];
  const pinned = parseVersion(nvmrc);
  const node = parseVersion(nodeVersion);
  const npm = parseVersion(npmVersion);
  if (!pinned) {
    problems.push(
      `.nvmrc must contain an exact version such as 24.21.0 (found "${String(nvmrc).trim()}").`,
    );
    return problems;
  }
  const expectedEngines = `>=${pinned.join('.')} <${pinned[0] + 1}`;
  if (enginesNode !== expectedEngines) {
    problems.push(
      `package.json engines.node is "${enginesNode}" but must be "${expectedEngines}" to match .nvmrc.`,
    );
  }
  if (!node) {
    problems.push(`Could not read the Node.js version ("${nodeVersion}").`);
  } else if (node[0] !== pinned[0] || compare(node, pinned) < 0) {
    problems.push(
      `Node.js ${node.join('.')} is not supported; use Node.js ${pinned.join('.')} (any ${pinned[0]}.x at or above it).`,
    );
  }
  if (!npm) {
    problems.push(`Could not read the npm version ("${npmVersion}").`);
  } else if (npm[0] < REQUIRED_NPM_MAJOR) {
    problems.push(
      `npm ${npm.join('.')} is too old; npm ${REQUIRED_NPM_MAJOR} or newer is required.`,
    );
  }
  return problems;
}

function currentNpmVersion() {
  const agent = /npm\/(\d+\.\d+\.\d+)/.exec(process.env.npm_config_user_agent || '');
  if (agent) return agent[1];
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  const rootDir = path.join(__dirname, '..', '..');
  const input = {
    nodeVersion: process.version,
    npmVersion: currentNpmVersion(),
    nvmrc: fs.readFileSync(path.join(rootDir, '.nvmrc'), 'utf8'),
    enginesNode: (
      JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).engines || {}
    ).node,
  };
  const problems = evaluateToolchain(input);
  if (problems.length === 0) {
    console.log(
      `Toolchain: PASS — Node.js ${input.nodeVersion}, npm ${input.npmVersion}, pinned ${input.nvmrc.trim()}.`,
    );
    return 0;
  }
  console.error('Toolchain: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { evaluateToolchain };
