// The console's fourth-audit fixes (2026-11-10), measured in the browser rather than looked at:
// Dispatch's Stops table reads whole at 1280 and 1440 px beside no empty block (G5); the order a
// visitor placed in this tab says "Yours" on its card and the board opens on its column (G7); one
// line above the board after three moves (G8); a card's event chip inside its card, and a ready
// delivery that says what it waits for (G9); the ledger says who recorded a refund (G13); and
// System's dates in the console's forms, its clock phrase on one line (F18, F19).
//
// Elements are picked by what they are (the visitor's own order by its id, a ledger row by its
// order), never by which seeded card happens to come first.
import type { Locator, Page } from '@playwright/test';
import {
  api,
  businessDate,
  deliveryOrder,
  demoAccount,
  expect,
  expectNoAxeViolations,
  guestSandbox,
  liveSandbox,
  nthOpenDay,
  payOrder,
  pickupOrder,
  test,
} from './fixtures';
import { PLACED_ORDERS_ITEM } from '../src/lib/placed-orders';

type Menu = Parameters<typeof pickupOrder>[0];

interface Sandbox {
  id: string;
  clock_offset_s?: number;
}

/** "Tue 10 Nov, 5:06 am": lib/when.ts's time with its day; a year only when it is not this one. */
const MOMENT = String.raw`[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}(?: \d{4})?, \d{1,2}:\d{2} (?:am|pm)`;

/** Places a paid order and returns its id. */
async function paidOrder(page: Page, sandbox: Sandbox, want: unknown): Promise<string> {
  const placed = await api<{ id: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    want,
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  await payOrder(page, sandbox.id, placed.body.id);
  return placed.body.id;
}

/** Stands in for Stripe.js, which cannot load here: defines no `Stripe` (order-status.spec.ts). */
const STRIPE_STUB = '/* e2e: Stripe.js cannot load on this machine */';

/**
 * Places an order through the real checkout in this tab, as a visitor does: the cart as the menu
 * leaves it, then how, when and Place order. Returns the order's id from its page.
 */
async function checkoutOrder(page: Page, want: ReturnType<typeof pickupOrder>): Promise<string> {
  await page
    .context()
    .route('https://js.stripe.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: STRIPE_STUB }),
    );
  await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
    lines: want.lines,
    note: '',
    kind: 'pickup',
    zone: 'z1',
    slot: '',
  });
  await page.goto('/checkout/');
  const how = page.locator('section[aria-labelledby="how-heading"]');
  await expect(how.getByRole('radio', { name: /^Pickup/ })).toBeChecked();
  await how.getByRole('button', { name: 'Continue' }).click();
  await page.locator(`input[name="day"][value="${want.slot.slice(0, 10)}"]`).check();
  const slot = page.locator(`input[name="slot"][value^="${want.slot.slice(0, 16)}"]`);
  await expect(slot).toBeEnabled();
  await slot.check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText(/\d+ min left to pay\./)).toBeVisible();
  await page.getByRole('link', { name: 'Follow this order' }).click();
  await expect(page).toHaveURL(/\/order\/\?id=/);
  const id = new URL(page.url()).searchParams.get('id') ?? '';
  expect(id).not.toBe('');
  return id;
}

/** Marks an order as placed in this tab, as the checkout does (lib/placed-orders.ts). */
async function markPlaced(page: Page, id: string) {
  await page.evaluate(([key, order]) => sessionStorage.setItem(key, JSON.stringify([order])), [
    PLACED_ORDERS_ITEM,
    id,
  ] as const);
}

/** The board, live. */
async function openBoard(page: Page) {
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
}

/** A card by its order. */
const cardOf = (page: Page, id: string) =>
  page.locator('.board li.card').filter({ has: page.getByText(id.slice(-6), { exact: true }) });

/** How far an element's box runs past its container's on each side, in px; all zero or less when inside. */
async function overrun(inner: Locator, outer: Locator) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  if (a === null || b === null) return 0;
  return Math.max(
    b.x - a.x,
    a.x + a.width - (b.x + b.width),
    b.y - a.y,
    a.y + a.height - (b.y + b.height),
  );
}

/** How many lines an element's text takes. */
const linesOf = (el: Locator) =>
  el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  });

