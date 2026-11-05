// An order placed and paid, and the kitchen board's socket showing its card (docs/roadmap.md,
// PR 11: "an order, a payment"). The order and the payment are the calls the storefront makes,
// made from the page. The confirm is made at the fake Stripe, as scripts/smoke-payments.sh makes
// it, because the Payment Element cannot mount here: Stripe.js comes from js.stripe.com, which
// this browser cannot reach, and the fake is not Stripe. The board is never reloaded: the card
// arrives, then turns confirmed, over the WebSocket alone.
import {
  api,
  confirmAtFakeStripe,
  demoAccount,
  expect,
  liveSandbox,
  pickupOrder,
  test,
} from './fixtures';

test('an order paid with the test card turns confirmed on the board over its socket', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  const menu = await api<Parameters<typeof pickupOrder>[0]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/menu`,
  );
  expect(menu.status).toBe(200);
  const order = await api<{ id: string; total_cents: number }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders`,
    pickupOrder(menu.body, sandbox.clock_offset_s ?? 0, 2),
  );
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const short = order.body.id.slice(-6);
  const pending = page.locator('section[aria-labelledby="board-pending"]');
  const confirmed = page.locator('section[aria-labelledby="board-confirmed"]');
  await expect(pending.locator('code', { hasText: short })).toBeVisible();

  // The payment step: the order's own id as the Idempotency-Key, as the storefront sends it.
  const payment = await api<{ client_secret: string; amount_cents: number; status: string }>(
    page,
    'POST',
    `/v1/sandboxes/${sandbox.id}/orders/${order.body.id}/payment`,
    undefined,
    order.body.id,
  );
  expect(payment.status, JSON.stringify(payment.body)).toBe(200);
  expect(payment.body.amount_cents).toBe(order.body.total_cents);
  const confirm = await confirmAtFakeStripe(payment.body.client_secret);
  expect(confirm.body.status).toBe('succeeded');

  // Only the webhook marks an order paid; the board hears it from the Kitchen.
  await expect(confirmed.locator('code', { hasText: short })).toBeVisible();
  await expect(pending.locator('code', { hasText: short })).toHaveCount(0);
  await expect(
    page
      .getByRole('log')
      .locator('li', { hasText: 'OrderPaid' })
      .filter({ hasText: order.body.id }),
  ).toHaveCount(1);
  const read = await api<{ status: string }>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/orders/${order.body.id}`,
  );
  expect(read.body.status).toBe('confirmed');
});
