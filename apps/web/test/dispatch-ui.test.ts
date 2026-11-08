// The dispatch components drawn once, statically: the map's marks and routes, the comparison with and
// without a browser plan, and that nothing carries a style attribute, which the page policy refuses.
// Effects do not run in a static render, so these look at the first paint; the logic behind it is in
// dispatch.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Dispatch from '../src/components/Dispatch';
import DispatchComparison from '../src/components/DispatchComparison';
import DispatchMap from '../src/components/DispatchMap';
import DispatchPlan from '../src/components/DispatchPlan';
import DispatchStops from '../src/components/DispatchStops';
import { report } from '../src/lib/dispatch';
import { day, isochrones, plan, route, stop } from './dispatch-support';

const stops = [stop(1, 1, 8), stop(2, 2, 8), stop(3, 3, 8), stop(4, 40, 8), stop(5, 40, 6)];
const server = plan('server', [
  { van: 1, stops: [1, 2], minutes: 41 },
  { van: 2, stops: [3, 4, 5], minutes: 63 },
]);
const browser = plan('browser', [{ van: 1, stops: [3, 2, 1, 4, 5], minutes: 90 }], { plan_v: 1 });

const map = (shown: typeof server | null) =>
  renderToStaticMarkup(
    createElement(DispatchMap, { data: route, isochrones, stops, plan: shown, caption: 'A map' }),
  );

describe('DispatchMap', () => {
  test('draws six bands largest first, labelled, 63 faint places and the bakery', () => {
    const html = map(null);
    const bands = [...html.matchAll(/class="map-band map-band-(\d)"/g)].map((m) => Number(m[1]));
    expect(bands).toEqual([6, 5, 4, 3, 2, 1]);
    expect(html.match(/class="map-band-label"/g)).toHaveLength(6);
    expect(html).toContain('>30 min<');
    expect(html).toContain('>5 min<');
    expect(html.match(/class="map-place"/g)).toHaveLength(63);
    expect(html).toContain('The bakery');
    expect(html).toContain('viewBox="-40 -40 2080 1203"');
    expect(html).toContain('role="img"');
    expect(html).toContain('<title id="dispatch-map-title">A map</title>');
  });

  test('without a plan the stops are open marks with no number and no route', () => {
    const html = map(null);
    expect(html.match(/map-mark map-mark-open/g)).toHaveLength(4); // places 1, 2, 3 and 40
    expect(html).not.toContain('<polyline');
    expect(html).not.toContain('map-mark-text');
  });

  test('with a plan: a polyline for each van, a mark in its van’s colour and shape, the stop numbers', () => {
    const html = map(server);
    expect(html.match(/<polyline/g)).toHaveLength(2);
    expect(html).toContain('map-route map-route-a');
    expect(html).toContain('map-route map-route-b');
    // Van 1 (A) marks with squares, van 2 (B) with circles.
    expect(html).toMatch(/<rect class="map-mark map-mark-a"/);
    expect(html).toMatch(/<circle class="map-mark map-mark-b"/);
    expect(html).toContain('>1<');
    expect(html).toContain('>2<');
    // Stops 4 and 5 share a place: one mark, both numbers.
    expect(html).toContain('>4,5<');
  });

  test('says in its tooltips which stop it is, and the public place, never a home', () => {
    const html = map(server);
    expect(html).toContain(`<title>Stop 1, ${route.points[1]?.label}</title>`);
    expect(html).toContain('Stop 4, 5,');
  });

  test('no style attribute and no inline event handler, which the page policy would refuse', () => {
    for (const html of [map(null), map(server)]) {
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/\son[a-z]+=/);
    }
  });
});

describe('the comparison', () => {
  const both = day(stops, {
    proposed: server,
    submitted: browser,
    comparison: { server_minutes: 104, browser_minutes: 90, gap_percent: 15.6 },
  });
  const html = (d: typeof both | null, solver: Parameters<typeof report>[1]) =>
    renderToStaticMarkup(createElement(DispatchComparison, { report: report(d, solver), solver }));

  test('both totals side by side, last back, vans used, and the gap', () => {
    const out = html(both, 'ready');
    expect(out).toContain('Server (savings heuristic)');
    expect(out).toContain('Browser (VROOM)');
    expect(out).toContain('<td>104</td><td>90</td>');
    expect(out).toContain('<td>10:42 am</td><td>10:42 am</td>');
    expect(out).toContain('<td>2</td><td>1</td>');
    expect(out).toContain('The server’s plan drives 15.6% longer than the browser’s');
  });

  test('without a browser plan: the server’s figures alone, and the other column says it is not planned', () => {
    const out = html(day(stops, { proposed: server }), 'idle');
    expect(out).toContain('<td>104</td><td>Not planned yet</td>');
    expect(out).toContain('Only the server’s plan so far');
  });

  test('with the solver unavailable: the server’s figures alone, and the column says unavailable', () => {
    const out = html(day(stops, { proposed: server }), 'unavailable');
    expect(out).toContain('<td>104</td><td>Unavailable here</td>');
    expect(out).toContain('The browser’s solver is not available here');
  });

  test('explains the method and names the Route Lab without a link', () => {
    const out = html(both, 'ready');
    expect(out).toContain('savings heuristic');
    expect(out).toContain('The Dispatch object checks');
    expect(out).toContain('The Route Lab is where the solver is explained');
    expect(out).not.toContain('<a ');
  });
});

describe('the plan and the stops', () => {
  test('a plan shows each van’s stops, units and minutes, the total and when the last van is back', () => {
    const out = renderToStaticMarkup(
      createElement(DispatchPlan, { plan: server, title: 'Server' }),
    );
    expect(out).toContain('2 vans, 104 drive minutes in all, the last van back at 10:42 am');
    expect(out).toContain('<td>41</td>');
    expect(out).toContain('swatch-b');
  });

  test('a plan with stops left out says it cannot be published', () => {
    const out = renderToStaticMarkup(
      createElement(DispatchPlan, {
        plan: plan('server', [{ van: 1, stops: [1] }], { unassigned: ['x'] }),
        title: 'S',
      }),
    );
    expect(out).toContain('1 stop is in no van');
    expect(out).toContain('cannot be published');
  });

  test('the table has order, place, window, zone, units, status, van and stop', () => {
    const d = day([stop(1, 1, 8, { van: 1, stop: 1 }), stop(2, 2, 5, { status: 'provisional' })]);
    const out = renderToStaticMarkup(createElement(DispatchStops, { day: d, data: route }));
    for (const head of ['Order', 'Place', 'Window', 'Zone', 'Units', 'Status', 'Van', 'Stop']) {
      expect(out).toContain(`<th scope="col" class="whitespace-nowrap">${head}</th>`);
    }
    // On a phone the head is hidden and the rows stack, so each value carries its own label.
    for (const label of ['Order', 'Place', 'Window', 'Units', 'Status', 'Van', 'Stop']) {
      expect(out).toContain(`<span class="font-semibold sm:hidden">${label}: </span>`);
    }
    // The table breaks only between words ("Delivered", not "Delivere d").
    expect(out).toContain('<table class="[overflow-wrap:normal]">');
    expect(out).toContain('9:00 am to 11:00 am');
    expect(out).toContain('Zone 1');
    expect(out).toContain('Provisional (not paid yet)');
    expect(out).toContain('Drop-off spot: ');
    expect(out).not.toMatch(/\sstyle=/);
  });
});

describe('the island', () => {
  test('before the sandbox is known it asks nothing of the map and says what it is waiting for', () => {
    const out = renderToStaticMarkup(createElement(Dispatch));
    expect(out).toContain('Looking for your sandbox');
  });
});
