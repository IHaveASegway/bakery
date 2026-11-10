// Words and addresses after the audit of 2026-11-08 (afternoon): the tour's bake line (N8), a
// scheduled campaign said once (N9), one name in the Place cell (N12), the dispatch day in the URL
// (N13) and the catering page's signed-out sentence (P4).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import DispatchStops from '../src/components/DispatchStops';
import { CATERING_START } from '../src/lib/catering';
import { scheduledSaid, stateSays } from '../src/lib/crm';
import { dayFromQuery, dropOffNote, queryWithDay } from '../src/lib/dispatch';
import { ALL_ENTRIES } from '../src/guide';
import { day, route, stop } from './dispatch-support';

describe('N8: the guide and the bake list say the same', () => {
  test('moving the clock does not make a plan', () => {
    const bake = ALL_ENTRIES.find((e) => e.id === 'kitchen-bake');
    const said = [bake?.what ?? '', ...(bake?.facts ?? [])].join(' ');
    expect(said).not.toContain('when the clock moves');
    expect(said).toContain('an order or a catering deposit for that day is paid');
    expect(said).toContain('Moving the clock makes none');
  });
});

describe('N9: a scheduled campaign says it once', () => {
  test('the foot line does not repeat the card’s sentence', () => {
    const said = scheduledSaid('2026-11-08T14:30:00-07:00', Date.parse('2026-11-08T12:00:00Z'));
    expect(said).toBe('Send time set: Sun 8 Nov, 2:30 pm.');
    expect(`${stateSays('scheduled')} ${said}`.match(/clock/g)).toHaveLength(1);
    expect(said).not.toContain('Scheduled');
  });
});

describe('N12: the Place cell names the place once', () => {
  test('the drop-off spot shows only when it differs from the label', () => {
    expect(dropOffNote('Sunnyside Park', 'Sunnyside Park')).toBeNull();
    expect(dropOffNote('Sunnyside Park', ' sunnyside park ')).toBeNull();
    expect(dropOffNote('p2', 'Sunnyside Park')).toBe('Drop-off spot: Sunnyside Park');
    expect(dropOffNote('p2', null)).toBeNull();
  });

  test('the table prints a name that equals the label once', () => {
    const name = route.points[1]?.label ?? '';
    expect(name).not.toBe('');
    const d = day([stop(1, 1, 8, { place_label: name })]);
    const out = renderToStaticMarkup(createElement(DispatchStops, { day: d, data: route }));
    expect(out.split(name)).toHaveLength(2);
    expect(out).not.toContain('Drop-off spot');
  });
});

describe('N13: the dispatch day lives in the URL', () => {
  test('parses a day and nothing else', () => {
    expect(dayFromQuery('?day=2026-11-10')).toBe('2026-11-10');
    expect(dayFromQuery('?x=1&day=2026-11-10')).toBe('2026-11-10');
    expect(dayFromQuery('')).toBeNull();
    expect(dayFromQuery('?day=tomorrow')).toBeNull();
    expect(dayFromQuery('?day=2026-13-40x')).toBeNull();
  });

  test('writes it, keeps other parameters, and leaves today out', () => {
    expect(queryWithDay('', '2026-11-10', '2026-11-08')).toBe('?day=2026-11-10');
    expect(queryWithDay('?x=1&day=2026-11-09', '2026-11-10', '2026-11-08')).toBe(
      '?x=1&day=2026-11-10',
    );
    expect(queryWithDay('?day=2026-11-10', '2026-11-08', '2026-11-08')).toBe('');
    expect(queryWithDay('?x=1&day=2026-11-10', '2026-11-08', '2026-11-08')).toBe('?x=1');
  });
});

describe('P4: the catering page says what is true signed out', () => {
  // Since 2026-11-10 the page shows the gate there, with its own title and button.
  test('its gate speaks of catering and an inquiry, not of a menu or an order', () => {
    expect(CATERING_START).toEqual({
      title: 'Catering starts with your own sandbox.',
      action: 'Start an inquiry',
    });
    for (const words of Object.values(CATERING_START)) {
      expect(words).not.toMatch(/menu|order/i);
    }
  });
});
