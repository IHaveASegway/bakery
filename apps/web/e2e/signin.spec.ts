// Sign-in with a demo account, through the sign-in page's own forms, and the sandbox the same press
// makes (docs/roadmap.md, PR 11: "sign-in" and "a sandbox created"; audit G11, 2026-11-10). Turnstile's script is
// the stand-in in fixtures.ts; everything else is the storefront and the API as they ship.
import { expect, password, test } from './fixtures';

test('a demo account is created with its sandbox, and signed in to again', async ({ page }) => {
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

  // On the console the top bar's bakery nav is one link, back to the shop, and never "Sign in".
  // The shop's header says "Your bakery" on every page and, for a signed-in visitor, goes to the
  // console, on a page (the privacy page) whose islands never ask for the session themselves
  // (audit C17). On a page with no script (the tools page) the same words go to the sign-in page,
  // which says the sandbox is there and offers the console (audit F14).
  const nav = page.getByRole('navigation', { name: 'The bakery' });
  await expect(nav.getByRole('link', { name: 'The shop' })).toHaveAttribute('href', '/menu/');
  await expect(nav.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await page.goto('/privacy/');
  await expect(nav.getByRole('link', { name: 'Your bakery' })).toHaveAttribute('href', '/app/');
  await page.goto('/how-its-built/tools/');
  await expect(nav.getByRole('link', { name: 'Your bakery' })).toHaveAttribute('href', '/signin/');
  await expect(nav.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
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

  // The press that made the account made its sandbox too (audit G11), and the account keeps it
  // across a sign-out, so the console opens on it, seeded by its first alarm.
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toHaveCount(0);
  // The top bar names the sandbox on every console page.
  await expect(page.getByRole('button', { name: /^Sandbox / })).toBeVisible();
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
