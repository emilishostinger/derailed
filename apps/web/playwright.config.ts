import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the compiled binary, not the dev server.
 *
 * The binary embeds the SPA, so there is no Vite and no HMR to tear the page down
 * mid-assertion; it boots on a scratch data directory on a high port and serves the
 * real dashboard and the real API together, which is exactly what a user gets. These
 * cover the handful of flows that must never break, and only the ones that need no
 * Docker (onboarding, sign-in, the role boundary), so they are deterministic. Build
 * the binary first: `bun run scripts/build.ts --target=darwin-arm64 --out=dist-bin/derailed-e2e`.
 */
const PORT = 8499;

export default defineConfig({
  testDir: './e2e',
  // `.pw.ts`, deliberately not `.spec.ts` or `.test.ts`: those globs are what `bun test`
  // scans for, and it would otherwise try to run this Playwright spec as a unit test and
  // fail. This pattern is Playwright's alone.
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  // Use the system Google Chrome rather than downloading a Playwright browser, so the
  // suite runs on a fresh checkout without a separate `playwright install` step. CI
  // that wants this can install the browser instead.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    // A fresh data dir every run, so onboarding always starts from an empty machine.
    // cwd defaults to this config file's directory (apps/web), so the binary is two up.
    command: `sh -c "rm -rf /tmp/derailed-e2e-data && DERAILED_DATA=/tmp/derailed-e2e-data DERAILED_PORT=${PORT} DERAILED_HOST=127.0.0.1 ../../dist-bin/derailed-e2e serve"`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
