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
  const recorder = page.getByRole('button', { name: 'Recorder' });
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
  await expect(recorder).toBeFocused();
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
  await liveSandbox(page);
  await page.goto('/menu/');
  await page
    .getByRole('button', { name: /^Add .*, to the cart$/ })
    .first()
    .click();
  await page.goto('/checkout/');

  // The first day on offer with a pickup time still open, once that day's schedule has been read.
  const status = page.locator('#slot-status');
  await expect(status).toHaveText(/slots open\.|closed that day|not baked that day/);
  const days = await page.locator('#day option').count();
  expect(days).toBeGreaterThan(1);
  const picker = page.getByRole('group', { name: 'Pickup time' });
  const open = picker.locator('input[type="radio"]:not([disabled])');
  for (let i = 0; i < days; i++) {
    await page.locator('#day').selectOption({ index: i });
    const day = await page.locator('#day').inputValue();
    // The day's own slots (a radio's value starts with its date), or the line that it is closed.
    await expect(
      picker.locator(`input[value^="${day}"]`).or(page.getByText('closed that day')).first(),
    ).toBeVisible();
    await expect(status).toHaveText(/slots open\.|closed that day|not baked that day/);
    if ((await open.count()) > 0) break;
  }
  await open.first().check();
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

test('with the switch off, a press opens no note, and it stays off in the tab', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  await page.goto('/app/');
  const toggle = page.getByRole('switch', { name: 'Under the hood' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.guide-spot')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Under the hood' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
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
});
