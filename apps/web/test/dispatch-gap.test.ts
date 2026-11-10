// ADR 0012's Revisit trigger as a test: the server's plan, the savings heuristic with its
// improvement pass, against VROOM on seed 42's busy Saturday for several birth dates, windows
// included, through scripts/dispatch-gap.mjs, the check a person runs by hand. The problem comes from the seed crate's dispatch-problem example, so the test needs cargo;
// the solver is the storefront's, fetched at build. Without either the test skips with a message,
// as the other solver tests do; CI's verify job has both.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  TRIGGER_PERCENT,
  gapTenths,
  lateNode,
  loadProblem,
  routeMinutes,
  vroomInput,
} from '../../../scripts/dispatch-gap.mjs';
import { fetchSolver, readLock, solverRoot } from '../../../scripts/fetch-solver.mjs';
import { buildProblem, type RouteData } from '../src/lib/dispatch';

const SCRIPT = fileURLToPath(new URL('../../../scripts/dispatch-gap.mjs', import.meta.url));
const ROOT = resolve(SCRIPT, '..', '..');

/** The fixed sandbox: seed 42, born on the day the hand measurement of 2026-11-09 used first. */
const SEED = 42;
const BORN = '2026-11-07';
/**
 * The births the gap is held on. Seed 42's busy Saturday repeats week by week of birth, and these
 * four are each of its days from 2026-11-04 to 2026-11-10: 2026-11-07, the first measured;
 * 2026-11-10, past the trigger at 26.9% before the improvement pass (roadmap R95); 2026-11-08,
 * the widest after it, 12.9% (measured 2026-11-10); and 2026-11-04.
 */
const BIRTHS = ['2026-11-04', BORN, '2026-11-08', '2026-11-10'];

interface Problem {
  seed: number;
  born: string;
  date: string;
  vans: number;
  capacity: number;
  service_seconds: number;
  stops: {
    node: number;
    order: string;
    units: number;
    window: string;
    open_s: number;
    close_s: number;
  }[];
  minutes: number[][];
  heuristic: {
    routes: { van: number; stops: string[] }[];
    minutes: number;
    unassigned: string[];
    validator: { ok: boolean; minutes?: number; rule?: string; error?: string };
  };
  construction_minutes: number;
}

const why: string[] = [];
try {
  execFileSync('cargo', ['--version'], { stdio: 'ignore' });
} catch {
  why.push('no cargo');
}
const lock = readLock();
try {
  fetchSolver({ lock });
} catch (e) {
  why.push(e instanceof Error ? e.message.split('\n')[0]! : String(e));
}
if (!existsSync(join(solverRoot(), lock.folder, 'vroom-solver.mjs'))) why.push('no solver');
const ready = why.length === 0;
if (!ready) console.warn(`dispatch-gap: skipping (${why.join('; ')})`);

let problem: Problem;
let dir: string;
const problems = new Map<string, { problem: Problem; file: string }>();

beforeAll(() => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'dispatch-gap-'));
  for (const born of BIRTHS) {
    const p = loadProblem(SEED, born) as Problem;
    const file = join(dir, `problem-${born}.json`);
    writeFileSync(file, JSON.stringify(p));
    problems.set(born, { problem: p, file });
  }
  problem = problems.get(BORN)!.problem;
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the gap is half away from zero in tenths, as the screen compares', () => {
  expect([gapTenths(328, 290), gapTenths(364, 351), gapTenths(413, 352)]).toEqual([131, 37, 173]);
  expect([gapTenths(290, 328), gapTenths(0, 0), gapTenths(5, 0)]).toEqual([-116, 0, null]);
});

describe.skipIf(!ready)("the busy Saturday's gap (ADR 0012, Revisit if)", () => {
  test('the problem is the busy Saturday, and names ids, units, minutes and seconds only', () => {
    expect([problem.seed, problem.born, problem.vans, problem.stops.length]).toEqual([
      SEED,
      BORN,
      4,
      63,
    ]);
    expect(problem.minutes).toHaveLength(64);
    expect(problem.stops.map((s) => s.node)).toEqual(Array.from({ length: 63 }, (_, k) => k + 1));
    expect(Object.keys(problem.stops[0]!).sort()).toEqual(
      ['close_s', 'node', 'open_s', 'order', 'units', 'window'].sort(),
    );
    expect(JSON.stringify(problem)).not.toMatch(/place|label|"x"|"y"/);
  });

  test.each(BIRTHS)(
    "born %s, the server's plan passes the validator at its own minutes",
    (born) => {
      const { problem } = problems.get(born)!;
      const h = problem.heuristic;
      expect(h.validator).toEqual({ ok: true, minutes: h.minutes });
      expect(h.unassigned).toEqual([]);
      const nodeOf = new Map(problem.stops.map((s) => [s.order, s.node]));
      const routes = h.routes.map((r) => r.stops.map((o) => nodeOf.get(o)!));
      expect(routes.flat().sort((a, b) => a - b)).toEqual(problem.stops.map((s) => s.node));
      // The script's window rule agrees with the validator's, and its minutes with the plan's.
      expect(routes.map((r) => lateNode(problem, r))).toEqual(routes.map(() => null));
      expect(routes.reduce((sum, r) => sum + routeMinutes(problem, r), 0)).toBe(h.minutes);
      // The improvement pass never drives longer than the construction it starts from.
      expect(h.minutes).toBeLessThanOrEqual(problem.construction_minutes);
    },
  );

  test("the script asks VROOM what the dispatch screen's buildProblem would", () => {
    // Route data whose place k is node k: the Worker's minutes in seconds, as route-data.json's
    // durations round up to them (both built 2026-11-05 from one openrouteservice run).
    const n = problem.minutes.length;
    const data: RouteData = {
      license: 'synthetic',
      attribution: 'synthetic',
      copyright: 'synthetic',
      viewBox: [0, 0, 1, 1],
      serviceSeconds: problem.service_seconds,
      points: Array.from({ length: n }, (_, i) => ({
        i,
        label: `node ${i}`,
        kind: i === 0 ? 'depot' : 'stop',
        x: 0,
        y: 0,
      })),
      durations: problem.minutes.flat().map((m) => m * 60),
      distances: problem.minutes.flat(),
    };
    const stops = problem.stops.map((s) => ({
      order: s.order,
      place: s.node,
      units: s.units,
      window: s.window,
    }));
    const built = buildProblem(data, stops, problem.vans, problem.capacity, problem.date);
    expect(vroomInput(problem)).toEqual(built.input);
  });

  test.each(BIRTHS)(
    `born %s, the server drives at most ${TRIGGER_PERCENT}% longer than VROOM`,
    (born) => {
      const { problem, file } = problems.get(born)!;
      const out = execFileSync(process.execPath, [SCRIPT, '--problem', file, '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const r = JSON.parse(out) as {
        server_minutes: number;
        vroom_minutes: number;
        gap_tenths_percent: number;
        over_trigger: boolean;
        problems: string[];
      };
      // A non-zero exit throws above; these say why when the figures move.
      expect(r.problems).toEqual([]);
      expect(r.server_minutes).toBe(problem.heuristic.minutes);
      expect(r.vroom_minutes).toBeGreaterThan(0);
      expect(r.gap_tenths_percent).toBeLessThanOrEqual(TRIGGER_PERCENT * 10);
      expect(r.over_trigger).toBe(false);
    },
    120_000,
  );
});
