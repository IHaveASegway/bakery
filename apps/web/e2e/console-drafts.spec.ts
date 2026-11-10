// A price drafted in another tab is shown when the window is looked at again, and Publish stops for one it had not shown (audit N6); the capacity panel follows a publish (N10).
import { demoAccount, expect, liveSandbox, test } from './fixtures';

test('a price drafted in another tab is shown on focus, and Publish stops for it', async ({
  page,
  context,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/menu/');
  await expect(page.getByText('No item waits for Publish.')).toBeVisible();

  // A second tab drafts a price.
  const other = await context.newPage();
  await other.goto('/app/menu/');
  await expect(other.getByText('No item waits for Publish.')).toBeVisible();
  await other
    .getByLabel(/^Price of .*, in dollars$/)
    .first()
    .fill('7.77');
  await other
    .getByRole('button', { name: /^Set the price of/ })
    .first()
    .click();
  await expect(other.getByText('1 item has a price waiting for Publish.')).toBeVisible();
  await other.close();

  // Coming back to the first tab reads the drafts again: counted, and its note shows.
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('1 item has a price waiting for Publish.')).toBeVisible();
  await expect(page.getByText('Waiting for publish: $7.77.')).toBeVisible();

  // N10: a publish moves the capacity panel's version without a reload.
  await expect(page.getByText('Menu version 1 set the item caps.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Publish menu' }).click();
  await expect(page.getByText('Menu published. It is now version 2.')).toBeVisible();
  await expect(page.getByText('Menu version 2 set the item caps.').first()).toBeVisible({
    timeout: 15_000,
  });
});

test('Publish stops for a draft the page had not shown', async ({ page, context }) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/menu/');
  await expect(page.getByText('No item waits for Publish.')).toBeVisible();

  const other = await context.newPage();
  await other.goto('/app/menu/');
  await expect(other.getByText('No item waits for Publish.')).toBeVisible();
  await other
    .getByLabel(/^Price of .*, in dollars$/)
    .first()
    .fill('8.88');
  await other
    .getByRole('button', { name: /^Set the price of/ })
    .first()
    .click();
  await expect(other.getByText('1 item has a price waiting for Publish.')).toBeVisible();
  await other.close();

  // No focus event reaches the first tab: Publish itself looks first and stops.
  await page.bringToFront();
  await page.getByRole('button', { name: 'Publish menu' }).click();
  await expect(page.getByText(/^Another tab drafted a price for /)).toBeVisible();
  await expect(page.getByText('1 item has a price waiting for Publish.')).toBeVisible();
  await expect(page.getByText(/Menu published\./)).toHaveCount(0);
  // The second press publishes everything that waits.
  await page.getByRole('button', { name: 'Publish menu' }).click();
  await expect(page.getByText('Menu published. It is now version 2.')).toBeVisible();
});

// R86 (the audit of 2026-11-10, F2): a price for one variant leaves its siblings alone, through
// the editor, the publish and the storefront.
test('Half is priced alone, published, and the storefront shows Half changed and Whole kept', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/menu/');
  await expect(page.getByText('No item waits for Publish.')).toBeVisible();
  await page.getByLabel('Price of Country loaf, Half, in dollars').fill('6.25');
  await page.getByRole('button', { name: 'Set the price of Country loaf, Half' }).click();
  await expect(
    page.getByText('Country loaf, Half: $6.25 drafted. Publish to put it on sale.'),
  ).toBeVisible();
  await expect(page.getByText('Waiting for publish: $6.25.')).toBeVisible();
  // Whole's own field still shows its own price.
  await expect(page.getByLabel('Price of Country loaf, Whole, in dollars')).toHaveValue('9.50');
  // A reload restores the draft on Half alone.
  await page.reload();
  await expect(page.getByLabel('Price of Country loaf, Half, in dollars')).toHaveValue('6.25');
  await expect(page.getByLabel('Price of Country loaf, Whole, in dollars')).toHaveValue('9.50');
  await page.getByRole('button', { name: 'Publish menu' }).click();
  await expect(page.getByText('Menu published. It is now version 2.')).toBeVisible();

  await page.goto('/menu/');
  const loaf = page
    .locator('li.item')
    .filter({ has: page.getByRole('heading', { name: 'Country loaf' }) });
  const half = loaf.locator('.variants li').filter({ hasText: 'Half' });
  const whole = loaf.locator('.variants li').filter({ hasText: 'Whole' });
  await expect(half.locator('.price')).toHaveText('$6.25', { timeout: 15_000 });
  await expect(whole.locator('.price')).toHaveText('$9.50');
});
