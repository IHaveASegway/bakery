// The API reference lays out only what is near the window (`content-visibility: auto` on its 76
// operations and 127 schemas, global.css). Each check here fails on a page that does not have the
// property, or that has it and gets one of its costs wrong: a link that lands short, a section
// that is out of the accessibility tree, a page that moves sideways, paper that is cut.
import { expect, expectNoAxeViolations, test } from './fixtures';

test.use({ allowedStatuses: [401] });

const WIDTHS = [390, 1280] as const;

// Whether the browser has skipped this element's layout (it sits inside a section that is far from
// the window). `contentVisibilityAuto` is the option that answers false for such an element; a
// bounding box does not, since Chromium still reports a size for a skipped section's descendants.
const laidOut = (selector: string) => (page: import('@playwright/test').Page) =>
  page
    .locator(selector)
    .evaluate((el) => (el as HTMLElement).checkVisibility({ contentVisibilityAuto: true }));

async function targets(page: import('@playwright/test').Page) {
  await page.goto('/docs/api/');
  await expect(page.locator('h1')).toBeVisible();
  return page.evaluate(() => {
    const schemas = [...document.querySelectorAll<HTMLElement>('section.api-schema')].map(
      (s) => s.id,
    );
    const ops = [...document.querySelectorAll<HTMLElement>('article.api-op')].map((a) => a.id);
    return {
      schemas: [
        schemas[0]!,
        schemas[Math.floor(schemas.length / 2)]!,
        schemas[schemas.length - 1]!,
      ],
      op: ops[Math.floor(ops.length / 2)]!,
      schemaCount: schemas.length,
      opCount: ops.length,
    };
  });
}

// The heading of a target is in the window and below anything stuck to the top of it.
async function expectHeadingClear(page: import('@playwright/test').Page, id: string) {
  await expect
    .poll(
      () =>
        page.evaluate((anchor) => {
          const target = document.getElementById(anchor)!;
          const heading = target.querySelector<HTMLElement>('h3, h4')!;
          const top = heading.getBoundingClientRect().top;
          const bottom = heading.getBoundingClientRect().bottom;
          let stuck = 0;
          for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            const position = getComputedStyle(el).position;
            if (position !== 'sticky' && position !== 'fixed') continue;
            const box = el.getBoundingClientRect();
            if (box.top <= 1 && box.bottom > 0 && box.width > 0)
              stuck = Math.max(stuck, box.bottom);
          }
          return top >= stuck - 1 && bottom <= window.innerHeight;
        }, id),
      { message: `the heading of #${id} is in the window, clear of any sticky bar` },
    )
    .toBe(true);
}

