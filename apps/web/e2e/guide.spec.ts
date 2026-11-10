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

test('placing an order at checkout opens a note with the request, its status and its time', async ({
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
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
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
  // No socket on this page: the events are shown as expected, not as observed.
  await expect(note.locator('[data-state="expected"]', { hasText: 'OrderPlaced' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoAxeViolations(page);
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
  await expect(page.getByRole('region', { name: 'Under the hood: The clock' })).toBeVisible();
});

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
