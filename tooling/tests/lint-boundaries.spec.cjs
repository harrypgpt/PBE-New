'use strict';

// Runs the real ESLint CLI with the real repository config against in-memory files, proving the
// architecture rules are wired up (roadmap S1 criterion 3).
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

function lint(file, code) {
  const result = spawnSync(
    process.execPath,
    [eslintBin, '--stdin', '--stdin-filename', file, '--format', 'json'],
    { cwd: root, input: code, encoding: 'utf8' },
  );
  if (!result.stdout) throw new Error(`ESLint produced no output: ${result.stderr}`);
  return JSON.parse(result.stdout)[0].messages.map((m) => m.ruleId);
}

const MOD = 'apps/api/src/modules';

describe('module boundary lint rule (MODULE_BOUNDARIES.md)', () => {
  test('rejects an upward import (tier 1 identity -> tier 2 projects)', () => {
    const rules = lint(
      `${MOD}/identity/identity.service.ts`,
      "import { x } from '../projects/projects.service';\nexport { x };\n",
    );
    expect(rules).toContain('pbe/module-boundaries');
  });

  test('rejects a tier-6 import from a tier-4 module (runs -> reporting)', () => {
    const rules = lint(
      `${MOD}/runs/runs.service.ts`,
      "export * from '../reporting/report.service';\n",
    );
    expect(rules).toContain('pbe/module-boundaries');
  });

  test('rejects an unlisted same-tier import (projects -> reference-data)', () => {
    const rules = lint(
      `${MOD}/projects/projects.service.ts`,
      "import { x } from '../reference-data/drugs';\nexport { x };\n",
    );
    expect(rules).toContain('pbe/module-boundaries');
  });

  test('rejects imports from unregistered modules', () => {
    const rules = lint(
      `${MOD}/projects/projects.service.ts`,
      "import { x } from '../made-up/thing';\nexport { x };\n",
    );
    expect(rules).toContain('pbe/module-boundaries');
  });

  test('allows a downward import (projects -> identity)', () => {
    const rules = lint(
      `${MOD}/projects/projects.service.ts`,
      "import { x } from '../identity/identity.service';\nexport { x };\n",
    );
    expect(rules).not.toContain('pbe/module-boundaries');
  });

  test('allows a listed same-tier import (next-best-action -> risk-fingerprint)', () => {
    const rules = lint(
      `${MOD}/insights/next-best-action/nba.engine.ts`,
      "import { x } from '../risk-fingerprint/rf.engine';\nexport { x };\n",
    );
    expect(rules).not.toContain('pbe/module-boundaries');
  });

  test('allows imports within one module', () => {
    const rules = lint(
      `${MOD}/runs/runs.service.ts`,
      "import { x } from './runs.repository';\nexport { x };\n",
    );
    expect(rules).not.toContain('pbe/module-boundaries');
  });
});

describe('cross-application and purity rules', () => {
  test('the web app may not import backend code', () => {
    const rules = lint(
      'apps/web/src/app/page.tsx',
      "import { AppModule } from '../../../api/src/app.module';\nexport { AppModule };\n",
    );
    expect(rules).toContain('pbe/no-cross-app-imports');
  });

  test('the API may not import frontend code', () => {
    const rules = lint(
      'apps/api/src/main.ts',
      "import Page from '../../web/src/app/page';\nexport { Page };\n",
    );
    expect(rules).toContain('pbe/no-cross-app-imports');
  });

  test('the web app may not import the API by package name', () => {
    const rules = lint('apps/web/src/app/page.tsx', "import x from '@pbe/api';\nexport { x };\n");
    expect(rules).toContain('no-restricted-imports');
  });

  test('shared packages may not import application code', () => {
    const rules = lint(
      'packages/contracts/src/x.ts',
      "import { configureApp } from '../../../apps/api/src/configure-app';\nexport { configureApp };\n",
    );
    expect(rules).toContain('pbe/no-cross-app-imports');
  });

  test('science-core may not import I/O modules', () => {
    const rules = lint(
      'packages/science-core/src/x.ts',
      "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  test('science-core may not read the clock or use unseeded randomness', () => {
    const rules = lint(
      'packages/science-core/src/x.ts',
      'export const t = new Date();\nexport const r = Math.random();\n',
    );
    expect(rules).toEqual(
      expect.arrayContaining(['no-restricted-globals', 'no-restricted-properties']),
    );
  });

  test('clean code produces no findings', () => {
    expect(
      lint(
        'packages/science-core/src/x.ts',
        'export const add = (a: number, b: number): number => a + b;\n',
      ),
    ).toEqual([]);
  });
});
