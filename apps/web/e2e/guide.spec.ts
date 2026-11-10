// The guide, Under the hood (docs/architecture.md, "The guide"; ADR 0014), doing its signature
// thing in a browser: on the console, pressing a card's button on the kitchen board opens a note
// beside it that names the frame sent, the event that came back with its sequence number, and why
// this tool and when not; at checkout, placing an order opens a note with the request, its status
// and its time. A note is not a dialog and takes no focus, axe holds with one open, Escape closes
// it, and the recorder reaches the same by keyboard.
import AxeBuilder from '@axe-core/playwright';
import { freeable } from './cover';
import type { Locator, Page } from '@playwright/test';
import {
  api,
  confirmAtFakeStripe,
  coversOf,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  payOrder,
  password,
  pickupOrder,
  test,
} from './fixtures';

/**
 * The note never covers its anchor, and sits beside it with its caret when there is room. Both
 * are in the window. `room` says whether the page is sure to have that room: the order's page
 * has it (the suite's 1280 px window and the 608 px column). The board has it or not by how many
 * cards the seed's day puts above the pressed one, which grows through the morning, so there only
 * the first half is asked: a note with no room beside its card is placed with no side.
 */
async function beside(page: Page, note: Locator, room = true) {
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
      return apart && (side !== null || !room) ? 'clear' : `apart ${apart}, side ${side}`;
    })
    .toBe('clear');
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
  // Beside the card where there is room, else docked: never over the moved card, its next button
  // or the next card's Start (this check replaced "beside" on 2026-11-10).
  await expect(page.locator('html')).toHaveAttribute('data-guide-marks', 'settled');
  expect(await overWhatMatters(page, 'Start production')).toEqual([]);

  // The note took no focus: the board put it on the card's next button, where it stays.
  const inProduction = page.locator('section[aria-labelledby="board-in_production"]');
  await expect(
    inProduction.getByRole('button', { name: `Mark ready for order ${short}` }),
  ).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoAxeViolations(page);

  // A card's "…" menu open over the board is nearer than the note: the first Escape closes the
  // menu alone, the next the note. The menu is another column's, so the note covers none of it.
  const cardMenu = page
    .locator('section[aria-labelledby="board-in_production"] details.menu > summary')
    .first();
  if (await cardMenu.isVisible()) {
    await cardMenu.click();
    await expect(page.locator('.board details.menu[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.board details.menu[open]')).toHaveCount(0);
    await expect(note).toBeVisible();
  }
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
  // The cause its events carry, which the API names in Bakery-Cause: here, the key it sent.
  await expect(request).toContainText('cause');
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

  test('the gate on the catering page, the checkout and the menu carries its mark after its title at every width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/menu/');
    const adds = page.getByRole('button', { name: /^Add .*, to the cart$/ });
    await expect(adds.first()).toBeEnabled();
    await adds.first().click();
    for (const path of ['/catering/', '/checkout/']) {
      await page.goto(path);
      const mark = page.locator('[data-guide-target="start-here"]');
      await expect(mark, path).toBeVisible();
      await expect(mark).toHaveAttribute('data-guide-how', 'line');
    }
    // Never dropped, whatever room the title leaves on its last line: at every width from 320 to
    // 1280 px a gate's title keeps its mark after its words (pull request #143: in DejaVu Sans
    // the catering title filled its line at 390 px and had none). The menu's gate too.
    for (const path of ['/catering/', '/checkout/', '/menu/']) {
      const target = path === '/menu/' ? 'menu-start' : 'start-here';
      for (const width of [320, 336, 352, 368, 384, 400, 416, 432, 768, 1024, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(path);
        await expect(page.locator(`[data-tour="${target}"]`)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-guide-marks', 'settled');
        const mark = page.locator(`[data-guide-target="${target}"]`);
        await expect(mark, `${path} at ${width} px`).toBeVisible();
        expect(await mark.getAttribute('data-guide-how'), `${path} at ${width} px`).not.toBe(
          'gutter',
        );
      }
    }
  });

  test('a title whose glyph boxes are taller than its lines keeps its mark', async ({ page }) => {
    // Playwright's image on GitHub's runner renders `system-ui` in WenQuanYi Zen Hei, whose glyph
    // box is taller than a 1.2 line. There the two lines of this title overlapped by 0.4 px, and
    // the mark set level with the second was refused as lying on the first (pull request #143's
    // run of 2026-11-10). Any font does the same once its lines are tighter than its glyph box, so
    // the lines are tightened here, through the style object, and the mark must stay. A tighter
    // title is also a shorter one, which would bring the sentence under it up beneath the mark,
    // and a mark is rightly refused on another element's words: the title's bottom margin grows by
    // what its lines lost, so that sentence stays where it was and only the title's lines change.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/catering/');
    const mark = page.locator('[data-guide-target="start-here"]');
    await expect(mark).toBeVisible();
    const before = await mark.boundingBox();
    const title = page.locator('[data-tour="start-here"] .start-title');
    const overlap = await title.evaluate((element) => {
      const tall = element.getBoundingClientRect().height;
      (element as HTMLElement).style.lineHeight = '1';
      const lost = tall - element.getBoundingClientRect().height;
      const margin = Number.parseFloat(getComputedStyle(element).marginBottom);
      (element as HTMLElement).style.marginBottom = `${margin + lost}px`;
      window.dispatchEvent(new Event('resize'));
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0);
      const [first, second] = [lines.at(0), lines.at(-1)];
      return first === undefined || second === undefined || first === second
        ? 0
        : first.bottom - second.top;
    });
    // The premise, in whatever font this machine has: two lines, the first reaching into the second.
    expect(overlap).toBeGreaterThan(1);
    // The marks are placed again for the new lines: this one has moved, or gone.
    await expect.poll(async () => (await mark.boundingBox())?.y).not.toBe(before?.y);
    await expect(page.locator('html')).toHaveAttribute('data-guide-marks', 'settled');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute('data-guide-how', 'line');
  });

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
    // With the gate gone and no result line on the checkout, the note waits as its line once the
    // page has settled (up to about a second: Layer.tsx, afterSettling), so the read waits for it:
    // in CI on 2026-11-10 (#146's run) one read 10 ms after Continue appeared found the open note
    // over the cart's "Back to the menu".
    await expect.poll(() => guideOverControls(page)).toEqual([]);
  });
});

