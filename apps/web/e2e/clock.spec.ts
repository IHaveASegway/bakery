// The console's clock control: a step moves business time forward, and what the console shows
// follows it. The clock line reads a day later, the capacity editor's days start a day later, and
// the Kitchen's activity feed shows the ClockAdvanced event (the clock part of
// scripts/smoke-schedule.sh, through the page).
import {
  api,
  businessDate,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  test,
} from './fixtures';

const DAY_MS = 86_400_000;

test('advancing the clock a day moves the console’s business time and its days', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const before = sandbox.clock_offset_s ?? 0;
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  const clockLine = page.locator('p', { hasText: 'Business time is' });
  const businessNow = clockLine.locator('time');
  const days = page.locator('#capacity-day option');
  const today = businessDate(Date.now() + before * 1000);
  await expect(days.first()).toHaveAttribute('value', today);
  const shownBefore = Date.parse((await businessNow.getAttribute('datetime')) ?? '');
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Advance 1 day' }).click();
  await expect(page.getByText(/^Business time moved forward\. It is now /)).toBeVisible();

  // The API's offset is a day more, and the page shows business time a day on.
  const read = await api<{ clock_offset_s: number }>(page, 'GET', `/v1/sandboxes/${sandbox.id}`);
  expect(read.body.clock_offset_s - before).toBe(DAY_MS / 1000);
  await expect
    .poll(async () => Date.parse((await businessNow.getAttribute('datetime')) ?? '') - shownBefore)
    .toBeGreaterThanOrEqual(DAY_MS);
  await expect(days.first()).toHaveAttribute(
    'value',
    businessDate(Date.now() + read.body.clock_offset_s * 1000),
  );
  await expect(days.first()).not.toHaveAttribute('value', today);
  await expect(
    page.getByRole('log').locator('li', { hasText: 'ClockAdvanced' }).first(),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});
