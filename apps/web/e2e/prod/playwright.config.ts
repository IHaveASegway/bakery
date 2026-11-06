// prod-smoke: the smoke table of docs/delivery.md ("Smoke checks"), through both hostnames, run by
// the `prod-smoke` job after `deploy` or `rollback`. It refuses to start unless it is told where
// it points: SMOKE_TARGET=production (the job), or SMOKE_LOCAL=1, which e2e/run.mjs sets to
// rehearse it against wrangler dev (E2E_SUITE=prod-smoke pnpm --filter web e2e), with the same
// host mapping as the e2e suite so nothing leaves the machine.
import { defineConfig, devices } from '@playwright/test';

const local = process.env.SMOKE_LOCAL === '1';
if (!local && process.env.SMOKE_TARGET !== 'production') {
  throw new Error('prod-smoke: set SMOKE_TARGET=production, or run it locally through e2e/run.mjs');
}
const webPort = Number(process.env.E2E_WEB_PORT || 8797);
const apiPort = Number(process.env.E2E_API_PORT || 8798);
// prod-smoke.spec.ts waits up to SMOKE_WAIT_MS for both hostnames (two minutes, or ten on a first
// attach, Incident #41). The run gets that wait plus two minutes for the checks, and never less than
// the five minutes it always had: 5 minutes by default, 12 on a first attach.
const waitMs = Number(process.env.SMOKE_WAIT_MS || 120_000);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/prod-smoke',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalTimeout: Math.max(5 * 60_000, waitMs + 2 * 60_000),
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.SMOKE_WEB || 'https://bakery.ihaveasegway.com',
    deviceScaleFactor: 1,
    headless: true,
    ignoreHTTPSErrors: local, // wrangler dev's certificate; production's is the zone's
    trace: 'retain-on-failure',
    launchOptions: {
      args: local
        ? [
            '--no-proxy-server',
            `--host-resolver-rules=MAP bakery.ihaveasegway.com 127.0.0.1:${webPort}, MAP api.bakery.ihaveasegway.com 127.0.0.1:${apiPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
          ]
        : [],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
