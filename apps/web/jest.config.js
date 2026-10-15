/** @type {import('jest').Config} */
module.exports = {
  displayName: 'web',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }] },
  moduleNameMapper: { '^@pbe/contracts$': '<rootDir>/../../packages/contracts/src/index.ts' },
};
