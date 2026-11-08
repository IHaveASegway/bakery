// The dispatch screen's pure pieces: the route data's shape, the VROOM problem and how its answer
// is read, the browser's plan as the API's request, the map's projection helpers, the comparison's
// words, the stop numbering and the day list. No DOM, no fetch, no worker: the screen, the Node
// test of the real solver and the unit tests all run these same functions.
//
// The Dispatch object decides (ADR 0012). Nothing here validates a plan, recomputes its minutes or
// says whether it may be published; the browser proposes, and every figure the screen shows as a
// plan's total is the API's.
import type {
  ComparisonView,
  DispatchResponse,
  PlanRequest,
  PlanSource,
  PlanView,
  StopStatus,
  StopView,
} from '../contracts';
import { HORIZON_DAYS, horizonDates } from './schedule';
import { clockLabel, mountainLocal, mountainToMs } from './slots';

// ---- The static route data -------------------------------------------------------------------

/** Where the build's route data are served from: static assets of the storefront, never the API. */
export const ROUTE_DATA_URL = '/app/dispatch/data/route-data.json';
export const ISOCHRONES_URL = '/app/dispatch/data/isochrones.json';

/** The bakery is place 0 of the route data and of the matrix. */
export const DEPOT = 0;

/** A place on the map. Point 0 is the bakery; every other point is a public drop-off spot. */
export interface RoutePoint {
  /** The index into the matrices. */
  readonly i: number;
  readonly label: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/** route-data.json (tools/route-data/out/README.md): the places and the travel matrices. */
export interface RouteData {
  readonly license: string;
  readonly licenseUrl?: string;
  readonly attribution: string;
  readonly copyright: string;
  readonly viewBox: readonly [number, number, number, number];
  /** Seconds at each stop to hand the order over. */
  readonly serviceSeconds: number;
  readonly points: readonly RoutePoint[];
  /** Seconds from i to j at [i * n + j]: free-flow, no traffic. */
  readonly durations: readonly number[];
  readonly distances: readonly number[];
}

/** isochrones.json: the areas the bakery reaches within each number of minutes, nested. */
export interface Isochrones {
  readonly depot: readonly [number, number];
  readonly minutes: readonly number[];
  readonly within: readonly string[];
}

const isNumbers = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) &&
  (length === undefined || value.length === length) &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Reads route-data.json, refusing a file that is not the shape the map and the solver rely on. */
export function parseRouteData(value: unknown): RouteData {
  const v = (value ?? {}) as Partial<Record<keyof RouteData, unknown>>;
  if (!isNumbers(v.viewBox, 4)) throw new Error('route-data.json: no viewBox');
  if (!Array.isArray(v.points) || v.points.length < 2)
    throw new Error('route-data.json: no points');
  const n = v.points.length;
  v.points.forEach((p: Partial<RoutePoint>, k) => {
    if (p.i !== k || typeof p.label !== 'string' || !isNumbers([p.x, p.y])) {
      throw new Error(`route-data.json: point ${k} is malformed`);
    }
  });
  if ((v.points[0] as RoutePoint).kind !== 'depot') {
    throw new Error('route-data.json: point 0 is not the bakery');
  }
  if (!isNumbers(v.durations, n * n)) throw new Error('route-data.json: durations are not n by n');
  if (!isNumbers(v.distances, n * n)) throw new Error('route-data.json: distances are not n by n');
  if (typeof v.serviceSeconds !== 'number') throw new Error('route-data.json: no serviceSeconds');
  if (typeof v.attribution !== 'string' || typeof v.copyright !== 'string') {
    throw new Error('route-data.json: no attribution');
  }
  return v as unknown as RouteData;
}

/** Reads isochrones.json. */
export function parseIsochrones(value: unknown): Isochrones {
  const v = (value ?? {}) as Partial<Record<keyof Isochrones, unknown>>;
  if (!isNumbers(v.depot, 2)) throw new Error('isochrones.json: no depot');
  if (!isNumbers(v.minutes)) throw new Error('isochrones.json: no minutes');
  if (
    !Array.isArray(v.within) ||
    v.within.length !== v.minutes.length ||
    !v.within.every((d) => typeof d === 'string')
  ) {
    throw new Error('isochrones.json: within does not match minutes');
  }
  return v as unknown as Isochrones;
}

