// What every spec shares: a guard that fails a test on any CSP violation or console error, a
// stand-in for Turnstile's script, a synthetic client address per test, and helpers that make the
// calls the storefront makes, from inside the page, so they carry its origin and its cookie.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { nextClientIp } from './addresses';

export const STOREFRONT = 'https://bakery.ihaveasegway.com';
export const API = 'https://api.bakery.ihaveasegway.com';
export const API_DIRECT = `https://127.0.0.1:${process.env.E2E_API_PORT || 8798}`;
const FAKE_STRIPE = `http://127.0.0.1:${process.env.E2E_STRIPE_PORT || 8800}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Turnstile's script cannot load here: the browser reaches no host but the two Workers. This
 * stand-in renders nothing and passes at once, as the documented always-pass test site key does,
 * with a token the fake siteverify accepts (scripts/fake-providers.mjs: any token starting
 * "pass"). Each reset issues a new token, since a token works once.
 */
const TURNSTILE_STUB = `
(() => {
  const widgets = new Map();
  let next = 0;
  const issue = (id) => {
    const w = widgets.get(id);
    if (w) setTimeout(() => w.callback('pass-e2e-' + id + '-' + Date.now()), 0);
  };
  window.turnstile = {
    render(el, options) {
      const id = 'e2e-' + next++;
      widgets.set(id, options);
      issue(id);
      return id;
    },
    reset(id) { issue(id); },
    remove(id) { widgets.delete(id); },
  };
})();
`;

/** Collects every CSP violation a page reports, across navigations, through a binding. */
const CSP_REPORTER = `
document.addEventListener('securitypolicyviolation', (e) => {
  window.__e2eCsp?.(JSON.stringify({
    directive: e.effectiveDirective, blocked: e.blockedURI, page: e.documentURI,
    source: e.sourceFile, line: e.lineNumber,
  }));
});
`;

interface Options {
  /**
   * Statuses a test expects one of the two Workers to answer, such as 410 from the API after a
   * wipe or 404 for an unknown page. Chromium logs every 4xx or 5xx answer as a console error;
   * only these, and only from the storefront or the API, are let through.
   */
  allowedStatuses: number[];
}
interface Fixtures {
  /** A synthetic client address (2001:db8::/32, RFC 3849) for this test's calls to the API. */
  clientIp: string;
  guard: void;
}

export const test = base.extend<Options & Fixtures>({
  allowedStatuses: [[], { option: true }],
  // Playwright reads a fixture's dependencies from its first argument's pattern, so it must be one.
  // eslint-disable-next-line no-empty-pattern
  clientIp: async ({}, use, testInfo) => {
    // A visitor per test: the API limits sandbox creation per client address (1 a minute), and
    // on wrangler dev every request would otherwise come from 127.0.0.1. Never one another test
    // of the run had (e2e/addresses.ts).
    await use(nextClientIp(testInfo.workerIndex));
  },
  guard: [
    async ({ context, clientIp, allowedStatuses }, use) => {
      const violations: string[] = [];
      const errors: string[] = [];
      await context.exposeBinding('__e2eCsp', (_source, report: string) => {
        violations.push(report);
      });
      await context.addInitScript(CSP_REPORTER);
      await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB }),
      );
      await context.route(`${API}/**`, (route) =>
        route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': clientIp } }),
      );
      context.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const status = /status of (\d{3})/.exec(text)?.[1];
        const url = message.location().url;
        const ours = url.startsWith(`${API}/`) || url.startsWith(`${STOREFRONT}/`);
        if (ours && status && allowedStatuses.includes(Number(status))) return;
        errors.push(`${text} (${message.location().url})`);
      });
      context.on('weberror', (error) => errors.push(`uncaught: ${error.error().message}`));
      await use();
      expect(violations, 'no CSP violation').toEqual([]);
      expect(errors, 'no console error').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The answer to a call made from inside the page, as the storefront's src/lib/api.ts makes it. */
export interface Answer<T = unknown> {
  status: number;
  body: T;
}

