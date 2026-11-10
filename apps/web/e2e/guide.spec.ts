// The guide, Under the hood (docs/architecture.md, "The guide"; ADR 0014), doing its signature
// thing in a browser: on the console, pressing a card's button on the kitchen board opens a note
// beside it that names the frame sent, the event that came back with its sequence number, and why
// this tool and when not; at checkout, placing an order opens a note with the request, its status
// and its time. A note is not a dialog and takes no focus, axe holds with one open, Escape closes
// it, and the recorder reaches the same by keyboard.
import type { Locator, Page } from '@playwright/test';
import {
  api,
  confirmAtFakeStripe,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  payOrder,
  pickupOrder,
  test,
} from './fixtures';

/**
 * The note never covers its anchor, and sits beside it with its caret when there is room (here,
 * the suite's 1280 px window and the 608 px column, there is). Both are in the window.
 */
async function beside(page: Page, note: Locator) {
  const anchor = page.locator('[data-guide-anchor]');
  await expect(anchor).toHaveCount(1);
  await expect
    .poll(async () => {
      const a = await anchor.boundingBox();
      const n = await note.boundingBox();
      if (a === null || n === null) return 'not drawn';
      const apart =
        n.x >= a.x + a.width ||
        n.x + n.width <= a.x ||
        n.y >= a.y + a.height ||
        n.y + n.height <= a.y;
      const side = await note.getAttribute('data-side');
      return apart && side !== null ? 'beside' : `apart ${apart}, side ${side}`;
    })
    .toBe('beside');
}

