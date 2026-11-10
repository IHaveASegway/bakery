// What every spec shares: a guard that fails a test on any CSP violation or console error, a
// stand-in for Turnstile's script, a synthetic client address per test (e2e/addresses.ts: never
// one another test of the run had), and helpers that make the calls the storefront makes, from
// inside the page, so they carry its origin and its cookie. The rest are the bakery's calendar in
// business time (businessIso, businessDate, nthOpenDay), orders the seeded menu sells
// (pickupOrder, deliveryOrder), their payment at the fake Stripe (payOrder), the cron, the object
// listing, and the axe check every screen runs once its data have loaded (expectNoAxeViolations).
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { nextClientIp } from './addresses';
import { freeable } from './cover';

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

/** The face the pages render in instead of system-ui, or '' for the machine's own. */
const FONT = process.env.E2E_FONT?.trim() ?? '';

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
      // E2E_FONT="DejaVu Sans" renders the pages in that face instead of the machine's system-ui:
      // Playwright's image on GitHub's runner maps system-ui to DejaVu Sans, wider than Inter, and
      // the placement of the guide's marks and notes depends on where lines end (2026-11-10, pull
      // request #143). Set through the CSSOM before any page script runs, which the CSP allows;
      // unset, nothing changes.
      if (FONT !== '') {
        await context.addInitScript((face: string) => {
          // The script can run before the document has its root element: set it once it does.
          const set = () =>
            document.documentElement.style.setProperty('--font-ui', `"${face}", sans-serif`);
          if (document.documentElement !== null) set();
          else {
            new MutationObserver((_, watcher) => {
              if (document.documentElement === null) return;
              set();
              watcher.disconnect();
            }).observe(document, { childList: true });
          }
        }, FONT);
      }
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
  persona_zone?: string | null;
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

/**
 * A guest's sandbox, made as a visitor makes one: the sign-in page's "Continue as a guest", whose
 * Turnstile is the guard's stand-in. Waited on until its seeding is done.
 */
export async function guestSandbox(page: Page): Promise<Sandbox> {
  await page.goto('/signin/');
  const button = page.getByRole('button', { name: 'Continue as a guest' });
  await expect(button).toBeEnabled();
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/v1/sandboxes',
    ),
    button.click(),
  ]);
  expect(created.status()).toBe(201);
  // The page goes on as soon as the sandbox is made, so the id is read from the session after.
  await page.waitForURL((url) => url.pathname !== '/signin/');
  const session = await api<{ kind: string; sandbox: string | null }>(page, 'GET', '/v1/session');
  expect(session.body.kind).toBe('guest');
  const id = session.body.sandbox ?? '';
  expect(id).not.toBe('');
  let sandbox: Sandbox = { id, state: 'seeding' };
  await expect
    .poll(
      async () => {
        sandbox = (await api<Sandbox>(page, 'GET', `/v1/sandboxes/${id}`)).body;
        return sandbox.state;
      },
      { timeout: 60_000 },
    )
    .toBe('live');
  return sandbox;
}

