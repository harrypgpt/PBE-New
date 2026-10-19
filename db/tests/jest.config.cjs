/**
 * Database integration tests on REAL PostgreSQL 18 (ADR-003). They run in pbe_test (ADR-020),
 * read pbe_dev only inside READ ONLY transactions, restore backups into temporary
 * pbe_restore_check_<hex> databases they create and drop themselves, and run superuser and
 * teardown tests only on a private throw-away PostgreSQL instance.
 * kysely is ES-module-only, so ts-jest also transpiles it for tests (see apps/api/jest.config.cjs).
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: 'database (PostgreSQL 18)',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.db.spec.ts'],
  testTimeout: 60000,
  transform: { '^.+\\.[jt]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }] },
  moduleNameMapper: { '^@pbe/contracts$': '<rootDir>/../../packages/contracts/src/index.ts' },
  transformIgnorePatterns: ['/node_modules/(?!kysely/)'],
};