/** The licence and copyright pages the route data's attribution names. */
export const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/**
 * What the dispatch page's credit line needs from ATTRIBUTION.txt, which tools/route-data/ writes
 * beside the data: the openrouteservice version the times were computed with. The page says the
 * rest in its own words, with the two URLs as links rather than printed inline, so a phone does
 * not get the file's hard line breaks. A file that no longer names the version or the two pages
 * throws, so the build stops rather than publish a credit that has drifted from the data.
 */
export function routeCredit(attribution: string): { orsVersion: string } {
  const version = /openrouteservice (v\d+(?:\.\d+)*)/.exec(attribution)?.[1];
  if (version === undefined) throw new Error('ATTRIBUTION.txt: no openrouteservice version');
  for (const url of [ODBL_URL, OSM_COPYRIGHT_URL]) {
    if (!attribution.includes(url)) throw new Error(`ATTRIBUTION.txt: ${url} is not named`);
  }
  return { orsVersion: version };
}

// ---- Days, stops and numbers ----------------------------------------------------------------

/** The bakery days the screen offers, today first: the sandbox's own days (404 `no-such-day` beyond). */
export function dispatchDays(clockOffsetS: number, nowMs: number = Date.now()): string[] {
  return horizonDates(nowMs + clockOffsetS * 1000, HORIZON_DAYS);
}

/** The last six characters of an order's ULID: enough to tell stops apart. */
export const shortId = (id: string): string => id.slice(-6);

