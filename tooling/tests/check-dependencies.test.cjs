'use strict';
const path = require('node:path');
const { checkDependencies } = require('../scripts/check-dependencies.cjs');
const { makeRepo, cleanupRepos } = require('./helpers/fixture-repo.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');

function lockWith(packages) {
  const entries = { '': { name: 'fixture' } };
  for (const [key, meta] of Object.entries(packages)) entries[key] = { version: '1.0.0', ...meta };
  return { name: 'fixture', lockfileVersion: 3, packages: entries };
}

function cleanRepo(overrides = {}) {
  return {
    'package.json': {
      name: 'fixture',
      workspaces: ['apps/*'],
      devDependencies: { jest: '30.0.0' },
    },
    'package-lock.json': lockWith({ 'node_modules/jest': {} }),
    'apps/web/package.json': { name: '@fixture/web', dependencies: { zod: '4.0.0' } },
    'src/index.ts': 'export const x = 1;\n',
    ...overrides,
  };
}

const rulesOf = (dir) => checkDependencies(dir).map((f) => f.rule);

afterAll(cleanupRepos);

describe('dependency guard — passing cases', () => {
  test('the real PBE repository passes', () => {
    expect(checkDependencies(REPO_ROOT)).toEqual([]);
  });

  test('a clean fixture passes', () => {
    expect(checkDependencies(makeRepo(cleanRepo()))).toEqual([]);
  });

  test('similar-looking but allowed names pass (prismjs, typescript, argparse, pg)', () => {
    const dir = makeRepo(
      cleanRepo({
        'package.json': {
          name: 'fixture',
          dependencies: { prismjs: '1.0.0', typescript: '6.0.0', argparse: '2.0.0', pg: '8.0.0' },
        },
      }),
    );
    expect(checkDependencies(dir)).toEqual([]);
  });

  test('an install script explicitly denied in allowScripts passes', () => {
    const dir = makeRepo(
      cleanRepo({
        'package.json': { name: 'fixture', allowScripts: { watcher: false } },
        'package-lock.json': lockWith({ 'node_modules/watcher': { hasInstallScript: true } }),
      }),
    );
    expect(checkDependencies(dir)).toEqual([]);
  });
});

describe('dependency guard — failing cases', () => {
  test.each([
    ['prisma', 'prisma'],
    ['@prisma/client', 'prisma'],
    ['drizzle-kit', 'schema-sync'],
    ['sqlite3', 'sqlite-or-in-memory-db'],
    ['better-sqlite3', 'sqlite-or-in-memory-db'],
    ['pg-mem', 'sqlite-or-in-memory-db'],
    ['@electric-sql/pglite', 'sqlite-or-in-memory-db'],
    ['python-shell', 'python'],
    ['pyodide', 'python'],
    ['node-gyp', 'python'],
    ['ioredis', 'unapproved-infrastructure'],
  ])('direct dependency %s is rejected as %s', (name, rule) => {
    const dir = makeRepo(
      cleanRepo({ 'package.json': { name: 'fixture', devDependencies: { [name]: '1.0.0' } } }),
    );
    expect(rulesOf(dir)).toContain(rule);
  });

  test('a prohibited package in a workspace manifest is rejected', () => {
    const dir = makeRepo(
      cleanRepo({
        'apps/api/package.json': {
          name: '@fixture/api',
          dependencies: { '@prisma/client': '6.0.0' },
        },
      }),
    );
    expect(rulesOf(dir)).toContain('prisma');
  });

  test('a prohibited transitive package in the lockfile is rejected', () => {
    const dir = makeRepo(
      cleanRepo({
        'package-lock.json': lockWith({
          'node_modules/jest': {},
          'node_modules/jest/node_modules/sqlite3': {},
        }),
      }),
    );
    expect(rulesOf(dir)).toContain('sqlite-or-in-memory-db');
  });

  test.each([
    ['python3 tools/build.py', 'python'],
    ['pip install -r requirements.txt', 'python'],
    ['prisma migrate dev', 'schema-sync'],
    ['drizzle-kit push', 'schema-sync'],
  ])('script "%s" is rejected as %s', (command, rule) => {
    const dir = makeRepo(
      cleanRepo({ 'package.json': { name: 'fixture', scripts: { x: command } } }),
    );
    expect(rulesOf(dir)).toContain(rule);
  });

  test.each([
    'tools/analysis.py',
    'requirements.txt',
    'pyproject.toml',
    'notebooks/model.ipynb',
    'Pipfile',
  ])('Python project file %s is rejected', (file) => {
    const dir = makeRepo(cleanRepo({ [file]: 'x' }));
    expect(rulesOf(dir)).toContain('python');
  });

  test('a missing lockfile is rejected', () => {
    const files = cleanRepo();
    delete files['package-lock.json'];
    expect(rulesOf(makeRepo(files))).toContain('lockfile');
  });

  test('an install script without an allowScripts decision is rejected', () => {
    const dir = makeRepo(
      cleanRepo({
        'package-lock.json': lockWith({ 'node_modules/native': { hasInstallScript: true } }),
      }),
    );
    expect(rulesOf(dir)).toContain('install-script');
  });

  test('an allowed node-gyp install script is rejected (node-gyp needs Python)', () => {
    const dir = makeRepo(
      cleanRepo({
        'package.json': { name: 'fixture', allowScripts: { native: true } },
        'package-lock.json': lockWith({ 'node_modules/native': { hasInstallScript: true } }),
        'node_modules/native/package.json': {
          name: 'native',
          scripts: { install: 'node-gyp rebuild' },
        },
      }),
    );
    expect(rulesOf(dir)).toContain('python');
  });
});
