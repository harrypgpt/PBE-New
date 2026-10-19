/** Migration runner unit tests (no database). @type {import('jest').Config} */
module.exports = {
  displayName: 'migrate (unit)',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
};
