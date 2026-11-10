// The console's words and checks after the audit of 2026-11-08: times in the bakery's own words,
// a pause that says it was published, a price field that says what it sets, the bake list's
// catering lines, the inbox's empty kinds, the token panel's Rotate, the campaign card after a
// send, and the dispatch comparison over different stops. Static renders show the first paint;
// effects do not run in them.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { CampaignResponse } from '../src/contracts';
import BakeList from '../src/components/BakeList';
import { CampaignCard } from '../src/components/Campaigns';
import { CardView } from '../src/components/KitchenBoard';
import { leaveLabel } from '../src/components/ConsoleTopBar';
import { canRotate } from '../src/lib/api-token';
import { stateSays } from '../src/lib/crm';
import { proposedSaid, report, routeCredit, sameStops } from '../src/lib/dispatch';
import { countText } from '../src/lib/inbox';
import { applyEvent, bakeLineText, EMPTY_BOARD, type Card } from '../src/lib/kitchen';
import {
  andList,
  priceFieldName,
  priceSaid,
  statusSaid,
  waitingPriceText,
  waitingText,
} from '../src/lib/menu';
import { nextPollMs, POLL_MAX_MS, POLL_MS } from '../src/lib/use-poll';
import { clockOfText, shortDate, shortWhen, timesIn, whenText } from '../src/lib/when';
import { day, orderId, plan, stop } from './dispatch-support';

describe('one formatter for every time shown', () => {
  test('a business time reads as the bakery says it', () => {
    expect(whenText('2026-11-08T08:15:00-07:00')).toBe('8:15 am on Sunday 2026-11-08');
    expect(shortWhen('2026-11-08T08:15:00-07:00')).toBe('Sun 8 Nov, 8:15 am');
    expect(shortWhen('2026-11-10T21:45:00Z')).toBe('Tue 10 Nov, 2:45 pm');
    expect(shortWhen('soon')).toBe('soon');
    expect(shortDate('2026-11-10T21:45:00Z')).toBe('Tue 10 Nov');
    expect(whenText('2026-11-10T07:00:00-07:00')).toBe('7:00 am on Tuesday 2026-11-10');
  });

  test('a UTC stamp, as the feed carries, reads as the same bakery time', () => {
    // 16:22:40Z is 9:22:40 in Salt Lake City in November.
    expect(whenText('2026-11-08T16:22:07Z')).toBe('9:22 am on Sunday 2026-11-08');
    expect(whenText('2026-11-08T16:22:07Z', { seconds: true })).toBe(
      '9:22:07 am on Sunday 2026-11-08',
    );
  });

  test('a date, nothing and text that is not a time', () => {
    expect(whenText('2026-11-07')).toBe('Saturday 2026-11-07');
    expect(whenText(null)).toBe('never');
    expect(whenText('soon')).toBe('soon');
    expect(clockOfText('2026-11-08T13:45:00-07:00')).toBe('1:45 pm');
  });

  test('times inside a sentence the API wrote are put in words, the rest left as it is', () => {
    expect(timesIn('Clock moved from 2026-11-11T07:01:40-07:00 to 2026-11-12T07:01:40-07:00')).toBe(
      'Clock moved from 7:01 am on Wednesday 2026-11-11 to 7:01 am on Thursday 2026-11-12',
    );
    expect(timesIn('Routes proposed: 2 vans')).toBe('Routes proposed: 2 vans');
  });

  test('a board card shows its slot in words, with the wire form kept for machines', () => {
    const placed = applyEvent(EMPTY_BOARD, {
      id: 'e1',
      type: 'OrderPlaced',
      stream: `order:S:${orderId(1)}`,
      seq: 1,
      at: '2026-11-08T07:00:00-07:00',
      recorded_at: '2026-11-08T14:00:00Z',
      cause: null,
      data: {
        lines: [{ variant: 'country-loaf/whole', qty: 1 }],
        slot: '2026-11-08T08:15:00-07:00',
        kind: 'pickup',
      },
    });
    const card = placed.cards[orderId(1)] as Card;
    const html = renderToStaticMarkup(
      createElement(CardView, {
        card,
        sandboxId: 'S',
        canRefund: false,
        open: true,
        onAct: () => undefined,
        onRefunded: () => undefined,
      }),
    );
    // The card says it short, as people say it; the long form is the element's title.
    expect(html).toContain(
      '<time dateTime="2026-11-08T08:15:00-07:00" title="8:15 am on Sunday 2026-11-08"><span class="card-clock">8:15 am</span> <span class="card-date">Sun 8 Nov</span></time>',
    );
    // Focus can be put on the card when its new state has no button.
    expect(html).toContain('tabindex="-1"');
  });
});

