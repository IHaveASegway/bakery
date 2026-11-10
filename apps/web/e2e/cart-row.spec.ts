// A cart line's row fits its column (2026-11-10): at 1280 px the checkout's cart column was too
// narrow for the stepper, the price and Remove on one line, and a price of two of a loaf broke
// inside itself ("$19.0" over "0"). For quantities 1, 2, 10 and the most a line takes, of the
// dearest cake, the price sits on one line and nothing in the row leaves the row or its column:
// on the checkout and on the menu's cart, at 1280 px (the panel beside the list) and at 390 px
// (the checkout's column, and the menu's cart sheet).
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The page asks for the session once, and a visitor with none gets a 401 that Chromium logs.
test.use({ allowedStatuses: [401] });

const CAKE = 'chocolate-layer-cake/9-inch';
const QUANTITIES = [1, 2, 10, 24];

/** Puts `qty` of the cake in the tab's cart, as the menu's Add and the stepper leave it. */
async function cartOf(page: Page, qty: number) {
  await page.goto('/signin/');
  await page.evaluate(
    ({ variant, qty }) =>
      sessionStorage.setItem(
        'bakery.cart.v1',
        JSON.stringify({
          lines: [{ variant, qty }],
          note: '',
          kind: 'pickup',
          zone: 'z1',
          slot: '',
        }),
      ),
    { variant: CAKE, qty },
  );
}

interface Fit {
  priceText: string;
  priceLines: number;
  priceClipped: boolean;
  outsideRow: string[];
  rowOutsideColumn: boolean;
}

/** Measures the first cart line inside `column`. */
const measure = (page: Page, column: string) =>
  page
    .locator(`${column} .cart-lines li`)
    .first()
    .evaluate((li, column): Fit => {
      const box = li.getBoundingClientRect();
      const host = li.closest(column)!;
      const pad = parseFloat(getComputedStyle(host).paddingRight) || 0;
      const hostBox = host.getBoundingClientRect();
      const price = li.querySelector<HTMLElement>('.price')!;
      const range = document.createRange();
      range.selectNodeContents(price);
      // One line box: every rectangle of the price's text shares one top.
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const outsideRow = [...li.children]
        .filter((child) => {
          const r = child.getBoundingClientRect();
          return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
        })
        .map((child) => child.className || child.tagName);
      return {
        priceText: price.textContent ?? '',
        priceLines: tops.size,
        priceClipped: price.scrollWidth > price.clientWidth + 0.5,
        outsideRow,
        rowOutsideColumn:
          box.right > hostBox.right - pad + 0.5 || li.scrollWidth > li.clientWidth + 0.5,
      };
    }, column);

function expectFits(fit: Fit, where: string) {
  expect(fit.priceText, where).toMatch(/^\$[\d,]+\.\d\d$/);
  expect(fit.priceLines, `${where}: ${fit.priceText} on one line`).toBe(1);
  expect(fit.priceClipped, `${where}: price not clipped`).toBe(false);
  expect(fit.outsideRow, `${where}: nothing leaves the row`).toEqual([]);
  expect(fit.rowOutsideColumn, `${where}: the row fits its column`).toBe(false);
}

for (const [width, height] of [
  [1280, 800],
  [390, 844],
] as const) {
  test(`at ${width} px a cart line fits its column on the checkout and the menu`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    for (const qty of QUANTITIES) {
      await cartOf(page, qty);
      await page.goto('/checkout/');
      const summary = page.locator('.checkout-summary .cart-lines li').first();
      await expect(summary.locator('.price')).toHaveText(/^\$/);
      expectFits(await measure(page, '.checkout-summary'), `checkout ${width} px, ${qty}`);

      await page.goto('/menu/');
      if (width < 960) {
        // A phone: the cart is a bar at the foot of the window, and a sheet when pressed.
        const bar = page.locator('.cart-bar');
        await expect(bar).toBeEnabled();
        await bar.click();
      }
      await expect(page.locator('.cart .cart-lines li .price').first()).toBeVisible();
      expectFits(await measure(page, '.cart-sheet'), `menu ${width} px, ${qty}`);
    }
  });
}