/** The stops a plan must cover: confirmed ones and ones out for delivery, in order-id order. */
export function plannable(day: DispatchResponse): StopView[] {
  return day.stops
    .filter((s) => s.status === 'confirmed' || s.status === 'out_for_delivery')
    .sort((a, b) => cmp(a.order, b.order));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A stop's place in a plan: its van and its number counted from 1 across the vans. */
export interface StopNumber {
  readonly van: number;
  readonly number: number;
}

/**
 * The stop numbering (docs/domain.md): a stop's number is its 1-based position in the plan, van 1's
 * stops first, then van 2's, each van in driving order. It is the number `CompleteStopRequest` and
 * the published `StopView.stop` use, so a proposal shows the numbers it would be published with.
 */
export function stopNumbers(plan: PlanView | null | undefined): Map<string, StopNumber> {
  const numbers = new Map<string, StopNumber>();
  let next = 1;
  for (const van of [...(plan?.vans ?? [])].sort((a, b) => a.van - b.van)) {
    for (const order of van.stops) numbers.set(order, { van: van.van, number: next++ });
  }
  return numbers;
}

// ---- A van's day ------------------------------------------------------------------------------

// The numbers the API checks a plan's times with, copied from the domain: DEPARTURE_MINUTES and
// SERVICE_MINUTES in crates/domain/src/dispatch.rs, WINDOW_MINUTES in crates/domain/src/calendar.rs,
// and the arithmetic in crates/domain/src/dispatch/windows.rs. The vans leave at 09:00 on the plan's
// day; a van that reaches a door before its window opens waits; it may start serving up to the
// window's close and spends 3 minutes at the door. A plan that starts serving a stop later than the
// close is refused (`window`).

/** When the vans leave, local minutes after midnight: 09:00, the first window's start. */
export const DEPARTURE_MINUTES = 9 * 60;
/** Seconds at each door, the domain's 3 minutes. */
export const SERVICE_SECONDS = 180;
/** How long a delivery window is open from its start. */
export const WINDOW_MINUTES = 120;

/**
 * A business time as seconds after the vans leave on `date`, the one time axis of the VROOM
 * problem. The time is read with its own offset (RFC 3339, `2026-11-07T11:00:00-07:00`) and the
 * departure is 09:00 on the bakery's clock on `date`, so the answer is the same whatever offset the
 * wire used. Whole minutes, rounded down, as windows.rs measures a window's opening. No clock is read.
 */
export function secondsAfterDeparture(time: string, date: string): number {
  const ms = Date.parse(time);
  if (!/T\d{2}:\d{2}/.test(time) || Number.isNaN(ms)) throw new Error(`Not a time: ${time}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a date: ${date}`);
  return Math.floor((ms - mountainToMs(date, DEPARTURE_MINUTES)) / 60_000) * 60;
}

// ---- The VROOM problem and its answer -------------------------------------------------------

/** VROOM's input format (VROOM docs/API.md), as much of it as the screen uses. */
export interface VroomInput {
  readonly vehicles: readonly {
    id: number;
    start_index: number;
    end_index: number;
    capacity: [number];
    /** Seconds after the vans leave: from 0, when they leave, to the latest a van can be back. */
    time_window: [number, number];
  }[];
  readonly jobs: readonly {
    id: number;
    location_index: number;
    delivery: [number];
    service: number;
    /** When service may start: the window's start and its close, in seconds after the vans leave. */
    time_windows: [number, number][];
  }[];
  readonly matrices: { readonly car: { durations: number[][] } };
}

/** The parts of VROOM's output the screen reads. */
export interface VroomOutput {
  readonly code: number;
  readonly error?: string;
  readonly routes?: readonly {
    readonly vehicle: number;
    readonly steps: readonly {
      readonly type: string;
      readonly id?: number;
      readonly location_index?: number;
    }[];
  }[];
  readonly unassigned?: readonly { readonly id: number }[];
}

/** A problem for VROOM and what is needed to read its answer back. */
export interface VroomProblem {
  readonly input: VroomInput;
  /** Order ULIDs: job `k` is `orders[k - 1]`. */
  readonly orders: readonly string[];
  /** The matrix place of each location index: 0 is the bakery, `k` the place of job `k`. */
  readonly places: readonly number[];
  readonly vans: number;
}

/** How the matrix's seconds reach VROOM. */
export type Metric = 'minutes' | 'seconds';

/**
 * VROOM's input for these stops and vans on `date`, built the way the site's Route Lab builds it:
 * vehicles with a capacity that start and end at the bakery, jobs with a delivery amount, and the
 * travel matrix cut to the bakery and the stops, in that order, so location `k` is the `k`-th of
 * them. A job's id is its 1-based position among the stops sorted by order id, not its place: two
 * stops can share a drop-off spot.
 *
 * Time is the API's (windows.rs): one axis in seconds after the vans leave at 09:00 on `date`. Each
 * job may start service from its window's start to 120 minutes later and takes 180 seconds; each
 * vehicle's window runs from 0 to the latest a van that keeps to the windows can be back, the last
 * close plus a door and the drive home. VROOM lets a van wait for a window to open, as the API does.
 *
 * `metric: 'minutes'` (the default) rounds every leg up to whole minutes, which is the matrix the
 * Dispatch object plans and measures with (matrix.json: minutes rounded up from the seconds), so
 * VROOM minimises the figure the API will compare and its times are the ones the API checks the
 * windows with. `'seconds'` hands VROOM the raw durations, which are shorter, so a plan made with
 * them may reach a door later than VROOM thought.
 */
export function buildProblem(
  data: RouteData,
  stops: readonly Pick<StopView, 'order' | 'place' | 'units' | 'window'>[],
  vans: number,
  capacity: number,
  date: string,
  metric: Metric = 'minutes',
): VroomProblem {
  if (!Number.isInteger(vans) || vans < 1) throw new Error('A plan needs at least one van');
  const n = data.points.length;
  const sorted = [...stops].sort((a, b) => cmp(a.order, b.order));
  for (const stop of sorted) {
    if (!Number.isInteger(stop.place) || stop.place < 0 || stop.place >= n) {
      throw new Error(`Stop ${shortId(stop.order)} is at a place the route data do not have`);
    }
  }
  const places = [DEPOT, ...sorted.map((s) => s.place)];
  const leg = (from: number, to: number): number => {
    const seconds = data.durations[from * n + to] ?? 0;
    return metric === 'minutes' ? Math.ceil(seconds / 60) * 60 : seconds;
  };
  const windows = sorted.map((stop): [number, number] => {
    const open = secondsAfterDeparture(stop.window, date);
    return [open, open + WINDOW_MINUTES * 60];
  });
  const back = Math.max(
    0,
    ...windows.map(([, close], k) => close + SERVICE_SECONDS + leg(places[k + 1]!, DEPOT)),
  );
  return {
    input: {
      vehicles: Array.from({ length: vans }, (_, v) => ({
        id: v + 1,
        start_index: 0,
        end_index: 0,
        capacity: [capacity] as [number],
        time_window: [0, back] as [number, number],
      })),
      jobs: sorted.map((stop, k) => ({
        id: k + 1,
        location_index: k + 1,
        delivery: [stop.units] as [number],
        service: SERVICE_SECONDS,
        time_windows: [windows[k]!],
      })),
      matrices: { car: { durations: places.map((a) => places.map((b) => leg(a, b))) } },
    },
    orders: sorted.map((s) => s.order),
    places,
    vans,
  };
}

/** How hard VROOM looks: its -x level. 5, its default, up to 40 stops; 3 above (the site's ADR 0016). */
export const explorationFor = (jobs: number): number => (jobs > 40 ? 3 : 5);

/** VROOM's own time limit for a solve; the worker call carries it. */
export const SOLVE_LIMIT_MS = 5_000;

/** The options a solve is asked with. */
export const solveOptions = (jobs: number) => ({
  explorationLevel: explorationFor(jobs),
  timeoutMs: SOLVE_LIMIT_MS,
});

/** VROOM answered with an error object, or an answer the screen cannot read. */
export class VroomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VroomError';
  }
}

