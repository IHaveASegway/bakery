// The catering screens: the staff queue on the console lists the sandbox's seeded events, and an
// inquiry sent from the storefront's catering page (/catering/) joins it as an inquiry the staff
// can quote (docs/architecture.md, "The catering saga"; the first steps of scripts/smoke-catering.sh).
import { api, demoAccount, expect, expectNoAxeViolations, liveSandbox, test } from './fixtures';

interface Events {
  events: { catering: string; state: string; headcount: number; brief?: string | null }[];
}

// No headcount can tell the new event from the seeded ones: the seed draws each from 10 to 200
// (crates/seed/src/lib.rs) and the domain accepts only 10 to 200 (crates/domain/src/catering.rs),
// and on 2026-11-10 a seeded "Pastry platter for 37" matched this spec's text. So the storefront
// card is found as the one the page opened after sending, and the staff card by its brief, which
// no seeded event has. Any valid number does here; 37 is the one the spec has always sent.
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

  await page.goto('/app/catering/');
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
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/v1/sandboxes/${sandbox.id}/catering`,
  );
  await form.getByRole('button', { name: 'Send inquiry' }).click();
  const answer = await created;
  expect(answer.status()).toBe(201);
  const made = (await answer.json()) as Events['events'][number];
  // The event the POST made, by its id: an inquiry for this headcount with this brief.
  const byId = await api<Events['events'][number]>(
    page,
    'GET',
    `/v1/sandboxes/${sandbox.id}/catering/${made.catering}`,
  );
  expect(byId.status).toBe(200);
  expect(byId.body).toMatchObject({ state: 'inquiry', headcount: Number(HEADCOUNT), brief: BRIEF });
  // The page opens the event it just made (Catering.tsx, onCreated), so its card is the one whose
  // "Open this event" is pressed, wherever the list's order puts it.
  const mine = page
    .getByRole('list', { name: 'Catering events, newest first' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Open this event', pressed: true }) });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(`Pastry platter for ${HEADCOUNT}`);
  await expect(mine).toContainText('Inquiry');
  await expectNoAxeViolations(page);

  // The staff queue has it, among the seeded ones, with the quote its state allows.
  await page.goto('/app/catering/');
  await expect(queue.getByText(new RegExp(`^${count + 1} events:`))).toBeVisible();
  const card = queue.locator('ul.queue > li').filter({ hasText: `Brief: ${BRIEF}` });
  await expect(card).toHaveCount(1);
  await expect(card.locator('dd').first()).toHaveText('Inquiry');
  await card.getByRole('button', { name: 'Send quote' }).click();
  await expect(card.locator('dd').first()).toHaveText('Quoted');
  await expect(card).toContainText('Quote valid until');
});
