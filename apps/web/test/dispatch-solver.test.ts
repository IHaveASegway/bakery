import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { fetchSolver, readLock, solverRoot } from '../../../scripts/fetch-solver.mjs';
import {
  DEPOT,
  buildProblem,
  planRequest,
  readSolution,
  solveOptions,
  type VroomInput,
  type VroomOutput,
} from '../src/lib/dispatch';
import { SLICE_STOPS, orderId, route, slice, stop } from './dispatch-support';

// The real solver, in Node, the way the site's node-solver.ts runs it: the same files the page
// serves, imported from public/ where the build fetched them. They are not in the repository, so
// the test fetches them first (a no-op when they are there and match the lock) and skips with a
// message when it cannot (offline, no git), as the other solver tests do.

const lock = readLock();
const dir = join(solverRoot(), lock.folder);
let reason = '';
try {
  fetchSolver({ lock });
} catch (e) {
  reason = e instanceof Error ? e.message.split('\n')[0]! : String(e);
}
const present = existsSync(join(dir, 'vroom-solver.mjs'));
if (!present) {
  console.warn(`dispatch-solver: no solver in ${dir} (${reason}); skipping the Node solves`);
}

interface Solver {
  readonly version: string;
  solve(input: VroomInput, options: { explorationLevel: number; timeoutMs?: number }): VroomOutput;
}
let solver: Solver;

beforeAll(async () => {
  if (!present) return;
  const url = pathToFileURL(join(dir, 'vroom-solver.mjs')).href;
  const module = (await import(/* @vite-ignore */ url)) as { createVroom(): Promise<Solver> };
  solver = await module.createVroom();
});

/** The busy Saturday's size (docs/domain.md, "63 delivery orders across 4 vans"): a stop at each of
 *  the fixture's 63 drop-off spots, 4 to 14 units each, deterministic. */
const SATURDAY = Array.from({ length: 63 }, (_, k) => stop(k + 1, k + 1, 4 + ((k * 7) % 11)));
const VANS = 4;
const CAPACITY = 250;

describe.skipIf(!present)('the real VROOM, in Node, over the fixture', () => {
  test('it is the version the lock pins', () => {
    expect(solver.version).toBe('1.15.0');
    expect(lock.folder).toContain(solver.version);
  });

  test('the 6-place slice: every stop once, and the answer reads back as the API’s request', () => {
    const problem = buildProblem(slice(6), SLICE_STOPS, 2, 40);
    const output = solver.solve(problem.input, solveOptions(6));
    expect(output.code).toBe(0);
    const plan = readSolution(output, problem);
    expect(plan.unassigned).toEqual([]);
    const placed = plan.routes.flatMap((r) => r.stops).sort();
    expect(placed).toEqual([1, 2, 3, 4, 5, 6].map(orderId));
    for (const r of plan.routes.filter((r) => r.stops.length > 0)) {
      expect(r.start).toBe(DEPOT);
      expect(r.end).toBe(DEPOT);
    }
    const request = planRequest(plan);
    expect(request.vans.map((v) => v.van)).toEqual([1, 2]);
    expect(JSON.stringify(request)).not.toMatch(/minutes|total|cost|duration/);
  });

  test('capacity is VROOM’s to respect: a stop bigger than any van is left unassigned, not placed', () => {
    const big = [stop(1, 1, 5), stop(2, 2, 99)];
    const problem = buildProblem(slice(6), big, 1, 10);
    const plan = readSolution(solver.solve(problem.input, solveOptions(2)), problem);
    expect(plan.unassigned).toEqual([orderId(2)]);
    expect(plan.routes[0]?.stops).toEqual([orderId(1)]);
  });

  test('the busy Saturday: 63 stops on 4 vans, all placed, none over capacity, in the time measured', () => {
    const problem = buildProblem(route, SATURDAY, VANS, CAPACITY);
    expect(problem.input.jobs).toHaveLength(63);
    const times: number[] = [];
    let output: VroomOutput | null = null;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      output = solver.solve(problem.input, solveOptions(63));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(
      `dispatch-solver: 63 stops, ${VANS} vans, capacity ${CAPACITY}: VROOM ${solver.version} solved in ${times
        .map((t) => `${t.toFixed(0)} ms`)
        .join(', ')} (Node ${process.version}, 3 runs, sorted)`,
    );
    const plan = readSolution(output!, problem);
    expect(plan.unassigned).toEqual([]);
    const placed = plan.routes.flatMap((r) => r.stops);
    expect(placed).toHaveLength(63);
    expect(new Set(placed).size).toBe(63);
    const units = new Map(SATURDAY.map((s) => [s.order, s.units]));
    for (const r of plan.routes) {
      expect(r.stops.reduce((sum, o) => sum + (units.get(o) ?? 0), 0)).toBeLessThanOrEqual(
        CAPACITY,
      );
    }
    expect(plan.routes).toHaveLength(VANS);
    // ADR 0012 revisits the browser solve if it passes 2 s on a phone; in Node it is far inside that.
    expect(times[1]).toBeLessThan(2000);
  });

  test('the same problem gives the same plan twice', () => {
    const problem = buildProblem(route, SATURDAY, VANS, CAPACITY);
    const a = readSolution(solver.solve(problem.input, solveOptions(63)), problem);
    const b = readSolution(solver.solve(problem.input, solveOptions(63)), problem);
    expect(b).toEqual(a);
  });

  test('VROOM beats dealing the stops to the vans in turn, in the minutes the object counts', () => {
    const problem = buildProblem(route, SATURDAY, VANS, CAPACITY);
    const plan = readSolution(solver.solve(problem.input, solveOptions(63)), problem);
    const minutes = (places: number[]): number => {
      let total = 0;
      for (let i = 0; i + 1 < places.length; i++) {
        const seconds = route.durations[places[i]! * 64 + places[i + 1]!] ?? 0;
        total += Math.ceil(seconds / 60);
      }
      return total;
    };
    const placeOf = new Map(SATURDAY.map((s) => [s.order, s.place]));
    const vroom = plan.routes.reduce(
      (sum, r) => sum + minutes([DEPOT, ...r.stops.map((o) => placeOf.get(o)!), DEPOT]),
      0,
    );
    const dealt = Array.from({ length: VANS }, (_, v) =>
      SATURDAY.filter((_, k) => k % VANS === v).map((s) => s.place),
    );
    const dealtMinutes = dealt.reduce((sum, places) => sum + minutes([DEPOT, ...places, DEPOT]), 0);
    console.log(`dispatch-solver: VROOM ${vroom} drive minutes, dealt in turn ${dealtMinutes}`);
    expect(vroom).toBeLessThan(dealtMinutes);
  });
});