/**
 * The guide's open note and floating line against what matters to the visitor's press:
 * the control pressed (`pressed`, a name without its order), every control of that name, the
 * result (the ringed element and anything marked data-guide-result) and the control the page put
 * the focus on. Each that one covers, named.
 */
async function overWhatMatters(page: Page, pressed: string): Promise<string[]> {
  return page.evaluate((name) => {
    const strip = (s: string) => s.trim().replace(/\s+for order\s+\S+$/i, '');
    const label = (el: Element) => strip(el.getAttribute('aria-label') ?? el.textContent ?? '');
    const guide = [
      ...document.querySelectorAll(
        '.guide-note, .guide-layer:not(.guide-line-docked) > .guide-line',
      ),
    ].map((n) => n.getBoundingClientRect());
    const matters = new Map<Element, string>();
    for (const el of document.querySelectorAll('main button, main a[href], main summary')) {
      if (label(el) === name) matters.set(el, `the control "${name}"`);
    }
    for (const el of document.querySelectorAll('[data-guide-anchor], [data-guide-result]')) {
      matters.set(el, `the result "${(el.textContent ?? '').trim().slice(0, 30)}"`);
    }
    const active = document.activeElement;
    if (active instanceof Element && active.closest('main') !== null) {
      matters.set(active, `the next control "${label(active).slice(0, 30)}"`);
    }
    const hits: string[] = [];
    for (const [el, what] of matters) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      for (const b of guide) {
        if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) {
          hits.push(what);
        }
      }
    }
    return hits;
  }, pressed);
}

for (const width of [1280, 1440]) {
  test(`at ${width} px a move's note covers neither the moved card, its next button nor the next Start`, async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/');
    await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
    const confirmed = page.locator('section[aria-labelledby="board-confirmed"]');
    const start = confirmed.getByRole('button', { name: /^Start production for order / }).first();
    await expect(start).toBeVisible();
    await start.click();
    const note = page.locator('#guide-live, .guide-layer:not(.guide-line-docked) > .guide-line');
    await expect(note.first()).toBeVisible();
    await expect(page.locator('#guide-live')).toContainText('OrderProductionStarted');
    await expect(page.locator('html')).toHaveAttribute('data-guide-marks', 'settled');
    expect(await overWhatMatters(page, 'Start production')).toEqual([]);
  });

  test(`at ${width} px the clock's note covers neither the readout it changed nor its buttons`, async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/system/');
    const day = page.getByRole('button', { name: /^Advance 1 day/ }).first();
    await expect(day).toBeVisible();
    const name = ((await day.getAttribute('aria-label')) ?? (await day.textContent()) ?? '').trim();
    await day.click();
    await expect(page.locator('#guide-live')).toContainText('The clock');
    expect(await overWhatMatters(page, name)).toEqual([]);
    // The clock's other buttons, pressed next, are not under it either.
    for (const next of ['15 minutes', '1 hour']) {
      const other = page.getByRole('button', { name: new RegExp(`^Advance ${next}`) }).first();
      const label = ((await other.getAttribute('aria-label')) ?? '').trim();
      expect(await overWhatMatters(page, label), next).toEqual([]);
    }
  });
}

test('the refund’s note opens in full, inside the window, with no line on it and only the refund ringed', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const menu = page
    .locator('section[aria-labelledby="board-confirmed"] details.menu > summary')
    .first();
  await menu.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await menu.click();
  const panel = page.locator('.board details.menu[open] .menu-panel');
  await panel.getByRole('button', { name: /^Refund order / }).click();
  await panel.getByRole('button', { name: /^Refund all that is left of \$/ }).click();
  const said = page.locator('[data-guide-result]', { hasText: /^Refunded \$/ });
  await expect(said).toBeVisible();
  const note = page.getByRole('region', { name: 'Under the hood: Refunding an order' });
  // In full, by itself: the answer to a deliberate two-press action.
  await expect(note).toBeVisible();
  // In the page's flow, right after the refund's result line, which stays in view: the page
  // scrolls to the rest of the note.
  const placed = await note.evaluate((n) => {
    const slot = n.closest('.guide-flow');
    const before = slot?.previousElementSibling ?? null;
    return {
      inFlow: slot !== null,
      afterTheResult:
        before !== null &&
        (before.matches('[data-guide-result]') ||
          before.querySelector('[data-guide-result]') !== null),
    };
  });
  expect(placed).toEqual({ inFlow: true, afterTheResult: true });
  const box = await note.boundingBox();
  expect(box?.y ?? 900).toBeLessThan(800);
  const line = await said.boundingBox();
  expect(line?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((line?.y ?? 900) + (line?.height ?? 0)).toBeLessThanOrEqual(800);
  // Its folded line is not shown while it is open.
  await expect(page.locator('.guide-layer:not(.guide-line-docked) > .guide-line')).toHaveCount(0);
  // Only the refund's sentence is ringed, and the note is not over it.
  const ringed = page.locator('[data-guide-anchor]');
  if ((await ringed.count()) > 0) await expect(ringed).toHaveAttribute('data-guide-result', '');
  expect(await overWhatMatters(page, 'Refund all')).toEqual([]);
});

