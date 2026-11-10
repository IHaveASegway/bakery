// The shop's follow-through from the audit of 2026-11-10, measured in the browser:
// G1, the inbox: a pressed subject opens its message directly under its own row, its heading in the
// viewport and focused, at 390 and 1280 px, for the first, a middle and the last message listed;
// Escape and Close give the focus back to the subject; the order page's link opens that order's
// receipt, and an order the list does not hold leaves the plain list.
// G11, the demo account: the press that makes the account makes its sandbox, so one press more
// reaches a live Kitchen board and "You have no sandbox" is never drawn; the card's two actions
// stand apart.
// G10, the menu by keyboard: after Add, the way to the cart is the next Tab stop, and it takes the
// focus to the cart (at 1280 px the panel, at 390 px the sheet), whose heading then shows a ring.
// G11.2, Google and GitHub: a sign-in lands on /app/start/, which starts the sandbox; /app/ never
// does.
import type { Locator, Page } from '@playwright/test';
import {
  api,
  demoAccount,
  expect,
  liveSandbox,
  password,
  payOrder,
  pickupOrder,
  test,
} from './fixtures';

const WIDTHS = [390, 1280] as const;
const HEIGHT = { 390: 844, 1280: 800 } as const;

/** Where the open message is, measured against the viewport and the focus. */
interface Opened {
  focused: boolean;
  headingTop: number;
  headingBottom: number;
  viewport: number;
  sectionHeight: number;
  scrollY: number;
  heading: string;
  open: number;
  /** The open message's row comes right after the pressed subject's row. */
  underItsRow: boolean;
}

const opened = (page: Page, subjectId: string) =>
  page.evaluate((subjectId): Opened => {
    const heading = document.getElementById('message-heading');
    const section = document.getElementById('inbox-open');
    const row = document.getElementById(subjectId)?.closest('tr');
    const box = heading?.getBoundingClientRect();
    return {
      focused: heading !== null && document.activeElement === heading,
      headingTop: box?.top ?? -1,
      headingBottom: box?.bottom ?? -1,
      viewport: window.innerHeight,
      sectionHeight: section?.getBoundingClientRect().height ?? 0,
      scrollY: window.scrollY,
      heading: heading?.textContent ?? '',
      open: document.querySelectorAll('#inbox-open').length,
      underItsRow: row?.nextElementSibling?.contains(section) ?? false,
    };
  }, subjectId);

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

for (const width of WIDTHS) {
  test(`at ${width} px a pressed subject opens its message under its row, in view and focused`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: HEIGHT[width] });
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/inbox/');
    const subjects = page.locator('table.inbox-table > tbody > tr > th button.link');
    await expect(subjects.first()).toBeVisible();
    const count = await subjects.count();
    expect(count, 'the seed fills the list').toBeGreaterThan(10);

    // The first, a middle and the last message listed, whatever they are.
    const picks: [string, Locator][] = [
      ['first', subjects.first()],
      ['middle', subjects.nth(Math.floor(count / 2))],
      ['last', subjects.last()],
    ];
    for (const [i, [which, subject]] of picks.entries()) {
      const id = (await subject.getAttribute('id')) ?? '';
      expect(id, `${which}: the subject has an id`).toMatch(/^subject-/);
      const name = ((await subject.textContent()) ?? '').trim();
      await subject.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      // Pressed by the pointer, then by the keyboard, so both ways are measured.
      if (i % 2 === 0) await subject.click();
      else {
        await subject.focus();
        await page.keyboard.press('Enter');
      }
      await expect.poll(async () => (await opened(page, id)).focused, which).toBe(true);
      const at = await opened(page, id);
      expect(at.heading, which).toBe(name);
      expect(at.open, `${which}: one message open`).toBe(1);
      expect(at.underItsRow, `${which}: directly under its own row`).toBe(true);
      expect(at.headingTop, `${which}: the heading's top in view`).toBeGreaterThanOrEqual(0);
      expect(at.headingBottom, `${which}: the heading's foot in view`).toBeLessThanOrEqual(
        at.viewport,
      );
      expect(
        Math.abs(at.scrollY - before),
        `${which}: the page moved ${at.scrollY - before} px for a ${at.sectionHeight} px message`,
      ).toBeLessThanOrEqual(at.sectionHeight);
      await expect(subject).toHaveAttribute('aria-expanded', 'true');

      // Closed by Escape, Close, and the subject again, in turn: the focus goes back to the subject.
      if (i === 0) await page.keyboard.press('Escape');
      else if (i === 1)
        await page.locator('#inbox-open').getByRole('button', { name: 'Close' }).click();
      else await subject.click();
      await expect(page.locator('#inbox-open')).toHaveCount(0);
      expect(await focusedId(page), `${which}: the focus is back on the subject`).toBe(id);
      await expect(subject).toHaveAttribute('aria-expanded', 'false');
    }

    // Escape from the subject itself closes it too, and one message is open at a time.
    const first = picks[0]![1];
    const last = picks[2]![1];
    await first.click();
    await last.click();
    await expect(page.locator('#inbox-open')).toHaveCount(1);
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await last.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#inbox-open')).toHaveCount(0);
  });
}