test('a card’s button on the board opens a note: the frame, the event and its sequence, why and when not', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  // A paid order, as order.spec.ts makes one: the call the storefront makes, then the fake Stripe.
  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  const order = await api<{ id: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2),
  );
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const payment = await api<{ client_secret: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders/${order.body.id}/payment`,
    undefined,
    order.body.id,
  );
  await confirmAtFakeStripe(payment.body.client_secret);
  const short = order.body.id.slice(-6);
  const confirmed = page.locator('section[aria-labelledby="board-confirmed"]');
  await expect(confirmed.locator('code', { hasText: short })).toBeVisible();

  // Calls the page made with no click (the order above came from the test, not a press) opened
  // nothing: only the visitor's own actions do.
  await expect(page.locator('#guide-live')).toHaveCount(0);

  await confirmed.getByRole('button', { name: `Start production for order ${short}` }).click();
  const note = page.getByRole('region', { name: 'Under the hood: The kitchen board' });
  await expect(note).toBeVisible();
  await expect(note).toContainText('cmd start_production');
  await expect(note).toContainText('ack');
  await expect(note).toContainText('by the Order object');
  // The event that came back over the socket, tied to the frame by its cause, with its sequence.
  const event = note.locator('[data-state="observed"]', { hasText: 'OrderProductionStarted' });
  await expect(event).toContainText(/seq \d+/);
  await expect(note).toContainText('Why this tool');
  await expect(note).toContainText('two tabs cannot disagree');
  await expect(note).toContainText('When not');
  await expect(note).toContainText('that needs a projection');
  await beside(page, note);

  // The note took no focus: the board put it on the card's next button, where it stays.
  const inProduction = page.locator('section[aria-labelledby="board-in_production"]');
  await expect(
    inProduction.getByRole('button', { name: `Mark ready for order ${short}` }),
  ).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Escape');
  await expect(note).toHaveCount(0);

  // The recorder: the same, by keyboard, and Escape puts the focus back on its button.
  const recorder = await recorderButton(page);
  await recorder.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel.getByRole('heading', { name: 'Recorder' })).toBeFocused();
  const row = panel.getByRole('button', { name: /The kitchen board/ }).first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(
    panel.locator('[data-state="observed"]', { hasText: 'OrderProductionStarted' }),
  ).toContainText(/seq \d+/);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // In the top bar the Recorder sat in the guide's menu, which closed: the focus is on its button.
  await expect(page.getByRole('button', { name: 'More of Under the hood' })).toBeFocused();
});

test('placing an order at checkout, as a guest, opens a note with the request and what the recorder saw', async ({
  page,
}) => {
  // Stripe.js cannot load here (fixtures.ts): an empty stand-in makes the payment panel say its
  // form could not load, as it does when the script is blocked, without a failed request.
  await page.route('https://js.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* not reachable here */',
    }),
  );
  const sandbox = await guestSandbox(page);
  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  const want = pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2);
  // The cart as the menu's Add buttons leave it in this tab (as order-status.spec.ts writes it).
  await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
    lines: want.lines,
    note: '',
    kind: 'pickup',
    zone: 'z1',
    slot: '',
  });
  await page.goto('/checkout/');

  // The checkout's three steps (#101): how, when, then Place order.
  const how = page.locator('section[aria-labelledby="how-heading"]');
  await expect(how.getByRole('radio', { name: /^Pickup/ })).toBeChecked();
  await how.getByRole('button', { name: 'Continue' }).click();
  await expect(how.getByText('Pickup at the bakery')).toBeVisible();
  await page.locator(`input[name="day"][value="${want.slot.slice(0, 10)}"]`).check();
  const slot = page.locator(`input[name="slot"][value^="${want.slot.slice(0, 16)}"]`);
  await expect(slot).toBeEnabled();
  await slot.check();
  const place = page.getByRole('button', { name: 'Place order' });
  await expect(place).toBeEnabled();
  await place.click();

  const note = page.getByRole('region', { name: 'Under the hood: Placing the order' });
  await expect(note).toBeVisible();
  const request = note.locator('li', { hasText: 'POST …/orders' }).first();
  await expect(request).toContainText('201');
  await expect(request).toContainText(/\d+ ms/);
  await expect(request).toContainText('key');
  await expect(note).toContainText('Each attempt carries its own Idempotency-Key');
  await expect(note).toContainText('When not');
  // No socket on this page, but the flight recorder: a few reads after the answer, OrderPlaced is
  // observed, with the classes the Queue's consumer delivered it to and how long it waited.
  const placed = note.locator('[data-state="observed"]', { hasText: 'OrderPlaced' });
  await expect(placed).toBeVisible({ timeout: 10_000 });
  await expect(placed).toContainText('delivered to');
  await expect(placed).toContainText(/taken by the Queue’s consumer \d+ ms after it was written/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoAxeViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoAxeViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
});

test('the recorder panel tails the recorder’s socket: a hop arrives as the order is placed', async ({
  page,
}) => {
  const sandbox = await guestSandbox(page);
  await page.goto('/menu/');
  await (await recorderButton(page)).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel).toContainText('Live, on the recorder’s socket');
  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  const placed = await api(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2),
  );
  expect(placed.status).toBe(201);
  const hops = panel.getByRole('list', { name: 'Hops from the recorder, newest first' });
  await expect(hops.locator('li', { hasText: 'OrderPlaced' }).first()).toContainText(
    'Delivered to',
    { timeout: 15_000 },
  );
  await expect(panel).toContainText('No hop carries a note, a name or an amount');
  await expectNoAxeViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoAxeViolations(page);
});

test('with the kitchen refusing deliveries, the panel shows the retry and the dead letter in plain words', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const fault = await api(page, 'POST', `/v1/sandboxes/${sandbox.id}/faults`, {
    fault: 'kitchen',
    on: true,
  });
  expect(fault.status).toBe(200);
  await page.goto('/menu/');
  await (await recorderButton(page)).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel).toContainText('Live, on the recorder’s socket');
  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  const placed = await api(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2),
  );
  expect(placed.status).toBe(201);
  const hops = panel.getByRole('list', { name: 'Hops from the recorder, newest first' });
  // One line an event, at its latest hop: the Queue tried the delivery again (attempt 2 or more,
  // the recorder's own count, a lower bound) and then kept it as a dead letter.
  const orderPlaced = hops.locator('li', { hasText: 'OrderPlaced' });
  await expect(orderPlaced.first()).toContainText(
    /Dead-lettered for Kitchen.* after attempt [2-9]/,
    {
      timeout: 60_000,
    },
  );
});

test('a guest’s short path on the console moves a card, and says a refund needs a sign-in', async ({
  page,
}) => {
  await guestSandbox(page);
  await page.goto('/app/');
  await expect(
    page.getByText('You can move any order here; a refund needs a sign-in.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'More of Under the hood' }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const note = page.locator('#guide-path');
  // The board's move is a guest's since 2026-11-10: no sign-in asked.
  await expect(note).toContainText('Press a card’s button to move it on.');
  await expect(note).not.toContainText('needs a sign-in');
  await note.getByRole('button', { name: 'Next' }).click();
  // The refund is not: the step says so, links to sign in, and Next moves past it.
  await expect(note).toContainText('Refund an order from a card’s menu.');
  await expect(note).toContainText(
    'This step needs a sign-in: a guest can read it here, not do it.',
  );
  await expect(note.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin/');
  await note.getByRole('button', { name: 'Next' }).click();
  await expect(note).toContainText('Read the day’s bake list.');
  await expectNoAxeViolations(page);
});

test('a guest’s Leave asks first, in the bar, and a guest who stays keeps the sandbox', async ({
  page,
}) => {
  const sandbox = await guestSandbox(page);
  await page.goto('/app/');
  const leave = page.getByRole('button', { name: 'Leave', exact: true });
  await expect(leave).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await leave.click();
  const panel = page.getByRole('group', { name: 'Leave this sandbox' });
  await expect(panel).toContainText('You cannot come back to this sandbox once you leave.');
  await expect(panel).toContainText('It is wiped at 10:00 UTC, or at once with Wipe now');
  await expectNoAxeViolations(page);
  await panel.getByRole('button', { name: 'Stay' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/$/);
  // Still this guest's sandbox: the session answers with it.
  const session = await api<{ sandbox: string | null }>(page, 'GET', '/v1/session');
  expect(session.body.sandbox).toBe(sandbox.id);
});

test('with the switch off, a press opens no note and the layer is not loaded; on again, notes return, but never over the recorder', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  // The clock is on the console's System page.
  await page.goto('/app/system/');
  const toggle = page.getByRole('switch', { name: 'Under the hood' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.guide-spot')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Under the hood' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // The page has hydrated (its controls are drawn only once it has read the session): a click
  // before that is replayed by React later, too late to be known as the visitor's press.
  await expect(page.getByRole('button', { name: /^Advance 15 minutes/ }).first()).toBeVisible();
  // A write the visitor presses (the clock, one step) opens nothing while the guide is off.
  await page
    .getByRole('button', { name: /^Advance 15 minutes/ })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await api<{ clock_offset_s: number }>(page, 'GET', `/v1/sandboxes/${sandbox.id}`)).body
          .clock_offset_s,
    )
    .toBeGreaterThan(0);
  await expect(page.locator('.guide-note')).toHaveCount(0);
  // Off, the page loaded no layer, and the recorder still opens (it loads the layer then).
  expect(await layerLoaded(page)).toBe(false);
  await (await recorderButton(page)).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // On again: the press made while it was off opens nothing late, and no mark or note flashes.
  const advance = page.getByRole('button', { name: /^Advance 15 minutes/ }).first();
  await page.getByRole('switch', { name: 'Under the hood' }).click();
  await expect(page.locator('.guide-spot').first()).toBeVisible();
  await expect(page.locator('.guide-note')).toHaveCount(0);

  // With the recorder open, a press is the panel's newest row and no note opens over it, then
  // or after the panel closes.
  await (await recorderButton(page)).click();
  await expect(panel).toBeVisible();
  // The panel's rows for the visitor's presses of the clock (not its entry row of the same title).
  const clockRows = panel.locator('.guide-row', { hasText: 'POST …/clock' });
  await expect(clockRows).toHaveCount(1); // the press made while the guide was off
  // The panel covers the control at this window's size; the keyboard reaches it all the same.
  await advance.focus();
  await page.keyboard.press('Enter');
  await expect(clockRows).toHaveCount(2);
  await expect(page.locator('.guide-note')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.guide-note')).toHaveCount(0);

  // With the recorder closed, the next press opens its note again.
  await advance.click();
  const clock = page.getByRole('region', { name: 'Under the hood: The clock' });
  await expect(clock).toBeVisible();
  // What the press set off, said in the note now that the page no longer says it.
  await expect(clock).toContainText('each one worked out its timers again');
  await expect(page.getByText('How this works')).toHaveCount(0);
});

test('the menu’s read opens a note with what answered, and Ask again shows the 304', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/menu/');
  // No click: the page's own read is told when it happens, but folded to one line, over nothing.
  const line = page.locator('.guide-line');
  await expect(line).toContainText('Where the menu came from');
  await expect(line).toContainText(/200, cache (hit|miss)/);
  expect(await guideOverControls(page)).toEqual([]);
  const note = page.getByRole('region', { name: 'Under the hood: Where the menu came from' });
  await expect(note).toHaveCount(0);
  await line.getByRole('button', { name: /Where the menu came from/ }).click();
  await expect(note).toBeVisible();
  await expect(note).toContainText('GET …/menu');
  await expect(note).toContainText(/Bakery-Cache: (hit|miss)/);
  await expect(note).toContainText('ETag: "');
  await expect(note).toContainText(
    /Served from the cache|The Catalog object answered and the cache was filled/,
  );
  await expect(note).toContainText('When not');
  // The page itself no longer explains.
  await expect(page.getByText('How this works')).toHaveCount(0);

  await note.getByRole('button', { name: 'Ask again' }).click();
  await expect(note).toContainText('304');
  await expect(note).toContainText('If-None-Match: "');
  await expect(note).toContainText('This page’s copy was current');
  await expectNoAxeViolations(page);
});

test.describe('a stranger at the gate', () => {
  // The first look at the session, before there is one, is a 401 that Chromium logs.
  test.use({ allowedStatuses: [401] });

  test('the note after Start ordering lies over none of the checkout’s controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/menu/');
    const adds = page.getByRole('button', { name: /^Add .*, to the cart$/ });
    await expect(adds.first()).toBeEnabled();
    await adds.first().click();
    await page.goto('/checkout/');
    const gate = page.getByRole('region', { name: 'Ordering starts with your own sandbox.' });
    await gate.getByRole('button', { name: 'Start ordering' }).click();
    // Beside what it explains where a place is clear of the steps' controls, else as its line.
    await expect(page.locator('.guide-line, #guide-live')).toContainText('Try it as a guest', {
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 30_000 });
    expect(await guideOverControls(page)).toEqual([]);
  });
});

test('one press of Show me around shows step 1, with the menu’s line showing', async ({ page }) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/menu/');
  const line = page.locator('.guide-line');
  await expect(line).toContainText('Where the menu came from');
  await page.getByRole('button', { name: 'Show me around' }).click();
  await expect(page.locator('#guide-path')).toContainText('1 of');
  await expect(line).toHaveCount(0);
});

test('every mark sits at the end of the words it explains, on the home page, the menu and System', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const path of ['/', '/menu/', '/app/system/']) {
    await page.goto(path);
    await expect(page.locator('.guide-spot').first()).toBeVisible();
    expect(await marksAwayFromWords(page), path).toEqual([]);
  }
});

test('the recorder is never wider than the window, after the window narrows with marks drawn', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/');
  await expect(page.locator('.guide-spot').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await (await recorderButton(page)).click();
  const panel = page.locator('.guide-panel');
  await expect(panel).toBeVisible();
  // The panel is sized by the window at once; the page is read once it is at rest (the marks
  // placed for the new width), and what sticks out past the window, outside any box that scrolls
  // or clips it, is named: on a phone the layout widens to the widest content, and every fixed
  // part of the guide with it.
  const sizes = () =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const clipped = (el: Element) => {
        for (
          let up = el.parentElement;
          up !== null && up !== document.body;
          up = up.parentElement
        ) {
          if (getComputedStyle(up).overflowX !== 'visible') return true;
        }
        return false;
      };
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > width + 0.5 && !clipped(el))
        .slice(0, 6)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${String(el.className)} ${Math.round(el.getBoundingClientRect().right)}`,
        );
      return {
        panel: document.querySelector('.guide-panel')?.getBoundingClientRect().width ?? 0,
        page: document.documentElement.scrollWidth,
        width,
        wide,
        settled: document.documentElement.dataset.guideMarks === 'settled',
      };
    });
  const first = await sizes();
  expect(first.panel).toBeLessThanOrEqual(first.width);
  await expect
    .poll(async () => {
      const now = await sizes();
      return now.settled && now.page <= now.width ? 'fits' : `${now.page}: ${now.wide.join('; ')}`;
    })
    .toBe('fits');
});

