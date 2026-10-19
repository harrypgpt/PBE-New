// ESLint flat config for the PBE monorepo.
// Module-boundary and science-core purity rules implement
// docs/architecture/MODULE_BOUNDARIES.md §2, §3 and §7. Tests for these rules live in
// tooling/tests/lint-boundaries.test.cjs.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const AI_CLIENTS = {
  regex:
    '^(openai|@anthropic-ai/|@google/(generative-ai|genai)|@mistralai/|cohere-ai|ollama|@ai-sdk/|ai$|langchain|@langchain/|@huggingface/|replicate)',
  message:
    'AI client libraries may only be imported by the ai-assist module (MODULE_BOUNDARIES.md §5, ADR-009).',
};
const DATABASE_CLIENTS = {
  regex: '^(pg|kysely|postgres|mysql2?|mongodb|typeorm|sequelize|drizzle-orm|knex)(/|$)',
  message: 'Database access belongs to the API db module only (MODULE_BOUNDARIES.md §2-§3).',
};
const NODE_BUILTINS = {
  regex:
    '^(node:|(fs|path|os|net|http|https|http2|child_process|worker_threads|cluster|dgram|dns|tls|crypto|stream|zlib|readline|vm|process|url|util|events|buffer|timers|perf_hooks|async_hooks|module|inspector)(/|$))',
  message: 'This package must stay free of Node.js I/O and runtime APIs (MODULE_BOUNDARIES.md §2).',
};
// ADR-021: inside apps/api, only src/modules/db may talk to PostgreSQL or set the tenant context.
const DB_DRIVERS_OUTSIDE_GATEWAY = {
  regex: '^(kysely|pg|pg-[a-z-]+|postgres)(/|$)',
  message:
    'Use the data-access layer (apps/api/src/modules/db) — direct database access bypasses tenant context (ADR-021).',
};
const TENANT_CONTEXT_PATTERN = '/set_config|app\\.tenant_id|app\\.user_id/i';
const TENANT_CONTEXT_OUTSIDE_GATEWAY = [
  {
    selector: `Literal[value=${TENANT_CONTEXT_PATTERN}]`,
    message:
      'Tenant context may only be set by withTenantTransaction in apps/api/src/modules/db (ADR-021).',
  },
  {
    selector: `TemplateElement[value.raw=${TENANT_CONTEXT_PATTERN}]`,
    message:
      'Tenant context may only be set by withTenantTransaction in apps/api/src/modules/db (ADR-021).',
  },
];
const otherWorkspaces = (...names) => ({
  regex: `^@pbe/(${names.join('|')})(/|$)`,
  message: 'Forbidden workspace dependency direction (MODULE_BOUNDARIES.md §2).',
});
const relativeInto = (...folders) => ({
  regex: `(^|/)(${folders.join('|')})/`,
  message: 'Do not reach into another workspace with a relative path; use its package name.',
});
const restrict = (...patterns) => ['error', { patterns }];

const TS_FILES = '**/*.ts';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.next/**', '**/out/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { files: ['**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  { files: ['tooling/tests/**'], languageOptions: { globals: { ...globals.jest } } },

  // apps/web: UI only. Talks to the API through contracts; never to the DB or science-core.
  {
    files: [`apps/web/${TS_FILES}`, 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('api', 'science-core'),
        relativeInto('apps', 'packages', 'api', 'science-core', 'contracts'),
        DATABASE_CLIENTS,
        AI_CLIENTS,
      ),
    },
  },

  // apps/api: may use contracts and science-core; never the web app; AI only in ai-assist;
  // PostgreSQL only through the data-access layer in src/modules/db (ADR-021).
  {
    files: [`apps/api/${TS_FILES}`],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('web'),
        relativeInto('apps', 'packages', 'web', 'science-core', 'contracts'),
        AI_CLIENTS,
        DB_DRIVERS_OUTSIDE_GATEWAY,
      ),
      'no-restricted-syntax': ['error', ...TENANT_CONTEXT_OUTSIDE_GATEWAY],
    },
  },
  {
    files: [`apps/api/src/modules/ai-assist/${TS_FILES}`],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('web'),
        relativeInto('apps', 'packages', 'web', 'science-core', 'contracts'),
        DB_DRIVERS_OUTSIDE_GATEWAY,
      ),
    },
  },
  {
    files: [`apps/api/src/modules/db/${TS_FILES}`],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('web'),
        relativeInto('apps', 'packages', 'web', 'science-core', 'contracts'),
        AI_CLIENTS,
      ),
      'no-restricted-syntax': 'off',
    },
  },

  // packages/contracts: schemas only (zod). No other PBE package, no I/O.
  {
    files: [`packages/contracts/${TS_FILES}`],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('web', 'api', 'science-core'),
        relativeInto('apps', 'packages', 'web', 'api', 'science-core'),
        NODE_BUILTINS,
        DATABASE_CLIENTS,
        AI_CLIENTS,
      ),
    },
  },

  // packages/science-core: pure, deterministic functions. No I/O, clock, randomness, DB or AI.
  {
    files: [`packages/science-core/${TS_FILES}`],
    rules: {
      'no-restricted-imports': restrict(
        otherWorkspaces('web', 'api', 'contracts'),
        relativeInto('apps', 'packages', 'web', 'api', 'contracts'),
        NODE_BUILTINS,
        DATABASE_CLIENTS,
        AI_CLIENTS,
      ),
      'no-restricted-globals': [
        'error',
        ...['fetch', 'process', 'require', 'crypto', 'XMLHttpRequest', 'WebSocket'].map((name) => ({
          name,
          message: 'science-core must not perform I/O or use runtime state; pass values in.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Pass time in as an argument.' },
        { object: 'Math', property: 'random', message: 'Use a seeded generator passed in.' },
        { object: 'performance', property: 'now', message: 'Pass time in as an argument.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() reads the clock; pass time in as an argument.',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic import is not allowed in science-core.',
        },
      ],
    },
  },
);
