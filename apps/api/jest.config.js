/** @type {import('jest').Config} */
module.exports = {
  displayName: 'api',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  // Tests use the shared package's source so they do not depend on a prior build;
  // the production builds verify consumption of the compiled package.
  moduleNameMapper: { '^@pbe/contracts$': '<rootDir>/../../packages/contracts/src/index.ts' },
};