test('after a fresh sandbox, a price draft and a move, no row of a note is left waiting at rest', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await demoAccount(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/app/');
  // A fresh sandbox from the console's own button: nothing on this page to sit beside once the
  // board replaces the button, so it waits as its line, over no control.
  await page.getByRole('button', { name: 'New sandbox' }).first().click();
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible({
    timeout: 60_000,
  });
  const line = page.locator('.guide-layer:not(.guide-line-docked) > .guide-line');
  await expect(line).toContainText('A fresh sandbox');
  await expect(page.locator('#guide-live')).toHaveCount(0);
  expect(await guideOverControls(page)).toEqual([]);
  await line.getByRole('button', { name: /A fresh sandbox/ }).click();
  const fresh = page.locator('#guide-live');
  await expect(fresh).toContainText('names none');
  await expect(fresh.locator('[data-state="expected"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A price draft: the page sends its PATCH with no Idempotency-Key, and the API names the cause
  // it wrote under in Bakery-Cause (ADR 0013's postscript of 2026-11-10), so the note follows its
  // MenuItemChanged to the recorder like any write.
  await page.goto('/app/menu/');
  const field = page.getByRole('textbox', { name: /^Price of Country loaf, Whole/ });
  await expect(field).toBeVisible();
  await field.fill('9.75');
  await page.getByRole('button', { name: /^Set the price of Country loaf, Whole/ }).click();
  const draft = page.locator('#guide-live');
  await expect(draft).toBeVisible();
  await expect(draft).toContainText('cause');
  await expect(draft).not.toContainText('cannot be tied');
  await expect(
    draft.locator('[data-state="observed"]', { hasText: 'MenuItemChanged' }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(draft.locator('[data-state="expected"]')).toHaveCount(0);

  // A board move: its one event comes back over the socket.
  await page.goto('/app/');
  const start = page
    .locator('section[aria-labelledby="board-confirmed"]')
    .getByRole('button', { name: /^Start production for order / })
    .first();
  await start.click();
  const move = page.locator('#guide-live');
  await expect(
    move.locator('[data-state="observed"]', { hasText: 'OrderProductionStarted' }),
  ).toBeVisible();
  await expect(move.locator('[data-state="expected"]')).toHaveCount(0);
});

test('with the recorder open on Dispatch, Propose is pressed beside it, and its row and its hops agree', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/dispatch/');
  const form = page.getByRole('form', { name: 'Propose a plan' });
  await expect(form).toBeVisible();
  await (await recorderButton(page)).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel).toContainText('Live, on the recorder’s socket');
  // A column of the page: nothing of the page's main column is under it.
  const under = await page.evaluate(() => {
    const p = document.querySelector('.guide-panel')?.getBoundingClientRect();
    if (p === undefined) return ['no panel'];
    return [...document.querySelectorAll('main button, main a[href], main input, main select')]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter(
        ({ r }) =>
          r.width > 0 &&
          r.left < p.right &&
          r.right > p.left &&
          r.top < p.bottom &&
          r.bottom > p.top,
      )
      .map(({ c }) => (c.textContent ?? '').trim().slice(0, 30));
  });
  expect(under).toEqual([]);
  // A plain click, no force: the panel is not over it.
  await form.getByRole('button', { name: 'Propose' }).click();
  await expect(page.getByText(/^Proposed a plan that uses/)).toBeVisible();
  const row = panel.locator('[data-guide-trace]').first();
  await row.getByRole('button').click();
  // RouteProposed is tied by the cause the API named (Bakery-Cause), in the row and in the hops.
  await expect(row.locator('[data-state="observed"]', { hasText: 'RouteProposed' })).toBeVisible({
    timeout: 10_000,
  });
  const trace = await row.getAttribute('data-guide-trace');
  await expect(
    panel.locator(`[data-guide-hop-of="${trace}"]`, { hasText: 'RouteProposed' }),
  ).toBeVisible();
  // Every hop the panel calls this action's is an observed row of the action, and no row of it
  // says an event is on its way while the panel lists that event as delivered.
  const disagree = await page.evaluate(() => {
    const out: string[] = [];
    for (const hop of document.querySelectorAll('.guide-panel [data-guide-hop-of]')) {
      const id = hop.getAttribute('data-guide-hop-of') ?? '';
      const type = hop.querySelector('code')?.textContent ?? '';
      const rows = document.querySelector(`.guide-panel [data-guide-trace="${CSS.escape(id)}"]`);
      if (rows === null || rows.querySelector('.guide-chain') === null) continue;
      const states = [...rows.querySelectorAll('.guide-hop')]
        .filter((h) => h.querySelector('code')?.textContent === type)
        .map((h) => h.getAttribute('data-state'));
      if (!states.includes('observed')) out.push(`${type}: ${states.join(',') || 'no row'}`);
    }
    return out;
  });
  expect(disagree).toEqual([]);
  await expectNoAxeViolations(page);
});

/** A new sandbox's board at 1280 px (or `width`), live, with its pages's frames counted. */
async function liveBoard(page: Page, width = 1280, height = 900) {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width, height });
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
}

/** Presses Start on the first confirmed card and waits for its note in the page's flow. */
async function startFirst(page: Page): Promise<Locator> {
  await page
    .locator('section[aria-labelledby="board-confirmed"]')
    .getByRole('button', { name: /^Start production for order / })
    .first()
    .click();
  const note = page.locator('.guide-flow #guide-live');
  await expect(note).toContainText('OrderProductionStarted');
  // Under the card in its new column (when the ack comes before the event, the note is first
  // under the card where it was, and follows it), and past the moment it may still settle.
  await expect(
    page.locator('section[aria-labelledby="board-in_production"] .guide-flow'),
  ).toHaveCount(1);
  await page.waitForTimeout(400);
  return note;
}

