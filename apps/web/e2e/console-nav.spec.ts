// The console's in-page navigation (audit C26) and the menu tour on a phone (audit P3): a link in
// "On this page" puts the focus on its heading so Tab goes on from there, the board's skip link
// passes the cards, and the menu tour's list step rings one card that sits above the tour's bar.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

test('the “On this page” list and the board’s skip link move the focus past the cards', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  await expectNoAxeViolations(page);

  const nav = page.getByRole('navigation', { name: 'On this page' });
  await expect(nav.getByRole('link')).toHaveCount(20);

  // A link lands the focus on the section's heading; Tab then goes to what follows it.
  await nav.getByRole('link', { name: 'Ledger' }).click();
  await expect(page.locator('#ledger-heading')).toBeFocused();
  await page.keyboard.press('Tab');
  const after = await page.evaluate(() => {
    const heading = document.getElementById('ledger-heading')!;
    return Boolean(
      document.activeElement &&
      heading.compareDocumentPosition(document.activeElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(after).toBe(true);

  // The skip link shows on focus, and Enter lands on the first heading after the board's cards.
  const skip = page.getByRole('link', { name: 'Skip the board’s cards' });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#bake-heading')).toBeFocused();
});

test.describe('on a phone', () => {
  // A visitor with no session: the page asks once and the API answers 401, which Chromium logs.
  test.use({ viewport: { width: 390, height: 844 }, allowedStatuses: [401] });

  test('the menu tour opens at the cart and rings one card above the bar', async ({ page }) => {
    await page.goto('/menu/');
    await page.getByRole('button', { name: 'Take the tour' }).click();
    const ringed = page.locator('[data-tour-current]');
    await expect(ringed).toHaveAttribute('data-tour', 'menu-cart');
    // The page did not jump to its foot: the cart is the first thing it shows.
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(1000);

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(ringed).toHaveAttribute('data-tour', 'menu-list');
    await expect
      .poll(async () => {
        const target = await ringed.boundingBox();
        const dock = await page.locator('#tour-dock').boundingBox();
        return target !== null && dock !== null && target.height < 500 && target.y >= 0
          ? Math.round(dock.y - (target.y + target.height))
          : null;
      })
      .toBeGreaterThanOrEqual(0);
  });
});
