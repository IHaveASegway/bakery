// The guest's way in (audit F1 and F3, 2026-11-10): a stranger who fills a cart and opens the
// checkout with no sandbox meets one gate, before any choice. Start ordering makes a guest sandbox
// right there, through Turnstile (the stand-in in fixtures.ts), and the visitor stays on the
// checkout with the cart they had, then picks a time. The gate's Sign in comes back to the page,
// the menu's banner does the same thing in place, and a guest who comes to the sign-in page with no
// `next` lands on the menu, where they came to order. Since later on 2026-11-10 the catering page
// shows the same gate, with its own title and button.
import type { Page } from '@playwright/test';
import { expect, expectNoAxeViolations, test } from './fixtures';

// The first look at the session, before there is one, is a 401 that Chromium logs.
test.use({ allowedStatuses: [401] });

const CART_KEY = 'bakery.cart.v1';
const cartOf = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), CART_KEY);

/** Two things in the cart from the menu's own Add buttons, as a stranger fills it. */
async function fillCart(page: Page): Promise<string | null> {
  await page.goto('/menu/');
  const adds = page.getByRole('button', { name: /^Add .*, to the cart$/ });
  await expect(adds.first()).toBeEnabled();
  await adds.nth(0).click();
  await adds.nth(1).click();
  await expect(page.getByText(/^Added /)).toBeVisible();
  const cart = await cartOf(page);
  expect(JSON.parse(cart ?? '{}').lines).toHaveLength(2);
  return cart;
}

const sandboxMade = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/v1/sandboxes',
  );

test('the checkout with no sandbox is one gate that starts a guest in place, cart kept', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const cart = await fillCart(page);
  await page.goto('/checkout/');

  // One gate, before any choice: no method, no Continue, no small type saying ordering is off.
  const gate = page.getByRole('region', { name: 'Ordering starts with your own sandbox.' });
  await expect(gate).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Pickup/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await expect(page.getByText('ordering is off')).toHaveCount(0);
  await expect(gate.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/signin/?next=/checkout/',
  );
  // The cart is in view beside it.
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  await expectNoAxeViolations(page);

  // Start ordering: a sandbox is made here, and the page stays.
  const [made] = await Promise.all([
    sandboxMade(page),
    gate.getByRole('button', { name: 'Start ordering' }).click(),
  ]);
  expect(made.status()).toBe(201);
  // The steps take the gate's place once the new sandbox has seeded, and the focus goes to them.
  const how = page.getByRole('heading', { name: /How you get it/ });
  await expect(how).toBeVisible({ timeout: 60_000 });
  await expect(how).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/checkout/');
  expect(await cartOf(page)).toBe(cart);
  await expect(
    page.getByText('Your sandbox is live. Orders you place here go to it.'),
  ).toBeVisible();
  // The header says the same words as before, and now goes to the console.
  const nav = page.getByRole('navigation', { name: 'The bakery' });
  await expect(nav.getByRole('link', { name: 'Your bakery' })).toHaveAttribute('href', '/app/');

  // A time can be picked, and the order is ready to place.
  await page.getByRole('button', { name: 'Continue' }).click();
  const slot = page.locator('input[name="slot"]:enabled').first();
  await expect(slot).toBeVisible({ timeout: 30_000 });
  await slot.check();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();
  await expectNoAxeViolations(page);
});

test('the gate’s Sign in comes back to the checkout', async ({ page }) => {
  test.setTimeout(120_000);
  const cart = await fillCart(page);
  await page.goto('/checkout/');
  const gate = page.getByRole('region', { name: 'Ordering starts with your own sandbox.' });
  await gate.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/signin\/\?next=\/checkout\/$/);
  await expect(page.getByText('Then on to checkout.')).toBeVisible();
  const button = page.getByRole('button', { name: 'Continue as a guest' });
  await expect(button).toBeEnabled();
  await Promise.all([sandboxMade(page), button.click()]);
  await page.waitForURL((url) => url.pathname === '/checkout/');
  await expect(page.getByRole('heading', { name: /How you get it/ })).toBeVisible({
    timeout: 60_000,
  });
  expect(await cartOf(page)).toBe(cart);
});

test('the menu’s banner starts in place too, and the sign-in page then says the sandbox is there', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/menu/');
  const gate = page.getByRole('region', { name: 'Ordering starts with your own sandbox.' });
  await expect(gate.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/signin/?next=/menu/',
  );
  await expectNoAxeViolations(page);
  const [made] = await Promise.all([
    sandboxMade(page),
    gate.getByRole('button', { name: 'Start ordering' }).click(),
  ]);
  expect(made.status()).toBe(201);
  await expect(page.getByText('Your sandbox is live. Orders you place here go to it.')).toBeVisible(
    {
      timeout: 60_000,
    },
  );
  expect(new URL(page.url()).pathname).toBe('/menu/');
  await expect(gate).toHaveCount(0);

  // The header reads "Your bakery" on a page with no script too, and the sign-in page it leads to
  // says the sandbox is there rather than offering to start again (audit F14).
  await page.goto('/how-its-built/tools/');
  const nav = page.getByRole('navigation', { name: 'The bakery' });
  await nav.getByRole('link', { name: 'Your bakery' }).click();
  await expect(page.getByRole('heading', { name: 'You already have a sandbox' })).toBeVisible();
  // No second start beside it, and the account cards say what they cost a guest.
  await expect(page.getByRole('heading', { name: 'Continue as a guest' })).toHaveCount(0);
  await expect(page.getByText('leaves this guest sandbox behind for good')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveAttribute(
    'href',
    '/app/',
  );
  await expectNoAxeViolations(page);
});

test('a guest who comes to the sign-in page with no next lands on the menu', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/signin/');
  await expect(page.getByText('Then on to the menu.')).toBeVisible();
  const button = page.getByRole('button', { name: 'Continue as a guest' });
  await expect(button).toBeEnabled();
  await Promise.all([sandboxMade(page), button.click()]);
  await page.waitForURL((url) => url.pathname === '/menu/');
});

test('the catering page shows the same gate, starts a sandbox in place, and then the inquiry form', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/catering/');
  const gate = page.getByRole('region', { name: 'Catering starts with your own sandbox.' });
  await expect(gate).toBeVisible();
  // One way: no second sentence with a link to the sign-in page beside it.
  await expect(page.getByText('Sign in or try it as a guest')).toHaveCount(0);
  await expect(gate.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/signin/?next=/catering/',
  );
  await expectNoAxeViolations(page);
  const [made] = await Promise.all([
    sandboxMade(page),
    gate.getByRole('button', { name: 'Start an inquiry' }).click(),
  ]);
  expect(made.status()).toBe(201);
  const form = page.getByRole('heading', { name: 'Ask about an event' });
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect(form).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/catering/');
  await expect(gate).toHaveCount(0);
  await expect(page.getByText('Your sandbox is live.')).toBeVisible();
});

test('the catering gate’s Sign in comes back to the catering page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/catering/');
  const gate = page.getByRole('region', { name: 'Catering starts with your own sandbox.' });
  await gate.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByText('Then on to catering.')).toBeVisible();
  const button = page.getByRole('button', { name: 'Continue as a guest' });
  await expect(button).toBeEnabled();
  await Promise.all([sandboxMade(page), button.click()]);
  await page.waitForURL((url) => url.pathname === '/catering/');
  await expect(page.getByRole('heading', { name: 'Ask about an event' })).toBeVisible({
    timeout: 60_000,
  });
});