describe('the menu editor says what the Catalog does', () => {
  test('a pause or a resume was published at once, as a version of its own', () => {
    expect(statusSaid('Seeded rye', true, 2)).toBe(
      'Seeded rye is paused. That was published at once as version 2: the storefront shows it paused now. Price drafts still wait for Publish.',
    );
    expect(statusSaid('Seeded rye', false, 3)).toContain('on sale again');
    expect(statusSaid('Seeded rye', true, 2)).not.toContain('drafted');
  });

  test('the line beside Publish counts the drafts the server holds', () => {
    expect(waitingText(null)).toBe('Reading what waits for Publish…');
    expect(waitingText(0)).toBe('No item waits for Publish.');
    expect(waitingText(1)).toBe('1 item has a price waiting for Publish.');
    expect(waitingText(3)).toBe('3 items have prices waiting for Publish.');
  });

  test('each variant has its own price field, named for it (roadmap R86)', () => {
    const v = (label: string) => ({ label }) as never;
    const loaf = { name: 'Fern loaf', variants: [v('Whole'), v('Half')] };
    const tea = { name: 'Moss tea', variants: [v('Small')] };
    expect(priceFieldName(loaf, v('Half'))).toBe('Fern loaf, Half');
    // One variant: the item's name alone, as its one field always had.
    expect(priceFieldName(tea, v('Small'))).toBe('Moss tea');
    expect(priceSaid(loaf, v('Half'), 600)).toBe(
      'Fern loaf, Half: $6.00 drafted. Publish to put it on sale.',
    );
    expect(waitingPriceText(550, undefined)).toBeNull();
    expect(waitingPriceText(550, 550)).toBeNull();
    expect(waitingPriceText(550, 600)).toBe('Waiting for publish: $6.00.');
    expect(andList(['Small', 'Medium', 'Large'])).toBe('Small, Medium and Large');
  });
});