/** Waits `n` of the page's frames. */
const frames = (page: Page, n: number) =>
  page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count;
        const next = () => (--left <= 0 ? done() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    n,
  );

/** Keeps, in the page, the card the note sits under now and every change of its column's children. */
const watchSlot = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { card: Element | null; changes: number; y: number };
    const slot = document.querySelector('.guide-flow');
    w.card = slot?.previousElementSibling ?? null;
    w.changes = 0;
    w.y = window.scrollY;
    new MutationObserver((records) => {
      for (const r of records) w.changes += r.addedNodes.length + r.removedNodes.length;
    }).observe(slot?.parentElement ?? document.body, { childList: true });
  });

/** Where the note sits now against what watchSlot kept. */
const slotState = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { card: Element | null; changes: number; y: number };
    const slot = document.querySelector('.guide-flow');
    return {
      underTheMovedCard: slot !== null && slot.previousElementSibling === w.card,
      childrenChanged: w.changes,
      ringOnTheCard: w.card?.hasAttribute('data-guide-anchor') ?? false,
      scrolled: Math.round(window.scrollY - w.y),
    };
  });

test('on the console a move’s note is drawn under its card, in the page, and the next button does not move', async ({
  page,
}) => {
  await liveBoard(page, 1280, 800);
  // Layout shift, both ways: every entry, and those with no recent input (a press is input for
  // half a second, so the note's arrival counts only in the first sum).
  await page.evaluate(() => {
    const w = window as unknown as { shiftAll: number; shiftQuiet: number };
    w.shiftAll = 0;
    w.shiftQuiet = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
      }[]) {
        w.shiftAll += e.value;
        if (!e.hadRecentInput) w.shiftQuiet += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });
  // Where every card is before the press, in the page.
  const cardsAt = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.board .column')].map((column) => ({
        state: column.getAttribute('data-state'),
        cards: [...column.querySelectorAll('.cards > li.card')].map((c) => ({
          id: c.querySelector('.card-id')?.textContent ?? '',
          y: Math.round(c.getBoundingClientRect().top + window.scrollY),
        })),
      })),
    );
  const note = await startFirst(page);
  const next = page.locator('section[aria-labelledby="board-in_production"] button:focus');
  await expect(next).toBeVisible();
  // In the page's flow, right under the moved card, in its column; not floating, not docked.
  const placed = await note.evaluate((n) => {
    const slot = n.closest('.guide-flow');
    const card = slot?.previousElementSibling;
    return {
      inFlow: slot !== null,
      underCard: card?.contains(document.activeElement) ?? false,
      position: getComputedStyle(n).position,
    };
  });
  expect(placed).toEqual({ inFlow: true, underCard: true, position: 'static' });
  await expect(note).toContainText(BOARD_LINE_START);
  // Read at the column's width: no word, in a chip or in running text, is cut across two lines;
  // a name wraps only between its words (start_ production, Order Production Started).
  expect(await brokenWords(page)).toEqual([]);
  expect(await overWhatMatters(page, 'Start production')).toEqual([]);
  // Measured in the page, not the window: the note opens and leaves below the next button.
  const pageY = () => next.evaluate((b) => b.getBoundingClientRect().top + window.scrollY);
  const shown = await pageY();
  // The honest half: a card below the note in its column moves down by the note's height, and
  // no card in another column moves at all.
  const height = await note.evaluate((n) => {
    const slot = n.closest('.guide-flow') as HTMLElement;
    const style = getComputedStyle(slot);
    // The note's own height, its margins, and the gap its list puts between two items.
    const gap = parseFloat(getComputedStyle(slot.parentElement as Element).rowGap) || 0;
    return (
      slot.getBoundingClientRect().height +
      parseFloat(style.marginTop) +
      parseFloat(style.marginBottom) +
      gap
    );
  });
  const below = await note.evaluate((n) => {
    const after = n.closest('.guide-flow')?.nextElementSibling;
    return after === null || after === undefined
      ? null
      : {
          id: after.querySelector('.card-id')?.textContent ?? '',
          y: Math.round(after.getBoundingClientRect().top + window.scrollY),
        };
  });
  const during = await cardsAt();
  await expect(note).toHaveCount(0, { timeout: 15_000 });
  // No card in another column moved for the note: where each was while it showed is where it is
  // once it has gone. (The board's own status line, written above the columns on the answer,
  // moves every column alike, before the note is measured.)
  const gone = await cardsAt();
  const others = (cols: typeof during) =>
    cols
      .filter((c) => c.state !== 'in_production')
      .flatMap((c) => c.cards.map((card) => `${c.state} ${card.id} ${card.y}`));
  expect(others(gone)).toEqual(others(during));
  expect(Math.abs((await pageY()) - shown)).toBeLessThanOrEqual(1);
  if (below !== null) {
    const now = gone.flatMap((c) => c.cards).find((c) => c.id === below.id);
    // While the note showed, the card under it sat lower by the note's height; now it is back up.
    expect(Math.abs((now?.y ?? 0) + height - below.y)).toBeLessThanOrEqual(1);
  }
  const shift = await page.evaluate(() => {
    const w = window as unknown as { shiftAll: number; shiftQuiet: number };
    return { all: w.shiftAll, quiet: w.shiftQuiet };
  });
  console.log(
    `layout shift, board move note in flow: every entry ${shift.all.toFixed(4)}, no recent input ${shift.quiet.toFixed(4)}`,
  );
  expect(shift.all).toBeLessThan(0.25);
  expect(shift.quiet).toBeLessThan(0.05);
});