/**
 * Each mark against the ends of the page's lines of text: a mark sits a few pixels after the end
 * of a line, level with it, never in a gutter beside nothing or on a card's border. Each that does
 * not, named by what it explains.
 */
async function marksAwayFromWords(page: Page): Promise<string[]> {
  await expect(page.locator('html')).toHaveAttribute('data-guide-marks', 'settled');
  return page.evaluate(() => {
    const ends: DOMRect[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if ((n.textContent ?? '').trim() === '') continue;
      if (n.parentElement?.closest('[data-guide-root]') != null) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      ends.push(...range.getClientRects());
    }
    const away: string[] = [];
    for (const mark of document.querySelectorAll<HTMLElement>('.guide-spot')) {
      const m = mark.getBoundingClientRect();
      const middle = m.top + m.height / 2;
      const near = ends.some(
        (r) =>
          middle >= r.top - 4 &&
          middle <= r.bottom + 4 &&
          m.left - r.right >= 0 &&
          m.left - r.right <= 24,
      );
      if (!near || mark.dataset.guideHow === 'gutter') {
        away.push(`${mark.dataset.guideTarget ?? '?'} (${mark.dataset.guideHow ?? '?'})`);
      }
    }
    return away;
  });
}

/**
 * The guide's notes and folded lines against the page's controls (buttons, inputs, links, the slot
 * picker's labels), as boxes on the screen now: each that meets one, named.
 */
