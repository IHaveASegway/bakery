// Fixes from the audit of 2026-11-10: the catering form says what is wrong at its field (F11), a
// card's "…" menu closes on Escape and one at a time (F15), and Refund says in words what its
// second press does (F21). Nothing here refunds: the second press is never made.
import { demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the catering form marks a headcount of 500 at its field, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await demoAccount(page);
    await liveSandbox(page);
    await page.goto('/catering/');
    const form = page.getByRole('form', { name: 'Ask about an event' });
    const headcount = form.getByLabel('Headcount');
    await expect(headcount).toBeVisible();
    await expect(
      form.getByText('Still to fill: a day, a headcount, a package and a venue.'),
    ).toBeVisible();

    await headcount.fill('500');
    await expect(headcount).toHaveAttribute('aria-invalid', 'true');
    const error = form.locator('#cat-headcount-error');
    await expect(error).toHaveText('500 is more than 200 people.');
    await expect(headcount).toHaveAttribute('aria-describedby', /cat-headcount-error/);
    // Send stays off, as the checkout's Place order does, and says what is still to fill.
    await expect(form.getByRole('button', { name: 'Send inquiry' })).toBeDisabled();
    await expect(form.getByText('Still to fill: a day, a package and a venue.')).toBeVisible();
    await expectNoAxeViolations(page);

    await headcount.fill('40');
    await expect(headcount).not.toHaveAttribute('aria-invalid', 'true');
    await expect(error).toHaveText('');
  });
}

test('a card’s menu closes on Escape with focus back on its button, and one opens at a time', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  // A <summary> is a disclosure, not a button, to the accessibility tree; its name says what it is.
  // The two menus are the first in each of two different columns. A menu opens under its card at
  // the card's own width, inside its column, so it can lie over a "…" further down the same column
  // (a short card with another under it) but never over one in another column; two menus picked
  // in one column would make the test depend on the seeded board's layout.
  const columns = page
    .locator('.board > section.column')
    .filter({ has: page.locator('details.menu') });
  await expect.poll(() => columns.count()).toBeGreaterThan(1);
  const menuIn = (n: number) =>
    columns.nth(n).locator('details.menu > summary[aria-label^="More for order "]').first();
  const first = menuIn(0);
  const second = menuIn(1);
  const open = page.locator('.board details.menu[open]');
  // The console's top bar is sticky: a button scrolled to the window's top edge sits under it. Each
  // button is put in the middle of the window before it is pressed, so nothing covers it.
  const press = async (target: typeof first) => {
    await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await target.click();
  };

  await press(first);
  await expect(open).toHaveCount(1);
  await press(second);
  await expect(open).toHaveCount(1);
  await expect(open.locator('summary')).toHaveAttribute(
    'aria-label',
    (await second.getAttribute('aria-label')) ?? '',
  );

  await page.keyboard.press('Escape');
  await expect(open).toHaveCount(0);
  await expect(second).toBeFocused();

  // Refund's first press asks, in words, with the amount; Keep the order takes it back.
  await press(second);
  const panel = open.locator('.menu-panel');
  await press(panel.getByRole('button', { name: /^Refund order / }));
  await expect(panel.getByRole('status')).toHaveText(
    /^Press Refund all to refund everything left of order \w{6}’s \$[\d,]+\.\d{2}\. This cannot be undone/,
  );
  await expect(panel.getByRole('button', { name: /^Refund all that is left of \$/ })).toBeVisible();
  await expectNoAxeViolations(page);
  await press(panel.getByRole('button', { name: 'Keep the order' }));
  await expect(panel.getByRole('status')).toHaveCount(0);
  // The panel sits inside its card's column: its edges are the card's.
  const card = await open.locator('xpath=ancestor::li[contains(@class,"card")]').boundingBox();
  const box = await panel.boundingBox();
  expect(card && box && box.x >= card.x - 1 && box.x + box.width <= card.x + card.width + 1).toBe(
    true,
  );
});

// F9 on a phone, measured in the browser (2026-11-10): every stacked table cell that draws a label
// keeps a label column at least as wide as the label, so the label never sits on its value. A read
// of the source could not see this: on the API reference a plainer rule's padding won over the
// label column's, and every label there was drawn over its value.
test('at 390 px every stacked table cell keeps its label beside its value, not on it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demoAccount(page);
  await liveSandbox(page);
  // Each page, and whether it must have labelled cells (Dispatch's first open day may have no stops).
  const PAGES: [string, boolean][] = [
    ['/docs/api/', true],
    ['/privacy/', true],
    ['/inbox/', true],
    ['/app/money/', true],
    ['/app/customers/', true],
    ['/app/dispatch/', false],
  ];
  for (const [path, required] of PAGES) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    if (required) await expect(page.locator('table').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const result = await page.evaluate(() => {
      const bad: string[] = [];
      let labelled = 0;
      for (const table of document.querySelectorAll('table:not(.table-fits)')) {
        for (const cell of table.querySelectorAll(':scope > tbody > tr > :is(th, td)')) {
          const el = cell as HTMLElement;
          if (el.offsetParent === null) continue;
          const before = getComputedStyle(el, '::before');
          const label = before.content.replace(/^"|"$/g, '');
          if (before.content === 'none' || label === '') continue;
          labelled += 1;
          const padding = parseFloat(getComputedStyle(el).paddingLeft);
          const width = parseFloat(before.width);
          if (!(padding >= width)) {
            bad.push(`${label}: padding-left ${padding}px under a ${width}px label`);
          }
        }
      }
      return { bad: bad.slice(0, 5), labelled };
    });
    if (required) expect(result.labelled, `${path}: labelled cells`).toBeGreaterThan(0);
    expect(result.bad, path).toEqual([]);
  }
});