test('at the narrowest window that shows the board’s five columns, a card is under 150 px and a move’s note waits as its line', async ({
  page,
}) => {
  // The board shows five columns above 72rem (global.css): 1153 px is the narrowest such window.
  await liveBoard(page, 1153, 900);
  const width = (await page.locator('.board .cards > li').first().boundingBox())?.width ?? 0;
  expect(width).toBeLessThan(150);
  await page
    .locator('section[aria-labelledby="board-confirmed"]')
    .getByRole('button', { name: /^Start production for order / })
    .first()
    .click();
  const line = page.locator('.guide-layer:not(.guide-line-docked) > .guide-line');
  await expect(line).toContainText('The kitchen board');
  await expect(page.locator('.guide-flow')).toHaveCount(0);
  expect(await overWhatMatters(page, 'Start production')).toEqual([]);
});

for (const [column, side] of [
  [168, 'wide'],
  [160, 'narrow'],
] as const) {
  test(`with the board’s columns forced to ${column} px, a move’s note is ${side === 'wide' ? 'drawn in its column, every word whole' : 'its line'}`, async ({
    page,
  }) => {
    await liveBoard(page, 1440, 900);
    // The measure forced: five columns of a set width, set through the style object.
    await page.evaluate((px) => {
      const board = document.querySelector<HTMLElement>('.board');
      if (board !== null) board.style.gridTemplateColumns = `repeat(5, ${px}px)`;
    }, column);
    const width = (await page.locator('.board .cards > li').first().boundingBox())?.width ?? 0;
    if (side === 'wide') expect(width).toBeGreaterThanOrEqual(150);
    else expect(width).toBeLessThan(150);
    await page
      .locator('section[aria-labelledby="board-confirmed"]')
      .getByRole('button', { name: /^Start production for order / })
      .first()
      .click();
    if (side === 'wide') {
      await expect(page.locator('.guide-flow #guide-live')).toContainText('OrderProductionStarted');
      expect(await brokenWords(page)).toEqual([]);
    } else {
      const line = page.locator('.guide-layer:not(.guide-line-docked) > .guide-line');
      await expect(line).toContainText('The kitchen board');
      await expect(page.locator('.guide-flow')).toHaveCount(0);
    }
  });
}

test('a press on a note’s own Pin, or a Tab through it, leaves the note under its card', async ({
  page,
}) => {
  await liveBoard(page);
  const note = await startFirst(page);
  await frames(page, 10);
  await watchSlot(page);
  const pin = note.getByRole('button', { name: 'Keep this note open' });
  await pin.click();
  await frames(page, 30);
  expect(await slotState(page)).toEqual({
    underTheMovedCard: true,
    childrenChanged: 0,
    ringOnTheCard: true,
    scrolled: 0,
  });
  await expect(pin).toBeFocused();
  // Tab through the note's own controls: the same.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    await frames(page, 10);
    const inside = await note.evaluate((n) => n.contains(document.activeElement));
    if (!inside) break;
    // The browser may scroll a focused link low in the note into view; the note itself stays.
    expect(await slotState(page)).toMatchObject({
      underTheMovedCard: true,
      childrenChanged: 0,
      ringOnTheCard: true,
    });
  }
});

test('a move’s note stays with the moved card while the focus goes elsewhere on the board', async ({
  page,
}) => {
  await liveBoard(page);
  await startFirst(page);
  await frames(page, 10);
  await watchSlot(page);
  // Another column's card menu, then a Tab across three cards.
  const menu = page
    .locator('section[aria-labelledby="board-confirmed"] details.menu > summary')
    .first();
  await menu.click();
  await frames(page, 5);
  expect(await slotState(page)).toMatchObject({ underTheMovedCard: true, scrolled: 0 });
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    await frames(page, 10);
    expect(await slotState(page), `after Tab ${i + 1}`).toMatchObject({
      underTheMovedCard: true,
      scrolled: 0,
    });
  }
});

test('a note in the page arrives at full contrast', async ({ page }) => {
  await liveBoard(page);
  // From the frame the note is put in the page and for five frames after, its opacity is 1.
  await page.evaluate(() => {
    const w = window as unknown as { seen: number[] };
    w.seen = [];
    new MutationObserver(() => {
      const note = document.querySelector('.guide-flow .guide-note');
      if (note === null || w.seen.length > 0) return;
      const look = (left: number) => {
        w.seen.push(Number(getComputedStyle(note).opacity));
        if (left > 0) requestAnimationFrame(() => look(left - 1));
      };
      look(5);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await startFirst(page);
  await frames(page, 10);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  expect(seen.length).toBeGreaterThanOrEqual(6);
  expect(seen.filter((o) => o !== 1)).toEqual([]);
});

test('a note folding away takes no pointer or focus, and none is left folded in the page', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await liveBoard(page);
  const note = await startFirst(page);
  // The moment it starts to fold, the pointer comes to where it is.
  await page.waitForFunction(
    () => document.querySelector('.guide-flow[data-leaving]') !== null,
    null,
    {
      timeout: 15_000,
      polling: 'raf',
    },
  );
  const folding = await page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>('.guide-flow[data-leaving]');
    return slot?.inert ?? false;
  });
  expect(folding).toBe(true);
  const box = await note.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 10);
  await page.waitForTimeout(1_000);
  // Gone, or whole again: never folded to nothing and still in the page.
  await expect(page.locator('.guide-flow[data-leaving]')).toHaveCount(0);
  if ((await note.count()) > 0)
    expect((await note.boundingBox())?.height ?? 0).toBeGreaterThan(100);
});

