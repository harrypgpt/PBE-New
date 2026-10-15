'use strict';

const {
  findPythonFiles,
  findPrismaFiles,
  findPrismaInManifest,
  analyzeLockfile,
  packageNameFromLockKey,
} = require('../scripts/lib/toolchain.cjs');

describe('Python detection', () => {
  test('flags Python sources and environment files', () => {
    const files = [
      'tools/train.py',
      'requirements.txt',
      'ml/requirements-dev.txt',
      'pyproject.toml',
      'Pipfile',
      'setup.py',
      '.python-version',
      'notebook.ipynb',
      'apps/api/src/main.ts',
    ];
    expect(findPythonFiles(files)).toEqual(files.slice(0, -1));
  });

  test('does not flag ordinary project files', () => {
    expect(
      findPythonFiles([
        'apps/web/src/app/page.tsx',
        'README.md',
        'package.json',
        'copy.pyramid.ts',
      ]),
    ).toEqual([]);
  });
});

describe('Prisma detection', () => {
  test('flags Prisma schema files', () => {
    expect(findPrismaFiles(['db/schema.prisma', 'db/schema.sql'])).toEqual(['db/schema.prisma']);
  });

  test('flags Prisma dependencies and scripts in package.json', () => {
    const problems = findPrismaInManifest({
      dependencies: { '@prisma/client': '6.0.0' },
      devDependencies: { prisma: '6.0.0' },
      scripts: { migrate: 'prisma migrate deploy', build: 'tsc' },
    });
    expect(problems).toEqual([
      'dependencies: @prisma/client',
      'devDependencies: prisma',
      'script "migrate" runs prisma',
    ]);
  });

  test('accepts a clean manifest', () => {
    expect(
      findPrismaInManifest({ dependencies: { zod: '4.0.0' }, scripts: { build: 'tsc' } }),
    ).toEqual([]);
  });
});

describe('lockfile analysis', () => {
  test('extracts package names from nested lockfile keys', () => {
    expect(packageNameFromLockKey('node_modules/a/node_modules/@scope/b')).toBe('@scope/b');
    expect(packageNameFromLockKey('apps/api')).toBeUndefined();
  });

  test('flags Prisma, native-build tools and unapproved install scripts', () => {
    const lock = {
      packages: {
        '': {},
        'apps/api': {},
        'node_modules/@prisma/client': {},
        'node_modules/node-gyp': {},
        'node_modules/x/node_modules/prebuild-install': {},
        'node_modules/native-thing': { hasInstallScript: true },
        'node_modules/approved-thing': { hasInstallScript: true },
        'node_modules/zod': {},
      },
    };
    const result = analyzeLockfile(lock, {
      installScripts: { 'approved-thing': 'prebuilt binaries only' },
    });
    expect(result).toEqual({
      prisma: ['node_modules/@prisma/client'],
      nativeBuildTools: ['node_modules/node-gyp', 'node_modules/x/node_modules/prebuild-install'],
      installScripts: ['node_modules/native-thing'],
    });
  });
});
