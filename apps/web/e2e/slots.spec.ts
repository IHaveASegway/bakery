// The checkout's slot picker on a live sandbox (components/SlotPicker.tsx): with the business clock
// moved to 8:00 am on an open day, a slot already past is greyed out as too soon, a slot cut to no
// places reads full, and a free one later in the day can be chosen. The API refuses the two greyed-out ones
// too, so the picker's hints match its rules. order.spec.ts places its order through the API and
// never opens this page.
import {
  api,
  businessDate,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  test,
} from './fixtures';

// The two refusals below are the answers under test, and Chromium logs them.
test.use({ allowedStatuses: [409] });

interface Menu {
  categories: {
    items: {
      name: string;
      status: string;
      days_baked: string[];
      season?: unknown;
      variants: { slug: string; label: string; lead_minutes: number }[];
    }[];
  }[];
}
interface Schedule {
  open: boolean;
  slots: { start: string; free: number }[];
}
interface Problem {
  type: string;
  detail: string;
}

test('a past slot and a full slot are not offered, and a free one is chosen', async ({ page }) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;

  // The clock to the next opening (7:00 am on an open day), then an hour on.
  let offset = 0;
  for (const step of ['next-opening', '1h']) {
    const moved = await api<{ clock_offset_s: number }>(page, 'POST', `${base}/clock`, { step });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    offset = moved.body.clock_offset_s;
  }
  const day = businessDate(Date.now() + offset * 1000);
  const weekday = new Date(`${day}T12:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
    .toLowerCase();

  // One item baked that day, in season, that needs at most two hours' notice.
  const menu = await api<Menu>(page, 'GET', `${base}/menu`);
  const item = menu.body.categories
    .flatMap((c) => c.items)
    .find(
      (i) =>
        i.status === 'available' &&
        !i.season &&
        i.days_baked.includes(weekday) &&
        i.variants.some((v) => v.lead_minutes <= 120),
    );
  expect(item, `an item baked on ${day} with a short lead`).toBeDefined();
  if (item === undefined) return;
  const variant = item.variants.find((v) => v.lead_minutes <= 120);
  if (variant === undefined) return;

  // 2:45 pm, the day's last slot, cut to no places.
  const cut = await api(page, 'PATCH', `${base}/schedule/${day}/capacity`, {
    target: 'slot:14:45',
    capacity: 0,
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(200);
  const schedule = (await api<Schedule>(page, 'GET', `${base}/schedule/${day}`)).body;
  expect(schedule.open).toBe(true);
  // A past slot and a later one that still have places, so each is greyed out for one reason.
  const hhmm = (start: string) => start.slice(11, 16);
  const open = schedule.slots.filter((s) => s.free > 0);
  const past = open.find((s) => hhmm(s.start) < '08:00')?.start;
  const free = open.find((s) => hhmm(s.start) >= '11:00' && hhmm(s.start) < '14:45')?.start;
  const full = schedule.slots.find((s) => hhmm(s.start) === '14:45')?.start;
  expect([past, free, full].every(Boolean), JSON.stringify(schedule.slots)).toBe(true);
  if (past === undefined || free === undefined || full === undefined) return;

  // A click before the menu's island has hydrated does nothing (the button is the server's HTML), so
  // wait for Astro to mark the island hydrated (it drops the island's `ssr` attribute), and then for
  // the cart's own line saying it took the item, before leaving the page.
  await page.goto('/menu/');
  await expect(page.locator('astro-island[component-url*="StoreMenu"]')).not.toHaveAttribute(
    'ssr',
    /.*/,
  );
  await page
    .getByRole('button', { name: `Add ${item.name}, ${variant.label}, to the cart` })
    .click();
  await expect(page.getByText(`Added ${item.name}, ${variant.label}.`)).toBeVisible();
  await page.goto('/checkout/');
  // As on the menu: the checkout's island first (Astro drops its `ssr` attribute once it has
  // hydrated), and the cart it read, with pickup chosen, before the first press.
  await expect(page.locator('astro-island[component-url*="Checkout"]')).not.toHaveAttribute(
    'ssr',
    /.*/,
  );
  await expect(page.getByRole('radio', { name: /^Pickup/ })).toBeChecked();
  // Step 1 is pickup already; its one action opens step 2, the day and the time.
  await page.getByRole('button', { name: 'Continue' }).click();
  const picker = page.getByRole('group', { name: 'Pickup time' });
  await expect(page.locator('input[name="day"]:checked')).toHaveValue(day);
  await expect(picker.getByText(/^\d+ of 32 slots open\./)).toBeVisible();

  const input = (start: string) => `input[type="radio"][value="${start}"]`;
  const radio = (start: string) => picker.locator(input(start));
  const label = (start: string) => picker.locator('label', { has: page.locator(input(start)) });
  await expect(radio(past)).toBeDisabled();
  await expect(label(past)).toContainText('too soon');
  await expect(radio(full)).toBeDisabled();
  await expect(label(full)).toHaveText('2:45 pm · full');
  await expect(radio(free)).toBeEnabled();
  await expectNoAxeViolations(page);

  await radio(free).check();
  await expect(radio(free)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();

  // The API holds the same line: the past slot is refused for its lead, the full one as full.
  const lines = [{ variant: variant.slug, qty: 1 }];
  for (const [slot, rule] of [
    [past, 'lead-time'],
    [full, 'slot-full'],
  ] as const) {
    const refused = await api<Problem>(page, 'POST', `${base}/orders`, {
      kind: 'pickup',
      slot,
      lines,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.detail).toContain(`The rule is ${rule}.`);
  }
});
