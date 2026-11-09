// The console's in-page navigation (audit C26) and the menu's short path on a phone (audit P3): a
// link in "On this page" puts the focus on its heading so Tab goes on from there, the board's skip
// link passes the cards, and the guide's first step on the menu rings one card that sits above its
// sheet.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

test('the “On this page” list and the board’s skip link move the focus past the cards', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  await expectNoAxeViolations(page);

  // The sidebar: the 20 sections in their seven workspaces, and the dispatch page under Dispatch.
  const nav = page.getByRole('navigation', { name: 'On this page' });
  await expect(nav.getByRole('link')).toHaveCount(21);
  await expect(nav.getByRole('link', { name: 'Delivery plans' })).toHaveAttribute(
    'href',
    '/app/dispatch/',
  );

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

  test('the menu’s short path opens at the first card and keeps it above the sheet', async ({
    page,
  }) => {
    await page.goto('/menu/');
    // On a phone the guide's bar is one pill: the switch, and a menu for the rest.
    await page.getByRole('button', { name: 'More of Under the hood' }).click();
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