interface MenuItem {
  status: string;
  pickup_only?: boolean;
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

/** The bakery date (America/Denver) of a moment, as YYYY-MM-DD. */
export const businessDate = (ms: number) => {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};

/** The n-th open day after a bakery date: every day but Monday, as scripts/smoke-dispatch.sh counts. */
export function nthOpenDay(date: string, n: number): string {
  let ms = Date.parse(`${date}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    ms += 86_400_000;
    if (new Date(ms).getUTCDay() !== 1) left -= 1;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A delivery in a date's 09:00 window, naming no zone (the API derives the persona's, R69), qty of one item baked that weekday that is
 * neither pickup-only nor seasonal, with a lead time inside two hours: scripts/smoke-dispatch.sh's
 * delivery_order.
 */
export function deliveryOrder(
  menu: { categories: { items: MenuItem[] }[] },
  date: string,
  qty: number,
) {
  const nine = Date.parse(`${date}T16:00:00Z`);
  const weekday = parts(nine).weekday.toLowerCase().slice(0, 3);
  // 09:00 in Denver is 15:00 or 16:00 UTC; iso() gives the date's own offset either way.
  const zone = iso(nine).slice(-6);
  for (const category of menu.categories) {
    for (const item of category.items) {
      if (item.status !== 'available' || item.pickup_only || item.season) continue;
      if (!item.days_baked.includes(weekday)) continue;
      const variant = item.variants.find((v) => v.lead_minutes <= 120);
      if (variant) {
        return {
          kind: 'delivery',
          slot: `${date}T09:00:00${zone}`,
          lines: [{ variant: variant.slug, qty }],
        };
      }
    }
  }
  throw new Error(`no item on the seeded menu fits a delivery on ${date}`);
}

/** Pays an order as the storefront does, its id as the key, and confirms it at the fake Stripe. */
export async function payOrder(page: Page, sandboxId: string, orderId: string) {
  const payment = await api<{ client_secret: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandboxId}/orders/${orderId}/payment`,
    undefined,
    orderId,
  );
  expect(payment.status, JSON.stringify(payment.body)).toBe(200);
  const confirm = await confirmAtFakeStripe(payment.body.client_secret);
  expect(confirm.body.status).toBe('succeeded');
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
 * Answers how many reads it took: one, unless something started to move while axe was reading.
 */
export async function expectNoAxeViolations(
  page: Page,
  options: { exclude?: string[] } = {},
): Promise<number> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  if (options.exclude?.length) builder = builder.disableRules(options.exclude);
  // A read is of the page at rest, and only that. A card that arrives fades in (components.css,
  // card-in), and axe reads its muted text against the half-faded card. Waiting before the read
  // covers a card already there. It cannot cover one whose data arrives while axe is reading: on
  // 2026-11-10 the Customers page's segment cards did, in pull request #148's run, and all five
  // failed contrast at once. So the page counts each animation that starts, the read is taken at
  // rest, and a read during which one started, or after which one still runs, is taken again:
  // three reads at most, and the last one stands. A real finding is there on every read.
  const readOnce = async () => {
    const before = await atRest(page);
    const { violations } = await readLaidOut(page, () => builder.analyze());
    const after = await page.evaluate(movement);
    return { violations, moved: after.started !== before || after.running };
  };
  let read = await readOnce();
  let reads = 1;
  for (; read.moved && reads < 3; reads += 1) read = await readOnce();
  const counted = await withoutViewportCovers(page, read.violations);
  // Every node of every violation, so a failure names all of them, not the first.
  const lines = counted.map(
    (v) =>
      `${v.id} (${v.impact ?? 'unrated'}) at ${v.nodes.map((n) => String(n.target[0])).join(', ')}: ${v.help}`,
  );
  expect(lines, 'no axe violation').toEqual([]);
  return reads;
}

/**
 * Runs a read with every part of the page laid out. A page may tell the browser to skip what is far
 * from the window (`content-visibility: auto`, the API reference's operations and schemas), and axe
 * measures targets from boxes: on 2026-11-10 it called a few links in skipped sections too close to
 * their neighbours on that page (rule target-size) although each is 24 px tall once laid out, the
 * state a visitor sees on scrolling there. Skipped text is in the accessibility tree all the same;
 * only the geometry differs. A constructable stylesheet is used because the page's policy refuses a
 * style element added from outside; it is removed after the read.
 */
async function readLaidOut<T>(page: Page, read: () => Promise<T>): Promise<T> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { content-visibility: visible !important; }');
    (window as Window & { __axeLaidOut?: CSSStyleSheet }).__axeLaidOut = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  try {
    return await read();
  } finally {
    await page.evaluate(() => {
      const sheet = (window as Window & { __axeLaidOut?: CSSStyleSheet }).__axeLaidOut;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    });
  }
}

type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/**
 * What the page says about motion, asked inside it: how many CSS animations have started since the
 * count began, and whether an animation or transition that ends is running now. One that loops (a
 * skeleton's pulse) never ends and is not waited for. The first call starts the count.
 */
function movement(): { started: number; running: boolean } {
  const w = window as Window & { __axeStarted?: number };
  if (w.__axeStarted === undefined) {
    w.__axeStarted = 0;
    document.addEventListener(
      'animationstart',
      () => {
        w.__axeStarted = (w.__axeStarted ?? 0) + 1;
      },
      true,
    );
  }
  const running = document
    .getAnimations()
    .some(
      (a) =>
        a.playState === 'running' &&
        Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? 0)),
    );
  return { started: w.__axeStarted, running };
}

/**
 * Waits until the page is at rest and answers the count of animations started by then, read in the
 * same frame that found it at rest, so nothing can start between the two unseen.
 */
