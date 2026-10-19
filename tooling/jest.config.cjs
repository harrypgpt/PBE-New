/** Guardrail self-tests (plain CommonJS, no transform). @type {import('jest').Config} */
module.exports = {
  displayName: 'tooling',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.cjs'],
  transform: {},
};