test('Dispatch’s Stops read whole at 1280 and 1440 px, under the map with no empty block', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;
  const day = nthOpenDay(businessDate(Date.now() + (sandbox.clock_offset_s ?? 0) * 1000), 1);
  const menu = await api<Menu>(page, 'GET', `${base}/menu`);
  expect(menu.status).toBe(200);
  const id = await paidOrder(page, sandbox, deliveryOrder(menu.body, day, 3));
  await expect
    .poll(
      async () =>
        (
          await api<{ stops: { order: string; status: string }[] }>(
            page,
            'GET',
            `${base}/dispatch/${day}`,
          )
        ).body.stops.some((s) => s.order === id && s.status === 'confirmed'),
      { timeout: 30_000 },
    )
    .toBe(true);

  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/dispatch/?day=${day}`);
    const region = page.getByRole('region', { name: 'Stops table' });
    await expect(region.getByRole('row').filter({ hasText: id.slice(-6) })).toBeVisible();
    await expect(page.getByText('Loading the map…')).toHaveCount(0);

    // No sideways scroll, and every column's head inside the box.
    const box = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(box.scroll, `at ${width} px`).toBeLessThanOrEqual(box.client + 1);
    for (const th of await region.locator('th').all()) {
      expect(await overrun(th, region), `a column head at ${width} px`).toBeLessThanOrEqual(1);
    }
    // A window reads on one line or two.
    for (const cell of await region.locator('td[data-label="Window"]').all()) {
      expect(await linesOf(cell), `a window at ${width} px`).toBeLessThanOrEqual(2);
    }
    // The stops sit right under the map and the plans, and the two beside each other end close.
    const map = await page.locator('.dispatch-map-panel').boundingBox();
    const plans = await page.locator('.dispatch-plans').boundingBox();
    const stops = await page.locator('.dispatch-stops').boundingBox();
    expect(map && plans && stops).toBeTruthy();
    if (map && plans && stops) {
      const above = Math.max(map.y + map.height, plans.y + plans.height);
      expect(stops.y - above).toBeLessThanOrEqual(32);
      expect(Math.abs(map.y + map.height - (plans.y + plans.height))).toBeLessThanOrEqual(300);
      expect(stops.width).toBeGreaterThan(map.width);
    }
  }
  await expectNoAxeViolations(page);

  // A phone still stacks the rows with their labels, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  const region = page.getByRole('region', { name: 'Stops table' });
  await expect(region.locator('thead')).toHaveCSS('position', 'absolute');
  const box = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the visitor’s own order says Yours, opens its column, and three moves leave one line', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const sandbox = await guestSandbox(page);
    const menu = await api<Menu>(page, 'GET', `/v1/sandboxes/${sandbox.id}/menu`);
    expect(menu.status).toBe(200);
    // Through the checkout, which remembers the order for this tab, then paid at the fake Stripe.
    const id = await checkoutOrder(page, pickupOrder(menu.body, sandbox.clock_offset_s ?? 0));
    const short = id.slice(-6);
    await payOrder(page, sandbox.id, id);
    await expect(
      page.getByRole('list', { name: 'Your order’s steps' }).locator('[aria-current="step"]'),
    ).toContainText('Paid');
    expect(
      await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? '[]'),
        PLACED_ORDERS_ITEM,
      ),
    ).toEqual([id]);

    // A seeded order's page, opened in the same tab, does not make that order the visitor's.
    const ledger = await api<{ entries: { kind: string; ref: string; stripe_id: string }[] }>(
      page,
      'GET',
      `/v1/sandboxes/${sandbox.id}/billing/ledger`,
    );
    expect(ledger.status).toBe(200);
    const seeded = ledger.body.entries.find(
      (e) => e.kind === 'payment' && e.stripe_id.startsWith('seed:'),
    )?.ref;
    expect(seeded, 'the seed made at least one order paid').toBeTruthy();
    await page.goto(`/order/?id=${seeded}`);
    await expect(page.getByRole('list', { name: 'Your order’s steps' })).toBeVisible();
    await openBoard(page);
    const seededShort = (seeded ?? '').slice(-6);
    await expect(cardOf(page, seeded ?? '')).toHaveCount(1);
    await expect(
      page
        .locator('.board li.card[data-yours]')
        .filter({ has: page.getByText(seededShort, { exact: true }) }),
    ).toHaveCount(0);

    // Marked in words, and the board opens on the column that holds it.
    const own = page.locator('.board li.card[data-yours]');
    await expect(own).toHaveCount(1);
    await expect(own).toContainText(short);
    await expect(own.getByText('Yours', { exact: true })).toBeVisible();
    await expect(page.locator('.board')).toHaveAttribute('data-show', 'confirmed');
    await expect(page.getByRole('button', { name: /^Confirmed \(\d+\)$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectNoAxeViolations(page);

    // Three moves, one line above the board: the latest, in a live region.
    await page.getByRole('button', { name: `Start production for order ${short}` }).click();
    const chip = cardOf(page, id).locator('.card-event');
    await expect(chip).toHaveAttribute('title', 'OrderProductionStarted');
    expect(await overrun(chip, cardOf(page, id))).toBeLessThanOrEqual(0.5);
    await page.getByRole('button', { name: `Mark ready for order ${short}` }).click();
    await expect(cardOf(page, id).locator('.card-event')).toHaveAttribute('title', 'OrderReady');
    await page.getByRole('button', { name: `Mark picked up for order ${short}` }).click();
    const said = page.locator('.board-said');
    await expect(said).toHaveAttribute('aria-live', 'polite');
    await expect(said.locator('p')).toHaveText(`Mark picked up for ${short}: acknowledged.`);
    await expect(said.locator('p')).toHaveCount(1);
  });
});

test('a chip stays in its card at every width, and a ready delivery says what it waits for', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const sandbox = await guestSandbox(page);
  const offset = sandbox.clock_offset_s ?? 0;
  const menu = await api<Menu>(page, 'GET', `/v1/sandboxes/${sandbox.id}/menu`);
  expect(menu.status).toBe(200);
  const pickup = await paidOrder(page, sandbox, pickupOrder(menu.body, offset));
  // Two open days on: a day no plan has been published for, so no van has the delivery yet.
  const day = nthOpenDay(businessDate(Date.now() + offset * 1000), 2);
  const delivery = await paidOrder(page, sandbox, deliveryOrder(menu.body, day, 2));
  // This test is about the chip: the order is marked as the checkout marks it (the phone test
  // places one through the checkout itself).
  await markPlaced(page, pickup);
  await openBoard(page);

  const own = cardOf(page, pickup);
  await expect(own.getByText('Yours', { exact: true })).toBeVisible();
  // Beside "Yours" the id still reads on one line in a 1280 px column.
  expect(await linesOf(own.locator('.card-id'))).toBe(1);
  await page
    .getByRole('button', { name: `Start production for order ${pickup.slice(-6)}` })
    .click();
  const chip = own.locator('.card-event');
  await expect(chip).toHaveAttribute('title', 'OrderProductionStarted');
  // The words are the type's, joined by soft hyphens only.
  expect(await chip.evaluate((n) => (n.textContent ?? '').replaceAll('\u00AD', ''))).toBe(
    'OrderProductionStarted',
  );
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.getByRole('button', { name: /^In production/ }).click();
    await expect(chip).toBeVisible();
    expect(await overrun(chip, own), `the chip at ${width} px`).toBeLessThanOrEqual(0.5);
    // At most a line per word, and nothing cut: a break falls only at a soft hyphen.
    expect(await linesOf(chip), `the chip's lines at ${width} px`).toBeLessThanOrEqual(3);
    expect(
      await chip.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
      `the chip is whole at ${width} px`,
    ).toBe(true);
  }

  // The delivery made ready waits for its van, in words, with the way to Dispatch.
  await page.setViewportSize({ width: 1280, height: 900 });
  const short = delivery.slice(-6);
  await page.getByRole('button', { name: `Start production for order ${short}` }).click();
  await page.getByRole('button', { name: `Mark ready for order ${short}` }).click();
  const ready = page
    .locator('section.column[data-state="ready"] li.card')
    .filter({ has: page.getByText(short, { exact: true }) });
  await expect(ready.locator('.card-waits')).toHaveText(
    'Waits for a van: it goes out when the day’s plan is published on Dispatch.',
  );
  await expect(ready.getByRole('link', { name: 'Dispatch' })).toHaveAttribute(
    'href',
    '/app/dispatch/',
  );
  expect(await overrun(ready.locator('.card-waits'), ready)).toBeLessThanOrEqual(0.5);
  await expectNoAxeViolations(page);
});

