// The gap ADR 0012's Revisit trigger is about: the server's plan, the savings heuristic with its
// improvement pass, against VROOM, in total drive minutes, on one sandbox's busy Saturday,
// delivery windows included.
//
//   node scripts/dispatch-gap.mjs [<seed> <birth date>]    default: 42 2026-11-07
//   node scripts/dispatch-gap.mjs --problem <file>         a problem the example already wrote
//   add --json to print one JSON object instead of the lines
//
// The problem comes from `cargo run -p bakery-seed --example dispatch-problem`: the stops in
// order-id order with their units and windows, the vans, the Worker's matrix cut to the bakery and
// the stops, and the server's plan with what the validator said of it: the savings construction
// with the improvement pass after it, as the object proposes, and the construction's minutes
// alone. It names no place. VROOM is
// the storefront's, the files scripts/fetch-solver.mjs leaves in apps/web/public/app/dispatch/solver/,
// asked the way the dispatch screen asks it (apps/web/src/lib/dispatch.ts, buildProblem and
// solveOptions). The gap is (server - VROOM) / VROOM, in tenths of a percent rounded half away from
// zero, as the screen's comparison is. Exit 0 when the gap is at most the trigger, 1 above it or
// when either plan breaks a rule, 2 when the check cannot run. Node 22, no dependency.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchSolver, readLock, solverRoot } from './fetch-solver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ADR 0012, "Revisit": the heuristic is revisited when it drives more than this much longer. */
export const TRIGGER_PERCENT = 25;
export const DEFAULT_SEED = 42;
export const DEFAULT_BORN = '2026-11-07';

/** The dispatch screen's solve options (dispatch.ts, explorationFor, SOLVE_LIMIT_MS). */
export const solveOptions = (jobs) => ({ explorationLevel: jobs > 40 ? 3 : 5, timeoutMs: 5_000 });

/** The busy Saturday's problem for a seed and a birth date, from the seed crate's example. */
export function loadProblem(seed = DEFAULT_SEED, born = DEFAULT_BORN) {
  const out = execFileSync(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
      '-p',
      'bakery-seed',
      '--example',
      'dispatch-problem',
      '--',
      String(seed),
      born,
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out);
}

/** The storefront's solver, fetched first when it is missing. */
export async function loadSolver() {
  const lock = readLock();
  const dir = join(solverRoot(), lock.folder);
  if (!existsSync(join(dir, 'vroom-solver.mjs'))) fetchSolver({ lock });
  const module = await import(pathToFileURL(join(dir, 'vroom-solver.mjs')).href);
  return module.createVroom();
}

/**
 * VROOM's input, as buildProblem builds it with its default `minutes` metric: location 0 the
 * bakery and `k` the `k`-th stop, each leg the Worker's whole minutes in seconds, a job's window
 * from its start to its close, 180 seconds at each door, and each van out from 0 to the latest a
 * van that keeps to the windows can be back.
 */
export function vroomInput(problem) {
  const leg = (a, b) => problem.minutes[a][b] * 60;
  const back = Math.max(
    0,
    ...problem.stops.map((s) => s.close_s + problem.service_seconds + leg(s.node, 0)),
  );
  return {
    vehicles: Array.from({ length: problem.vans }, (_, v) => ({
      id: v + 1,
      start_index: 0,
      end_index: 0,
      capacity: [problem.capacity],
      time_window: [0, back],
    })),
    jobs: problem.stops.map((s) => ({
      id: s.node,
      location_index: s.node,
      delivery: [s.units],
      service: problem.service_seconds,
      time_windows: [[s.open_s, s.close_s]],
    })),
    matrices: { car: { durations: problem.minutes.map((row) => row.map((m) => m * 60)) } },
  };
}

/** VROOM's routes as node lists, one per van that has stops, and the nodes it left out. */
export function readRoutes(output) {
  if (output.code !== 0) throw new Error(`VROOM: ${output.error ?? `code ${output.code}`}`);
  return {
    routes: (output.routes ?? [])
      .map((r) => r.steps.filter((s) => s.type === 'job').map((s) => s.id))
      .filter((r) => r.length > 0),
    unassigned: (output.unassigned ?? []).map((u) => u.id),
  };
}

/** One van's drive, the bakery to each node and back, in the Worker's minutes. */
export function routeMinutes(problem, nodes) {
  if (nodes.length === 0) return 0;
  let total = 0;
  let at = 0;
  for (const n of [...nodes, 0]) {
    total += problem.minutes[at][n];
    at = n;
  }
  return total;
}

/**
 * The first node a van serves after its window closed, or null: the validator's window rule
 * (crates/domain/src/dispatch/windows.rs) in whole minutes after the vans leave, a van that is
 * early waiting, and the service minutes at each door.
 */
