#!/usr/bin/env node
// Runs the end-to-end suite the way the `e2e` job runs it (docs/delivery.md, "From launch"): both
// Workers on `wrangler dev` from the built artifacts, over local HTTPS, with the fake providers
// and the fake Stripe beside them, then Playwright against them. Chromium maps the production
// hostnames to these servers and refuses every other host, so the bytes under test keep their
// origins, cookies and CORS, and no request leaves the machine.
//
// Run:   pnpm --filter web e2e        (from anywhere; Node 22 or later)
//
// It needs the two artifacts `verify` uploads, built as `verify` builds them:
//   apps/web/dist      pnpm build
//   workers/api/dist   cd workers/api && worker-build --release && pnpm exec wrangler deploy --dry-run --outdir dist
// and Playwright's Chromium (pnpm --filter web exec playwright install chromium; the e2e job runs
// in Playwright's image, which has it). Arguments after `--` go to `playwright test`.
//
// A machine whose Chromium is another build than the one Playwright wants (a cloud session's, for
// one) can name a binary with E2E_CHROMIUM_PATH, which e2e/playwright.config.ts passes as
// launchOptions.executablePath:
//   E2E_CHROMIUM_PATH=/path/to/chrome pnpm --filter web e2e
// CI leaves it unset. A run on another build tests that build, not the lockfile's.
//
// Ports are fixed, and differ from the smoke scripts' (8787, 8788, 8790, 8791) so both can run on
// one machine: web 8797, API 8798, fake providers 8799, fake Stripe 8800, the webhook relay 8801,
// inspectors 9347 and 9348. Each can be moved with E2E_<NAME>_PORT. Every secret in the scratch
// env file is random or a documented test value, written to a temporary directory and deleted
// with it; nothing is written into the repository but Playwright's test-results/.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(WEB_DIR, '..', '..');
const port = (name, fallback) => Number(process.env[`E2E_${name}_PORT`] || fallback);
const PORTS = {
  web: port('WEB', 8797),
  api: port('API', 8798),
  providers: port('PROVIDERS', 8799),
  stripe: port('STRIPE', 8800),
  relay: port('RELAY', 8801),
  webInspector: port('WEB_INSPECTOR', 9347),
  apiInspector: port('API_INSPECTOR', 9348),
};
const FAKE = `http://127.0.0.1:${PORTS.providers}`;
// Which suite: the e2e suite (default), or prod-smoke rehearsed against these servers.
const SUITE = process.env.E2E_SUITE || 'e2e';
const CONFIGS = { e2e: 'e2e/playwright.config.ts', 'prod-smoke': 'e2e/prod/playwright.config.ts' };
const STARTUP_TIMEOUT_MS = Number(process.env.E2E_STARTUP_TIMEOUT_S || 120) * 1000;
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const PLAYWRIGHT = path.join(WEB_DIR, 'node_modules', '.bin', 'playwright');

// The fake Stripe's own test-shaped values, as scripts/fake-stripe.mjs lists them. Not secrets.
const FAKE_STRIPE = {
  key: 'rk_test_not_a_key',
  webhook: 'whsec_not_a_secret',
  publishable: 'pk_test_not_a_key',
};
// Turnstile's documented always-pass test secret (Cloudflare, "Testing"); the fake's siteverify
// checks only that one is sent.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

const started = Date.now();
const children = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'bakery-e2e-'));
let relay = null;
let failed = false;
let stopping = false;

function log(line) {
  console.log(`[e2e] ${line}`);
}

function stopAll() {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // each child leads its own process group
      } catch {
        // already gone
      }
    }
  }
  relay?.close();
}

function keepLogs() {
  const out = path.join(WEB_DIR, 'test-results', 'e2e-logs');
  mkdirSync(out, { recursive: true });
  for (const name of ['providers', 'stripe', 'api', 'web']) {
    const file = path.join(scratch, `${name}.log`);
    if (existsSync(file)) cpSync(file, path.join(out, `${name}.log`));
  }
  log(`server logs kept in ${path.relative(process.cwd(), out) || out}`);
}

function cleanUp() {
  stopAll();
  if (failed) keepLogs();
  // Give the servers a moment to let go of their state before it is deleted.
  setTimeout(() => rmSync(scratch, { recursive: true, force: true }), 500).unref();
}

