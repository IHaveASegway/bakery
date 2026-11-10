// Fixes from the audit of 2026-11-10: the catering form says what is wrong at its field (F11), a
// card's "…" menu closes on Escape and one at a time (F15), and Refund says in words what its
// second press does (F21). Nothing here refunds: the second press is never made.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the catering form marks a headcount of 500 at its field, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/catering/');
    const form = page.getByRole('form', { name: 'Ask about an event' });
    const headcount = form.getByLabel('Headcount');
    await expect(headcount).toBeVisible();
    await expect(
      form.getByText('Still to fill: a day, a headcount, a package and a venue.'),
    ).toBeVisible();

    await headcount.fill('500');
    await expect(headcount).toHaveAttribute('aria-invalid', 'true');
    const error = form.locator('#cat-headcount-error');
    await expect(error).toHaveText('500 is more than 200 people.');
    await expect(headcount).toHaveAttribute('aria-describedby', /cat-headcount-error/);
    // Send stays off, as the checkout's Place order does, and says what is still to fill.
    await expect(form.getByRole('button', { name: 'Send inquiry' })).toBeDisabled();
    await expect(form.getByText('Still to fill: a day, a package and a venue.')).toBeVisible();
    await expectNoAxeViolations(page);

    await headcount.fill('40');
    await expect(headcount).not.toHaveAttribute('aria-invalid', 'true');
    await expect(error).toHaveText('');
  });
}

test('a card’s menu closes on Escape with focus back on its button, and one opens at a time', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const buttons = page.getByRole('button', { name: /^More for order / });
  await expect.poll(() => buttons.count()).toBeGreaterThan(1);
  const first = buttons.nth(0);
  const second = buttons.nth(1);
  const open = page.locator('.board details.menu[open]');

  await first.click();
  await expect(open).toHaveCount(1);
  await second.click();
  await expect(open).toHaveCount(1);
  await expect(open.locator('summary')).toHaveAttribute(
    'aria-label',
    (await second.getAttribute('aria-label')) ?? '',
  );

  await page.keyboard.press('Escape');
  await expect(open).toHaveCount(0);
  await expect(second).toBeFocused();

  // Refund's first press asks, in words, with the amount; Cancel takes it back.
  await second.click();
  const panel = open.locator('.menu-panel');
  await panel.getByRole('button', { name: /^Refund order / }).click();
  await expect(panel.getByRole('status')).toHaveText(
    /^Press Refund all to refund everything left of order \w{6}’s \$[\d,]+\.\d{2}\. This cannot be undone/,
  );
  await expect(panel.getByRole('button', { name: /^Refund all that is left of \$/ })).toBeVisible();
  await expectNoAxeViolations(page);
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByRole('status')).toHaveCount(0);
  // The panel sits inside its card's column: its edges are the card's.
  const card = await open.locator('xpath=ancestor::li[contains(@class,"card")]').boundingBox();
  const box = await panel.boundingBox();
  expect(card && box && box.x >= card.x - 1 && box.x + box.width <= card.x + card.width + 1).toBe(
    true,
  );
});