/** One van of the browser's plan, as VROOM reported it. */
export interface BrowserRoute {
  readonly van: number;
  /** Order ULIDs, in driving order. */
  readonly stops: readonly string[];
  /** The places VROOM reports the route starting and ending at, when it reports them. */
  readonly start: number | null;
  readonly end: number | null;
}

/** The browser's plan: one route for each of the day's vans, and the stops VROOM could not place. */
export interface BrowserPlan {
  readonly routes: readonly BrowserRoute[];
  readonly unassigned: readonly string[];
}

/** VROOM's answer as a plan: every van from 1 to the day's vans, a van left at the bakery with no stops. */
export function readSolution(output: VroomOutput, problem: VroomProblem): BrowserPlan {
  if (output.code !== 0) throw new VroomError(`VROOM: ${output.error ?? `code ${output.code}`}`);
  const order = (id: number | undefined): string => {
    const found = id === undefined ? undefined : problem.orders[id - 1];
    if (found === undefined) throw new VroomError(`VROOM named a job (${id}) that was not asked`);
    return found;
  };
  const place = (step: { location_index?: number } | undefined): number | null =>
    step?.location_index === undefined ? null : (problem.places[step.location_index] ?? null);
  const byVan = new Map<number, BrowserRoute>();
  for (const route of output.routes ?? []) {
    if (route.vehicle < 1 || route.vehicle > problem.vans) {
      throw new VroomError(`VROOM named a van (${route.vehicle}) that was not asked`);
    }
    byVan.set(route.vehicle, {
      van: route.vehicle,
      stops: route.steps.filter((s) => s.type === 'job').map((s) => order(s.id)),
      start: place(route.steps.find((s) => s.type === 'start')),
      end: place(route.steps.find((s) => s.type === 'end')),
    });
  }
  return {
    routes: Array.from(
      { length: problem.vans },
      (_, v) => byVan.get(v + 1) ?? { van: v + 1, stops: [], start: null, end: null },
    ),
    unassigned: (output.unassigned ?? []).map((u) => order(u.id)),
  };
}

/**
 * The browser's plan as the API's request. It carries no minutes and no totals: the object computes
 * them from its own matrix (ADR 0012, decision 4), and a request that sent any would be refused.
 */
export function planRequest(plan: BrowserPlan): PlanRequest {
  return {
    vans: plan.routes.map((r) => ({
      van: r.van,
      stops: [...r.stops],
      ...(r.start === null ? {} : { start: r.start }),
      ...(r.end === null ? {} : { end: r.end }),
    })),
  };
}

// ---- The map ---------------------------------------------------------------------------------

export type ViewBox = readonly [number, number, number, number];

/** Room the map keeps around the data's box, so a mark on a place at its edge is drawn whole. */
export const MAP_PAD = 40;

/** The box the map shows: the data's view box with `MAP_PAD` units of room on every side. */
export const paddedBox = (box: ViewBox, pad = MAP_PAD): ViewBox => [
  box[0] - pad,
  box[1] - pad,
  box[2] + 2 * pad,
  box[3] + 2 * pad,
];

/** The `viewBox` attribute. */
export const viewBoxText = (box: ViewBox): string => box.join(' ');

/** Whether a point is inside the view box, `margin` units in from its edge. */
export function inViewBox(box: ViewBox, x: number, y: number, margin = 0): boolean {
  return (
    x >= box[0] + margin &&
    x <= box[0] + box[2] - margin &&
    y >= box[1] + margin &&
    y <= box[1] + box[3] - margin
  );
}

/** The map's coordinates of a place, or null for an index the route data do not have. */
export function pointOf(data: RouteData, place: number): { x: number; y: number } | null {
  const point = data.points[place];
  return point === undefined ? null : { x: point.x, y: point.y };
}