function start(name, command, args, options = {}) {
  // Each child's whole output goes to its own log, kept only when the run fails.
  const out = path.join(scratch, `${name}.log`);
  writeFileSync(out, '');
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => writeFileSync(out, chunk, { flag: 'a' });
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('exit', (code, signal) => {
    if (!stopping) {
      log(`${name} exited early (${signal ?? code}); see its log`);
      failed = true;
    }
  });
  children.push(child);
  return child;
}
function portFree(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: p });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/** Resolves with the status of GET url, or null when nothing answers. Self-signed TLS is fine. */
function status(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

async function waitFor(name, url) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failed) break;
    if ((await status(url)) === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not answer 200 at ${url} within ${STARTUP_TIMEOUT_MS / 1000} s`);
}

/**
 * The fake Stripe posts webhooks over plain HTTP to a loopback host only, and the API listens on
 * HTTPS here, so this relays each delivery to it unchanged: method, path, headers and body.
 */
function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const upstream = https.request(
        {
          host: '127.0.0.1',
          port: PORTS.api,
          method: req.method,
          path: req.url,
          headers: req.headers,
          rejectUnauthorized: false,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    server.listen(PORTS.relay, '127.0.0.1', () => resolve(server));
  });
}

function writeEnvFile() {
  const random = () => randomBytes(36).toString('base64url');
  const lines = [
    '# Written by apps/web/e2e/run.mjs for one run, in a temporary directory; deleted when it ends.',
    `SESSION_HMAC_KEY=${random()}`,
    `ACCOUNT_HMAC_KEY=${random()}`,
    `TURNSTILE_SECRET=${TURNSTILE_TEST_SECRET}`,
    `TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:${PORTS.providers}/turnstile/siteverify`,
    // The fake providers' own client ids and secrets (scripts/fake-providers.mjs), not secrets.
    `GOOGLE_ISSUER=${FAKE}/google`,
    `GITHUB_AUTHORIZE_URL=${FAKE}/github/login/oauth/authorize`,
    `GITHUB_TOKEN_URL=${FAKE}/github/login/oauth/access_token`,
    `GITHUB_USER_URL=${FAKE}/github/user`,
    'GOOGLE_CLIENT_ID=fake-google-client',
    'GOOGLE_CLIENT_SECRET=fake-google-client-secret',
    'GITHUB_CLIENT_ID=fake-github-client',
    'GITHUB_CLIENT_SECRET=fake-github-client-secret',
    // The production origins: Chromium maps both hostnames to the servers below.
    'ALLOWED_ORIGIN=https://bakery.ihaveasegway.com',
    'API_ORIGIN=https://api.bakery.ihaveasegway.com',
    `STRIPE_API_BASE=http://127.0.0.1:${PORTS.stripe}`,
    `STRIPE_SECRET_KEY=${FAKE_STRIPE.key}`,
    `STRIPE_WEBHOOK_SECRET=${FAKE_STRIPE.webhook}`,
    `STRIPE_PUBLISHABLE_KEY=${FAKE_STRIPE.publishable}`,
  ];
  const file = path.join(scratch, 'api.env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

async function main() {
  if (!CONFIGS[SUITE]) throw new Error(`E2E_SUITE is ${SUITE}; it is e2e or prod-smoke`);
  for (const [what, file] of [
    ['the storefront build (pnpm build)', path.join(WEB_DIR, 'dist', 'index.html')],
    [
      'the API bundle (wrangler deploy --dry-run --outdir dist)',
      path.join(ROOT, 'workers/api/dist/shim.js'),
    ],
    ['Wrangler (pnpm install)', WRANGLER],
    ['Playwright (pnpm install)', PLAYWRIGHT],
  ]) {
    if (!existsSync(file)) throw new Error(`missing ${what}: ${path.relative(ROOT, file)}`);
  }
  for (const [name, p] of Object.entries(PORTS)) {
    if (!(await portFree(p)))
      throw new Error(`port ${p} (${name}) is taken; stop it or set E2E_*_PORT`);
  }

  // The API runs its scanned bundle: the config that deploy uploads it with, no build, no bundling.
  await new Promise((resolve, reject) => {
    const gen = spawn(process.execPath, [path.join(ROOT, 'scripts/api-deploy-config.mjs')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    gen.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('api-deploy-config failed')),
    );
  });
  const envFile = writeEnvFile();

  log('starting the fake providers, the fake Stripe and the webhook relay');
  start('providers', process.execPath, [
    path.join(ROOT, 'scripts/fake-providers.mjs'),
    '--port',
    String(PORTS.providers),
  ]);
  start(
    'stripe',
    process.execPath,
    [path.join(ROOT, 'scripts/fake-stripe.mjs'), '--port', String(PORTS.stripe)],
    { env: { FAKE_STRIPE_WEBHOOK_URL: `http://127.0.0.1:${PORTS.relay}/v1/stripe/webhook` } },
  );
  relay = await startRelay();

  const dev = (name, config, devPort, inspector, extra) => [
    'dev',
    '--config',
    config,
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(devPort),
    '--inspector-port',
    String(inspector),
    '--local-protocol',
    'https',
    '--persist-to',
    path.join(scratch, `${name}-state`),
    '--show-interactive-dev-session=false',
    ...extra,
  ];
  log('starting both Workers on wrangler dev (HTTPS, self-signed)');
  start(
    'api',
    WRANGLER,
    dev('api', 'workers/api/dist/wrangler.json', PORTS.api, PORTS.apiInspector, [
      '--env-file',
      envFile,
    ]),
    {
      env: { WRANGLER_SEND_METRICS: 'false' },
    },
  );
  start('web', WRANGLER, dev('web', 'apps/web/wrangler.jsonc', PORTS.web, PORTS.webInspector, []), {
    env: { WRANGLER_SEND_METRICS: 'false' },
  });
  await Promise.all([
    waitFor('the fake providers', `http://127.0.0.1:${PORTS.providers}/_health`),
    waitFor('the fake Stripe', `http://127.0.0.1:${PORTS.stripe}/_health`),
    waitFor('the API', `https://127.0.0.1:${PORTS.api}/v1/health`),
    waitFor('the storefront', `https://127.0.0.1:${PORTS.web}/`),
  ]);
  log(`servers ready after ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const passthrough = process.argv.slice(2).filter((a) => a !== '--');
  // No proxy reaches Playwright or its browser: every address the suite uses is on this machine.
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(name)) delete env[name];
  }
  const code = await new Promise((resolve) => {
    const pw = spawn(
      PLAYWRIGHT,
      ['test', '--config', path.join(WEB_DIR, CONFIGS[SUITE]), ...passthrough],
      {
        cwd: WEB_DIR,
        stdio: 'inherit',
        env: {
          ...env,
          E2E_WEB_PORT: String(PORTS.web),
          E2E_API_PORT: String(PORTS.api),
          E2E_STRIPE_PORT: String(PORTS.stripe),
          E2E_API_STATE: path.join(scratch, 'api-state'),
          E2E_FAKE_STRIPE_KEY: FAKE_STRIPE.key,
          // prod-smoke's rehearsal: the browser goes through the host mapping, the API calls
          // straight to wrangler dev, and the sign-in redirects end at the fake providers.
          ...(SUITE === 'prod-smoke'
            ? {
                SMOKE_LOCAL: '1',
                SMOKE_WEB_DIRECT: `https://127.0.0.1:${PORTS.web}`,
                SMOKE_API_DIRECT: `https://127.0.0.1:${PORTS.api}`,
                SMOKE_DIST: path.join(WEB_DIR, 'dist'),
                SMOKE_GOOGLE_AUTHORIZE: `${FAKE}/google/authorize`,
                SMOKE_GITHUB_AUTHORIZE: `${FAKE}/github/login/oauth/authorize`,
              }
            : {}),
        },
      },
    );
    pw.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  log(
    `playwright exited ${code}; the whole run took ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return code;
}

process.on('SIGINT', () => {
  stopping = true;
  cleanUp();
  process.exit(130);
});

main().then(
  (code) => {
    stopping = true;
    failed = failed || code !== 0;
    cleanUp();
    process.exitCode = code;
  },
  (e) => {
    stopping = true;
    failed = true;
    console.error(`[e2e] ${e.message}`);
    cleanUp();
    process.exitCode = 1;
  },
);