test('a pointer below the note in its column holds it, until the pointer leaves the window', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await liveBoard(page, 1280, 1500);
  const note = await startFirst(page);
  const spot = await note.evaluate((n) => {
    const slot = n.closest('.guide-flow') as Element;
    const column = (slot.closest('.column') ?? slot.parentElement)?.getBoundingClientRect();
    const r = slot.getBoundingClientRect();
    // Midway between the note's foot and its column's, inside the window.
    const foot = Math.min(column?.bottom ?? r.bottom, window.innerHeight - 4);
    return { x: (column?.left ?? 0) + 20, y: Math.round((r.bottom + foot) / 2) };
  });
  await page.mouse.move(spot.x, spot.y);
  // Past the note's own time and the first wait.
  await page.waitForTimeout(12_000);
  await expect(note).toBeVisible();
  // The pointer leaves through the window's edge: the note no longer waits on it.
  await page.evaluate(() =>
    document.documentElement.dispatchEvent(
      new PointerEvent('pointerleave', { pointerType: 'mouse' }),
    ),
  );
  await expect(note).toHaveCount(0, { timeout: 5_000 });
});

test('Publish menu’s note opens just above the stuck bar, short, over neither the bar nor the version line', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/menu/');
  // A price to publish first: with nothing drafted, Publish is refused.
  const field = page.getByRole('textbox', { name: /^Price of Country loaf, Whole/ });
  await field.fill('9.75');
  await page.getByRole('button', { name: /^Set the price of Country loaf, Whole/ }).click();
  await expect(page.locator('#guide-live')).toContainText('MenuItemChanged', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  const publish = page.getByRole('button', { name: 'Publish menu' });
  await expect(publish).toBeVisible();
  await publish.click();
  const note = page.locator('#guide-live');
  await expect(note).toContainText('MenuPublished', { timeout: 10_000 });
  await frames(page, 30);
  const read = await page.evaluate(() => {
    const n = document.querySelector('#guide-live') as HTMLElement;
    const r = n.getBoundingClientRect();
    const bar = document.querySelector('.publish-bar')?.getBoundingClientRect();
    const version = [...document.querySelectorAll('main p')].find((p) =>
      /Version \d+ is published/.test(p.textContent ?? ''),
    );
    const v = version?.getBoundingClientRect();
    const meets = (a: DOMRect | undefined) =>
      a !== undefined &&
      a.left < r.right &&
      a.right > r.left &&
      a.top < r.bottom &&
      a.bottom > r.top;
    const versionInView = v !== undefined && v.bottom > 0 && v.top < window.innerHeight;
    return {
      overBar: meets(bar),
      overVersion: versionInView && meets(v),
      inWindow: r.top >= 0 && r.bottom <= window.innerHeight,
      ownScroll: n.scrollHeight > n.clientHeight + 1,
      halfOrLess: r.height <= window.innerHeight / 2,
      aboveBar: bar === undefined ? null : Math.round(bar.top - r.bottom),
      height: Math.round(r.height),
    };
  });
  console.log(`Publish note: ${read.height} px tall, ${read.aboveBar} px above the bar`);
  expect(read).toMatchObject({
    overBar: false,
    overVersion: false,
    inWindow: true,
    ownScroll: false,
    halfOrLess: true,
  });
  expect(read.aboveBar).toBeGreaterThanOrEqual(0);
  expect(read.aboveBar).toBeLessThanOrEqual(16);
});

test('Save draft’s note goes under the new draft card, which does not move as it comes and goes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/customers/');
  const save = page.getByRole('button', { name: 'Save draft' });
  await expect(save).toBeVisible();
  await save.click();
  const note = page.locator('#guide-live');
  await expect(note).toContainText('CampaignDrafted');
  const schedule = page.getByRole('button', { name: 'Schedule', exact: true }).first();
  await expect(schedule).toBeVisible();
  const at = () =>
    schedule.evaluate((b) => {
      const card = b.closest('li');
      const y = (e: Element | null | undefined) =>
        e === null || e === undefined
          ? -1
          : Math.round(e.getBoundingClientRect().top + window.scrollY);
      return { card: y(card), schedule: y(b) };
    });
  const shown = await at();
  await expect(note).toHaveCount(0, { timeout: 15_000 });
  expect(await at()).toEqual(shown);
});

test('two tabs press Start on one order: the second note says its move was a repeat, and nothing waits', async ({
  page,
}) => {
  await liveBoard(page);
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 900 });
  await other.goto('/app/');
  await expect(other.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const first = page
    .locator('section[aria-labelledby="board-confirmed"]')
    .getByRole('button', { name: /^Start production for order / })
    .first();
  const name = (await first.getAttribute('aria-label')) ?? '';
  await expect(other.getByRole('button', { name, exact: true })).toBeVisible();
  // Both tabs press the same order's Start in the same moment, before either board has heard the
  // other's move: a click dispatched in each page, as a press is.
  const press = (p: Page) =>
    p.evaluate((label) => {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
    }, name);
  await Promise.all([press(page), press(other)]);
  const notes = [page.locator('#guide-live'), other.locator('#guide-live')];
  for (const n of notes) await expect(n).toContainText('OrderProductionStarted');
  const states = await Promise.all(
    notes.map((n) =>
      n.evaluate((el) =>
        [...el.querySelectorAll('.guide-hop')]
          .filter((h) => h.textContent?.includes('OrderProductionStarted'))
          .map((h) => h.getAttribute('data-state')),
      ),
    ),
  );
  // One tab's move made the event; the other's is the repeat, written nothing.
  expect(states.flat().sort()).toEqual(['noop', 'observed']);
  for (const n of notes) await expect(n.locator('[data-state="expected"]')).toHaveCount(0);
  await other.close();
});

