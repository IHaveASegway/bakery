// Fixtures for the dispatch tests: the real route data (the committed fixture), a 6-place slice of
// it, and stops, plans and days over them. Synthetic: the stops belong to no one, the places are
// the fixture's public parks, libraries and stations, and the ULIDs are counters.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DispatchResponse, PlanView, StopView } from '../src/contracts';
import { parseIsochrones, parseRouteData, type RouteData } from '../src/lib/dispatch';

const dataDir = fileURLToPath(new URL('../public/app/dispatch/data/', import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(`${dataDir}${name}`, 'utf8'));

export const route: RouteData = parseRouteData(read('route-data.json'));
export const isochrones = parseIsochrones(read('isochrones.json'));

/** The first `n` places of the route data with their own sub-matrix: place 0 is still the bakery. */
export function slice(n: number): RouteData {
  const keep = route.points.slice(0, n);
  const pick = (matrix: readonly number[]) =>
    keep.flatMap((a) => keep.map((b) => matrix[a.i * route.points.length + b.i] ?? 0));
  return {
    ...route,
    points: keep,
    durations: pick(route.durations),
    distances: pick(route.distances),
  };
}

/** A made-up order id: 26 Crockford characters, the last digits a counter. */
export const orderId = (k: number): string => `01JD0ORDER${String(k).padStart(16, '0')}`;

export const stop = (
  k: number,
  place: number,
  units: number,
  extra: Partial<StopView> = {},
): StopView => ({
  customer: `01JD0CUSTOMER${String(k).padStart(13, '0')}`,
  order: orderId(k),
  place,
  place_label: `p${place + 1}`,
  status: 'confirmed',
  units,
  window: '2026-11-07T09:00:00-07:00',
  zone: 'z1',
  ...extra,
});

export function plan(
  source: 'server' | 'browser',
  vans: { van: number; stops: number[]; units?: number; minutes?: number }[],
  extra: Partial<PlanView> = {},
): PlanView {
  return {
    last_back: '2026-11-07T10:42:00-07:00',
    minutes: vans.reduce((sum, v) => sum + (v.minutes ?? 30), 0),
    plan_v: 1,
    source,
    unassigned: [],
    vans: vans.map((v) => ({
      van: v.van,
      stops: v.stops.map(orderId),
      units: v.units ?? 10 * v.stops.length,
      minutes: v.minutes ?? 30,
    })),
    ...extra,
  };
}

export function day(stops: StopView[], extra: Partial<DispatchResponse> = {}): DispatchResponse {
  return { date: '2026-11-07', vans: 2, capacity: 250, plan_v: 0, stops, ...extra };
}

/** Six stops over places 1 to 5 (two share place 3): the 6-place slice's day. */
export const SLICE_STOPS: StopView[] = [
  stop(1, 1, 12),
  stop(2, 2, 8),
  stop(3, 3, 20),
  stop(4, 3, 5),
  stop(5, 4, 9),
  stop(6, 5, 14),
];
