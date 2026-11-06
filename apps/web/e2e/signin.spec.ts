// Sign-in with a demo account, through the sign-in page's own forms, and a sandbox created from
// the console (docs/roadmap.md, PR 11: "sign-in" and "a sandbox created"). Turnstile's script is
// the stand-in in fixtures.ts; everything else is the storefront and the API as they ship.
import { expect, password, test } from './fixtures';

test('a demo account is created, signed in to, and makes a sandbox', async ({ page }) => {
  const secret = password();

  await page.goto('/signin/');
  const create = page.getByRole('form', { name: 'Create a demo account' });
  const submit = create.getByRole('button', { name: 'Create a demo account' });
  // Enabled once the island has hydrated and the challenge has passed; a field filled before
  // hydration would be emptied by it.
  await expect(submit).toBeEnabled();
  await create.getByLabel('Password').fill(secret);
  await submit.click();
  const username = (await page.locator('code.username').textContent())?.trim() ?? '';
  expect(username).toMatch(/^baker-[0-9a-hjkmnp-tv-z]{4}$/);

  // The new account's session reaches the console; signing out ends it.
  await page.getByRole('link', { name: 'Continue to the console' }).click();
  await expect(page.getByRole('heading', { name: 'Signed in with a demo account' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin\/$/);

  // Sign in again with the username shown once and the password chosen, once the forms' island
  // has hydrated again.
  await expect(submit).toBeEnabled();
  const signin = page.getByRole('form', { name: 'Sign in to a demo account' });
  await signin.getByLabel('Username').fill(username);
  await signin.getByLabel('Password').fill(secret);
  await signin.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('heading', { name: 'Signed in with a demo account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toBeVisible();

  // A sandbox, seeded by its first alarm; the console updates by itself.
  await page.getByRole('button', { name: 'New sandbox' }).click();
  await expect(page.getByRole('heading', { name: 'Your sandbox' })).toBeVisible();
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Kitchen board' })).toBeVisible();
});
