// The end-to-end suite's configuration (docs/delivery.md, the `e2e` row). Run it with
// `pnpm --filter web e2e`, which starts the servers first (e2e/run.mjs); this file alone starts
// nothing. Headless Chromium at the lockfile's Playwright, one worker, because the specs share
// one API and its per-IP limits, and the nightly wipe in wipe.spec.ts wipes every sandbox.
import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.E2E_WEB_PORT || 8797);
const apiPort = Number(process.env.E2E_API_PORT || 8798);

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
  // The suite's budget (docs/roadmap.md, PR 11 prep): the whole run stays under five minutes.
  globalTimeout: 5 * 60_000,
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