async function atRest(page: Page): Promise<number> {
  await page.evaluate(movement);
  // Let what is moving finish first: a card that just arrived is still fading in.
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== 'running' ||
              !Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? 0)),
          ),
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  // The page must be at rest too: a step of the guide's short path scrolls its element into view
  // smoothly, and axe read the board mid-scroll, while the guide's marks were being placed again
  // for the new scroll position (data-guide-marks="settling", components/guide/Layer.tsx). A mark
  // is an opaque dark disc, so one read at its old place over a card's muted id made that text
  // fail against it. Wait until the scroll has stopped and the marks stand where the layout puts
  // them: two animation frames at the same scroll position with the marks settled.
  const rest = await page.waitForFunction(
    () => {
      const w = window as Window & { __axeY?: number; __axeStarted?: number };
      const still = w.__axeY === window.scrollY;
      w.__axeY = window.scrollY;
      const marks = document.documentElement.dataset.guideMarks;
      return still && (marks === undefined || marks === 'settled')
        ? { started: w.__axeStarted ?? 0 }
        : false;
    },
    null,
    { polling: 'raf', timeout: 10_000 },
  );
  return ((await rest.jsonValue()) as { started: number }).started;
}

/**
 * The one kind of finding the helper drops (2026-11-10, from a run of pull request #140): a
 * `target-size` finding for a control that, at this scroll position, lies under one of the page's
 * OWN sticky or fixed bars along the window's top or foot (the console's top bar, the masthead,
 * the menu's category chips, the phone's bottom nav, found by their computed position, not by
 * name) and that some scroll position would bring out between those bars. axe counts a control
 * partly behind another focusable widget as too small; a card's Start scrolled up under the top
 * bar's clock is that, and no visitor sees it: the card is out of view. A finding still counts
 * when what covers the control is the guide's own layer (a note, a mark, its control, the
 * recorder: audit 4's G3 is exactly that), and when no scroll can free the control (the end of a
 * page under a fixed bottom nav, a control taller than the room between the bars:
 * e2e/cover.ts, freeable). The page is not scrolled to find out: on a phone a scroll folds an open
 * note, and the test goes on afterwards.
 */
async function withoutViewportCovers(
  page: Page,
  violations: AxeViolation[],
): Promise<AxeViolation[]> {
  const out: AxeViolation[] = [];
  for (const v of violations) {
    if (v.id !== 'target-size') {
      out.push(v);
      continue;
    }
    const selectors = v.nodes.map((n) => String(n.target[0]));
    const measured = await coversOf(page, selectors);
    const nodes = v.nodes.filter((_, i) => {
      const m = measured.nodes[i];
      if (m === null || m === undefined) return true;
      const viewportsDoing =
        m.underBar && !m.underGuide && freeable(m, measured.bands, measured.maxScroll);
      return !viewportsDoing;
    });
    if (nodes.length > 0) out.push({ ...v, nodes });
  }
  return out;
}

/** What covers each control named by `selectors` at this scroll position, as the helper reads it. */
export interface Covers {
  /** The window's bands the page's own bars hold, along its top and foot (e2e/cover.ts). */
  bands: { top: number; bottom: number };
  /** How far the page scrolls. */
  maxScroll: number;
  /** Each control's place in the document and what lies over it, or null when it is not found. */
  nodes: ({ docTop: number; docBottom: number; underBar: boolean; underGuide: boolean } | null)[];
}

/**
 * Measures, without scrolling, what lies over each control: one of the page's own sticky or fixed
 * bars (by computed position; the guide's layer is not one) or the guide's layer.
 */
export function coversOf(page: Page, selectors: string[]): Promise<Covers> {
  return page.evaluate((sels) => {
    const height = window.innerHeight;
    type R = { top: number; bottom: number; left: number; right: number };
    const box = (el: Element): R => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const meets = (a: R, b: R) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const tops: R[] = [];
    const foots: R[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const position = getComputedStyle(el).position;
      if (position !== 'sticky' && position !== 'fixed') continue;
      if (el.closest('[data-guide-root]') !== null) continue;
      const r = box(el);
      if (r.right - r.left === 0 || r.bottom - r.top === 0 || r.bottom - r.top > height / 2) {
        continue;
      }
      if (r.top <= 1) tops.push(r);
      else if (r.bottom >= height - 1) foots.push(r);
    }
    const guide = [
      ...document.querySelectorAll(
        '.guide-note, .guide-spot, .guide-bar, .guide-panel, .guide-line, .guide-full[data-open]',
      ),
    ]
      .map(box)
      .filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0);
    return {
      bands: {
        top: Math.max(0, ...tops.map((r) => r.bottom)),
        bottom: Math.min(height, ...foots.map((r) => r.top)),
      },
      maxScroll: Math.max(0, document.documentElement.scrollHeight - height),
      nodes: sels.map((sel) => {
        const el = document.querySelector(sel);
        if (el === null) return null;
        const r = box(el);
        return {
          docTop: r.top + window.scrollY,
          docBottom: r.bottom + window.scrollY,
          underBar: [...tops, ...foots].some((b) => meets(r, b)),
          underGuide: guide.some((b) => meets(r, b)),
        };
      }),
    };
  }, selectors);
}
