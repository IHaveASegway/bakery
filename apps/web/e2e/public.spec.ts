// The public pages, as a visitor with no session meets them: each loads with the storefront's
// headers (docs/security.md, "The storefront's policy"), and none reports a CSP violation or a
// console error (the guard in fixtures.ts).
import { expect, expectNoAxeViolations, test } from './fixtures';

const PAGES = [
  '/',
  '/menu/',
  '/catering/',
  '/checkout/',
  '/order/',
  '/privacy/',
  '/signin/',
  '/about/',
  '/status/',
  '/how-its-built/',
  '/how-its-built/outbox/',
  '/how-its-built/cache/',
  '/how-its-built/rebuild/',
  '/how-its-built/routes/',
  '/how-its-built/single-writer/',
  '/how-its-built/idempotency/',
  '/how-its-built/sagas/',
  '/how-its-built/leases/',
  '/how-its-built/admission/',
  '/how-its-built/lag/',
  '/how-its-built/time-travel/',
  '/how-its-built/sandbox/',
  '/how-its-built/api/',
  '/how-its-built/breaker/',
  '/how-its-built/tools/',
  '/docs/api/',
  '/inbox/',
  '/app/',
  '/app/money/',
  '/app/menu/',
  '/app/catering/',
  '/app/customers/',
  '/app/dispatch/',
  '/app/system/',
  // The sign-in's landing (2026-11-10): with no session it goes on to the sign-in page.
  '/app/start/',
];

// A visitor with no session: a page that asks the API who it is gets 401, which Chromium logs.
test.use({ allowedStatuses: [401] });

for (const pathname of PAGES) {
  test(`${pathname} loads with the storefront's headers`, async ({ page }) => {
    const response = await page.goto(pathname);
    expect(response?.status()).toBe(200);
    const headers = response!.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(
      "connect-src 'self' https://api.bakery.ihaveasegway.com wss://api.bakery.ihaveasegway.com",
    );
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), usb=()');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    // HSTS has one owner, the zone, so the storefront never sends it.
    expect(headers['strict-transport-security']).toBeUndefined();
    await expect(page.locator('h1')).toBeVisible();
    // Every island's first calls have answered, so the guard has seen what they logged.
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  });
}

test.describe('an unknown path', () => {
  // The 404 is the answer under test, and Chromium logs it.
  test.use({ allowedStatuses: [401, 404] });

  test('is answered with the 404 page', async ({ page }) => {
    const response = await page.goto('/no-such-page/');
    expect(response?.status()).toBe(404);
    await expect(page.locator('h1')).toBeVisible();
    // Every island's first calls have answered, so the guard has seen what they logged.
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  });
});

// The tools page (/how-its-built/tools/): a "Considered and not chosen" list opens from the
// keyboard, and axe finds nothing with every list open, in the light scheme and the dark.
for (const colorScheme of ['light', 'dark'] as const) {
  test(`the tools page passes axe with every list open, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/how-its-built/tools/');
    await expect(page.locator('h1')).toHaveText('The tools, and what was not chosen');
    const summaries = page.locator('details.tool-alts > summary');
    expect(await summaries.count()).toBeGreaterThan(20);
    await summaries.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('details.tool-alts').first()).toHaveAttribute('open', '');
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('details')) d.open = true;
    });
    await expectNoAxeViolations(page);
  });
}

test('a page asks for the session once, with the guide open too (audit P2)', async ({ page }) => {
  let asked = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/session') asked += 1;
  });
  await page.goto('/menu/');
  await page.getByRole('button', { name: 'Recorder' }).click();
  const panel = page.getByRole('region', { name: 'Recorder' });
  await expect(panel).toBeVisible();
  // An entry's body reads the session for its curl, as the tour's card did.
  await panel.getByRole('button', { name: 'Where the menu came from' }).click();
  await expect(panel.getByText('The same call with curl')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(asked).toBe(1);
});

test('the sitemap is served and names the menu', async ({ page }) => {
  // Fetched, not opened: a browser's own XML viewer draws with an inline style the policy refuses.
  await page.goto('/about/');
  const answer = await page.evaluate(async () => {
    const response = await fetch('/sitemap.xml');
    return { status: response.status, text: await response.text() };
  });
  expect(answer.status).toBe(200);
  expect(answer.text).toContain('<loc>https://bakery.ihaveasegway.com/menu/</loc>');
});

test('a cart quantity can be cleared and retyped, and settles into range with the range said (audit P5)', async ({
  page,
}) => {
  await page.goto('/menu/');
  await page
    .getByRole('button', { name: /^Add .* to the cart$/ })
    .first()
    .click();
  const qty = page.getByRole('spinbutton', { name: /^Quantity of / });
  await expect(qty).toHaveValue('1');

  await qty.fill('');
  await expect(qty).toHaveValue('');
  await qty.fill('3');
  await expect(qty).toHaveValue('3');
  await expect(page.getByText('Quantities run from 1 to 24.')).toHaveCount(0);

  await qty.fill('99');
  await qty.blur();
  await expect(qty).toHaveValue('24');
  await expect(page.getByText('Quantities run from 1 to 24.')).toBeVisible();

  await qty.fill('');
  await qty.blur();
  await expect(qty).toHaveValue('1');
});
