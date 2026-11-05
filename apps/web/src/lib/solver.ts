// The browser's side of the solver: one module Web Worker, made on the first solve, that runs VROOM
// compiled to WebAssembly (ADR 0012, decision 6). The files are not part of the bundle. They are
// fetched at build by scripts/fetch-solver.mjs, checked against solver.lock.json, and served from
// /app/dispatch/solver/<folder>/, whose response carries the only 'wasm-unsafe-eval' on the site
// (src/policy.ts). Nothing here imports them, so a build without them still builds the page, and
// the page then says the solver is unavailable.
import lock from '../../solver.lock.json';
import type { SolverFailure } from './dispatch-errors';
import type { VroomInput, VroomOutput } from './dispatch';

/** Where the worker script is served from. */
export const SOLVER_FOLDER = `/app/dispatch/solver/${lock.folder}/`;
export const WORKER_URL = `${SOLVER_FOLDER}vroom-worker.mjs`;

/** The first solve waits for the files (about 344 KB gzip of WebAssembly); later ones only solve. */
export const FIRST_LIMIT_MS = 20_000;
export const LIMIT_MS = 15_000;

/** What the worker sends back (vroom-worker.mjs). */
interface Reply {
  id: number;
  output?: VroomOutput;
  ms?: number;
  version?: string;
  failed?: string;
}

/** The part of a Worker this module uses, so a test can stand in for one. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: Reply }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

/** The solver could not run: `reason` says why in the page's words (lib/dispatch-errors.ts). */
export class SolverUnavailable extends Error {
  readonly reason: SolverFailure;
  constructor(reason: SolverFailure, detail = '') {
    super(`The solver is unavailable (${reason})${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'SolverUnavailable';
    this.reason = reason;
  }
}

/** One solve's answer. `ms` is the solver's own measure of the solve, not of the plan. */
export interface Solved {
  output: VroomOutput;
  ms: number;
  version: string;
}

export interface SolverClient {
  solve(
    input: VroomInput,
    options: { explorationLevel: number; timeoutMs: number },
  ): Promise<Solved>;
  close(): void;
}

export interface ClientOptions {
  url?: string;
  make?: (url: string) => WorkerLike;
  /** Whether this browser can run the solver at all. */
  supported?: () => boolean;
  firstLimitMs?: number;
  limitMs?: number;
}

const browserSupports = (): boolean =>
  typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';

/**
 * A solver that starts its worker on the first `solve`. A worker that cannot load (a missing file,
 * a refused script, WebAssembly the policy or the browser will not compile) reports an error event
 * or a failed reply; a solve with no answer in the time limit stops the worker. Each of those
 * rejects with a SolverUnavailable and discards the worker, so the next solve tries afresh.
 */
export function createSolverClient(options: ClientOptions = {}): SolverClient {
  const url = options.url ?? WORKER_URL;
  const make = options.make ?? ((u) => new Worker(u, { type: 'module' }) as unknown as WorkerLike);
  const supported = options.supported ?? browserSupports;
  const firstLimit = options.firstLimitMs ?? FIRST_LIMIT_MS;
  const limit = options.limitMs ?? LIMIT_MS;

  let worker: WorkerLike | null = null;
  let answered = false;
  let asked = 0;
  let current: {
    id: number;
    resolve: (solved: Solved) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function drop(): void {
    worker?.terminate();
    worker = null;
    answered = false;
  }

  function fail(error: Error): void {
    const job = current;
    current = null;
    drop();
    if (job) {
      clearTimeout(job.timer);
      job.reject(error);
    }
  }

  function start(): WorkerLike {
    const made = make(url);
    made.addEventListener('error', () => fail(new SolverUnavailable('load')));
    made.addEventListener('message', ({ data }) => {
      const job = current;
      if (!job || data.id !== job.id) return;
      if (data.failed !== undefined || data.output === undefined) {
        return fail(new SolverUnavailable('load', data.failed ?? 'no output'));
      }
      clearTimeout(job.timer);
      current = null;
      answered = true;
      job.resolve({ output: data.output, ms: data.ms ?? 0, version: data.version ?? '' });
    });
    return made;
  }

  return {
    solve(input, solveOptions) {
      if (!supported()) return Promise.reject(new SolverUnavailable('unsupported'));
      if (current) return Promise.reject(new Error('A solve is already running'));
      return new Promise<Solved>((resolve, reject) => {
        try {
          worker ??= start();
        } catch (e) {
          drop();
          return reject(new SolverUnavailable('load', e instanceof Error ? e.message : ''));
        }
        const id = ++asked;
        const timer = setTimeout(
          () => fail(new SolverUnavailable('timeout')),
          answered ? limit : firstLimit,
        );
        current = { id, resolve, reject, timer };
        worker.postMessage({ id, input, options: solveOptions });
      });
    },
    close() {
      const job = current;
      current = null;
      if (job) clearTimeout(job.timer);
      drop();
    },
  };
}
