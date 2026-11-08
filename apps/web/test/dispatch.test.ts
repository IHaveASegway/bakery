import { describe, expect, test } from 'vitest';
import {
  DEPOT,
  VroomError,
  bandLabels,
  bandsLargestFirst,
  buildProblem,
  clockText,
  completable,
  dispatchDays,
  explorationFor,
  figuresOf,
  gapText,
  inViewBox,
  mapRoutes,
  MAP_PAD,
  paddedBox,
  parseIsochrones,
  parseRouteData,
  pathVertices,
  plannable,
  planRequest,
  readSolution,
  report,
  routePoints,
  solveOptions,
  stopMarks,
  stopNumbers,
  stopRows,
  vanClass,
  secondsAfterDeparture,
  type VroomOutput,
} from '../src/lib/dispatch';
import { windowText } from '../src/lib/when';
import {
  DATE,
  day,
  isochrones,
  orderId,
  plan,
  route,
  SLICE_STOPS,
  slice,
  stop,
  windowAt,
} from './dispatch-support';

describe('the route data', () => {
  test('the committed fixture is what the screen expects: 64 places, the bakery first, square matrices', () => {
    expect(route.points).toHaveLength(64);
    expect(route.points[DEPOT]).toMatchObject({ i: 0, kind: 'depot', label: 'The bakery' });
    expect(route.durations).toHaveLength(64 * 64);
    expect(route.distances).toHaveLength(64 * 64);
    expect(route.viewBox).toEqual([0, 0, 2000, 1123]);
    expect(route.serviceSeconds).toBe(180);
    // Free-flow seconds, whole numbers, nothing negative, zero on the diagonal.
    for (let i = 0; i < 64; i++) expect(route.durations[i * 64 + i]).toBe(0);
    expect(route.durations.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
  });

  test('every one of the 64 places lies inside the view box', () => {
    for (const p of route.points) expect(inViewBox(route.viewBox, p.x, p.y), p.label).toBe(true);
  });

  test('a file that is not the shape is refused with a message that names the part', () => {
    expect(() => parseRouteData({})).toThrow('viewBox');
    expect(() => parseRouteData({ ...route, durations: [1, 2, 3] })).toThrow('durations');
    expect(() => parseRouteData({ ...route, points: [...route.points].reverse() })).toThrow(
      'point',
    );
    expect(() => parseIsochrones({ depot: [1, 2], minutes: [5, 10], within: ['M0 0z'] })).toThrow(
      'within',
    );
    expect(parseIsochrones(isochrones)).toEqual(isochrones);
  });
});

describe('the days', () => {
  test('seven bakery days from business today, shifted by the sandbox clock', () => {
    // 2026-11-05 12:00 UTC is 05:00 in Mountain time.
    const now = Date.UTC(2026, 10, 5, 12);
    const days = dispatchDays(0, now);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-11-05');
    expect(days[6]).toBe('2026-11-11');
    expect(dispatchDays(2 * 86_400, now)[0]).toBe('2026-11-07');
  });
});

describe('buildProblem, over the 6-place slice', () => {
  const data = slice(6);
  const problem = buildProblem(data, SLICE_STOPS, 2, 30, DATE);

  test('vehicles have a capacity and start and end at the bakery, from the time the vans leave', () => {
    const back = problem.input.vehicles[0]!.time_window[1];
    expect(problem.input.vehicles).toEqual([
      { id: 1, start_index: 0, end_index: 0, capacity: [30], time_window: [0, back] },
      { id: 2, start_index: 0, end_index: 0, capacity: [30], time_window: [0, back] },
    ]);
  });

  test('jobs carry their units as the delivery amount, the service time and a location', () => {
    expect(problem.input.jobs).toHaveLength(6);
    expect(problem.input.jobs.map((j) => j.delivery)).toEqual([[12], [8], [20], [5], [9], [14]]);
    for (const [k, job] of problem.input.jobs.entries()) {
      expect(job.id).toBe(k + 1);
      expect(job.location_index).toBe(k + 1);
      expect(job.service).toBe(180);
    }
  });

  test('job ids name stops, not places: two stops at one place are two jobs', () => {
    expect(problem.orders).toEqual([1, 2, 3, 4, 5, 6].map(orderId));
    expect(problem.places).toEqual([0, 1, 2, 3, 3, 4, 5]);
    const m = problem.input.matrices.car.durations;
    expect(m[3]?.[4]).toBe(0); // same place, no drive
  });

  test('the matrix is cut to the bakery then the stops, in whole minutes of seconds', () => {
    const m = problem.input.matrices.car.durations;
    expect(m).toHaveLength(7);
    for (const row of m) expect(row).toHaveLength(7);
    for (const [a, from] of problem.places.entries()) {
      for (const [b, to] of problem.places.entries()) {
        const seconds = data.durations[from * 6 + to] ?? 0;
        expect(m[a]?.[b], `${a}->${b}`).toBe(Math.ceil(seconds / 60) * 60);
        expect((m[a]?.[b] ?? 1) % 60).toBe(0);
      }
    }
  });

  test('the seconds metric hands VROOM the raw durations', () => {
    const raw = buildProblem(data, SLICE_STOPS, 2, 30, DATE, 'seconds').input.matrices.car
      .durations;
    expect(raw[0]?.[1]).toBe(data.durations[1]);
  });

  test('stops are sorted by order id, so the same day gives the same problem', () => {
    const shuffled = buildProblem(data, [...SLICE_STOPS].reverse(), 2, 30, DATE);
    expect(shuffled).toEqual(problem);
  });

  test('a stop at a place the data do not have, or no vans, is refused', () => {
    expect(() => buildProblem(data, [stop(9, 6, 1)], 1, 10, DATE)).toThrow('route data');
    expect(() => buildProblem(data, SLICE_STOPS, 0, 10, DATE)).toThrow('van');
  });

  test('how hard to look: 5 up to 40 stops, 3 above, with VROOM’s own five-second limit', () => {
    expect(explorationFor(40)).toBe(5);
    expect(explorationFor(41)).toBe(3);
    expect(solveOptions(63)).toEqual({ explorationLevel: 3, timeoutMs: 5000 });
  });
});

describe('buildProblem, in time: the API’s windows (crates/domain/src/dispatch/windows.rs)', () => {
  const data = slice(6);
  const stops = [
    stop(1, 1, 5, { window: windowAt(9) }),
    stop(2, 2, 5, { window: windowAt(11) }),
    stop(3, 3, 5, { window: windowAt(13) }),
  ];
  const problem = buildProblem(data, stops, 2, 30, DATE);
  const legHome = (place: number) => Math.ceil((data.durations[place * 6] ?? 0) / 60) * 60;

  test('each job may start service from its window’s start to 120 minutes later, on one axis from 09:00', () => {
    expect(problem.input.jobs.map((j) => j.time_windows)).toEqual([
      [[0, 7200]],
      [[7200, 14400]],
      [[14400, 21600]],
    ]);
  });

  test('each job takes 180 seconds at the door, the domain’s 3 minutes', () => {
    for (const job of problem.input.jobs) expect(job.service).toBe(180);
  });

  test('each van leaves at 0, 09:00, and may be back as late as the last close, a door and the drive home', () => {
    // The 13:00 stop closes at 15:00, 21,600 s after 09:00; it is the latest a van can be back.
    const back = Math.max(...[1, 2, 3].map((p, k) => 7200 * (k + 1) + 180 + legHome(p)));
    for (const v of problem.input.vehicles) expect(v.time_window).toEqual([0, back]);
    expect(back).toBeGreaterThan(21_600 + 180);
  });

  test('the windows follow the stops in order-id order, as the jobs do', () => {
    const reversed = buildProblem(data, [...stops].reverse(), 2, 30, DATE);
    expect(reversed.input.jobs).toEqual(problem.input.jobs);
  });

  test('a stop whose window is not a time is refused before VROOM is asked', () => {
    expect(() => buildProblem(data, [stop(1, 1, 5, { window: 'soon' })], 1, 10, DATE)).toThrow(
      'Not a time',
    );
  });
});

describe('secondsAfterDeparture: the RFC 3339 business time, with its offset, against 09:00 on the plan date', () => {
  test('the three window starts in standard time (-07:00)', () => {
    expect(secondsAfterDeparture('2026-11-07T09:00:00-07:00', '2026-11-07')).toBe(0);
    expect(secondsAfterDeparture('2026-11-07T11:00:00-07:00', '2026-11-07')).toBe(7200);
    expect(secondsAfterDeparture('2026-11-07T13:00:00-07:00', '2026-11-07')).toBe(14_400);
  });

  test('the offset is read, not assumed: the same moment in UTC or another offset gives the same seconds', () => {
    expect(secondsAfterDeparture('2026-11-07T18:00:00Z', '2026-11-07')).toBe(7200);
    expect(secondsAfterDeparture('2026-11-07T12:00:00-06:00', '2026-11-07')).toBe(7200);
  });

  test('in daylight time (-06:00) 09:00 is still 0 and 11:00 still 7200', () => {
    expect(secondsAfterDeparture('2026-07-11T09:00:00-06:00', '2026-07-11')).toBe(0);
    expect(secondsAfterDeparture('2026-07-11T11:00:00-06:00', '2026-07-11')).toBe(7200);
    // The same 11:00 written as if it were standard time is an hour later on the bakery's clock.
    expect(secondsAfterDeparture('2026-07-11T11:00:00-07:00', '2026-07-11')).toBe(10_800);
  });

  test('on the days the clocks change, 09:00 is measured on that day’s own offset', () => {
    // 2026-03-08 springs forward at 02:00; 2026-11-01 falls back at 02:00. Both before the vans leave.
    expect(secondsAfterDeparture('2026-03-08T11:00:00-06:00', '2026-03-08')).toBe(7200);
    expect(secondsAfterDeparture('2026-11-01T11:00:00-07:00', '2026-11-01')).toBe(7200);
  });

  test('whole minutes, rounded down, as the API measures a window’s opening', () => {
    expect(secondsAfterDeparture('2026-11-07T11:00:59-07:00', '2026-11-07')).toBe(7200);
    expect(secondsAfterDeparture('2026-11-07T08:59:30-07:00', '2026-11-07')).toBe(-60);
  });

  test('what is not a time or a date is refused', () => {
    expect(() => secondsAfterDeparture('2026-11-07', '2026-11-07')).toThrow('Not a time');
    expect(() => secondsAfterDeparture('2026-11-07T11:00:00-07:00', 'Saturday')).toThrow(
      'Not a date',
    );
  });
});

describe('readSolution', () => {
  const problem = buildProblem(slice(6), SLICE_STOPS, 3, 30, DATE);
  const output: VroomOutput = {
    code: 0,
    routes: [
      {
        vehicle: 2,
        steps: [
          { type: 'start', location_index: 0 },
          { type: 'job', id: 3, location_index: 3 },
          { type: 'job', id: 1, location_index: 1 },
          { type: 'end', location_index: 0 },
        ],
      },
      {
        vehicle: 1,
        steps: [
          { type: 'start', location_index: 0 },
          { type: 'job', id: 2, location_index: 2 },
          { type: 'end', location_index: 0 },
        ],
      },
    ],
    unassigned: [{ id: 6 }],
  };

  test('reads each van’s jobs in step order as order ids, and the places it starts and ends at', () => {
    const read = readSolution(output, problem);
    expect(read.routes.map((r) => r.van)).toEqual([1, 2, 3]);
    expect(read.routes[0]).toEqual({ van: 1, stops: [orderId(2)], start: 0, end: 0 });
    expect(read.routes[1]?.stops).toEqual([orderId(3), orderId(1)]);
    expect(read.unassigned).toEqual([orderId(6)]);
  });

  test('a van VROOM left at home is an empty route', () => {
    expect(readSolution(output, problem).routes[2]).toEqual({
      van: 3,
      stops: [],
      start: null,
      end: null,
    });
  });

  test('VROOM’s error object throws; a job or van it was not asked for throws', () => {
    expect(() => readSolution({ code: 2, error: 'bad input' }, problem)).toThrow(VroomError);
    expect(() => readSolution({ code: 2, error: 'bad input' }, problem)).toThrow('bad input');
    expect(() =>
      readSolution(
        { code: 0, routes: [{ vehicle: 1, steps: [{ type: 'job', id: 99 }] }] },
        problem,
      ),
    ).toThrow('99');
    expect(() => readSolution({ code: 0, routes: [{ vehicle: 4, steps: [] }] }, problem)).toThrow(
      'van',
    );
  });
});

describe('planRequest', () => {
  const problem = buildProblem(slice(6), SLICE_STOPS, 3, 30, DATE);
  const plain = readSolution(
    {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', location_index: 0 },
            { type: 'job', id: 2 },
            { type: 'end', location_index: 0 },
          ],
        },
      ],
    },
    problem,
  );

  test('sends every van with its stops and the places it starts and ends at, and nothing else', () => {
    expect(planRequest(plain)).toEqual({
      vans: [
        { van: 1, stops: [orderId(2)], start: 0, end: 0 },
        { van: 2, stops: [] },
        { van: 3, stops: [] },
      ],
    });
  });

  test('carries no minutes, totals or units: the object works those out itself', () => {
    const text = JSON.stringify(planRequest(plain));
    expect(text).not.toMatch(/minutes|total|units|cost|duration/);
  });
});