for (const width of WIDTHS) {
  test(`at ${width} px a link into a far section lands on its heading, from a hash and from a click`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { schemas, op, schemaCount, opCount } = await targets(page);
    expect(schemaCount).toBeGreaterThan(100);
    expect(opCount).toBeGreaterThan(50);

    // A click on a link of the page: the index's link to an operation, and a type's link to its section.
    await page.locator(`a[href="#${op}"]`).first().click();
    await expectHeadingClear(page, op);
    for (const id of schemas) {
      await page
        .locator(`a[href="#${id}"]`)
        .first()
        .evaluate((a) => (a as HTMLElement).click());
      await expectHeadingClear(page, id);
    }

    // The page loaded with the hash.
    for (const id of [...schemas, op]) {
      await page.goto(`/docs/api/#${id}`);
      await expectHeadingClear(page, id);
    }
  });

  test(`at ${width} px a far section is skipped but its text is in the accessibility tree`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { schemas } = await targets(page);
    const last = schemas[2]!;
    const name = last.replace(/^schema-/, '');
    // The property is on: the last section is far from the window and not laid out ...
    expect(await laidOut(`#${last} h3`)(page)).toBe(false);
    // ... and its heading is still read by assistive technology, by the name of the type.
    await expect(page.getByRole('heading', { name, exact: true, level: 3 })).toHaveCount(1);
    expect(await page.locator(`#${last}`).ariaSnapshot()).toContain(`heading "${name}" [level=3]`);
    expect(await laidOut(`#${last} h3`)(page)).toBe(false);
    await expectNoAxeViolations(page);
  });

  test(`at ${width} px the page does not move sideways and its height settles`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // A tall window, so the walk below is half as many steps; the rule is the same.
    const step = 1300;
    await page.setViewportSize({ width, height: step + 100 });
    await targets(page);
    // Move to a place, then read how far the page spills sideways and how tall it is, in one call.
    const at = (to: number) =>
      page.evaluate((y) => {
        window.scrollTo(0, y);
        const root = document.documentElement;
        return { sideways: root.scrollWidth - root.clientWidth, height: root.scrollHeight };
      }, to);
    // Top to bottom in windows, then back: a section that has been laid out keeps its height.
    let read = await at(0);
    expect(read.sideways).toBeLessThanOrEqual(0);
    for (let y = 0; y < read.height; y += step) {
      read = await at(y);
      expect(read.sideways, `sideways at ${y}`).toBeLessThanOrEqual(0);
    }
    for (let y = read.height; y > 0; y -= step) {
      read = await at(y);
      expect(read.sideways, `sideways at ${y} on the way back`).toBeLessThanOrEqual(0);
    }
    const first = await at(0);
    await at(first.height);
    const second = await at(0);
    expect(second.height).toBe(first.height);
    expect(second.sideways).toBeLessThanOrEqual(0);
  });
}

test('at 320 px the page does not move sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await targets(page);
  const sideways = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await sideways()).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await sideways()).toBeLessThanOrEqual(0);
});

test('on paper every section is laid out, as it is on the screen only near the window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await targets(page);
  const skipped = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('.api-op table, .api-schema table')].filter(
          (el) => !el.checkVisibility({ contentVisibilityAuto: true }),
        ).length,
    );
  // On the screen most of the 256 tables are skipped ...
  expect(await skipped()).toBeGreaterThan(100);
  // ... on paper none is, so the whole document prints. The browser lets go of a skipped section at
  // its next rendering update, not at the style change, so this is a poll: read at once after the
  // switch it still counted 255 in two tries of four on 2026-11-10.
  await page.emulateMedia({ media: 'print' });
  await expect.poll(skipped).toBe(0);
});

// A column is never narrower than its longest word. `main` breaks anywhere, and inside a table that
// let the browser squeeze a short column until "Required", "string" and "yes" stood on two lines:
// on 2026-11-10 more than 400 of the 16,033 words in these tables were broken so at 1280, 1024 and
// 768 px. A run of letters, digits and underscores is one word here; a break after a hyphen or a
// slash is the language's own and is not counted. Under 40rem the rows stack and the column heads
// are hidden from sight, so the widths asked are the ones that draw a table as a table.
for (const width of [768, 1024, 1280] as const) {
  test(`at ${width} px no word in a table of the reference is broken in two`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/docs/api/');
    await expect(page.locator('h1')).toBeVisible();
    const read = await page.evaluate(() => {
      // Every section laid out for the read: a skipped section has no lines to count.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('* { content-visibility: visible !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const broken = new Set<string>();
      let words = 0;
      const tables = document.querySelectorAll(
        'table.params-table, table.schema-table, table.frames-table',
      );
      for (const table of tables) {
        const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const match of (node.textContent ?? '').matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
            words += 1;
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const lines = new Set(
              [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
            );
            if (lines.size > 1) broken.add(match[0]);
          }
        }
      }
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      return { tables: tables.length, words, broken: [...broken].slice(0, 12) };
    });
    // The premise: the read saw the page's tables and their words.
    expect(read.tables).toBeGreaterThan(200);
    expect(read.words).toBeGreaterThan(10_000);
    expect(read.broken, 'words broken in two').toEqual([]);
  });
}
