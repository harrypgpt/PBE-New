// ESLint flat config for the whole monorepo. Rules here enforce the architecture, not style;
// formatting is Prettier's job.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import pbe from './tooling/eslint-plugin-pbe/index.cjs';

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const IO_MODULES = [
  'node:*',
  'fs',
  'fs/*',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'child_process',
  'cluster',
  'worker_threads',
  'os',
  'readline',
  'repl',
  'vm',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.next/',
      '**/coverage/',
      '**/next-env.d.ts',
      'docs/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: nodeGlobals },
  },
  // Relative imports may not cross from one app into another, or from a package into an app.
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    plugins: { pbe },
    rules: { 'pbe/no-cross-app-imports': 'error' },
  },
  {
    files: ['tooling/tests/**/*.cjs'],
    languageOptions: {
      globals: { describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly' },
    },
  },

  // Backend: enforce module tiers; never import frontend code.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'pbe/module-boundaries': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '@pbe/web'],
              message: 'The API must not import frontend code.',
            },
          ],
        },
      ],
    },
  },

  // Frontend: UI only; never import backend code.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    settings: { next: { rootDir: 'apps/web/' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/api/**', '@pbe/api'],
              message:
                'The web app must not import backend code; use the API through @pbe/contracts.',
            },
          ],
        },
      ],
    },
  },

  // Shared packages never depend on applications.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**', '@pbe/api', '@pbe/web'],
              message: 'Packages must not import applications.',
            },
          ],
        },
      ],
    },
  },

  // science-core: pure and I/O-free (ADR-008). No I/O, clock, network or unseeded randomness.
  {
    files: ['packages/science-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: IO_MODULES, message: 'science-core must stay I/O-free (ADR-008).' },
            {
              group: ['**/apps/**', '@pbe/*'],
              message: 'science-core must not depend on applications or other packages.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'No clock access in science-core (ADR-008); pass times in as inputs.',
        },
        { name: 'fetch', message: 'No network access in science-core (ADR-008).' },
        { name: 'process', message: 'No environment access in science-core (ADR-008).' },
        { name: 'performance', message: 'No clock access in science-core (ADR-008).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use a seeded RNG passed in as input (reproducibility).',
        },
      ],
    },
  },
);
