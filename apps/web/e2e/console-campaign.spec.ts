// A campaign made, scheduled and sent through the staff routes lands in the sandbox's inbox page
// (docs/architecture.md, "A campaign send"; the same sequence as scripts/smoke-crm.sh).
import {
  api,
  businessIso,
  demoAccount,
  expect,
  expectNoAxeViolations,
  liveSandbox,
  test,
} from './fixtures';

interface Campaign {
  campaign: string;
  state: string;
  recipients: number;
  delivered: number;
}

test('a campaign sent through the staff routes lands in the inbox page', async ({ page }) => {
  await demoAccount(page);
  const sandbox = await liveSandbox(page);
  const base = `/v1/sandboxes/${sandbox.id}`;

  const created = await api<Campaign>(page, 'POST', `${base}/campaigns`, {
    subject: 'cake-week',
    body: 'cake-orders',
    segment: 'everyone',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.campaign;

  // The earliest send time is about 15 business minutes ahead; ask for 20, on a whole minute.
  const ahead = Date.now() + (sandbox.clock_offset_s ?? 0) * 1000 + 20 * 60_000;
  const sendAt = businessIso(ahead);
  const scheduled = await api(page, 'POST', `${base}/campaigns/${id}/schedule`, {
    send_at: sendAt,
  });
  expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);

  // The clock passes send_at; the sandbox's alarm sends the campaign.
  const stepped = await api(page, 'POST', `${base}/clock`, { step: '1h' });
  expect(stepped.status, JSON.stringify(stepped.body)).toBe(200);
  await expect
    .poll(async () => (await api<Campaign>(page, 'GET', `${base}/campaigns/${id}`)).body.state, {
      timeout: 60_000,
    })
    .toBe('sent');
  // Delivery follows the send: the Inbox takes each message after the Crm freezes the recipients.
  await expect
    .poll(
      async () => {
        const c = (await api<Campaign>(page, 'GET', `${base}/campaigns/${id}`)).body;
        return c.recipients > 0 && c.delivered === c.recipients;
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.goto('/inbox/');
  await page.getByLabel('Show').selectOption({ label: 'Campaign' });
  const subject = page.getByRole('button', { name: 'It is cake week' }).first();
  await expect(subject).toBeVisible();
  await subject.click();
  await expect(page.getByRole('heading', { name: 'It is cake week' })).toBeVisible();
  await expectNoAxeViolations(page);
});
