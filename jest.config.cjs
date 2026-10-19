/**
 * Root Jest configuration (ADR-015). Each workspace and the tooling folder is a Jest project,
 * so `npm test` runs every suite and reports per-project results.
 * @type {import('jest').Config}
 */
module.exports = {
  // Test files run one at a time: the real-migrations test rebuilds pbe_test from empty, and no
  // other database test may run while it does (Stage 3).
  maxWorkers: 1,
  projects: [
    '<rootDir>/apps/web',
    '<rootDir>/apps/api',
    '<rootDir>/packages/contracts',
    '<rootDir>/packages/science-core',
    '<rootDir>/tooling',
    '<rootDir>/tooling/migrate',
    '<rootDir>/db/tests',
  ],
};
