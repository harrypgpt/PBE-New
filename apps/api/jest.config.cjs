/**
 * kysely 0.29 is published as an ES module only. Production code loads it natively (Node 24
 * require(esm)); Jest's module loader cannot, so for tests only, ts-jest also transpiles kysely's
 * JavaScript to CommonJS. Nothing else in node_modules is transformed.
 * Tests use the shared contracts' TypeScript sources directly (no build needed).
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: '@pbe/api',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  testTimeout: 60000,
  transform: { '^.+\\.[jt]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }] },
  moduleNameMapper: { '^@pbe/contracts$': '<rootDir>/../../packages/contracts/src/index.ts' },
  transformIgnorePatterns: ['/node_modules/(?!kysely/)'],
};