describe('the bake list', () => {
  test('a catering line says its headcount as people, not as a quantity', () => {
    expect(bakeLineText({ item: 'celebration-cake-and-coffee', qty: 156 })).toBe(
      'Celebration cake and coffee for 156 people',
    );
    expect(bakeLineText({ item: 'breakfast-spread', qty: 1 })).toBe(
      'Breakfast spread for 1 person',
    );
    expect(bakeLineText({ item: 'country-loaf', qty: 12 })).toBe('12 × country loaf');
  });

  test('the API’s catering flag decides, and a package slug still does for an older frame', () => {
    expect(bakeLineText({ item: 'spring-tasting', qty: 30, catering: true })).toBe(
      'spring tasting for 30 people',
    );
    expect(bakeLineText({ item: 'breakfast-spread', qty: 40, catering: true })).toBe(
      'Breakfast spread for 40 people',
    );
    expect(bakeLineText({ item: 'country-loaf', qty: 12, catering: false })).toBe(
      '12 × country loaf',
    );
  });

  test('with no plan from today on, it says what makes one, and that the clock does not', () => {
    const html = renderToStaticMarkup(createElement(BakeList, { lists: [], today: '2026-11-08' }));
    expect(html).toContain('when an order or a catering deposit for it is paid');
    expect(html).toContain('Moving the clock does not make one');
    expect(html).not.toContain('when the clock moves to it');
  });

  test('a day’s panel shows its times in words and its catering line for people', () => {
    const html = renderToStaticMarkup(
      createElement(BakeList, {
        today: '2026-11-08',
        lists: [
          {
            date: '2026-11-19',
            version: 1,
            reserved: 1,
            lines: [
              { item: 'lunch-boxes', qty: 49, start: '2026-11-19T07:00:00-07:00' },
              { item: 'croissant', qty: 6, start: '2026-11-19T07:00:00-07:00' },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('>7:00 am</time>');
    expect(html).toContain('Lunch boxes for 49 people');
    expect(html).toContain('6 × croissant');
  });
});

describe('the inbox filter', () => {
  test('a kind with no messages says so, rather than that the inbox is empty', () => {
    expect(countText(0, 0)).toBe('The inbox is empty.');
    expect(countText(0, 0, 'all')).toBe('The inbox is empty.');
    expect(countText(0, 0, 'campaign')).toBe('No campaign messages.');
    expect(countText(0, 0, 'receipt')).toBe('No receipt messages.');
    expect(countText(2, 2, 'receipt')).toBe('2 messages.');
  });
});

describe('the token panel', () => {
  test('Rotate needs a token to replace', () => {
    expect(canRotate(null)).toBe(false);
    expect(canRotate({ token_v: 0 } as never)).toBe(false);
    expect(canRotate({ token_v: 1, issued_at: '2026-11-08T16:00:00Z' } as never)).toBe(true);
  });
});

describe('a campaign card after its send', () => {
  const sent: CampaignResponse = {
    campaign: '01JTESTCAMPAIGN00000000AA',
    state: 'sent',
    subject: 'cake-week',
    body: 'cake-orders',
    segment: 'cake-last-30-days',
    send_at: '2026-11-08T09:30:00-07:00',
    recipients: 40,
    delivered: 40,
    opened: 18,
    clicked: 6,
  };

  test('says Sent once, and nothing about being scheduled', () => {
    const html = renderToStaticMarkup(
      createElement(CampaignCard, {
        sandboxId: 'S',
        campaign: sent,
        isGuest: false,
        clockOffsetS: 0,
        onChange: () => undefined,
        onEdit: () => undefined,
      }),
    );
    // The state is a badge (components.css), its word followed by the sentence on what it means.
    expect(html).toContain(
      '<strong class="badge" data-tone="ready">Sent</strong> The recipients were fixed',
    );
    expect(html).not.toContain('Sent. Sent.');
    expect(html).not.toContain('Scheduled.');
    expect(stateSays('cancelled')).toBe('Nothing was sent.');
  });
});

describe('the dispatch comparison', () => {
  const after = plan('server', [{ van: 1, stops: [2], minutes: 22 }], { plan_v: 3 });
  const before = plan('browser', [{ van: 1, stops: [1, 2], minutes: 41 }], { plan_v: 2 });
  const both = day([stop(1, 1, 8, { status: 'completed' }), stop(2, 2, 8)], {
    proposed: after,
    submitted: before,
    comparison: { server_minutes: 22, browser_minutes: 41, gap_percent: -46.3 },
  });

  test('plans over different stops are not compared, and the page says why', () => {
    expect(sameStops(after, before)).toBe(false);
    const r = report(both, 'ready');
    expect(r.compared).toBe(false);
    expect(r.summary).toContain('made over different stops');
    expect(r.summary).toContain('the server’s over 1, the browser’s over 2');
    expect(r.summary).not.toContain('46.3%');
  });

  test('plans over the same stops are compared as the API reports', () => {
    const same = plan('browser', [{ van: 1, stops: [2], minutes: 20 }], { plan_v: 4 });
    expect(sameStops(after, same)).toBe(true);
    const r = report(
      {
        ...both,
        submitted: same,
        comparison: { server_minutes: 22, browser_minutes: 20, gap_percent: 10 },
      },
      'ready',
    );
    expect(r.compared).toBe(true);
    expect(r.summary).toContain('10.0% longer');
  });

  test('the propose message counts the vans the plan uses', () => {
    expect(proposedSaid(after, 2)).toBe('Proposed a plan that uses 1 of the 2 vans.');
    expect(proposedSaid(after, 1)).toBe('Proposed a plan that uses the van.');
    const two = plan('server', [
      { van: 1, stops: [1], minutes: 9 },
      { van: 2, stops: [2], minutes: 9 },
    ]);
    expect(proposedSaid(two, 2)).toBe('Proposed a plan that uses both vans.');
  });

  test('the map credit takes its version from the route data’s attribution and refuses drift', () => {
    const text =
      'Map and route data: © OpenStreetMap contributors, under the Open Database License 1.0\n' +
      '(https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright.\n' +
      'Travel times were computed offline with openrouteservice v9.10.0, run\non this machine.';
    expect(routeCredit(text)).toEqual({ orsVersion: 'v9.10.0' });
    expect(() => routeCredit('no version here')).toThrow(/openrouteservice/);
  });
});

describe('the catering pages look again on their own', () => {
  test('every ten seconds, twice as long after each failure, up to a minute', () => {
    expect(POLL_MS).toBe(10_000);
    expect(nextPollMs(0)).toBe(10_000);
    expect(nextPollMs(1)).toBe(20_000);
    expect(nextPollMs(2)).toBe(40_000);
    expect(nextPollMs(3)).toBe(POLL_MAX_MS);
    expect(nextPollMs(9)).toBe(60_000);
  });
});

describe('the way out of the console, by who is here', () => {
  test('a guest leaves, since nothing can reach its sandbox again; a signed-in session signs out', () => {
    expect(leaveLabel('guest')).toBe('Leave');
    expect(leaveLabel('demo')).toBe('Sign out');
    expect(leaveLabel('google')).toBe('Sign out');
    expect(leaveLabel('github')).toBe('Sign out');
  });
});
