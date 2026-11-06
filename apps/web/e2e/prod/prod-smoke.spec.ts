// The smoke table of docs/delivery.md ("Smoke checks"), through the zone: the API's health,
// status, CORS from the storefront's origin and from another, the webhook route, the sign-in
// redirects; the storefront's headers (docs/security.md), its pages byte for byte against the
// artifact when SMOKE_DIST names it, and a page load with no CSP violation and no console error.
//
// Environment: SMOKE_WEB and SMOKE_API (the hostnames, production's by default); SMOKE_COMMIT,
// the commit /v1/health must report (left unset after a rollback); SMOKE_DIST, the web artifact.
// For a local rehearsal, e2e/run.mjs also sets SMOKE_*_DIRECT to wrangler dev's addresses, which
// the API calls use, and the provider prefixes the fake providers answer with.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';

const WEB = process.env.SMOKE_WEB || 'https://bakery.ihaveasegway.com';
const API = process.env.SMOKE_API || 'https://api.bakery.ihaveasegway.com';
const WEB_DIRECT = process.env.SMOKE_WEB_DIRECT || WEB;
const API_DIRECT = process.env.SMOKE_API_DIRECT || API;
const COMMIT = process.env.SMOKE_COMMIT || '';
const DIST = process.env.SMOKE_DIST || '';
const GOOGLE_AUTHORIZE = process.env.SMOKE_GOOGLE_AUTHORIZE || 'https://accounts.google.com/';
const GITHUB_AUTHORIZE =
  process.env.SMOKE_GITHUB_AUTHORIZE || 'https://github.com/login/oauth/authorize';
const OTHER_ORIGIN = 'https://example.com';
const WAIT_MS = 120_000;

const PAGES = [
  '/',
  '/menu/',
  '/catering/',
  '/checkout/',
  '/privacy/',
  '/signin/',
  '/about/',
  '/how-its-built/',
  '/how-its-built/outbox/',
  '/how-its-built/cache/',
  '/how-its-built/rebuild/',
  '/how-its-built/routes/',
  '/how-its-built/single-writer/',
];

function expectApiHeaders(res: APIResponse, type = 'application/json') {
  const h = res.headers();
  expect(h['content-type']).toBe(type);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cross-origin-resource-policy']).toBe('same-site');
}

function expectNoCors(res: APIResponse) {
  for (const name of Object.keys(res.headers())) {
    expect(name.startsWith('access-control-'), `${name} sent to ${OTHER_ORIGIN}`).toBe(false);
  }
}

test.beforeAll('both hostnames answer', async ({ request }) => {
  test.setTimeout(WAIT_MS + 30_000);
  await expect
    .poll(async () => (await request.get(`${API_DIRECT}/v1/health`)).status(), {
      timeout: WAIT_MS,
      intervals: [2_000],
    })
    .toBe(200);
  await expect
    .poll(async () => (await request.get(`${WEB_DIRECT}/`)).status(), {
      timeout: WAIT_MS,
      intervals: [2_000],
    })
    .toBe(200);
});