describe('the stop numbering', () => {
  const p = plan('server', [
    { van: 2, stops: [4, 5] },
    { van: 1, stops: [2, 1, 3] },
  ]);

  test('counts from 1 across the vans, van 1’s stops first, each van in driving order', () => {
    const numbers = stopNumbers(p);
    expect(numbers.get(orderId(2))).toEqual({ van: 1, number: 1 });
    expect(numbers.get(orderId(1))).toEqual({ van: 1, number: 2 });
    expect(numbers.get(orderId(3))).toEqual({ van: 1, number: 3 });
    expect(numbers.get(orderId(4))).toEqual({ van: 2, number: 4 });
    expect(numbers.get(orderId(5))).toEqual({ van: 2, number: 5 });
    expect(stopNumbers(null).size).toBe(0);
  });

  test('the table puts the published plan’s stops first, in stop order', () => {
    const rows = stopRows(
      day(
        [
          stop(1, 1, 5, { window: '2026-11-07T11:00:00-07:00' }),
          stop(2, 2, 5, { van: 1, stop: 2 }),
          stop(3, 3, 5, { van: 1, stop: 1 }),
          stop(4, 4, 5),
        ],
        { published: p },
      ),
    );
    expect(rows.map((r) => r.order)).toEqual([orderId(3), orderId(2), orderId(4), orderId(1)]);
  });

  test('completion buttons are for published stops not yet delivered', () => {
    const d = day([
      stop(1, 1, 5, { van: 1, stop: 1, status: 'completed' }),
      stop(2, 2, 5, { van: 1, stop: 2 }),
      stop(3, 3, 5),
    ]);
    expect(completable(d).map((r) => r.stop)).toEqual([2]);
  });

  test('only confirmed stops are planned', () => {
    const d = day([
      stop(1, 1, 5, { status: 'provisional' }),
      stop(2, 2, 5),
      stop(3, 3, 5, { status: 'removed' }),
      stop(4, 4, 5, { status: 'completed' }),
    ]);
    expect(plannable(d).map((s) => s.order)).toEqual([orderId(2)]);
  });
});