test('the order page’s receipt link opens that order’s receipt, in view and focused', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  const placed = await api<{ id: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2),
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const order = placed.body.id;
  await payOrder(page, sandbox.id, order);

  await page.goto(`/order/?id=${order}`);
  const link = page.getByRole('link', { name: 'Read your receipt in the inbox' });
  await expect(link).toHaveAttribute('href', `/inbox/?receipt=${order}`);
  await link.click();
  await expect(page).toHaveURL(`/inbox/?receipt=${order}`);

  // The receipt reaches the inbox through the Queue; the page opens it once the list holds it.
  const heading = page.locator('#message-heading');
  await expect(heading).toBeFocused({ timeout: 40_000 });
  const open = page.locator('button.link[aria-expanded="true"]');
  const mid = ((await open.getAttribute('id')) ?? '').replace(/^subject-/, '');
  const message = await api<{ kind: string; ref: string }>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/inbox/${mid}`,
  );
  expect(message.body.kind).toBe('receipt');
  expect(message.body.ref, 'the receipt is this order’s').toBe(order);
  const at = await opened(page, `subject-${mid}`);
  expect(at.underItsRow).toBe(true);
  expect(at.headingTop).toBeGreaterThanOrEqual(0);
  expect(at.headingBottom).toBeLessThanOrEqual(at.viewport);

  // An order the list does not hold: the plain list, nothing open, no error.
  await page.goto('/inbox/?receipt=01JZZZZZZZZZZZZZZZZZZZZZZZ');
  await expect(page.locator('table.inbox-table')).toBeVisible();
  await page.waitForTimeout(6_000); // past the list's next look
  await expect(page.locator('#inbox-open')).toHaveCount(0);
  await expect(page.locator('.problem')).toHaveCount(0);
});

test.describe('the inbox with no sandbox', () => {
  // The page asks for the session once, and a visitor with none gets a 401 that Chromium logs.
  test.use({ allowedStatuses: [401] });

  test('sends the visitor to the menu, which starts a sandbox in place', async ({ page }) => {
    await page.goto('/inbox/');
    const line = page.getByText('You have no sandbox yet, so the inbox is empty.');
    await expect(line).toBeVisible();
    await expect(line.getByRole('link', { name: 'Start at the menu' })).toHaveAttribute(
      'href',
      '/menu/',
    );
    await expect(line).toContainText('an order’s receipt lands here');
    await expect(page.getByRole('link', { name: 'Sign in or try it as a guest' })).toHaveCount(0);
  });
});

// Records, from the first byte of every console page, whether the empty state was ever drawn.
const WATCH_EMPTY = `
(() => {
  if (!location.pathname.startsWith('/app/')) return;
  window.__sawNoSandbox = false;
  const look = () => {
    for (const h of document.querySelectorAll('h2')) {
      if (h.textContent && h.textContent.trim() === 'You have no sandbox') window.__sawNoSandbox = true;
    }
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
})();
`;

test('a new demo account reaches a live Kitchen board in one press, its two actions apart', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(WATCH_EMPTY);
  await page.goto('/signin/');
  const create = page.getByRole('form', { name: 'Create a demo account' });
  const submit = create.getByRole('button', { name: 'Create a demo account' });
  await expect(submit).toBeEnabled();
  await create.getByLabel('Password').fill(password());
  const isPost = (path: string) => (r: { request(): { method(): string }; url(): string }) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === path;
  const [account, sandbox] = await Promise.all([
    page.waitForResponse(isPost('/v1/auth/demo')),
    page.waitForResponse(isPost('/v1/sandboxes')),
    submit.click(),
  ]);
  expect(account.status()).toBe(201);
  expect(sandbox.status()).toBe(201);
  await expect(page.locator('code.username')).toBeVisible();
  await expect(page.getByText('Your sandbox is made too')).toBeVisible();

  // The card's two actions stand apart, at both widths.
  const copy = page.getByRole('button', { name: 'Copy username' });
  const go = page.getByRole('link', { name: 'Continue to the console' });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT[width] });
    const a = (await copy.boundingBox())!;
    const b = (await go.boundingBox())!;
    const gap = Math.max(b.y - (a.y + a.height), b.x - (a.x + a.width));
    expect(gap, `${width} px: ${gap} px between the two actions`).toBeGreaterThanOrEqual(8);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // One press: the console, on a board that goes live, and never the empty state on the way.
  await go.click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('heading', { name: 'Kitchen board' })).toBeVisible();
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __sawNoSandbox?: boolean }).__sawNoSandbox)).toBe(
    false,
  );
});

test.describe('the menu by keyboard', () => {
  // Browsing and filling the cart need no sandbox; the page's one look at the session is a 401.
  test.use({ allowedStatuses: [401] });

  for (const width of WIDTHS) {
    test(`at ${width} px the way to the cart is the next Tab stop after a pressed Add`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      await page.goto('/menu/');
      const adds = page.locator('.menu .variants button:enabled');
      await expect(adds.first()).toBeVisible();
      // Nothing added yet: no extra stop anywhere in the list.
      await expect(page.locator('.to-cart')).toHaveCount(0);

      // An Add some way down the list, by what it is: an enabled Add of a card past the first.
      const add = page
        .locator('.menu .item')
        .filter({ has: page.locator('.variants button:enabled') })
        .nth(3)
        .locator('.variants button:enabled')
        .first();
      const label = (await add.getAttribute('aria-label')) ?? '';
      await add.focus();
      await page.keyboard.press('Enter');
      const what = label.replace(/^Add /, '').replace(/, to the cart$/, '');
      await expect(page.locator('.said')).toHaveText(`Added ${what}.`);
      await expect(page.locator('.to-cart')).toHaveCount(1);

      // At most two Tab presses forward of the pressed button.
      let reached = false;
      for (let presses = 1; presses <= 2 && !reached; presses += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(
          () => document.activeElement?.textContent === 'Go to your cart',
        );
      }
      expect(reached, 'the way to the cart within two Tab presses').toBe(true);
      const link = page.getByRole('link', { name: 'Go to your cart' });
      await expect(link).toBeFocused();
      // Seen while it holds the focus: a real box, inside the viewport.
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThan(40);
      expect(box.height).toBeGreaterThan(16);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(HEIGHT[width]);

      await page.keyboard.press('Enter');
      await expect(page.locator('#cart-heading')).toBeFocused();
      if (width === 390) await expect(page.locator('.cart')).toHaveAttribute('data-open', '');
      // Reached by the keyboard, the heading shows where the focus went, hugging its words.
      const ring = await outlineOf(page, '#cart-heading');
      expect(ring.style, 'the cart heading’s focus ring').not.toBe('none');
      expect(ring.width).toBeGreaterThan(0);
      expect(ring.box, 'the ring hugs the heading’s words').toBeLessThan(ring.parent);
      const checkout = page.getByRole('link', { name: 'Check out' });
      await expect(checkout).toBeVisible();
      // From the cart's heading, Check out is a few stops on, past the line's own controls.
      let found = false;
      for (let presses = 0; presses < 8 && !found; presses += 1) {
        await page.keyboard.press('Tab');
        found = await page.evaluate(() => document.activeElement?.textContent === 'Check out');
      }
      expect(found, 'Check out within a few Tab presses of the cart’s heading').toBe(true);
    });
  }

  test('at 390 px a tapped cart bar opens the sheet with no stray ring on its heading', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/menu/');
    const add = page.locator('.menu .variants button:enabled').first();
    await expect(add).toBeVisible();
    await add.click();
    await page.locator('.cart-bar').click();
    await expect(page.locator('#cart-heading')).toBeFocused();
    expect((await outlineOf(page, '#cart-heading')).style).toBe('none');
  });
});

/** The computed outline of an element, and its width against its parent's. */
const outlineOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      box: el.getBoundingClientRect().width,
      parent: el.parentElement?.getBoundingClientRect().width ?? 0,
    };
  });

// The sign-in's landing (audit G11.2, 2026-11-10): Google and GitHub come back to /app/start/,
// which makes the session a sandbox when it has none and shows the console at /app/. The fake
// providers (scripts/fake-providers.mjs) answer for a new account on each run.
const FAKE = `http://127.0.0.1:${process.env.E2E_PROVIDERS_PORT || 8799}`;

/** The fake providers' next sign-in is this account: a GitHub id, a Google subject. */
async function nextAccount(): Promise<number> {
  const id = 7_000_000 + Math.floor(Math.random() * 2_000_000);
  const res = await fetch(`${FAKE}/_config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      google: { sub: `fake-sub-e2e-${id}`, extra_claims: true, fault: 'none' },
      github: { id, fault: 'none' },
    }),
  });
  expect(res.status).toBe(200);
  return id;
}

/** Signs in through the sign-in page's provider link and returns the sandbox creations it made. */
async function signInWith(page: Page, provider: 'Google' | 'GitHub') {
  const creations: number[] = [];
  const watch = (r: { request(): { method(): string }; url(): string; status(): number }) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/v1/sandboxes') {
      creations.push(r.status());
    }
  };
  page.on('response', watch);
  await page.goto('/signin/');
  await page.getByRole('link', { name: `Continue with ${provider}` }).click();
  await page.waitForURL((url) => url.pathname === '/app/');
  return { creations, stop: () => page.off('response', watch) };
}

test.describe('the sign-in’s landing', () => {
  // The sign-in page asks for a session the visitor does not have yet.
  test.use({ allowedStatuses: [401] });
  test.afterEach(async () => {
    await fetch(`${FAKE}/_reset`, { method: 'POST' });
  });

  for (const provider of ['Google', 'GitHub'] as const) {
    test(`a first sign-in with ${provider} reaches a live board with no press`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await nextAccount();
      await page.addInitScript(WATCH_EMPTY);
      const first = await signInWith(page, provider);
      await expect(page.getByRole('heading', { name: 'Kitchen board' })).toBeVisible();
      await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible({
        timeout: 60_000,
      });
      first.stop();
      expect(first.creations, 'one sandbox made, on the landing').toEqual([201]);
      expect(
        await page.evaluate(() => (window as { __sawNoSandbox?: boolean }).__sawNoSandbox),
      ).toBe(false);
      // The landing replaced its own address: Back goes to the sign-in page, not to it.
      await page.goBack();
      await expect(page).toHaveURL(/\/signin\/$/);

      if (provider === 'GitHub') {
        // The same account again, its sandbox live: no second one, straight to the console.
        await page.context().clearCookies();
        const again = await signInWith(page, provider);
        await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible({
          timeout: 30_000,
        });
        again.stop();
        expect(again.creations, 'no second sandbox').toEqual([]);
      }
    });
  }

  test('with no session the landing goes to the sign-in page', async ({ page }) => {
    await page.goto('/app/start/');
    await expect(page).toHaveURL(/\/signin\/\?next=\/app\/$/);
    await expect(page.getByRole('heading', { name: 'Get your own bakery' })).toBeVisible();
  });
});

test.describe('a sandbox the landing cannot start', () => {
  // The second creation from one address inside a minute is refused, and Chromium logs the 429.
  test.use({ allowedStatuses: [401, 429] });
  test.afterEach(async () => {
    await fetch(`${FAKE}/_reset`, { method: 'POST' });
  });

  test('is said in the API’s words over the empty state, with no retry', async ({ page }) => {
    test.setTimeout(120_000);
    await nextAccount();
    const first = await signInWith(page, 'GitHub');
    await expect(page.getByRole('heading', { name: 'Kitchen board' })).toBeVisible();
    first.stop();
    expect(first.creations).toEqual([201]);

    // Another new account from the same address within the minute: the API's limit refuses it.
    await page.context().clearCookies();
    await nextAccount();
    const second = await signInWith(page, 'GitHub');
    await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New sandbox' })).toBeVisible();
    await expect(page.locator('.problem')).toContainText('Slow down');
    await page.waitForTimeout(3_000); // long enough for a retry to show itself
    second.stop();
    expect(second.creations, 'asked once, not retried').toEqual([429]);
  });
});

test('a signed-in session with no sandbox still sees the empty state on /app/', async ({
  page,
}) => {
  await demoAccount(page);
  const creations: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/v1/sandboxes') {
      creations.push(r.url());
    }
  });
  await page.goto('/app/');
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New sandbox' })).toBeVisible();
  expect(creations).toEqual([]);
});
