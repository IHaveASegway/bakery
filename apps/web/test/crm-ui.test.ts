// The CRM components drawn once, statically: which buttons each campaign state shows, who sees
// them, and that no field asks for a name, an email, a phone or an address. Effects do not run in
// a static render, so these look at the first paint; the logic behind it is in crm.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { CampaignResponse, CampaignState } from '../src/contracts';
import Campaigns, { CampaignCard } from '../src/components/Campaigns';
import Rebuild from '../src/components/Rebuild';

const campaign = (state: CampaignState): CampaignResponse => ({
  campaign: '01JTESTCAMPAIGN00000000AA',
  state,
  subject: 'cake-week',
  body: 'cake-orders',
  segment: 'cake-last-30-days',
  send_at: state === 'draft' || state === 'cancelled' ? null : '2026-11-08T09:30:00-07:00',
  recipients: state === 'sent' ? 40 : 0,
  delivered: state === 'sent' ? 40 : 0,
  opened: state === 'sent' ? 18 : 0,
  clicked: state === 'sent' ? 6 : 0,
});

const card = (state: CampaignState, isGuest = false) =>
  renderToStaticMarkup(
    createElement(CampaignCard, {
      sandboxId: 'S',
      campaign: campaign(state),
      isGuest,
      clockOffsetS: 0,
      onChange: () => undefined,
      onEdit: () => undefined,
    }),
  );

describe('a campaign card', () => {
  test('a draft offers edit, schedule (with a datetime input) and cancel', () => {
    const html = card('draft');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('>Schedule<');
    expect(html).toContain('>Edit<');
    expect(html).toContain('>Cancel campaign<');
  });

  test('a scheduled one offers only to unschedule, and shows its send time', () => {
    const html = card('scheduled');
    expect(html).not.toContain('datetime-local');
    expect(html).not.toContain('>Edit<');
    expect(html).toContain('Unschedule (back to draft)');
    expect(html).toContain('9:30 am on Sunday 2026-11-08');
  });

  test('a sent one has no buttons and shows its numbers with their rates', () => {
    const html = card('sent');
    expect(html).not.toContain('<button');
    expect(html).toContain('18 (45%)');
    expect(html).toContain('6 (15%)');
  });

  test('a cancelled one has no buttons', () => {
    expect(card('cancelled')).not.toContain('<button');
  });

  test('a guest sees the facts and no buttons', () => {
    const html = card('draft', true);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('datetime-local');
    expect(html).toContain('Draft');
  });

  test('a campaign with nothing delivered shows dashes for the rates, not NaN', () => {
    const html = card('scheduled');
    expect(html).toContain('0 (–)');
    expect(html).not.toContain('NaN');
  });
});

describe('the compose form and the rebuild', () => {
  const page = renderToStaticMarkup(
    createElement(Campaigns, { sandboxId: 'S', isGuest: false, clockOffsetS: 0 }),
  );

  test('subject, body and segment are selects; there is no text field', () => {
    expect(page.match(/<select/g)).toHaveLength(3);
    expect(page).not.toMatch(/<textarea|type="text"|type="email"|type="tel"/);
  });

  test('the preview shows the subject and the body as the inbox will', () => {
    expect(page).toContain('This weekend at Proof of Concept');
    expect(page).toContain('There is news from the bakery this week.');
  });

  test('the "How this works" line names the three guarantees', () => {
    expect(page).toMatch(/frozen at\s+send time/);
    expect(page).toContain('Consent is data the send reads');
    expect(page).toMatch(/sends\s+once, however often the alarm fires/);
  });

  test('the rebuild button is off for a guest, and its line names the principle', () => {
    const guest = renderToStaticMarkup(
      createElement(Rebuild, { sandboxId: 'S', isGuest: true, onFinished: () => undefined }),
    );
    expect(guest).toMatch(/<button[^>]*disabled/);
    expect(guest).toContain('disposable and the log is not');
    expect(guest).toContain('Backfill');
    const staff = renderToStaticMarkup(
      createElement(Rebuild, { sandboxId: 'S', isGuest: false, onFinished: () => undefined }),
    );
    expect(staff).not.toMatch(/<button[^>]*disabled/);
  });
});
