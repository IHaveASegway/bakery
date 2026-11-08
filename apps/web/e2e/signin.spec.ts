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

  // The header says "Console" for a signed-in visitor, on the console and on a page (the privacy page) whose islands
  // never ask for the session themselves (audit C17).
  const nav = page.getByRole('navigation', { name: 'The bakery' });
  await expect(nav.getByRole('link', { name: 'Console' })).toHaveAttribute('href', '/app/');
  await expect(nav.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await page.goto('/privacy/');
  await expect(nav.getByRole('link', { name: 'Console' })).toHaveAttribute('href', '/app/');
  await page.goto('/app/');
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

test('a username typed before the forms hydrate is kept (audit C25)', async ({ page }) => {
  // Hold every script back, as a slow connection would, so the visitor types into the server's HTML.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_astro/**/*.js', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/signin/', { waitUntil: 'commit' });
  const signin = page.getByRole('form', { name: 'Sign in to a demo account' });
  await signin.getByLabel('Username').fill('baker-typed');
  release();
  await expect(page.getByRole('button', { name: 'Create a demo account' })).toBeEnabled();
  await expect(signin.getByLabel('Username')).toHaveValue('baker-typed');
});
