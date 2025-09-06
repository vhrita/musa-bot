/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: false,
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
};