test.describe('the API', () => {
  test('health answers 200 with the build commit, and runs no object', async ({ request }) => {
    const res = await request.get(`${API_DIRECT}/v1/health`);
    expect(res.status()).toBe(200);
    expectApiHeaders(res);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.commit).toBe('string');
    if (COMMIT) expect(body.commit).toBe(COMMIT);
  });

  test('status answers with the day and the flag', async ({ request }) => {
    const res = await request.get(`${API_DIRECT}/v1/status`);
    expect(res.status()).toBe(200);
    expectApiHeaders(res);
    const body = await res.json();
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['live', 'read-only', 'off']).toContain(body.flag);
  });

  test("CORS answers the storefront's origin exactly, with credentials", async ({ request }) => {
    const get = await request.get(`${API_DIRECT}/v1/health`, { headers: { Origin: WEB } });
    expect(get.headers()['access-control-allow-origin']).toBe(WEB);
    expect(get.headers()['access-control-allow-credentials']).toBe('true');
    expect(get.headers()['vary']).toBe('Origin');
    const preflight = await request.fetch(`${API_DIRECT}/v1/sandboxes`, {
      method: 'OPTIONS',
      headers: {
        Origin: WEB,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, idempotency-key',
      },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-origin']).toBe(WEB);
    expect(preflight.headers()['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers()['access-control-allow-methods']).toBe('GET, POST, PATCH, DELETE');
  });

  test('CORS answers any other origin with no CORS header at all', async ({ request }) => {
    expectNoCors(
      await request.get(`${API_DIRECT}/v1/health`, { headers: { Origin: OTHER_ORIGIN } }),
    );
    expectNoCors(
      await request.fetch(`${API_DIRECT}/v1/sandboxes`, {
        method: 'OPTIONS',
        headers: { Origin: OTHER_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
    );
  });

  test('the Stripe webhook refuses a wrong signature with 400', async ({ request }) => {
    const res = await request.post(`${API_DIRECT}/v1/stripe/webhook`, {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=00' },
      data: '{"id":"evt_smoke"}',
    });
    expect(res.status()).toBe(400);
    expectApiHeaders(res, 'application/problem+json');
  });

  for (const [provider, authorize] of [
    ['google', GOOGLE_AUTHORIZE],
    ['github', GITHUB_AUTHORIZE],
  ] as const) {
    test(`sign-in with ${provider} redirects with a state and the __Host-oauth cookie`, async ({
      request,
    }) => {
      const res = await request.get(`${API_DIRECT}/v1/auth/${provider}/start?return=/app/`, {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(302);
      const location = new URL(res.headers()['location'] ?? '');
      expect(location.href.startsWith(authorize), location.href).toBe(true);
      expect(location.searchParams.get('state')).toBeTruthy();
      if (provider === 'google') expect(location.searchParams.get('scope')).toBe('openid');
      else expect(location.searchParams.has('scope')).toBe(false);
      const cookie =
        res.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie')?.value ?? '';
      expect(cookie).toMatch(/^__Host-oauth=/);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*Secure/i);
      // Lax, not Strict: the provider's redirect back is a cross-site navigation, which a Strict
      // cookie would miss (docs/security.md, "Google, with the openid scope alone").
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    });
  }
});

test.describe('the storefront', () => {
  for (const pathname of PAGES) {
    test(`${pathname} carries the storefront's headers`, async ({ request }) => {
      const res = await request.get(`${WEB_DIRECT}${pathname}`);
      expect(res.status()).toBe(200);
      const h = res.headers();
      expect(h['content-security-policy']).toContain("default-src 'self'");
      expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(h['content-security-policy']).not.toContain("'unsafe-inline'");
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), usb=()');
      expect(h['cross-origin-opener-policy']).toBe('same-origin');
    });
  }

  test('an unknown path is the 404 page', async ({ request }) => {
    expect((await request.get(`${WEB_DIRECT}/no-such-page/`)).status()).toBe(404);
  });

  test('every page is the artifact, byte for byte', async ({ request }) => {
    test.skip(
      !DIST,
      'SMOKE_DIST is not set: after a rollback the live pages are not this artifact',
    );
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (name === 'index.html') pages.push(file);
      }
    };
    walk(DIST);
    expect(pages.length).toBeGreaterThan(0);
    for (const file of pages) {
      const pathname =
        `/${path.relative(DIST, path.dirname(file)).split(path.sep).join('/')}/`.replace('//', '/');
      const res = await request.get(`${WEB_DIRECT}${pathname}`);
      expect(res.status(), pathname).toBe(200);
      expect(Buffer.compare(await res.body(), readFileSync(file)), pathname).toBe(0);
    }
  });

  test('the home page and the menu load with no CSP violation and no console error', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // A visitor with no session: the page asks the API who it is, and the 401 is the answer.
      if (m.location().url === `${API}/v1/session` && m.text().includes('status of 401')) return;
      problems.push(`${m.text()} (${m.location().url})`);
    });
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
    await page.addInitScript(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`),
      ),
    );
    for (const pathname of ['/', '/menu/']) {
      const res = await page.goto(pathname);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    expect(problems).toEqual([]);
  });
});