export function lateNode(problem, nodes) {
  const byNode = new Map(problem.stops.map((s) => [s.node, s]));
  let t = 0;
  let at = 0;
  for (const n of nodes) {
    const s = byNode.get(n);
    const start = Math.max(t + problem.minutes[at][n], s.open_s / 60);
    if (start > s.close_s / 60) return n;
    t = start + problem.service_seconds / 60;
    at = n;
  }
  return null;
}

/** (server - vroom) / vroom in tenths of a percent, half away from zero; null when VROOM drives 0. */
export function gapTenths(server, vroom) {
  if (vroom === 0) return server === 0 ? 0 : null;
  const scaled = (server - vroom) * 1000;
  return Math.trunc((scaled + Math.sign(scaled) * Math.trunc(vroom / 2)) / vroom);
}

/** Both plans' totals and the gap, with every rule the check holds them to. */
export function measure(problem, solver) {
  const nodeOf = new Map(problem.stops.map((s) => [s.order, s.node]));
  const server = problem.heuristic;
  const serverRoutes = server.routes.map((r) => r.stops.map((o) => nodeOf.get(o)));
  const recount = serverRoutes.reduce((sum, r) => sum + routeMinutes(problem, r), 0);

  const started = performance.now();
  const output = solver.solve(vroomInput(problem), solveOptions(problem.stops.length));
  const solveMs = Math.round(performance.now() - started);
  const vroom = readRoutes(output);
  const vroomMinutes = vroom.routes.reduce((sum, r) => sum + routeMinutes(problem, r), 0);
  const late = vroom.routes.map((r) => lateNode(problem, r)).filter((n) => n !== null);
  const units = vroom.routes.map((r) => r.reduce((sum, n) => sum + problem.stops[n - 1].units, 0));

  const problems = [];
  if (!server.validator.ok) problems.push(`the server's plan: ${server.validator.error}`);
  if (server.unassigned.length > 0)
    problems.push(`the server left ${server.unassigned.length} stops`);
  if (recount !== server.minutes)
    problems.push(`the server's ${server.minutes} recount to ${recount}`);
  if (server.minutes > problem.construction_minutes)
    problems.push(`the server's ${server.minutes} are more than its construction's`);
  if (vroom.unassigned.length > 0) problems.push(`VROOM left ${vroom.unassigned.length} stops`);
  if (late.length > 0) problems.push(`VROOM is late at ${late.length} stops`);
  if (units.some((u) => u > problem.capacity)) problems.push('VROOM overloads a van');
  if (vroom.routes.length > problem.vans) problems.push('VROOM uses more vans than the day has');

  const tenths = gapTenths(server.minutes, vroomMinutes);
  return {
    seed: problem.seed,
    born: problem.born,
    date: problem.date,
    stops: problem.stops.length,
    vans: problem.vans,
    server_minutes: server.minutes,
    construction_minutes: problem.construction_minutes,
    validator_ok: server.validator.ok,
    vroom_minutes: vroomMinutes,
    vroom_version: solver.version,
    exploration: solveOptions(problem.stops.length).explorationLevel,
    solve_ms: solveMs,
    gap_tenths_percent: tenths,
    gap_percent: tenths === null ? null : (tenths / 10).toFixed(1),
    trigger_percent: TRIGGER_PERCENT,
    over_trigger: tenths === null || tenths > TRIGGER_PERCENT * 10,
    problems,
  };
}

function report(r, today) {
  return [
    `dispatch-gap, measured ${today}: seed ${r.seed}, born ${r.born}, busy Saturday ${r.date}, ${r.stops} stops, ${r.vans} vans, windows on`,
    `  server (savings and the improvement pass, validator ${r.validator_ok ? 'ok' : 'refused'}): ${r.server_minutes} minutes, ${r.construction_minutes} before the pass`,
    `  VROOM ${r.vroom_version} (-x ${r.exploration}, ${r.solve_ms} ms): ${r.vroom_minutes} minutes`,
    `  gap: ${r.gap_percent ?? 'undefined'}% (the trigger is above ${r.trigger_percent}%)`,
    ...r.problems.map((p) => `  problem: ${p}`),
  ].join('\n');
}

async function main(argv) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  let problem;
  if (args[0] === '--problem' && args.length === 2) {
    problem = JSON.parse(readFileSync(args[1], 'utf8'));
  } else if (args.length === 0 || (args.length === 2 && /^\d+$/.test(args[0]))) {
    problem = loadProblem(args[0] ?? DEFAULT_SEED, args[1] ?? DEFAULT_BORN);
  } else {
    console.error('usage: dispatch-gap.mjs [<seed> <YYYY-MM-DD>] | --problem <file>  [--json]');
    return 2;
  }
  const r = measure(problem, await loadSolver());
  const today = new Date().toISOString().slice(0, 10);
  console.log(json ? JSON.stringify({ measured: today, ...r }) : report(r, today));
  return r.over_trigger || r.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`dispatch-gap: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    },
  );
}