/** The drop-off spot's public name. It is a park or a station, never somebody's home. */
export const placeName = (data: RouteData | null, place: number): string | null =>
  data?.points[place]?.label ?? null;

/** One mark on the map: a drop-off spot with the stops of the plan at it. */
export interface Mark {
  readonly place: number;
  readonly x: number;
  readonly y: number;
  /** The stop numbers at this place in the plan shown, ascending; empty when it shows none. */
  readonly numbers: readonly number[];
  /** The van of the first of them, or null. */
  readonly van: number | null;
}

/**
 * The marks of the day's stops, one for each place that has any, numbered by the plan shown
 * (`stopNumbers`). Without a plan the stops are marked and unnumbered. A removed stop has no mark.
 */
export function stopMarks(
  data: RouteData,
  stops: readonly StopView[],
  plan: PlanView | null | undefined,
): Mark[] {
  const numbers = stopNumbers(plan);
  const byPlace = new Map<number, { numbers: number[]; van: number | null }>();
  for (const stop of stops) {
    if (stop.status === 'removed') continue;
    const entry = byPlace.get(stop.place) ?? { numbers: [], van: null };
    const mine = numbers.get(stop.order);
    if (mine !== undefined) {
      entry.numbers.push(mine.number);
      entry.van ??= mine.van;
    }
    byPlace.set(stop.place, entry);
  }
  const marks: Mark[] = [];
  for (const [place, entry] of [...byPlace].sort((a, b) => a[0] - b[0])) {
    const at = pointOf(data, place);
    if (at === null) continue;
    marks.push({ place, ...at, numbers: entry.numbers.sort((a, b) => a - b), van: entry.van });
  }
  return marks;
}

/** A van's route as an SVG `points` list: the bakery, each stop in order, the bakery again. */
export function routePoints(data: RouteData, places: readonly number[]): string {
  return [DEPOT, ...places, DEPOT]
    .map((place) => pointOf(data, place))
    .filter((at) => at !== null)
    .map((at) => `${at.x},${at.y}`)
    .join(' ');
}

/** A route to draw: straight lines, since the route data carry no legs. */
export interface MapRoute {
  readonly van: number;
  readonly points: string;
}

/** The routes of a plan, one for each van with a stop, through the places of the stops it names. */
export function mapRoutes(
  data: RouteData,
  stops: readonly StopView[],
  plan: PlanView | null | undefined,
): MapRoute[] {
  const placeOf = new Map(stops.map((s) => [s.order, s.place]));
  return [...(plan?.vans ?? [])]
    .sort((a, b) => a.van - b.van)
    .map((van) => ({
      van: van.van,
      places: van.stops.flatMap((order) => placeOf.get(order) ?? []),
    }))
    .filter((van) => van.places.length > 0)
    .map((van) => ({ van: van.van, points: routePoints(data, van.places) }));
}

/** A van's class suffix: a to d, read by tokens.css's --map-van-a to --map-van-d. Van 5 would reuse d. */
export const vanClass = (van: number): string => 'abcd'[Math.min(Math.max(van, 1), 4) - 1] ?? 'd';

/** One isochrone band. `level` is 1 for the nearest, matching tokens.css's --map-band-1 to -6. */
export interface Band {
  readonly minutes: number;
  readonly level: number;
  readonly d: string;
}

/** The bands in drawing order: largest first, so each smaller one lies on top of the next. */
export function bandsLargestFirst(iso: Isochrones): Band[] {
  return iso.within.map((d, k) => ({ minutes: iso.minutes[k] ?? 0, level: k + 1, d })).reverse();
}

/**
 * The vertices of a path in isochrones.json's encoding: absolute `M` for the first subpath, relative
 * `m` after it, relative `l`, integers, `z` closing each ring. After `z` the pen is back at the start
 * of its subpath, so a relative `m` moves from there.
 */
export function pathVertices(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = '';
  let pending: number[] = [];
  let first = true;
  for (const token of d.match(/[MmLlz]|-?\d+(?:\.\d+)?/g) ?? []) {
    if (/^[MmLlz]$/.test(token)) {
      command = token;
      pending = [];
      if (token === 'z') {
        x = startX;
        y = startY;
      }
      continue;
    }
    pending.push(Number(token));
    if (pending.length < 2) continue;
    const [dx = 0, dy = 0] = pending;
    pending = [];
    // Capitals are absolute; the first `m` of a path is too. Pairs that follow a move are lines.
    if (command === 'M' || command === 'L' || (command === 'm' && first)) {
      x = dx;
      y = dy;
    } else {
      x += dx;
      y += dy;
    }
    if (command === 'M' || command === 'm') {
      startX = x;
      startY = y;
      first = false;
      command = command === 'M' ? 'L' : 'l';
    }
    out.push({ x, y });
  }
  return out;
}

