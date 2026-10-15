/** Tests for the repository tooling (lint rules, toolchain and secret checks). Plain CommonJS. */
/** @type {import('jest').Config} */
module.exports = {
  displayName: 'tooling',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.spec.cjs'],
  moduleFileExtensions: ['js', 'cjs', 'json'],
  transform: {},
};