/**
 * The words of the in-flow note that a line break cuts in two: each run of letters between a
 * space and a break opportunity (a text node holds one piece of a name) must lie on one line.
 */
async function brokenWords(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const note = document.querySelector('.guide-flow #guide-live');
    if (note === null) return ['no note in the flow'];
    const broken: string[] = [];
    const walk = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
      const text = node.textContent ?? '';
      // A hyphen, an underscore or a slash ends a word too: a line may break after one.
      for (const m of text.matchAll(/[^\s_/-]+[_/-]?/g)) {
        const range = document.createRange();
        range.setStart(node, m.index ?? 0);
        range.setEnd(node, (m.index ?? 0) + m[0].length);
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (tops.size > 1) broken.push(m[0]);
      }
    }
    return broken;
  });
}

/** The opening of the board's Start line (src/guide/kitchen.ts, BOARD_MOVES). */
const BOARD_LINE_START = 'OrderProductionStarted reaches the board on every screen';

test.describe('a stranger signing in', () => {
  // The first look at the session, before there is one, is a 401 that Chromium logs.
  test.use({ allowedStatuses: [401] });

  test('a demo account’s note waits as its line, over none of the other ways in, at once', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/signin/');
    const create = page.getByRole('form', { name: 'Create a demo account' });
    const submit = create.getByRole('button', { name: 'Create a demo account' });
    await expect(submit).toBeEnabled();
    await create.getByLabel('Password').fill(password());
    // From the press on, every frame: no note over a provider's button.
    await page.evaluate(() => {
      const w = window as unknown as { overProviders: string[] };
      w.overProviders = [];
      const look = () => {
        const notes = [...document.querySelectorAll('.guide-note')]
          .filter((n) => getComputedStyle(n).visibility !== 'hidden')
          .map((n) => n.getBoundingClientRect());
        for (const b of document.querySelectorAll('main button, main a[href]')) {
          if (!/Google|GitHub/.test(b.textContent ?? '')) continue;
          const r = b.getBoundingClientRect();
          for (const n of notes) {
            if (r.left < n.right && r.right > n.left && r.top < n.bottom && r.bottom > n.top) {
              w.overProviders.push((b.textContent ?? '').trim());
            }
          }
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await submit.click();
    await expect(page.locator('code.username')).toBeVisible();
    const line = page.locator('.guide-layer:not(.guide-line-docked) > .guide-line');
    await expect(line).toContainText('A demo account');
    await page.waitForTimeout(1_500);
    expect(
      await page.evaluate(() => (window as unknown as { overProviders: string[] }).overProviders),
    ).toEqual([]);
  });
});

test.describe('a keyboard on the menu', () => {
  // The first look at the session, before there is one, is a 401 that Chromium logs.
  test.use({ allowedStatuses: [401] });

  test('on the menu a keyboard meets the nav, the page, the footer, then the guide; never a mark', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/menu/');
    await expect(page.locator('.guide-spot').first()).toBeVisible();
    const order: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return 'body';
        if (el.closest('.guide-spot')) return 'mark';
        if (el.closest('[data-guide-root]')) return 'guide';
        if (el.closest('header')) return 'header';
        if (el.closest('main')) return 'main';
        if (el.closest('footer')) return 'footer';
        return 'other';
      });
      if (order.at(-1) !== where) order.push(where);
      if (where === 'guide' && order.includes('footer')) break;
    }
    expect(order).not.toContain('mark');
    const guide = order.indexOf('guide');
    expect(guide).toBeGreaterThan(order.indexOf('main'));
    expect(guide).toBeGreaterThan(order.indexOf('footer'));
    expect(order.indexOf('main')).toBeGreaterThan(order.indexOf('header'));
  });
});

test('a card scrolled under the console’s own top bar is the viewport’s doing, not a small target', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  // The state of pull request #140's run, put there on purpose: a card's Start scrolled until the
  // top bar's bottom edge cuts it, computed from both boxes. Whether axe raises target-size at a
  // given overlap is axe's business and changes with fonts and versions (in DejaVu Sans it named
  // none on #143's run); what this proves is the helper's own rule for that control.
  const start = page
    .locator('section[aria-labelledby="board-confirmed"] .card-actions .btn-primary')
    .first();
  await expect(start).toBeVisible();
  await start.evaluate((el) => {
    el.setAttribute('data-test-under-bar', '');
    const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 56;
    const r = el.getBoundingClientRect();
    // Its middle on the bar's bottom edge: half of it under the bar, half below.
    window.scrollBy(0, r.top + r.height / 2 - bar);
  });
  await page.waitForFunction(() => document.documentElement.dataset.guideMarks === 'settled');
  const covers = await coversOf(page, ['[data-test-under-bar]']);
  const node = covers.nodes[0];
  expect(node).not.toBeNull();
  if (node === null || node === undefined) return;
  // Under one of the page's own bars, not under the guide, and a scroll would free it.
  expect(node.underBar).toBe(true);
  expect(node.underGuide).toBe(false);
  expect(freeable(node, covers.bands, covers.maxScroll)).toBe(true);
  // What axe alone says here, for the record and not as an assertion.
  const raw = await new AxeBuilder({ page }).withRules(['target-size']).analyze();
  const named = raw.violations.flatMap((v) => v.nodes.map((x) => String(x.target[0])));
  if (named.length > 0) console.log(`axe alone names, under the top bar: ${named.join(', ')}`);
  // The helper passes there.
  await expectNoAxeViolations(page);
});