/** Where a band's minutes are written on the map. */
export interface BandLabel {
  readonly minutes: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A label for each band, on the band's own edge: the vertex of its outline nearest a ray from the
 * bakery. The rays turn from one band to the next, so the labels do not stack. Always inside the view
 * box, moved in from the edge when the outline touches it.
 */
export function bandLabels(iso: Isochrones, box: ViewBox, margin = 40): BandLabel[] {
  const [cx, cy] = iso.depot;
  return iso.within.map((d, k) => {
    const target = ((-80 + 62 * k) * Math.PI) / 180;
    let best: { x: number; y: number } = { x: cx, y: cy };
    let bestScore = Infinity;
    for (const v of pathVertices(d)) {
      const distance = Math.hypot(v.x - cx, v.y - cy);
      if (distance < 1) continue;
      let turn = Math.abs(Math.atan2(v.y - cy, v.x - cx) - target);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      // Close to the ray first; among equals, the one farthest out.
      const score = turn * 1000 - distance / 10;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return {
      minutes: iso.minutes[k] ?? 0,
      x: Math.min(Math.max(best.x, box[0] + margin), box[0] + box[2] - margin),
      y: Math.min(Math.max(best.y, box[1] + margin), box[1] + box[3] - margin),
    };
  });
}

// ---- Words -----------------------------------------------------------------------------------

/** "10:42 am", for a business time. */
export function clockText(time: string): string {
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return time;
  const l = mountainLocal(ms);
  return clockLabel(l.hour * 60 + l.minute);
}

const STATUS_WORDS: Record<StopStatus, string> = {
  provisional: 'Provisional (not paid yet)',
  confirmed: 'Confirmed',
  out_for_delivery: 'Out for delivery',
  removed: 'Removed',
  completed: 'Delivered',
};

export const statusText = (status: StopStatus): string => STATUS_WORDS[status];

/** "Zone 2", for `z2`. */
export const zoneText = (zone: string): string => `Zone ${zone.replace(/^z/, '')}`;

/** One row of the stops table. */
export interface StopRow {
  readonly order: string;
  readonly short: string;
  readonly place: number;
  readonly label: string;
  readonly window: string;
  readonly zone: string;
  readonly units: number;
  readonly status: StopStatus;
  readonly van: number | null;
  readonly stop: number | null;
}

/** The table's rows: the published plan's stops in stop order, then the rest by window and order. */
export function stopRows(day: DispatchResponse): StopRow[] {
  return day.stops
    .map((s): StopRow => ({
      order: s.order,
      short: shortId(s.order),
      place: s.place,
      label: s.place_label,
      window: s.window,
      zone: s.zone,
      units: s.units,
      status: s.status,
      van: s.van ?? null,
      stop: s.stop ?? null,
    }))
    .sort(
      (a, b) =>
        (a.stop ?? Infinity) - (b.stop ?? Infinity) ||
        cmp(a.window, b.window) ||
        cmp(a.order, b.order),
    );
}

/** The published plan's stops that are not yet delivered, in stop order: the completion buttons. */
export function completable(day: DispatchResponse): StopRow[] {
  return stopRows(day).filter((r) => r.stop !== null && r.status !== 'completed');
}

/** "Proposed a plan that uses 1 of the 2 vans.": the vans the plan uses, not the number asked for. */
export function proposedSaid(plan: PlanView | null | undefined, vans: number): string {
  const used = plan?.vans.filter((v) => v.stops.length > 0).length ?? 0;
  const of = `${vans} ${vans === 1 ? 'van' : 'vans'}`;
  if (used === vans) {
    const all = vans === 1 ? 'the van' : vans === 2 ? 'both vans' : `all ${of}`;
    return `Proposed a plan that uses ${all}.`;
  }
  return `Proposed a plan that uses ${used} of the ${of}.`;
}

// ---- The comparison --------------------------------------------------------------------------

/** What the screen says about one plan, all of it from the API's `PlanView`. */
export interface Figures {
  readonly source: PlanSource;
  readonly minutes: number;
  /** A business time, "10:42 am" once formatted. */
  readonly lastBack: string;
  readonly vansUsed: number;
  readonly stops: number;
  readonly unassigned: number;
  /** Not above the published plan's version: a plan made before the last publish. */
  readonly stale: boolean;
}

export function figuresOf(plan: PlanView | null | undefined, publishedV: number): Figures | null {
  if (plan === null || plan === undefined) return null;
  return {
    source: plan.source,
    minutes: plan.minutes,
    lastBack: plan.last_back,
    vansUsed: plan.vans.length,
    stops: plan.vans.reduce((sum, v) => sum + v.stops.length, 0),
    unassigned: plan.unassigned.length,
    stale: plan.plan_v <= publishedV,
  };
}

/** The gap as a sentence, from the API's own `gap_percent`; the screen computes none. */
export function gapText(comparison: ComparisonView): string {
  const { server_minutes: server, browser_minutes: browser, gap_percent: gap } = comparison;
  const against = `${server} minutes against ${browser}`;
  if (gap === null || gap === undefined) {
    return `The gap cannot be given as a percentage: the browser’s plan drives ${browser} minutes (${against}).`;
  }
  if (gap === 0) return `The two plans drive the same total, ${server} minutes.`;
  const size = `${Math.abs(gap).toFixed(1)}%`;
  return gap > 0
    ? `The server’s plan drives ${size} longer than the browser’s: ${against}.`
    : `The server’s plan drives ${size} shorter than the browser’s: ${against}.`;
}

/** What the browser's side of the screen can be. */
export type BrowserSolver = 'idle' | 'working' | 'ready' | 'unavailable';

/** The comparison as the screen shows it. Either side is null when that plan does not exist. */
export interface Report {
  readonly server: Figures | null;
  readonly browser: Figures | null;
  /** The sentence about the gap, or why there is none. */
  readonly summary: string;
  /** Both plans were made and the API compared them. */
  readonly compared: boolean;
}

/** Every stop a plan was made over, placed or left out, as a sorted list of order ids. */
export function planStops(plan: PlanView): string[] {
  return [...plan.vans.flatMap((v) => v.stops), ...plan.unassigned].sort(cmp);
}

/** Whether two plans were made over the same stops, so their totals can be set side by side. */
export function sameStops(a: PlanView, b: PlanView): boolean {
  const x = planStops(a);
  const y = planStops(b);
  return x.length === y.length && x.every((order, i) => order === y[i]);
}

/**
 * The comparison as the screen says it. The API compares the last proposal with the last browser
 * plan whatever stops each was made over; after a stop is delivered or a new one is paid, one of
 * them may cover stops the other does not, and their totals then say nothing about the methods.
 * So the screen sets the gap out only when both plans cover the same stops, and otherwise says why.
 */
export function report(day: DispatchResponse | null, solver: BrowserSolver): Report {
  const published = day?.plan_v ?? 0;
  const server = figuresOf(day?.proposed, published);
  const browser = figuresOf(day?.submitted, published);
  if (
    day?.proposed &&
    day.submitted &&
    server &&
    browser &&
    !sameStops(day.proposed, day.submitted)
  ) {
    const a = planStops(day.proposed).length;
    const b = planStops(day.submitted).length;
    return {
      server,
      browser,
      compared: false,
      summary: `The two plans were made over different stops (the server’s over ${a}, the browser’s over ${b}), so their drive times are not compared. Propose and plan in the browser again to compare them over the same stops.`,
    };
  }
  if (day?.comparison && server && browser) {
    return { server, browser, summary: gapText(day.comparison), compared: true };
  }
  if (server && !browser) {
    return {
      server,
      browser,
      compared: false,
      summary:
        solver === 'unavailable'
          ? 'The browser’s solver is not available here, so only the server’s plan is shown.'
          : 'Only the server’s plan so far. Plan in the browser to compare it with VROOM’s.',
    };
  }
  if (browser && !server) {
    return {
      server,
      browser,
      compared: false,
      summary: 'Only the browser’s plan so far. Propose a plan to compare it with the server’s.',
    };
  }
  return {
    server,
    browser,
    compared: false,
    summary:
      solver === 'unavailable'
        ? 'There is no plan yet, and the browser’s solver is not available here. Propose a plan.'
        : 'There is no plan yet. Propose a plan, then plan in the browser to compare them.',
  };
}
