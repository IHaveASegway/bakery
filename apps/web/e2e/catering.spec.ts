// The catering screens: the staff queue on the console lists the sandbox's seeded events, and an
// inquiry sent from the storefront's catering page (/catering/) joins it as an inquiry the staff
// can quote (docs/architecture.md, "The catering saga"; the first steps of scripts/smoke-catering.sh).
import { api, demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

interface Events {
  events: { catering: string; state: string; headcount: number; brief?: string | null }[];
}

// A headcount and a brief no seeded event has, so the new card is the one found.
const HEADCOUNT = '37';
const BRIEF = 'A pastry table for a made-up team breakfast, set out by eight.';

test('the catering queue lists the seeded events, and a storefront inquiry joins it', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const seeded = await api<Events>(page, 'GET', `/v1/sandboxes/${sandbox.id}/catering`);
  expect(seeded.status).toBe(200);
  const count = seeded.body.events.length;
  expect(count, 'the seed holds catering events').toBeGreaterThan(0);

  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  const queue = page.getByRole('region', { name: 'Catering queue' });
  await expect(queue.getByText(new RegExp(`^${count} events:`))).toBeVisible();
  await expect(queue.locator('ul.queue > li')).toHaveCount(count);
  await expectNoAxeViolations(page);

  // The inquiry, as a visitor makes it on the storefront.
  await page.goto('/catering/');
  const form = page.getByRole('form', { name: 'Ask about an event' });
  const day = form.getByLabel('Day');
  await expect(day.locator('option')).not.toHaveCount(1);
  await day.selectOption({ index: 1 });
  await form.getByLabel('Headcount').fill(HEADCOUNT);
  await form.getByLabel('Package').selectOption({ label: 'Pastry platter, $9.50 a head' });
  await form.getByLabel('Venue').selectOption({ label: 'Venue 2 (made up)' });
  await form.getByLabel('Brief (optional)').fill(BRIEF);
  await form.getByRole('button', { name: 'Send inquiry' }).click();
  const mine = page.getByRole('list', { name: 'Catering events, newest first' });
  await expect(
    mine.getByRole('listitem').filter({ hasText: `Pastry platter for ${HEADCOUNT}` }),
  ).toContainText('Inquiry');
  await expectNoAxeViolations(page);

  // The staff queue has it, among the seeded ones, with the quote its state allows.
  await page.goto('/app/');
  await expect(queue.getByText(new RegExp(`^${count + 1} events:`))).toBeVisible();
  const card = queue.locator('ul.queue > li').filter({ hasText: `Brief: ${BRIEF}` });
  await expect(card).toHaveCount(1);
  await expect(card.locator('dd').first()).toHaveText('Inquiry');
  await card.getByRole('button', { name: 'Send quote' }).click();
  await expect(card.locator('dd').first()).toHaveText('Quoted');
  await expect(card).toContainText('Quote valid until');
});
