// The dispatch day is kept in the address, and the catering page says what is true signed out.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

test('the dispatch day is kept in the address and survives a reload', async ({ page }) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/dispatch/');
  const day = page.getByLabel('Day');
  await expect(day).toBeEnabled();
  await expectNoAxeViolations(page);
  const options = await day
    .locator('option')
    .evaluateAll((o) => o.map((x) => x.getAttribute('value')));
  const second = options[1];
  expect(second).toBeTruthy();
  await day.selectOption(second!);
  await expect(page).toHaveURL(new RegExp(`\\?day=${second}$`));
  await page.reload();
  await expect(day).toHaveValue(second!);
  await day.selectOption(options[0]!);
  await expect(page).toHaveURL(/\/app\/dispatch\/$/);
});

test.describe('signed out', () => {
  // A visitor with no session: the page asks once and the API answers 401, which Chromium logs.
  test.use({ allowedStatuses: [401] });

  test('the catering page shows its gate, not that the menu is a seed menu', async ({ page }) => {
    await page.goto('/catering/');
    await expect(
      page.getByRole('region', { name: 'Catering starts with your own sandbox.' }),
    ).toBeVisible();
    await expect(page.getByText('seed menu')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });
});
