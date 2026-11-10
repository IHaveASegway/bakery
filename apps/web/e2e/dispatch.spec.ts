// The dispatch screen (/app/dispatch/): a day's paid deliveries are its stops, and the server's
// proposal for them shows its vans and stops. The orders are placed and paid as
// scripts/smoke-dispatch.sh places them, at the next open day's 09:00 window, so the day has
// confirmed stops whatever the sandbox's seed holds.
import {
  api,
  businessDate,
  deliveryOrder,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  nthOpenDay,
  payOrder,
  test,
} from './fixtures';

interface Day {
  stops: { order: string; status: string }[];
}
interface Proposed {
  proposed: {
    minutes: number;
    unassigned: string[];
    vans: { van: number; stops: string[]; units: number; minutes: number }[];
  } | null;
}

test('a day’s paid deliveries are its stops, and a proposal plans every one of them', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;
  const day = nthOpenDay(businessDate(Date.now() + (sandbox.clock_offset_s ?? 0) * 1000), 1);

  const menu = await api<Parameters<typeof deliveryOrder>[0]>(page, 'GET', `${base}/menu`);
  expect(menu.status).toBe(200);
  const orders: string[] = [];
  for (const qty of [3, 4]) {
    const placed = await api<{ id: string }>(
      page,
      'POST',
      `${base}/orders`,
      deliveryOrder(menu.body, day, qty),
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    orders.push(placed.body.id);
    await payOrder(page, sandbox.id, placed.body.id);
  }
  // Only the webhook marks an order paid, and the Dispatch hears it from the Order.
  await expect
    .poll(
      async () => {
        const answer = await api<Day>(page, 'GET', `${base}/dispatch/${day}`);
        return orders.every((o) =>
          answer.body.stops.some((s) => s.order === o && s.status === 'confirmed'),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.goto(`/app/dispatch/?day=${day}`);
  await expect(page.getByLabel('Day')).toHaveValue(day);
  const stops = page.getByRole('table', { name: 'The day’s delivery stops' });
  for (const order of orders) {
    const row = stops.getByRole('row').filter({ hasText: order.slice(-6) });
    // The stop's own state, under a heading that says it is the stop's: paid, in no plan yet.
    await expect(row.locator('[data-label="Stop status"]')).toHaveText('To plan');
    // The persona's own zone, their place's, which the API derived (R69).
    await expect(row).toContainText(`Zone ${(sandbox.persona_zone ?? '').slice(1)}`);
  }
  await expect(page.getByText('Loading the map…')).toHaveCount(0);
  await expectNoAxeViolations(page);

  // Four vans with room for every unit of the day. The seed may hold deliveries that day too, so
  // the plan is checked against the day's own confirmed stops, not assumed.
  const confirmed = (await api<Day>(page, 'GET', `${base}/dispatch/${day}`)).body.stops.filter(
    (s) => s.status === 'confirmed',
  );
  const form = page.getByRole('form', { name: 'Propose a plan' });
  await form.getByLabel('Vans').selectOption('4');
  await form.getByLabel('Capacity of a van, in units').fill('250');
  await form.getByRole('button', { name: 'Propose' }).click();
  await expect(page.getByText(/^Proposed a plan that uses/)).toBeVisible();

  // Every confirmed stop, ours among them, rides in exactly one van, and none is left out.
  const proposed = (await api<Proposed>(page, 'GET', `${base}/dispatch/${day}`)).body.proposed;
  expect(proposed).not.toBeNull();
  if (proposed === null) return;
  const planned = proposed.vans.flatMap((v) => v.stops);
  expect(proposed.unassigned).toEqual([]);
  expect([...planned].sort()).toEqual(confirmed.map((s) => s.order).sort());
  for (const order of orders) expect(planned).toContain(order);

  const plan = page.locator('.plan').filter({
    has: page.getByRole('heading', { name: 'Server’s proposal' }),
  });
  await expect(plan).toContainText(`${proposed.minutes} drive minutes in all`);
  await expect(plan.getByRole('rowheader')).toHaveText(proposed.vans.map((v) => `Van ${v.van}`));
  for (const van of proposed.vans) {
    const cells = plan
      .getByRole('row')
      .filter({ hasText: `Van ${van.van}` })
      .getByRole('cell');
    await expect(cells).toHaveText([
      String(van.stops.length),
      String(van.units),
      String(van.minutes),
    ]);
  }
  await expectNoAxeViolations(page);

  // The browser's plan, where this browser can run the solver: the table still holds every stop.
  await page.getByRole('button', { name: 'Plan in the browser' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'Browser’s plan, as the API checked it' })
      .or(page.getByText('The browser’s solver is unavailable.')),
  ).toBeVisible({ timeout: 30_000 });
  for (const order of orders) {
    await expect(stops.getByRole('row').filter({ hasText: order.slice(-6) })).toHaveCount(1);
  }

  // Publish the server's proposal. Without a reload the table says each of our stops is on the
  // published plan, with its van and number, and the map offers the published plan's routes.
  const publishForm = page.getByRole('form', { name: 'Publish a plan' });
  await publishForm.getByLabel('Server’s proposal').check();
  await publishForm.locator('button[type="submit"]').click();
  await expect(page.getByText(/^Published plan version \d+\.$/)).toBeVisible();
  const vanOf = new Map(proposed.vans.flatMap((v) => v.stops.map((o) => [o, v.van] as const)));
  for (const order of orders) {
    const row = stops.getByRole('row').filter({ hasText: order.slice(-6) });
    // Paid, not yet ready: on the plan, and it leaves when the kitchen marks it ready.
    await expect(row.locator('[data-label="Stop status"]')).toHaveText(
      'Published, leaves when ready',
    );
    await expect(row.locator('[data-label="Van"]')).toHaveText(String(vanOf.get(order)));
    await expect(row.locator('[data-label="Stop"]')).toHaveText(/^\d+$/);
  }
  await expect(page.getByRole('group', { name: 'Routes on the map' })).toContainText(
    'Published plan',
  );

  // A stop that changes without this page doing anything appears without a reload: another
  // delivery placed and paid now is read by the page's own ten-second look.
  const late = await api<{ id: string }>(
    page,
    'POST',
    `${base}/orders`,
    deliveryOrder(menu.body, day, 2),
  );
  expect(late.status, JSON.stringify(late.body)).toBe(201);
  await payOrder(page, sandbox.id, late.body.id);
  const lateRow = stops.getByRole('row').filter({ hasText: late.body.id.slice(-6) });
  await expect(lateRow.locator('[data-label="Stop status"]')).toHaveText('To plan', {
    timeout: 45_000,
  });
  await expectNoAxeViolations(page);
});
