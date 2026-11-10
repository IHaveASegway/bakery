// The accessibility helper reads a page at rest (fixtures.ts, expectNoAxeViolations). These two
// tests hold the reason and the rule: what axe says about a half-faded card, and that a card
// arriving while axe reads makes the helper read again. The cards are built here on a public page
// from the page's own classes, and their styles are set through the style object, as the page's
// policy requires.
import AxeBuilder from '@axe-core/playwright';
import { expect, expectNoAxeViolations, test } from './fixtures';

// The first look at the session, before there is one, is a 401 that Chromium logs.
test.use({ allowedStatuses: [401] });

const STILL_PAGE = '/how-its-built/tools/';

test('muted words on a half-faded card fail a plain axe read', async ({ page }) => {
  await page.goto(STILL_PAGE);
  await page.evaluate(() => {
    const list = document.createElement('ul');
    list.className = 'cards';
    const card = document.createElement('li');
    card.className = 'card';
    const words = document.createElement('p');
    words.className = 'hint';
    words.textContent = 'Muted words on a card that is half faded in.';
    card.append(words);
    // The page's own entrance (components.css, card-in), held at its middle.
    Object.assign(card.style, {
      animationTimingFunction: 'linear',
      animationDuration: '200ms',
      animationDelay: '-100ms',
      animationPlayState: 'paused',
    });
    list.append(card);
    document.querySelector('main')?.append(list);
  });
  const { violations } = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const targets = violations.flatMap((v) => v.nodes.map((n) => String(n.target[0])));
  expect(targets.some((target) => target.includes('.hint'))).toBe(true);
});

test('a card that arrives while axe is reading is read again, at rest', async ({ page }) => {
  await page.goto(STILL_PAGE);
  // The card arrives the moment axe's source lands in the page, as a panel's data does when it
  // comes while axe is already reading, and fades in as every card does.
  await page.evaluate(() => {
    const timer = setInterval(() => {
      if ((window as Window & { axe?: unknown }).axe === undefined) return;
      clearInterval(timer);
      const list = document.createElement('ul');
      list.className = 'cards';
      const card = document.createElement('li');
      card.className = 'card';
      const words = document.createElement('p');
      words.className = 'hint';
      words.textContent = 'Muted words on a card that just arrived.';
      card.append(words);
      list.append(card);
      document.querySelector('main')?.append(list);
    }, 2);
  });
  // The helper passes, and says it read more than once to do so.
  expect(await expectNoAxeViolations(page)).toBeGreaterThan(1);
  await expect(page.locator('main .cards .card .hint').last()).toHaveText(
    'Muted words on a card that just arrived.',
  );
  // With the card in place and nothing moving, one read is enough.
  expect(await expectNoAxeViolations(page)).toBe(1);
});
