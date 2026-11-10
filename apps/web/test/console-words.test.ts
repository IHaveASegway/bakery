// Words and addresses after the audit of 2026-11-08 (afternoon): the tour's bake line (N8), a
// scheduled campaign said once (N9), one name in the Place cell (N12), the dispatch day in the URL
// (N13) and the catering page's signed-out sentence (P4).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import DispatchStops from '../src/components/DispatchStops';
import { CATERING_SIGNED_OUT } from '../src/lib/catering';
import { scheduledSaid, stateSays } from '../src/lib/crm';
import { dayFromQuery, dropOffNote, queryWithDay } from '../src/lib/dispatch';
import { HOW } from '../src/guide/how';
import { day, route, stop } from './dispatch-support';

describe('N8: the tour and the bake list say the same', () => {
  test('moving the clock does not make a plan', () => {
    expect(HOW.bake).not.toContain('when the clock moves');
    expect(HOW.bake).toContain('an order or a catering deposit for that day is paid');
  });
});

describe('N9: a scheduled campaign says it once', () => {
  test('the foot line does not repeat the card’s sentence', () => {
    const said = scheduledSaid('2026-11-08T14:30:00-07:00');
    expect(said).toBe('Send time set: 2:30 pm on Sunday 2026-11-08.');
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
  test('it speaks of events, not of a menu', () => {
    expect(CATERING_SIGNED_OUT).toBe(
      'You have no sandbox yet, so there are no catering events to show.',
    );
    expect(CATERING_SIGNED_OUT).not.toContain('menu');
  });
});
