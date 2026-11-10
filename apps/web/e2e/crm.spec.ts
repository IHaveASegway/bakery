// The console's CRM panels: the customers list and one customer's timeline, the segments, and the
// lead pipeline, each matched against the API's own answer, with a lead moved a stage by the
// catering queue's own button (the pipeline panel only reports; a stage changes when the event
// does). The routes are those of scripts/smoke-crm.sh. R46.
import {
  api,
  businessDate,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  nthOpenDay,
  test,
} from './fixtures';

interface Customer {
  customer: string;
  display_name: string;
}
interface Timeline {
  entries: { at: string; type: string; ref: string; label: string }[];
}
interface Segments {
  segments: { segment: string; members: number }[];
}
interface Leads {
  stages: { stage: string; count: number; events: string[] }[];
}

// The pipeline's rows in the order the panel draws them (src/lib/crm.ts, LEAD_STAGES).
const STAGES = [
  ['inquiry', 'Inquiry'],
  ['quoted', 'Quoted'],
  ['accepted', 'Accepted'],
  ['won', 'Won (deposit paid)'],
  ['lost', 'Lost'],
  ['closed', 'Closed (delivered and paid)'],
] as const;

// The segments' headings, as the panel words them.
const SEGMENT_LABELS: Record<string, string> = {
  everyone: 'Everyone',
  'cake-last-30-days': 'Cake in the last 30 days',
  'delivery-customers': 'Delivery customers',
  'lapsed-60-days': 'Lapsed for 60 days',
  'catering-leads': 'Catering leads',
};

const BRIEF = 'A made-up tasting table for the crm spec, set out by nine.';

test('the CRM panels show what the API holds, and a quote moves a lead along the pipeline', async ({
  page,
}) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;

  // A lead of this test's own, in the inquiry stage, so the move below is certain.
  const today = businessDate(Date.now() + (sandbox.clock_offset_s ?? 0) * 1000);
  const inquiry = await api<{ catering: string }>(page, 'POST', `${base}/catering`, {
    date: nthOpenDay(today, 9),
    headcount: 40,
    package: 'breakfast-spread',
    venue: 'v2',
    brief: BRIEF,
  });
  expect(inquiry.status, JSON.stringify(inquiry.body)).toBe(201);
  const lead = inquiry.body.catering;

  // The seeded orders reach the Crm a moment after the sandbox is live.
  await expect
    .poll(
      async () =>
        (await api<{ customers: Customer[] }>(page, 'GET', `${base}/customers`)).body.customers
          .length,
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await api<Leads>(page, 'GET', `${base}/leads`)).body.stages.find(
          (s) => s.stage === 'inquiry',
        )?.events,
      { timeout: 30_000 },
    )
    .toContain(lead);

  await page.goto('/app/customers/');

  // Customers: the list is the API's, in its order.
  const customers = (await api<{ customers: Customer[] }>(page, 'GET', `${base}/customers`)).body
    .customers;
  const panel = page.getByRole('region', { name: 'Customers', exact: true });
  await expect(panel.getByText(`The ${customers.length} synthetic customers`)).toBeVisible();
  const rows = panel.locator('tbody tr');
  await expect(rows).toHaveCount(customers.length);
  for (const [i, c] of customers.slice(0, 3).entries()) {
    await expect(rows.nth(i).locator('th button')).toHaveText(c.display_name);
  }
  await expectNoAxeViolations(page);

  // One customer's timeline: every entry the API holds, newest first.
  const first = customers[0];
  if (!first) throw new Error('the seed holds no customers');
  await rows.nth(0).locator('th button').click();
  const timeline = panel.getByRole('region', { name: first.display_name, exact: true });
  const entries = timeline.getByRole('list', { name: /^Timeline of .*, newest first$/ });
  await expect(entries).toBeVisible();
  const expected = (
    await api<Timeline>(page, 'GET', `${base}/customers/${first.customer}/timeline`)
  ).body.entries;
  expect(expected.length, 'the first customer has a history').toBeGreaterThan(0);
  await expect(entries.getByRole('listitem')).toHaveCount(expected.length);
  await expectNoAxeViolations(page);

  // Segments: each with its size.
  const segments = (await api<Segments>(page, 'GET', `${base}/segments`)).body.segments;
  expect(segments.length).toBe(Object.keys(SEGMENT_LABELS).length);
  const segmentPanel = page.getByRole('region', { name: 'Segments', exact: true });
  await expect(segmentPanel.locator('ul.cards > li')).toHaveCount(segments.length);
  for (const s of segments) {
    const card = segmentPanel.locator('ul.cards > li').filter({
      has: page.getByRole('heading', {
        name: SEGMENT_LABELS[s.segment] ?? s.segment,
        exact: true,
      }),
    });
    await expect(card.locator('strong')).toHaveText(String(s.members));
  }
  await expectNoAxeViolations(page);

  // The pipeline: a row a stage, with the API's count, on the catering page with the queue.
  await page.goto('/app/catering/');
  const pipeline = page.getByRole('region', { name: 'Catering lead pipeline' });
  const stageRows = pipeline.locator('tbody tr');
  await expect(stageRows).toHaveCount(STAGES.length);
  const counts = async () => {
    const answer = (await api<Leads>(page, 'GET', `${base}/leads`)).body.stages;
    return STAGES.map(([stage]) => String(answer.find((s) => s.stage === stage)?.count ?? 0));
  };
  const before = await counts();
  await expect(stageRows.locator('td')).toHaveText(before);
  await expectNoAxeViolations(page);

  // The move: the queue's own button quotes the inquiry; the panel looks again every ten seconds.
  const queue = page.getByRole('region', { name: 'Catering queue' });
  const card = queue.locator('ul.queue > li').filter({ hasText: `Brief: ${BRIEF}` });
  await expect(card).toHaveCount(1);
  await expect(card.locator('dd').first()).toHaveText('Inquiry');
  await card.getByRole('button', { name: 'Send quote' }).click();
  await expect(card.locator('dd').first()).toHaveText('Quoted');

  const inquiryAt = STAGES.findIndex(([s]) => s === 'inquiry');
  const quotedAt = STAGES.findIndex(([s]) => s === 'quoted');
  const want = [...before];
  want[inquiryAt] = String(Number(before[inquiryAt]) - 1);
  want[quotedAt] = String(Number(before[quotedAt]) + 1);
  await expect(stageRows.locator('td')).toHaveText(want, { timeout: 30_000 });
  const after = (await api<Leads>(page, 'GET', `${base}/leads`)).body.stages;
  expect(after.find((s) => s.stage === 'quoted')?.events).toContain(lead);
  expect(after.find((s) => s.stage === 'inquiry')?.events).not.toContain(lead);
  expect(await counts()).toEqual(want);
  await expectNoAxeViolations(page);
});
