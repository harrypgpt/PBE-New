/**
 * Web unit and component tests (ADR-015: Jest + React Testing Library). Component tests run in
 * jsdom; files that need Node APIs (fetch Response, the file system) opt into the node
 * environment with a docblock. Browser-level tests live in e2e/ and run with Playwright.
 * Tests use the shared contracts' TypeScript sources directly (no build needed).
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: '@pbe/web',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.spec.tsx'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }] },
  moduleNameMapper: {
    '^@pbe/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '\\.module\\.css$': '<rootDir>/test/support/css-module.cjs',
    '\\.css$': '<rootDir>/test/support/empty.cjs',
  },
};