test('a refund just made is not called seeded, and System prints its dates in the console’s forms', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;

  // A payment the seed made, refunded in part now: Billing records it alone, and says so.
  const ledger = await api<{
    entries: { kind: string; purpose: string; ref: string; stripe_id: string }[];
  }>(page, 'GET', `${base}/billing/ledger`);
  const seeded = ledger.body.entries.find(
    (e) => e.kind === 'payment' && e.purpose === 'order' && e.stripe_id.startsWith('seed:'),
  );
  expect(seeded, 'the seed made at least one order paid').toBeTruthy();
  const order = seeded?.ref ?? '';
  const refund = await api(page, 'POST', `${base}/orders/${order}/refund`, {
    amount_cents: 100,
    reason: 'goodwill',
  });
  expect(refund.status, JSON.stringify(refund.body)).toBeLessThan(300);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/app/money/');
  const rows = page.getByRole('region', { name: 'Ledger entries' }).getByRole('row');
  const refunded = rows.filter({ hasText: 'Refund' }).filter({ hasText: order.slice(-6) });
  await expect(refunded).toHaveCount(1);
  await expect(refunded.locator('td[data-label="Recorded by"]')).toHaveText(
    'Billing, no Stripe call',
  );
  await expect(rows.filter({ hasText: 'Refund' }).filter({ hasText: '(seeded)' })).toHaveCount(0);

  // System: when the sandbox was born and is deleted, in the console's form, in UTC.
  await page.goto('/app/system/');
  const facts = page.locator('[data-tour="console-sandbox"]');
  await expect(facts.locator('dt:text-is("Born") + dd')).toHaveText(new RegExp(`^${MOMENT} UTC$`));
  await expect(facts.locator('dt:text-is("Deleted") + dd')).toHaveText(
    new RegExp(`^at ${MOMENT} UTC, in `),
  );
  // The clock's phrase never breaks inside itself.
  const clock = page.locator('.panel').filter({ has: page.locator('#clock-heading') });
  const phrase = clock.locator('[data-phrase="clock-left"]');
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(phrase).toHaveText(/^with .+ of 14 d left\.$/);
    expect(await linesOf(phrase), `the clock phrase at ${width} px`).toBe(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await clock.getByRole('button', { name: 'Advance 15 minutes' }).click();
  await expect(
    page.getByText(new RegExp(`^Business time moved forward\\. It is now ${MOMENT}\\.$`)),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});
