// The end-to-end suite's configuration (docs/delivery.md, the `e2e` row). Run it with
// `pnpm --filter web e2e`, which starts the servers first (e2e/run.mjs); this file alone starts
// nothing. Headless Chromium at the lockfile's Playwright, one worker, because the specs share
// one API and its per-IP limits, and the nightly wipe in wipe.spec.ts wipes every sandbox.
import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.E2E_WEB_PORT || 8797);
const apiPort = Number(process.env.E2E_API_PORT || 8798);
// A Chromium binary to launch instead of the one the lockfile's Playwright downloads, for a
// machine that has another build (e2e/run.mjs's header). Unset in CI: its image has the match.
const chromiumPath = process.env.E2E_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  testIgnore: 'prod/**', // prod-smoke has its own config, e2e/prod/playwright.config.ts
  outputDir: '../test-results/e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // The suite's limit. Five minutes from the PR 11 preparation until 2026-11-09, when 54 tests in
  // 16 specs needed about 5.5 minutes on a busy cloud machine (one worker, load average 4 to 6;
  // two runs stopped at 5 minutes with 42 and 50 passed and none failed), while CI ran #101's 55
  // tests in 3.4 minutes. Ten minutes leaves room for both; the e2e job's own limit is 20 minutes
  // (.github/workflows/ci.yml). docs/delivery.md, "The e2e suite".
  globalTimeout: 10 * 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'https://bakery.ihaveasegway.com',
    deviceScaleFactor: 1,
    headless: true,
    // wrangler dev's certificate is self-signed; the hostnames below never reach the internet.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: [
        // Never a proxy, even when the environment names one: a proxy resolves names itself, so
        // the rules below would not apply and a page could reach the real hostnames.
        '--no-proxy-server',
        // Both production hostnames go to wrangler dev, and every other name fails to resolve, so
        // a page can reach nothing but the two Workers. 127.0.0.1 is left as it is.
        `--host-resolver-rules=MAP bakery.ihaveasegway.com 127.0.0.1:${webPort}, MAP api.bakery.ihaveasegway.com 127.0.0.1:${apiPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
