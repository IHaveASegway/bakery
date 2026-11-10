// The checkout's three steps and the order's own status page (/order/?id=<order id>): an order is
// placed through the steps, paid at the fake Stripe as scripts/smoke-payments.sh pays, and its
// page follows it over the kitchen socket while a staff page moves its card. The second test
// holds the board's four sockets with three consoles and the status page, which must give its
// socket up and follow the order by reading it instead. Stripe.js cannot load here
// (js.stripe.com is unreachable), so the payment step says so, which is expected; a stub stands
// in for its script so the refusal is not a console error.
import type { Page } from '@playwright/test';
import {
  api,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  payOrder,
  pickupOrder,
  test,
} from './fixtures';

/** Stands in for Stripe.js: defines no `Stripe`, so the page's loader resolves to nothing. */
const STRIPE_STUB = '/* e2e: Stripe.js cannot load on this machine */';

type Menu = Parameters<typeof pickupOrder>[0];

async function seededOrder(page: Page) {
  const sandbox = await liveSandbox(page);
  const menu = await api<Menu>(page, 'GET', `/v1/sandboxes/${sandbox.id}/menu`);
  expect(menu.status).toBe(200);
  return { sandbox, want: pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2) };
}

/** The staff's button on the order's card, wherever on the board the card is. */
const move = (staff: Page, name: string) => staff.getByRole('button', { name }).click();

test('an order placed in three steps and paid follows the kitchen on its own page', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await context.route('https://js.stripe.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: STRIPE_STUB }),
  );
  await demoAccount(page);
  const { sandbox, want } = await seededOrder(page);

  // The cart as the menu's Add buttons leave it in this tab, written from the sign-in page, which
  // has no cart of its own to save over it.
  await page.evaluate((cart) => sessionStorage.setItem('bakery.cart.v1', JSON.stringify(cart)), {
    lines: want.lines,
    note: '',
    kind: 'pickup',
    zone: 'z1',
    slot: '',
  });
  await page.goto('/checkout/');

  // Step 1, how: pickup is chosen; one action.
  const how = page.locator('section[aria-labelledby="how-heading"]');
  await expect(how.getByRole('radio', { name: /^Pickup/ })).toBeChecked();
  await expectNoAxeViolations(page);
  await how.getByRole('button', { name: 'Continue' }).click();
  await expect(how.getByText('Pickup at the bakery')).toBeVisible();

  // Step 2, when: the slot's day, then the slot, then Place order.
  await page.locator(`input[name="day"][value="${want.slot.slice(0, 10)}"]`).check();
  const slot = page.locator(`input[name="slot"][value^="${want.slot.slice(0, 16)}"]`);
  await expect(slot).toBeEnabled();
  await slot.check();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Place order' }).click();

  // Step 3, pay: the hold as time left, and Stripe's form, which cannot load here.
  await expect(page.getByText(/\d+ min left to pay\./)).toBeVisible();
  await expect(page.getByText('Stripe’s payment form could not load')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your order' })).toBeVisible();
  await expectNoAxeViolations(page);

  // The order's page: placed, waiting for payment, and live on the socket.
  await page.getByRole('link', { name: 'Follow this order' }).click();
  await expect(page).toHaveURL(/\/order\/\?id=/);
  const id = new URL(page.url()).searchParams.get('id') ?? '';
  expect(id).not.toBe('');
  const current = page
    .getByRole('list', { name: 'Your order’s steps' })
    .locator('[aria-current="step"]');
  await expect(current).toContainText('Placed');
  await expect(page.getByText('Waiting for payment')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pay for this order' })).toHaveAttribute(
    'href',
    `/checkout/?order=${id}`,
  );
  await expect(page.getByText(/^Live: this page moves/)).toBeVisible();
  await expectNoAxeViolations(page);

  // Paid at the fake Stripe: the webhook marks it paid, and the page hears it from the Kitchen.
  await payOrder(page, sandbox.id, id);
  await expect(current).toContainText('Paid');
  await expect(page.getByText('Paid in Stripe’s sandbox.')).toBeVisible();

  // A staff page moves the card; the status page follows each move without a reload.
  const staff = await context.newPage();
  await staff.goto('/app/');
  await expect(staff.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const short = id.slice(-6);
  await move(staff, `Start production for order ${short}`);
  await expect(current).toContainText('In production');
  await expect(page.getByText(/Last heard: OrderProductionStarted/)).toBeVisible();
  await move(staff, `Mark ready for order ${short}`);
  await expect(current).toContainText('Ready');
  await move(staff, `Mark picked up for order ${short}`);
  await expect(current).toContainText('Picked up');
  await expect(page.getByText(/stopped listening/)).toBeVisible();
  await expectNoAxeViolations(page);
  await staff.close();
});

test('with the board’s four sockets wanted, the status page gives its own up and reads instead', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await demoAccount(page);
  const { sandbox, want } = await seededOrder(page);
  const placed = await api<{ id: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    want,
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const id = placed.body.id;
  await payOrder(page, sandbox.id, id);

  await page.goto(`/order/?id=${id}`);
  const current = page
    .getByRole('list', { name: 'Your order’s steps' })
    .locator('[aria-current="step"]');
  await expect(current).toContainText('Paid');
  await expect(page.getByText(/^Live: this page moves/)).toBeVisible();

  // Three consoles: with the status page, four sockets, the Kitchen's limit.
  const consoles: Page[] = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await context.newPage();
    await c.goto('/app/');
    await expect(c.getByText('Live. Changes appear here as they happen.')).toBeVisible();
    consoles.push(c);
  }
  await expect(
    page.getByText(/every live place, so this page checks every 10 seconds/),
  ).toBeVisible();

  // The last console still has its socket, and a move reaches the status page by a read.
  const staff = consoles[2] as Page;
  await move(staff, `Start production for order ${id.slice(-6)}`);
  await expect(current).toContainText('In production', { timeout: 25_000 });
  await expectNoAxeViolations(page);
  for (const c of consoles) await c.close();
});

test.describe('an order of another sandbox', () => {
  // The API answers 404 for it, and Chromium logs that.
  test.use({ allowedStatuses: [404] });

  test('an order that is not this session’s reads as not found, with the way back to the menu', async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/order/?id=01JZZZZZZZZZZZZZZZZZZZZZZZ');
    await expect(page.getByRole('heading', { name: 'We cannot find that order' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the menu' })).toHaveAttribute(
      'href',
      '/menu/',
    );
    await expectNoAxeViolations(page);
  });
});
