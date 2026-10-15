/** Root Jest configuration: runs every workspace's tests in one command (`npm test`). */
/** @type {import('jest').Config} */
module.exports = {
  projects: [
    '<rootDir>/packages/contracts',
    '<rootDir>/apps/api',
    '<rootDir>/apps/web',
    '<rootDir>/tooling',
  ],
};
