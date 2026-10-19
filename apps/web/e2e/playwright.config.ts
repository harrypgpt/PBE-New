import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests (ADR-015): a real Chromium against the PRODUCTION build of the website
 * (`next start`), which forwards /api/v1 to a real API on 127.0.0.1:3001 connected to the real
 * PostgreSQL test database (pbe_test, as pbe_app). The tests start and stop the API themselves
 * (e2e/api-server.ts) so the "API unreachable" case is real.
 * Prerequisite: `npm run build` (verify does this first).
 */
const WEB_DIR = path.join(__dirname, '..');

export default defineConfig({
  testDir: __dirname,
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: path.join(WEB_DIR, 'test-results'),
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3000',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run start',
    cwd: WEB_DIR,
    url: 'http://127.0.0.1:3000/',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { PBE_WEB_SHOWCASE: '1', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