async function guideOverControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.guide-note, .guide-line')].map((n) =>
      n.getBoundingClientRect(),
    );
    const hits: string[] = [];
    for (const c of document.querySelectorAll(
      'a[href], button, input, select, textarea, label, [role="button"]',
    )) {
      if (c.closest('[data-guide-root]') !== null) continue;
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      for (const b of boxes) {
        if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) {
          hits.push(`${c.tagName} "${(c.textContent ?? '').trim().slice(0, 30)}"`);
        }
      }
    }
    return hits;
  });
}

/** Which parts of the folded line are cut (their text runs past their box): none, on a phone. */
async function lineCut(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ['.guide-line-title', '.guide-line .guide-chip'].flatMap((selector) => {
      const el = document.querySelector(selector);
      if (el === null) return [`${selector} missing`];
      return el.scrollWidth > el.clientWidth + 1 ? [`${selector}: ${el.textContent ?? ''}`] : [];
    }),
  );
}

/** A guest's sandbox, made as the storefront makes one, waited on until it is live. */
async function guestSandbox(page: Page): Promise<{ id: string; clock_offset_s?: number }> {
  await page.goto('/signin/');
  const made = await api<{ id: string; state: string; clock_offset_s?: number }>(
    page,
    'POST',
    '/v1/sandboxes',
    { turnstile_token: 'pass-e2e-setup', replace: false },
  );
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await expect
    .poll(
      async () =>
        (await api<{ state: string }>(page, 'GET', `/v1/sandboxes/${made.body.id}`)).body.state,
      { timeout: 60_000 },
    )
    .toBe('live');
  return made.body;
}

