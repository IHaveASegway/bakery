// The checkout's slot picker on a live sandbox (components/SlotPicker.tsx): with the business clock
// moved to 8:00 am on an open day, a slot already past is greyed out as too soon, a slot cut to no
// places reads full, and a free one later in the day can be chosen. The API refuses the two greyed-out ones
// too, so the picker's hints match its rules. order.spec.ts places its order through the API and
// never opens this page.
import type { Page } from '@playwright/test';
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
  await page.setViewportSize({ width: 390, height: 844 });
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
  // A time already too soon is not listed at all: one line says why, and names the first open time.
  await expect(radio(past)).toHaveCount(0);
  await expect(picker.getByText('too soon')).toHaveCount(0);
  await expect(
    picker.getByText(/^Earlier times today need more notice: the first open time is /),
  ).toBeVisible();
  await expect(picker.locator('input[name="slot"]').first()).toBeEnabled();
  await expect(radio(full)).toBeDisabled();
  await expect(label(full)).toHaveText('2:45 pm · full');
  await expect(radio(free)).toBeEnabled();
  await expectNoAxeViolations(page);

  // Before paying, the page says whose name the order carries, above the button that places it.
  const who = page.getByTestId('ordering-as');
  await expect(who).toContainText(
    /^You are ordering as .+, one of this sandbox’s made-up customers, so a delivery has a place/,
  );
  await expect(who).toContainText('It is not you');
  const whoBox = await who.boundingBox();
  const placeBox = await page.getByRole('button', { name: 'Place order' }).boundingBox();
  expect(whoBox && placeBox && whoBox.y < placeBox.y, 'the line comes before Place order').toBe(
    true,
  );

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

/** A cart with one item that needs at most two hours' notice, baked on `weekday`, at the checkout. */
async function checkoutWithAnItem(page: Page, base: string, weekday: string) {
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
  expect(item, `an item baked on ${weekday} with a short lead`).toBeDefined();
  const variant = item?.variants.find((v) => v.lead_minutes <= 120);
  if (item === undefined || variant === undefined) throw new Error('no item');
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
  await expect(page.locator('astro-island[component-url*="Checkout"]')).not.toHaveAttribute(
    'ssr',
    /.*/,
  );
  await expect(page.getByRole('radio', { name: /^Pickup/ })).toBeChecked();
  return { item, variant };
}

const weekdayOf = (day: string) =>
  new Date(`${day}T12:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
    .toLowerCase();

// The When step at three hours of the bakery's day (the day is the bakery's, Mountain time): at
// opening, late in the morning and after the last slot. Its list starts at the first open time, one
// line says why the earlier ones are gone, and a day with nothing left offers the next one.
test.describe('the When step at three hours of the day', () => {
  test.use({ allowedStatuses: [409] });

  async function atHour(page: Page, steps: string[]) {
    await demoAccount(page);
    const sandbox = await liveSandbox(page);
    const base = `/v1/sandboxes/${sandbox.id}`;
    let offset = 0;
    for (const step of steps) {
      const moved = await api<{ clock_offset_s: number }>(page, 'POST', `${base}/clock`, { step });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      offset = moved.body.clock_offset_s;
    }
    const day = businessDate(Date.now() + offset * 1000);
    await checkoutWithAnItem(page, base, weekdayOf(day));
    await page.getByRole('button', { name: 'Continue' }).click();
    return { day, base };
  }

  test('at opening: the list starts at the first open time, with its line first', async ({
    page,
  }) => {
    const { day } = await atHour(page, ['next-opening']);
    const picker = page.getByRole('group', { name: 'Pickup time' });
    await expect(page.locator('input[name="day"]:checked')).toHaveValue(day);
    const line = picker.getByText(/^Earlier times today need more notice: the first open time is /);
    await expect(line).toBeVisible();
    const first = picker.locator('input[name="slot"]').first();
    await expect(first).toBeEnabled();
    // The line says the first listed time, and it comes before the list in the page.
    const firstLabel = await picker.locator('label.slot-chip .slot-time').first().innerText();
    await expect(line).toContainText(`the first open time is ${firstLabel}.`);
    expect(
      await line.evaluate(
        (el, list) => !!(el.compareDocumentPosition(list) & 4),
        await first.elementHandle(),
      ),
    ).toBe(true);
    // Nothing disabled for being too soon.
    await expect(picker.getByText('too soon')).toHaveCount(0);
    await expect(picker).toHaveAccessibleDescription(/Earlier times today need more notice/);
    await expectNoAxeViolations(page);
  });

  test('late in the morning: still one line, and the first time is later', async ({ page }) => {
    const { day } = await atHour(page, ['next-opening', '1h', '1h', '1h', '1h']);
    const picker = page.getByRole('group', { name: 'Pickup time' });
    await expect(page.locator('input[name="day"]:checked')).toHaveValue(day);
    await expect(picker.getByText(/^Earlier times today need more notice/)).toBeVisible();
    await expect(picker.getByText('too soon')).toHaveCount(0);
    const firstLabel = await picker.locator('label.slot-chip .slot-time').first().innerText();
    expect(firstLabel).not.toBe('7:00 am');
    await expect(picker.locator('label.slot-chip input:disabled')).toHaveCount(0);
  });

  test('a day when every time is open lists them all and has no line', async ({ page }) => {
    const { day } = await atHour(page, ['next-opening']);
    const picker = page.getByRole('group', { name: 'Pickup time' });
    // The chips are the days on offer; a later open day has all 32 times and no notice line.
    const later = page
      .locator('input[name="day"]')
      .locator('xpath=ancestor::label')
      .filter({ hasNot: page.locator(`input[value="${day}"]`) });
    const count = await later.count();
    let found = false;
    for (let i = 0; i < count; i += 1) {
      const chip = later.nth(i);
      if ((await chip.getAttribute('data-quiet')) === 'true') continue;
      await chip.click();
      await expect(picker.getByText(/^\d+ of 32 slots open\./)).toBeVisible();
      if ((await picker.locator('label.slot-chip').count()) === 32) {
        found = true;
        break;
      }
    }
    expect(found, 'a later open day lists all 32 times').toBe(true);
    await expect(picker.getByText(/^Earlier times/)).toHaveCount(0);
    await expect(picker.getByText('too soon')).toHaveCount(0);
  });

  test('after the last slot: nothing is listed, and the next open day is offered', async ({
    page,
  }) => {
    // 7:00 am and eight hours on is 3:00 pm, past the day's last slot (2:45 pm).
    const steps = ['next-opening', ...Array<string>(8).fill('1h')];
    const { day } = await atHour(page, steps);
    const picker = page.getByRole('group', { name: 'Pickup time' });
    // The picker opens on the next day with a time to choose; Today is still there to look at.
    await page.getByRole('radio', { name: /^Today/ }).check();
    await expect(page.locator('input[name="day"]:checked')).toHaveValue(day);
    await expect(
      picker.getByText(/^Nothing is left today: every time has passed or needs more notice\./),
    ).toBeVisible();
    await expect(picker.locator('label.slot-chip')).toHaveCount(0);
    const next = picker.getByRole('button', { name: /^See / });
    await expect(next).toBeVisible();
    await expectNoAxeViolations(page);
    await next.click();
    await expect(page.locator('input[name="day"]:checked')).not.toHaveValue(day);
    await expect(picker.locator('label.slot-chip').first()).toBeVisible();
    await expect(picker.getByText(/^Nothing is left/)).toHaveCount(0);
  });
});