describe('the map helpers', () => {
  const stops = Array.from({ length: 63 }, (_, k) => stop(k + 1, k + 1, 8));
  const everyone = plan('server', [
    { van: 1, stops: Array.from({ length: 16 }, (_, k) => k + 1) },
    { van: 2, stops: Array.from({ length: 16 }, (_, k) => k + 17) },
    { van: 3, stops: Array.from({ length: 16 }, (_, k) => k + 33) },
    { van: 4, stops: Array.from({ length: 15 }, (_, k) => k + 49) },
  ]);

  test('every stop lands inside the view box, numbered or not', () => {
    for (const shown of [null, everyone]) {
      const marks = stopMarks(route, stops, shown);
      expect(marks).toHaveLength(63);
      // Inside the data's box, and the mark (22 units and its edge) inside the box the map shows.
      for (const m of marks) {
        expect(inViewBox(route.viewBox, m.x, m.y), `place ${m.place}`).toBe(true);
        expect(inViewBox(paddedBox(route.viewBox), m.x, m.y, 31), `place ${m.place}`).toBe(true);
      }
    }
  });

  test('the map keeps room round the data’s box', () => {
    expect(paddedBox([0, 0, 2000, 1123])).toEqual([
      -MAP_PAD,
      -MAP_PAD,
      2000 + 2 * MAP_PAD,
      1123 + 2 * MAP_PAD,
    ]);
  });

  test('a stop is numbered by the plan shown, and unnumbered without one', () => {
    const marks = stopMarks(route, stops, everyone);
    expect(marks.find((m) => m.place === 1)).toMatchObject({ numbers: [1], van: 1 });
    expect(marks.find((m) => m.place === 63)).toMatchObject({ numbers: [63], van: 4 });
    expect(
      stopMarks(route, stops, null).every((m) => m.numbers.length === 0 && m.van === null),
    ).toBe(true);
  });

  test('two stops at one place share one mark, with both numbers', () => {
    const two = [stop(1, 7, 5), stop(2, 7, 5)];
    const p = plan('browser', [{ van: 1, stops: [2, 1] }]);
    expect(stopMarks(route, two, p)).toEqual([
      { place: 7, x: route.points[7]?.x, y: route.points[7]?.y, numbers: [1, 2], van: 1 },
    ]);
  });

  test('a removed stop has no mark', () => {
    expect(stopMarks(route, [stop(1, 7, 5, { status: 'removed' })], null)).toEqual([]);
  });

  test('a route runs from the bakery through its stops in order and back', () => {
    const at = (i: number) => `${route.points[i]?.x},${route.points[i]?.y}`;
    expect(routePoints(route, [5, 2])).toBe([0, 5, 2, 0].map(at).join(' '));
    const p = plan('server', [
      { van: 1, stops: [2, 1] },
      { van: 2, stops: [] },
    ]);
    const routes = mapRoutes(route, [stop(1, 5, 5), stop(2, 2, 5)], p);
    expect(routes).toEqual([{ van: 1, points: [0, 2, 5, 0].map(at).join(' ') }]);
  });

  test('vans are classed a to d, as tokens.css names them', () => {
    expect([1, 2, 3, 4].map(vanClass)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('the isochrones', () => {
  test('bands are drawn largest first, with their minutes', () => {
    const bands = bandsLargestFirst(isochrones);
    expect(bands.map((b) => b.minutes)).toEqual([30, 25, 20, 15, 10, 5]);
    expect(bands.map((b) => b.level)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  test('a path in the data’s encoding reads as vertices: M absolute, then relative l, m after z', () => {
    expect(pathVertices('M10 20l5 0 0 5z')).toEqual([
      { x: 10, y: 20 },
      { x: 15, y: 20 },
      { x: 15, y: 25 },
    ]);
    // After z the pen is back at the ring's start, and a relative m moves from there.
    expect(pathVertices('M10 20l5 0 0 5zm100 100l3 3z')).toEqual([
      { x: 10, y: 20 },
      { x: 15, y: 20 },
      { x: 15, y: 25 },
      { x: 110, y: 120 },
      { x: 113, y: 123 },
    ]);
  });

  test('every band outline lies inside the view box (the build clipped them)', () => {
    for (const d of isochrones.within) {
      const vertices = pathVertices(d);
      expect(vertices.length).toBeGreaterThan(3);
      for (const v of vertices) expect(inViewBox(route.viewBox, v.x, v.y)).toBe(true);
    }
  });

  test('each band has a label, inside the view box and not on top of another', () => {
    const labels = bandLabels(isochrones, route.viewBox);
    expect(labels.map((l) => l.minutes)).toEqual([5, 10, 15, 20, 25, 30]);
    for (const l of labels)
      expect(inViewBox(route.viewBox, l.x, l.y), `${l.minutes} min`).toBe(true);
    for (const [i, a] of labels.entries()) {
      for (const b of labels.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.minutes}/${b.minutes}`).toBeGreaterThan(40);
      }
    }
  });
});

describe('times', () => {
  test('a delivery window is two hours from its start, in the bakery’s time', () => {
    expect(windowText('2026-11-07T09:00:00-07:00')).toBe('9:00 am to 11:00 am');
    expect(windowText('2026-11-07T11:00:00-07:00')).toBe('11:00 am to 1:00 pm');
    expect(windowText('2026-11-07T13:00:00-07:00')).toBe('1:00 pm to 3:00 pm');
    expect(windowText('2026-11-07T20:00:00Z')).toBe('1:00 pm to 3:00 pm');
    expect(clockText('2026-11-07T10:42:00-07:00')).toBe('10:42 am');
    expect(windowText('not a time')).toBe('not a time');
  });
});

describe('the comparison', () => {
  const both = day(SLICE_STOPS, {
    proposed: plan('server', [{ van: 1, stops: [1, 2, 3], minutes: 110 }]),
    submitted: plan('browser', [{ van: 1, stops: [1, 2, 3], minutes: 100 }]),
    comparison: { server_minutes: 110, browser_minutes: 100, gap_percent: 10 },
  });

  test('with both plans: the API’s gap, said both ways round', () => {
    const r = report(both, 'ready');
    expect(r.compared).toBe(true);
    expect(r.summary).toBe(
      'The server’s plan drives 10.0% longer than the browser’s: 110 minutes against 100.',
    );
    expect(r.server).toMatchObject({ source: 'server', minutes: 110, vansUsed: 1, stops: 3 });
    expect(r.browser).toMatchObject({ source: 'browser', minutes: 100 });
    expect(gapText({ server_minutes: 90, browser_minutes: 100, gap_percent: -10 })).toBe(
      'The server’s plan drives 10.0% shorter than the browser’s: 90 minutes against 100.',
    );
    expect(gapText({ server_minutes: 100, browser_minutes: 100, gap_percent: 0 })).toBe(
      'The two plans drive the same total, 100 minutes.',
    );
    expect(gapText({ server_minutes: 20, browser_minutes: 0, gap_percent: null })).toContain(
      'cannot be given',
    );
  });

  test('without a browser plan the server’s figures stand alone, and say how to get the other', () => {
    const only = day(SLICE_STOPS, { proposed: both.proposed ?? null });
    const r = report(only, 'idle');
    expect(r.compared).toBe(false);
    expect(r.browser).toBeNull();
    expect(r.server?.minutes).toBe(110);
    expect(r.summary).toContain('Plan in the browser');
  });

  test('with the solver unavailable it says so, and still shows the server’s figures', () => {
    const r = report(day(SLICE_STOPS, { proposed: both.proposed ?? null }), 'unavailable');
    expect(r.server?.minutes).toBe(110);
    expect(r.browser).toBeNull();
    expect(r.summary).toBe(
      'The browser’s solver is not available here, so only the server’s plan is shown.',
    );
  });

  test('with only the browser’s plan, and with neither', () => {
    expect(report(day([], { submitted: both.submitted ?? null }), 'ready').summary).toContain(
      'Propose',
    );
    expect(report(day([]), 'idle')).toMatchObject({ server: null, browser: null, compared: false });
    expect(report(null, 'unavailable').summary).toContain('not available');
  });

  test('a plan at or below the published version is stale', () => {
    expect(figuresOf(plan('server', [], { plan_v: 2 }), 2)?.stale).toBe(true);
    expect(figuresOf(plan('server', [], { plan_v: 3 }), 2)?.stale).toBe(false);
    expect(figuresOf(null, 0)).toBeNull();
  });
});