/**
 * The Recorder's button. In the app shell's top bar the guide is one pill and the Recorder sits in
 * its "…" menu, so the menu is opened first; on the shop's dock it is in the bar.
 */
async function recorderButton(page: Page): Promise<Locator> {
  const more = page.getByRole('button', { name: 'More of Under the hood' });
  if (await more.isVisible()) await more.click();
  return page.getByRole('button', { name: 'Recorder' });
}

/** Whether the page has fetched the guide's deferred layer (its chunk is named Layer.*.js). */
async function layerLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .some((entry) => /\/_astro\/Layer\.[^/]+\.js$/.test(entry.name)),
  );
}

test('on the order page, the kitchen’s move opens a note with the event heard, and four sockets make the page read instead', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
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
  const id = placed.body.id;
  await payOrder(page, sandbox.id, id);
  await page.goto(`/order/?id=${id}`);
  await expect(page.getByText(/^Live: this page moves/)).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Under the hood' })).toBeEnabled();

  // A staff page moves the card: the order page hears the event and the guide says so, beside
  // the tracker, with the event's sequence, how the page listens, and why and when not.
  const staff = await context.newPage();
  await staff.goto('/app/');
  await expect(staff.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  await staff.getByRole('button', { name: `Start production for order ${id.slice(-6)}` }).click();
  const note = page.locator('#guide-watch');
  await expect(note).toContainText('evt OrderProductionStarted');
  await expect(note).toContainText(/seq \d+ on Order/);
  await expect(note).toContainText('listening only');
  await expect(note).toContainText('Why this tool');
  await expect(note).toContainText('When not');
  await beside(page, note);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoAxeViolations(page);

  // Two more consoles make four sockets: the order page gives its own up, and the guide says why.
  const consoles = [staff];
  for (let i = 0; i < 2; i += 1) {
    const c = await context.newPage();
    await c.goto('/app/');
    await expect(c.getByText('Live. Changes appear here as they happen.')).toBeVisible();
    consoles.push(c);
  }
  await expect(note).toContainText(
    'the board reported four sockets open, so this page gave its own up',
  );
  await expect(note).toContainText('A guest on the kitchen’s socket');

  // The recorder has the same, by keyboard.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recorder' }).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel.getByText('evt OrderProductionStarted')).toBeVisible();
  await expect(panel.getByText(/Reading every 10 seconds/)).toBeVisible();
  for (const c of consoles) await c.close();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * Every hotspot's box against every button, link and line of text on the page, at each step of a
   * scroll through it. The page's boxes are read once, in page coordinates (a scroll moves none of
   * them but the fixed bars, which a mark is kept off by design); the marks at every step.
   */
  async function spotsClearAllTheWay(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
      const hits = new Set<string>();
      type R = { l: number; t: number; r: number; b: number };
      const doc = (rect: DOMRect): R => ({
        l: rect.left + window.scrollX,
        t: rect.top + window.scrollY,
        r: rect.right + window.scrollX,
        b: rect.bottom + window.scrollY,
      });
      const meets = (a: R, b: R) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
      const inGuide = (n: Node) =>
        (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)?.closest(
          '[data-guide-root]',
        ) != null;
      const frame = () =>
        new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      // The marks are read only once they stand where the layout puts them now (Layer.tsx sets
      // data-guide-marks): a text change or a scroll moves them a frame later, and a mark read in
      // between sits where the old layout had it.
      const calm = async () => {
        for (let i = 0; i < 300; i += 1) {
          await frame();
          if (document.documentElement.dataset.guideMarks !== 'settled') continue;
          await frame();
          if (document.documentElement.dataset.guideMarks === 'settled') return;
        }
      };
      const pageThings = () => {
        const things: [string, R][] = [];
        for (const c of document.querySelectorAll(
          'a[href], button, input, select, textarea, [role="button"]',
        )) {
          const r = c.getBoundingClientRect();
          if (!inGuide(c) && r.width > 0)
            things.push([`${c.tagName} "${(c.textContent ?? '').trim().slice(0, 30)}"`, doc(r)]);
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          if ((n.textContent ?? '').trim() === '' || inGuide(n)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            things.push([`the text "${(n.textContent ?? '').trim().slice(0, 30)}"`, doc(r)]);
          }
        }
        return things;
      };
      window.scrollTo(0, 0);
      const end = document.documentElement.scrollHeight - window.innerHeight;
      for (let y = 0; ; y = Math.min(end, y + 300)) {
        window.scrollTo(0, y);
        await calm();
        // The page and its marks, read in the same settled frame.
        const things = pageThings();
        for (const spot of document.querySelectorAll('.guide-spot')) {
          const box = doc(spot.getBoundingClientRect());
          for (const [what, r] of things) if (meets(box, r)) hits.add(`at ${y}: a mark on ${what}`);
        }
        if (y >= end) break;
      }
      return [...hits];
    });
  }

  test('no hotspot sits on a button, a link or a line of text, on the home page, the menu and the checkout', async ({
    page,
  }) => {
    await demoAccount(page);
    const sandbox = await liveSandbox(page);
    const menu = await api<Parameters<typeof pickupOrder>[0]>(
      page,
      'GET',
      `/v1/sandboxes/${sandbox.id}/menu`,
    );
    const want = pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2);
    for (const path of ['/', '/menu/', '/checkout/']) {
      if (path === '/checkout/') {
        await page.evaluate(
          (cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)),
          {
            lines: want.lines,
            note: '',
            kind: 'pickup',
            zone: 'z1',
            slot: '',
          },
        );
      }
      await page.goto(path);
      await expect(page.locator('.guide-spot').first()).toBeVisible();
      // The menu's own note is about its read; close it, so the page is what is measured.
      const close = page.getByRole('button', { name: 'Close this note' });
      if (await close.isVisible()) await close.click();
      expect(await spotsClearAllTheWay(page), path).toEqual([]);
    }
  });

  test('the guide’s control is one button that never sits over an Add button or a checkout step control', async ({
    page,
  }) => {
    await demoAccount(page);
    const sandbox = await liveSandbox(page);
    const menu = await api<Parameters<typeof pickupOrder>[0]>(
      page,
      'GET',
      `/v1/sandboxes/${sandbox.id}/menu`,
    );
    const want = pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2);
    const underIt = (selector: string) =>
      page.evaluate(async (sel) => {
        const hits: string[] = [];
        const control = document.querySelector('.guide-bar-dock');
        if (control === null) return ['no guide control'];
        const frame = () =>
          new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const end = document.documentElement.scrollHeight - window.innerHeight;
        for (let y = 0; ; y = Math.min(end, y + 120)) {
          window.scrollTo(0, y);
          await frame();
          const c = control.getBoundingClientRect();
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (
              r.width > 0 &&
              r.left < c.right &&
              r.right > c.left &&
              r.top < c.bottom &&
              r.bottom > c.top
            ) {
              hits.push(
                `at ${y}: ${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}`,
              );
            }
          }
          if (y >= end) break;
        }
        return hits;
      }, selector);

    await page.goto('/menu/');
    const compact = page.getByRole('button', { name: /^Under the hood, (on|off)$/ });
    await expect(compact).toBeVisible();
    const box = await compact.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const close = page.getByRole('button', { name: 'Close this note' });
    if (await close.isVisible()) await close.click();
    // It sits at the cart bar's left end, in the same row, never over the column of Add buttons.
    const bar = await page.locator('.cart-bar').boundingBox();
    expect(
      Math.abs((bar?.y ?? 0) + (bar?.height ?? 0) - ((box?.y ?? 0) + (box?.height ?? 0))),
    ).toBeLessThanOrEqual(1);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(bar?.x ?? 0);
    expect(await underIt('button[aria-label^="Add "]')).toEqual([]);
    // A tap opens the whole control: the switch, the short path and the recorder.
    await compact.click();
    await expect(page.getByRole('switch', { name: 'Under the hood' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recorder' })).toBeVisible();
    await compact.click();

    await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
      lines: want.lines,
      note: '',
      kind: 'pickup',
      zone: 'z1',
      slot: '',
    });
    await page.goto('/checkout/');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    // No cart bar here: the control sits in the masthead's first row and scrolls away with it.
    expect(await underIt('form button, form input, form select, form label')).toEqual([]);
    await expectNoAxeViolations(page);
  });

  test('a note the page caused by itself is one line, over no control, until it is opened', async ({
    page,
  }) => {
    await demoAccount(page);
    const sandbox = await liveSandbox(page);
    const menu = await api<Parameters<typeof pickupOrder>[0]>(
      page,
      'GET',
      `/v1/sandboxes/${sandbox.id}/menu`,
    );
    const want = pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2);
    const line = page.locator('.guide-line');

    await page.goto('/menu/');
    await expect(line).toContainText('Where the menu came from');
    expect(await guideOverControls(page), 'menu').toEqual([]);
    expect(await lineCut(page), 'menu').toEqual([]);

    await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
      lines: want.lines,
      note: '',
      kind: 'pickup',
      zone: 'z1',
      slot: '',
    });
    await page.goto('/checkout/');
    await expect(line).toContainText('The menu this checkout read');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(await guideOverControls(page), 'checkout, step one').toEqual([]);
    expect(await lineCut(page), 'checkout').toEqual([]);
    // Opened, it is a note in full; a press in the page folds it back to the line.
    await line.getByRole('button', { name: /The menu this checkout read/ }).click();
    const note = page.getByRole('region', { name: 'Under the hood: The menu this checkout read' });
    await expect(note).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(note).toHaveCount(0);
    await expect(line).toBeVisible();
    // Step two: the slots are clear of it.
    await expect(page.locator('input[name="slot"]').first()).toBeAttached();
    expect(await guideOverControls(page), 'checkout, step two').toEqual([]);
  });

  test('the masthead shows every section, and the guide’s control covers no link', async ({
    page,
  }) => {
    for (const path of ['/', '/status/']) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'The bakery' });
      const control = await page.locator('.masthead .guide-bar-dock').boundingBox();
      // Every section and the session link, whatever the session link's words are.
      const links = nav.getByRole('link');
      expect(await links.count()).toBeGreaterThanOrEqual(6);
      for (const link of await links.all()) {
        const name = (await link.textContent()) ?? '';
        await expect(link).toBeInViewport({ ratio: 1 });
        const box = await link.boundingBox();
        expect(box, name).not.toBeNull();
        if (box === null || control === null) continue;
        const meets =
          box.x < control.x + control.width &&
          box.x + box.width > control.x &&
          box.y < control.y + control.height &&
          box.y + box.height > control.y;
        expect(meets, `${path}: the control over ${name}`).toBe(false);
      }
    }
    // A short page: the footer reaches the window's foot.
    const foot = await page.locator('footer.site-footer').boundingBox();
    expect((foot?.y ?? 0) + (foot?.height ?? 0)).toBeGreaterThanOrEqual(844 - 1);
  });

  test('the control’s menu closes on Escape and on a tap outside it', async ({ page }) => {
    await page.goto('/');
    const compact = page.getByRole('button', { name: /^Under the hood, (on|off)$/ });
    const recorder = page.getByRole('button', { name: 'Recorder' });
    await compact.click();
    await expect(recorder).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(recorder).toBeHidden();
    await expect(compact).toBeFocused();
    await compact.click();
    await expect(recorder).toBeVisible();
    await page.locator('main h1').click();
    await expect(recorder).toBeHidden();
  });

  test('with the cart open, the guide’s control lies over none of its buttons', async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/menu/');
    await page.getByRole('button', { name: /^Add / }).first().click();
    await page.locator('.cart-bar').click();
    const checkOut = page
      .getByRole('button', { name: 'Check out' })
      .or(page.getByRole('link', { name: 'Check out' }));
    await expect(checkOut.first()).toBeVisible();
    const hits = await page.evaluate(() => {
      const control = document.querySelector('.guide-bar-dock');
      if (control === null) return [];
      const c = control.getBoundingClientRect();
      if (getComputedStyle(control).visibility === 'hidden' || c.width === 0) return [];
      return [...document.querySelectorAll('.cart-sheet a[href], .cart-sheet button')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
        })
        .map((el) => (el.textContent ?? '').trim());
    });
    expect(hits).toEqual([]);
  });

  test('a note’s sheet folds to its line when the visitor scrolls the page beneath it', async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/app/system/');
    const advance = page.getByRole('button', { name: /^Advance 15 minutes/ }).first();
    await advance.click();
    const note = page.getByRole('region', { name: 'Under the hood: The clock' });
    await expect(note).toBeVisible();
    await page.mouse.move(195, 300);
    await page.mouse.wheel(0, 200);
    await expect(note).toHaveCount(0);
    const line = page.locator('.guide-line');
    await expect(line).toContainText('The clock');
    await line.getByRole('button', { name: /The clock/ }).click();
    await expect(note).toBeVisible();
  });

  test('a live note opened by a control low on the screen does not cover that control', async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/app/system/');
    const advance = page.getByRole('button', { name: /^Advance 15 minutes/ }).first();
    await expect(advance).toBeVisible();
    await advance.evaluate((el) =>
      window.scrollTo(
        0,
        el.getBoundingClientRect().top + window.scrollY - window.innerHeight + 160,
      ),
    );
    await advance.click();
    const note = page.getByRole('region', { name: 'Under the hood: The clock' });
    await expect(note).toBeVisible();
    const pressed = await advance.boundingBox();
    const sheet = await note.boundingBox();
    expect(pressed).not.toBeNull();
    expect(sheet).not.toBeNull();
    if (pressed === null || sheet === null) return;
    expect(pressed.y + pressed.height <= sheet.y || pressed.y >= sheet.y + sheet.height).toBe(true);
  });
});
