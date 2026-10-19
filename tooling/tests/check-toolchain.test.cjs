'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateToolchain } = require('../scripts/check-toolchain.cjs');

const GOOD = {
  nodeVersion: 'v24.21.0',
  npmVersion: '11.19.0',
  nvmrc: '24.21.0\n',
  enginesNode: '>=24.21.0 <25',
};

describe('toolchain check — passing cases', () => {
  test('the pinned version passes', () => {
    expect(evaluateToolchain(GOOD)).toEqual([]);
  });

  test('a newer Node 24 patch/minor passes', () => {
    expect(evaluateToolchain({ ...GOOD, nodeVersion: 'v24.22.1' })).toEqual([]);
  });

  test('the real environment passes the CLI check', () => {
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'check-toolchain.cjs')],
      {
        encoding: 'utf8',
      },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('toolchain check — failing cases', () => {
  test.each([
    ['older Node 24', { nodeVersion: 'v24.20.0' }],
    ['Node 22', { nodeVersion: 'v22.12.0' }],
    ['Node 25', { nodeVersion: 'v25.0.0' }],
    ['npm 10', { npmVersion: '10.9.2' }],
    ['engines not matching .nvmrc', { enginesNode: '>=24' }],
    ['.nvmrc without an exact version', { nvmrc: '24\n' }],
  ])('%s is rejected', (_name, change) => {
    expect(evaluateToolchain({ ...GOOD, ...change }).length).toBeGreaterThan(0);
  });
});
