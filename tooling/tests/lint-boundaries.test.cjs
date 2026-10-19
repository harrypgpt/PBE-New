'use strict';
// Proves the module-boundary and science-core purity lint rules both FAIL on forbidden code
// and PASS on allowed code (MODULE_BOUNDARIES.md §2, §5, §7).
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RESTRICTED = new Set([
  'no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
]);

// [description, file path, code, expected: 'blocked' | 'allowed']
const CASES = [
  // science-core purity
  [
    'science-core: node:fs import',
    'packages/science-core/src/p.ts',
    "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;",
    'blocked',
  ],
  [
    'science-core: bare fs import',
    'packages/science-core/src/p.ts',
    "import fs from 'fs';\nexport const r = fs;",
    'blocked',
  ],
  [
    'science-core: Date.now()',
    'packages/science-core/src/p.ts',
    'export const t = Date.now();',
    'blocked',
  ],
  [
    'science-core: new Date()',
    'packages/science-core/src/p.ts',
    'export const t = new Date();',
    'blocked',
  ],
  [
    'science-core: Math.random()',
    'packages/science-core/src/p.ts',
    'export const r = Math.random();',
    'blocked',
  ],
  [
    'science-core: fetch()',
    'packages/science-core/src/p.ts',
    "export const f = () => fetch('https://example.org');",
    'blocked',
  ],
  [
    'science-core: process.env',
    'packages/science-core/src/p.ts',
    'export const e = process.env;',
    'blocked',
  ],
  [
    'science-core: dynamic import',
    'packages/science-core/src/p.ts',
    "export const m = () => import('./other');",
    'blocked',
  ],
  [
    'science-core: database client',
    'packages/science-core/src/p.ts',
    "import { Pool } from 'pg';\nexport const p = Pool;",
    'blocked',
  ],
  [
    'science-core: AI client',
    'packages/science-core/src/p.ts',
    "import OpenAI from 'openai';\nexport const o = OpenAI;",
    'blocked',
  ],
  [
    'science-core: imports @pbe/api',
    'packages/science-core/src/p.ts',
    "import { x } from '@pbe/api';\nexport const y = x;",
    'blocked',
  ],
  [
    'science-core: relative path into apps',
    'packages/science-core/src/p.ts',
    "import { x } from '../../../apps/api/src/index';\nexport const y = x;",
    'blocked',
  ],
  [
    'science-core: pure function',
    'packages/science-core/src/p.ts',
    'export const add = (a: number, b: number): number => a + b;\nexport const epoch = new Date(0);',
    'allowed',
  ],
  // web
  [
    'web: imports science-core',
    'apps/web/src/p.ts',
    "import { x } from '@pbe/science-core';\nexport const y = x;",
    'blocked',
  ],
  [
    'web: imports api',
    'apps/web/src/p.ts',
    "import { x } from '@pbe/api';\nexport const y = x;",
    'blocked',
  ],
  [
    'web: database client',
    'apps/web/src/p.ts',
    "import { Pool } from 'pg';\nexport const p = Pool;",
    'blocked',
  ],
  [
    'web: imports contracts',
    'apps/web/src/p.ts',
    "import { x } from '@pbe/contracts';\nexport const y = x;",
    'allowed',
  ],
  // web (Stage 5): React component files (.tsx) and app/ routes follow the same rules
  [
    'web: component imports kysely',
    'apps/web/src/ui/P.tsx',
    "import { Kysely } from 'kysely';\nexport const P = () => <p>{String(Kysely)}</p>;",
    'blocked',
  ],
  [
    'web: page imports the API workspace',
    'apps/web/app/p/page.tsx',
    "import { x } from '@pbe/api';\nexport default function P() { return <p>{String(x)}</p>; }",
    'blocked',
  ],
  [
    'web: page imports science-core by relative path',
    'apps/web/app/p/page.tsx',
    "import { x } from '../../../../packages/science-core/src/index';\nexport default function P() { return <p>{String(x)}</p>; }",
    'blocked',
  ],
  [
    'web: component imports contracts',
    'apps/web/src/ui/P.tsx',
    "import { healthRoute } from '@pbe/contracts';\nexport const P = () => <p>{healthRoute.path}</p>;",
    'allowed',
  ],
  // api
  [
    'api: imports web',
    'apps/api/src/p.ts',
    "import { x } from '@pbe/web';\nexport const y = x;",
    'blocked',
  ],
  [
    'api: AI client outside ai-assist',
    'apps/api/src/modules/runs/p.ts',
    "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;",
    'blocked',
  ],
  [
    'api: AI client inside ai-assist',
    'apps/api/src/modules/ai-assist/p.ts',
    "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;",
    'allowed',
  ],
  [
    'api: imports science-core and contracts',
    'apps/api/src/p.ts',
    "import { a } from '@pbe/science-core';\nimport { b } from '@pbe/contracts';\nexport const y = [a, b];",
    'allowed',
  ],
  // contracts
  [
    'contracts: node:fs import',
    'packages/contracts/src/p.ts',
    "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;",
    'blocked',
  ],
  [
    'contracts: imports science-core',
    'packages/contracts/src/p.ts',
    "import { x } from '@pbe/science-core';\nexport const y = x;",
    'blocked',
  ],
  [
    'contracts: imports zod',
    'packages/contracts/src/p.ts',
    "import { z } from 'zod';\nexport const s = z.string();",
    'allowed',
  ],
  // apps/api data-access gateway (ADR-021)
  [
    'api: imports kysely outside the db module',
    'apps/api/src/modules/projects/p.ts',
    "import { Kysely } from 'kysely';\nexport const k = Kysely;",
    'blocked',
  ],
  [
    'api: imports pg outside the db module',
    'apps/api/src/modules/projects/p.ts',
    "import pg from 'pg';\nexport const p = pg;",
    'blocked',
  ],
  [
    'api: imports pg-pool outside the db module',
    'apps/api/src/p.ts',
    "import Pool from 'pg-pool';\nexport const p = Pool;",
    'blocked',
  ],
  [
    'api: set_config in a string outside the db module',
    'apps/api/src/modules/projects/p.ts',
    "export const q = \"select set_config('x', 'y', false)\";",
    'blocked',
  ],
  [
    'api: app.tenant_id in a template outside the db module',
    'apps/api/src/modules/projects/p.ts',
    'export const q = `SET app.tenant_id = 1`;',
    'blocked',
  ],
  [
    'api: kysely in ai-assist',
    'apps/api/src/modules/ai-assist/p.ts',
    "import { sql } from 'kysely';\nexport const s = sql;",
    'blocked',
  ],
  [
    'api: kysely and set_config inside the db module',
    'apps/api/src/modules/db/p.ts',
    "import { sql } from 'kysely';\nexport const s = sql;\nexport const q = 'set_config';",
    'allowed',
  ],
  [
    'api: importing the data-access layer',
    'apps/api/src/modules/projects/p.ts',
    "import { withTenantTransaction } from '../db';\nexport const w = withTenantTransaction;",
    'allowed',
  ],
];

let results;

beforeAll(() => {
  const probe = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'lint-probe.cjs')], {
    input: JSON.stringify(CASES.map(([, filePath, code]) => ({ filePath, code }))),
    encoding: 'utf8',
  });
  if (probe.status !== 0) throw new Error(`lint probe failed: ${probe.stderr}`);
  results = JSON.parse(probe.stdout);
}, 60000);

describe('module boundary and purity lint rules', () => {
  test.each(CASES.map((c, i) => [c[0], c[3], i]))('%s → %s', (_name, expected, index) => {
    const ruleIds = results[index].ruleIds;
    expect(ruleIds).not.toContain('parse-error');
    const restricted = ruleIds.filter((id) => RESTRICTED.has(id));
    if (expected === 'blocked') expect(restricted.length).toBeGreaterThan(0);
    else expect(restricted).toEqual([]);
  });
});