test.describe('a control under the guide’s own layer', () => {
  test.use({ allowedStatuses: [401, 404] });

  test('still fails the helper: the guide’s own layer is not one of the page’s bars (fixture page)', async ({
    page,
  }) => {
    // A small page built for the check, on the 404 page: a page button a scroll could move, and
    // one of the guide's marks (a button in a data-guide-root) over its right half, as a mark or
    // a note's button would lie over a control. Styles are set through the style object, as the
    // policy requires.
    await page.goto('/no-such-page/');
    await page.evaluate(() => {
      const tall = document.createElement('div');
      tall.style.height = '3000px';
      document.body.append(tall);
      const target = document.createElement('button');
      target.textContent = 'Go';
      target.id = 'covered';
      Object.assign(target.style, {
        position: 'absolute',
        top: '300px',
        left: '40px',
        width: '40px',
        height: '24px',
      });
      document.body.append(target);
      const root = document.createElement('div');
      root.setAttribute('data-guide-root', '');
      root.className = 'guide-layer';
      const mark = document.createElement('button');
      mark.className = 'guide-spot';
      mark.setAttribute('aria-label', 'Under the hood: a test mark');
      Object.assign(mark.style, {
        position: 'absolute',
        top: '298px',
        left: '58px',
        width: '28px',
        height: '28px',
      });
      root.append(mark);
      document.body.append(root);
    });
    await expect(expectNoAxeViolations(page)).rejects.toThrow(/target-size/);
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
      // A part read out and not shown (the chip beside the phone's control) is not cut.
      if (getComputedStyle(el).clipPath === 'inset(50%)') return [];
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

  test('the guide’s control reads “Under the hood” in one place on every page, over no link or control', async ({
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
    const order = await api<{ id: string }>(
      page,
      'POST',
      `/v1/sandboxes/${sandbox.id}/orders`,
      want,
    );
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
      lines: want.lines,
      note: '',
      kind: 'pickup',
      zone: 'z1',
      slot: '',
    });
    // Where the control is, from the masthead's top-left, and what it covers there.
    const where = () =>
      page.evaluate(() => {
        const control = document.querySelector('.guide-compact');
        const masthead = document.querySelector('.masthead');
        if (control === null || masthead === null) return null;
        const c = control.getBoundingClientRect();
        const m = masthead.getBoundingClientRect();
        const over = [
          ...document.querySelectorAll('a[href], button, input, select, textarea, label'),
        ]
          .filter((el) => !control.contains(el) && el.closest('[data-guide-root]') === null)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.left < c.right &&
              r.right > c.left &&
              r.top < c.bottom &&
              r.bottom > c.top
            );
          })
          .map((el) => (el.textContent ?? '').trim().slice(0, 30));
        return {
          left: Math.round(c.left - m.left),
          fromLinks: Math.round(
            c.top -
              (document.querySelector('.site-nav-links')?.getBoundingClientRect().bottom ?? 0),
          ),
          text: (control.textContent ?? '').trim(),
          over,
        };
      });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const seen: { left: number; fromLinks: number }[] = [];
      for (const path of ['/', '/menu/', '/checkout/', `/order/?id=${order.body.id}`]) {
        await page.goto(path);
        const compact = page.getByRole('button', { name: /^Under the hood, (on|off)$/ });
        await expect(compact).toBeVisible();
        // Words a stranger reads without pressing anything.
        await expect(compact).toContainText('Under the hood');
        const at = await where();
        expect(at, path).not.toBeNull();
        if (at === null) continue;
        expect(at.over, `${width} ${path}`).toEqual([]);
        seen.push({ left: at.left, fromLinks: at.fromLinks });
      }
      // The same place on each: the same distance from the masthead's edge and from its links.
      for (const at of seen) expect(at).toEqual(seen[0]);
      // The console's control is the same one in words, in its top bar's own row.
      await page.goto('/app/');
      const toggle = page.getByRole('switch', { name: 'Under the hood' });
      await expect(toggle).toBeVisible();
      await expect(toggle.locator('.guide-switch-text')).toBeVisible();
      await expect(toggle).toContainText('Under the hood');
      const covered = await toggle.evaluate((t) => {
        const c = t.getBoundingClientRect();
        return [...document.querySelectorAll('a[href], button, input, select')]
          .filter((el) => el.closest('[data-guide-root]') === null)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.left < c.right &&
              r.right > c.left &&
              r.top < c.bottom &&
              r.bottom > c.top
            );
          })
          .map((el) => (el.textContent ?? '').trim().slice(0, 30));
      });
      expect(covered, `${width} console`).toEqual([]);
    }
    // A tap opens the whole control: the switch, the short path and the recorder.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/menu/');
    const compact = page.getByRole('button', { name: /^Under the hood, (on|off)$/ });
    await compact.click();
    await expect(page.getByRole('switch', { name: 'Under the hood' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recorder' })).toBeVisible();
    await compact.click();
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

  /**
   * A sheet on the screen hears the page from its first moment. The page sends the wheel itself,
   * in the very task that draws the note: a wheel the suite sends arrives some milliseconds later,
   * which hid the gap until one run on the runner (2026-11-10) sent its wheel 23 ms after the note
   * showed. The listener was then attached in a passive effect, a moment after the note was drawn;
   * that wheel went unheard, and the sheet stayed over the page until its time ran out.
   */
  test('a note’s sheet hears a wheel in the task that draws it', async ({ page }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/app/system/');
    await page.evaluate(() => {
      const drawn = new MutationObserver(() => {
        if (document.getElementById('guide-live') === null) return;
        drawn.disconnect();
        const beneath = document.querySelector('main') ?? document.body;
        beneath.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
      });
      drawn.observe(document.body, { childList: true, subtree: true });
    });
    await page
      .getByRole('button', { name: /^Advance 15 minutes/ })
      .first()
      .click();
    await expect(page.locator('.guide-line')).toContainText('The clock');
    await expect(page.getByRole('region', { name: 'Under the hood: The clock' })).toHaveCount(0);
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
