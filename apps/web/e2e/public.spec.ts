// The public pages, as a visitor with no session meets them: each loads with the storefront's
// headers (docs/security.md, "The storefront's policy"), and none reports a CSP violation or a
// console error (the guard in fixtures.ts).
import { expect, test } from './fixtures';

const PAGES = [
  '/',
  '/menu/',
  '/catering/',
  '/checkout/',
  '/privacy/',
  '/signin/',
  '/about/',
  '/status/',
  '/how-its-built/',
  '/how-its-built/single-writer/',
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
  });
});
