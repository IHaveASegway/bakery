// The console's navigation (audit C26, and the seven pages of 2026-11-09) and the menu's short path
// on a phone (audit P3): the sidebar's pages, an old anchor that lands on its section's page with the
// focus on its heading, the board's skip link past the cards, and the guide's first step on the menu,
// which rings one card that sits above its sheet.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

test('the sidebar’s pages, an old anchor of the one-page console, and the board’s skip link', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  await expectNoAxeViolations(page);

  // The sidebar: the seven workspaces, each a page, the Kitchen current here.
  const nav = page.getByRole('navigation', { name: 'Console' });
  await expect(nav.getByRole('link')).toHaveCount(7);
  await expect(nav.getByRole('link', { name: 'Kitchen' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Money' }).click();
  await expect(page).toHaveURL(/\/app\/money\/$/);
  await expect(page.getByRole('heading', { name: 'Ledger' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');
  await expectNoAxeViolations(page);

  // A link to a section of the one-page console lands on its page, with the focus on its heading,
  // so Tab goes on from there.
  await page.goto('/app/#ledger-heading');
  await expect(page).toHaveURL(/\/app\/money\/#ledger-heading$/);
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
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const skip = page.getByRole('link', { name: 'Skip the board’s cards' });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#feed-heading')).toBeFocused();
});

test.describe('on a phone', () => {
  // A visitor with no session: the page asks once and the API answers 401, which Chromium logs.
  test.use({ viewport: { width: 390, height: 844 }, allowedStatuses: [401] });

  test('the menu’s short path opens at the first card and keeps it above the sheet', async ({
    page,
  }) => {
    await page.goto('/menu/');
    // On a phone the guide's control is one button showing on or off; a tap opens the rest.
    await page.getByRole('button', { name: /^Under the hood, (on|off)$/ }).click();
    await page.getByRole('button', { name: 'Show me around' }).click();
    const note = page.locator('#guide-path');
    await expect(note).toContainText('Add something to the cart.');
    const ringed = page.locator('[data-guide-anchor]');
    await expect(ringed).toHaveAttribute('data-tour', 'menu-list');
    // The note is a sheet over the lower third, and the step's card is in view above it.
    await expect
      .poll(async () => {
        const target = await ringed.boundingBox();
        const sheet = await note.boundingBox();
        return target !== null && sheet !== null && target.height < 500 && target.y >= 0
          ? Math.round(sheet.y - (target.y + target.height))
          : null;
      })
      .toBeGreaterThanOrEqual(0);
    // A note is not a dialog and took no focus; axe holds with it open.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });
});
