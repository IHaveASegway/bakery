// The catering queue keeps the keyboard after Send quote and after a refused Start production (audit N4); the wiped view's focus is checked in wipe.spec.ts (N7).
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

// The refused Start production is a 409, which Chromium logs.
test.describe('catering queue', () => {
  test.use({ allowedStatuses: [409] });

  test('the catering queue keeps the keyboard after Send quote and a refused Start production', async ({
    page,
  }) => {
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/app/');
    await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
    await expectNoAxeViolations(page);

    const cardWithFocus = () =>
      page.evaluate(() => document.activeElement?.closest('[id^="catering-card-"]')?.id ?? null);

    // A refused action leaves the focus on the button that was pressed.
    const queue = page.getByRole('region', { name: 'Catering queue' });
    const start = queue.getByRole('button', { name: 'Start production' }).first();
    await start.scrollIntoViewIfNeeded();
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(queue.locator('li[id^="catering-card-"] .problem').first()).toBeVisible();
    await expect(start).toBeFocused();

    // Sending a quote moves the card to another group; the card takes the focus, not the page.
    const send = queue.getByRole('button', { name: 'Send quote' }).first();
    await send.scrollIntoViewIfNeeded();
    await send.focus();
    await page.keyboard.press('Enter');
    await expect.poll(cardWithFocus).not.toBeNull();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });
});