/** Calls the API from the page: its origin, its cookie, an Idempotency-Key on POST. */
export async function api<T = unknown>(
  page: Page,
  method: string,
  pathname: string,
  body?: unknown,
  key?: string,
): Promise<Answer<T>> {
  return page.evaluate(
    async ({ origin, method, pathname, body, key }) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // A ULID, as src/lib/ulid.ts makes one: 48 bits of time, 80 random, Crockford base32.
      const ulid = () => {
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        let time = Date.now();
        let out = '';
        for (let i = 0; i < 10; i += 1) {
          out = alphabet[time % 32] + out;
          time = Math.floor(time / 32);
        }
        for (const byte of crypto.getRandomValues(new Uint8Array(16))) out += alphabet[byte % 32];
        return out;
      };
      if (method === 'POST') headers['Idempotency-Key'] = key ?? ulid();
      const res = await fetch(`${origin}${pathname}`, {
        method,
        credentials: 'include',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { origin: API, method, pathname, body, key },
  );
}

/** A made-up password: long enough for the API's rule, and never reused. */
export const password = () => `e2e-${randomBytes(12).toString('base64url')}`;

/** Creates a demo account from the sign-in page and leaves its session cookie in the context. */
export async function demoAccount(page: Page): Promise<string> {
  await page.goto('/signin/');
  const answer = await api<{ username: string }>(page, 'POST', '/v1/auth/demo', {
    password: password(),
    turnstile_token: 'pass-e2e-setup',
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.username;
}

interface Sandbox {
  id: string;
  state: string;
  clock_offset_s?: number;
}

/** A signed-in visitor's new sandbox, waited on until its seeding is done. */
export async function liveSandbox(page: Page): Promise<Sandbox> {
  const created = await api<Sandbox>(page, 'POST', '/v1/sandboxes', { replace: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let sandbox = created.body;
  await expect
    .poll(
      async () => {
        sandbox = (await api<Sandbox>(page, 'GET', `/v1/sandboxes/${created.body.id}`)).body;
        return sandbox.state;
      },
      // Seeding is 35 objects; on a loaded machine one answer can wait while they are made.
      { timeout: 60_000 },
    )
    .toBe('live');
  return sandbox;
}

interface MenuItem {
  status: string;
  days_baked: string[];
  season?: { from: string; to: string } | null;
  variants: { slug: string; lead_minutes: number }[];
}

// The bakery's business time (America/Denver), as the console sends it: an ISO time with its offset.
const TZ = 'America/Denver';
const parts = (ms: number) => {
  const o: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  for (const p of format.formatToParts(new Date(ms))) o[p.type] = p.value;
  const field = (name: string) => o[name] ?? '';
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
    weekday: field('weekday'),
  };
};
const offsetMin = (ms: number) => {
  const p = parts(ms);
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60000);
};
const iso = (ms: number) => {
  const p = parts(ms);
  const o = offsetMin(ms);
  const a = Math.abs(o);
  const zone = `${o < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${zone}`;
};

/** The business time of a moment, on a whole minute, as the staff routes take a send time. */
export const businessIso = (ms: number) =>
  iso(Math.ceil(ms / 60_000) * 60_000).replace(/:\d\d(?=[-+]\d\d:\d\d$)/, ':00');

/**
 * A pickup order the seeded menu sells, at the first slot about four hours out that the day's
 * Schedule takes: 07:00 to 14:45 on the quarter hour, closed Mondays, in America/Denver. The same
 * rule as scripts/smoke-payments.sh's order_json.
 */
export function pickupOrder(
  menu: { categories: { items: MenuItem[] }[] },
  clockOffsetS = 0,
  qty = 1,
) {
  const weekday = (ms: number) => parts(ms).weekday.toLowerCase().slice(0, 3);
  const minuteOf = (ms: number) => +parts(ms).hour * 60 + +parts(ms).minute;
  const isSlot = (ms: number) =>
    weekday(ms) !== 'mon' && minuteOf(ms) >= 420 && minuteOf(ms) <= 885 && minuteOf(ms) % 15 === 0;

  const now = Date.now() + clockOffsetS * 1000;
  let slot = Math.ceil((now + 240 * 60000) / 900000) * 900000;
  while (!isSlot(slot)) slot += 900000;
  const p = parts(slot);
  const md = `${p.month}-${p.day}`;
  const inSeason = (s: MenuItem['season']) =>
    !s || (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to);
  const lead = Math.floor((slot - now) / 60000) - 30;
  for (const category of menu.categories) {
    for (const item of category.items) {
      if (item.status !== 'available' || !item.days_baked.includes(weekday(slot))) continue;
      if (!inSeason(item.season)) continue;
      const variant = item.variants.find((v) => v.lead_minutes <= lead);
      if (variant) {
        return { kind: 'pickup', slot: iso(slot), lines: [{ variant: variant.slug, qty }] };
      }
    }
  }
  throw new Error('no item on the seeded menu fits a slot four hours out');
}

/**
 * The Payment Element's confirm, made at the fake Stripe with Stripe's test payment method, as
 * scripts/smoke-payments.sh makes it. The Payment Element itself cannot mount here: Stripe.js
 * comes from js.stripe.com, which this browser cannot reach, and the fake is not Stripe.
 */
export async function confirmAtFakeStripe(clientSecret: string) {
  const intent = clientSecret.split('_secret_')[0];
  const res = await fetch(`${FAKE_STRIPE}/v1/payment_intents/${intent}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.E2E_FAKE_STRIPE_KEY || 'rk_test_not_a_key'}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'payment_method=pm_card_visa',
  });
  return { status: res.status, body: (await res.json()) as { status: string } };
}

/** Runs the API's scheduled handler on wrangler dev, as the platform's cron would. */
export function runCron(cron: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = `${API_DIRECT}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron).replaceAll('%20', '+')}`;
    const req = httpsRequest(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The local half of the morning object check: scripts/list-objects.mjs over the API's state. */
export function listObjects() {
  const dir = process.env.E2E_API_STATE;
  if (!dir) throw new Error('E2E_API_STATE is not set: run the suite with pnpm --filter web e2e');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/list-objects.mjs'), dir], {
    encoding: 'utf8',
  });
  const objects = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { class: string; name: string | null; has_data: boolean });
  return { exit: run.status, objects, stderr: run.stderr };
}

/**
 * Fails the test when axe finds a violation of WCAG 2.0 A and AA, 2.1 AA or 2.2 AA on the page as
 * it stands. Call it once the page has settled (its data loaded, its islands mounted). The failure
 * lists each violation: rule id, impact, the first target selector and the rule's help text.
 * `exclude` skips named rules for one page; give each a comment naming the violation and "R47".
 */
export async function expectNoAxeViolations(page: Page, options: { exclude?: string[] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  if (options.exclude?.length) builder = builder.disableRules(options.exclude);
  const { violations } = await builder.analyze();
  const lines = violations.map(
    (v) => `${v.id} (${v.impact ?? 'unrated'}) at ${String(v.nodes[0]?.target[0])}: ${v.help}`,
  );
  expect(lines, 'no axe violation').toEqual([]);
}
