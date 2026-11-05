import { afterEach, describe, expect, test, vi } from 'vitest';
import type { VroomInput } from '../src/lib/dispatch';
import {
  SOLVER_FOLDER,
  SolverUnavailable,
  WORKER_URL,
  createSolverClient,
  type WorkerLike,
} from '../src/lib/solver';
import lock from '../solver.lock.json';

// The browser's side of the solver, with a Worker that is a fake: the ways the solver can be
// unavailable (no support, a worker that will not load, the WebAssembly refused, no answer in time)
// and the way it answers. The real solver runs in Node in dispatch-solver.test.ts.

afterEach(() => vi.useRealTimers());

const INPUT: VroomInput = {
  vehicles: [{ id: 1, start_index: 0, end_index: 0, capacity: [10] }],
  jobs: [{ id: 1, location_index: 1, delivery: [1], service: 180 }],
  matrices: {
    car: {
      durations: [
        [0, 60],
        [60, 0],
      ],
    },
  },
};
const OPTIONS = { explorationLevel: 5, timeoutMs: 5000 };

type Reply = { id: number; output?: unknown; ms?: number; version?: string; failed?: string };

class FakeWorker implements WorkerLike {
  static made: FakeWorker[] = [];
  posted: { id: number; input: unknown; options: unknown }[] = [];
  terminated = false;
  private messageListener: ((event: { data: Reply }) => void) | null = null;
  private errorListener: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    private readonly onPost: (worker: FakeWorker, message: { id: number }) => void = () =>
      undefined,
  ) {
    FakeWorker.made.push(this);
  }
  postMessage(message: { id: number; input: unknown; options: unknown }) {
    this.posted.push(message);
    this.onPost(this, message);
  }
  addEventListener(type: string, listener: (event: never) => void) {
    if (type === 'message') this.messageListener = listener as never;
    else this.errorListener = listener as never;
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: Reply) {
    this.messageListener?.({ data });
  }
  crash() {
    this.errorListener?.({});
  }
}

const client = (onPost?: (worker: FakeWorker, message: { id: number }) => void, extra = {}) => {
  FakeWorker.made = [];
  return createSolverClient({
    make: (url) => new FakeWorker(url, onPost),
    supported: () => true,
    ...extra,
  });
};
const answers = (worker: FakeWorker, message: { id: number }) =>
  worker.reply({ id: message.id, output: { code: 0 }, ms: 12.5, version: '1.15.0' });
const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof SolverUnavailable ? e.reason : `other: ${String(e)}`),
  );

describe('where the worker is', () => {
  test('the solver’s own folder under /app/dispatch/solver/, named by the lock', () => {
    expect(SOLVER_FOLDER).toBe(`/app/dispatch/solver/${lock.folder}/`);
    expect(WORKER_URL).toBe(`${SOLVER_FOLDER}vroom-worker.mjs`);
  });
});

describe('a solve that works', () => {
  test('starts the worker on the first solve, sends the problem, and returns VROOM’s answer', async () => {
    const solver = client(answers);
    expect(FakeWorker.made).toHaveLength(0);
    const solved = await solver.solve(INPUT, OPTIONS);
    expect(solved).toEqual({ output: { code: 0 }, ms: 12.5, version: '1.15.0' });
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]?.url).toBe(WORKER_URL);
    expect(FakeWorker.made[0]?.posted[0]).toMatchObject({ input: INPUT, options: OPTIONS });
  });

  test('keeps the one worker for later solves, and a reply for another solve is ignored', async () => {
    const solver = client((worker, message) => {
      worker.reply({ id: message.id + 100, output: { code: 9 } });
      answers(worker, message);
    });
    await solver.solve(INPUT, OPTIONS);
    await solver.solve(INPUT, OPTIONS);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]?.posted.map((m) => m.id)).toEqual([1, 2]);
  });

  test('close stops the worker', async () => {
    const solver = client(answers);
    await solver.solve(INPUT, OPTIONS);
    solver.close();
    expect(FakeWorker.made[0]?.terminated).toBe(true);
  });
});

describe('the solver unavailable', () => {
  test('a browser with no Worker or no WebAssembly: unsupported, and no worker is made', async () => {
    const solver = client(answers, { supported: () => false });
    expect(await reason(solver.solve(INPUT, OPTIONS))).toBe('unsupported');
    expect(FakeWorker.made).toHaveLength(0);
  });

  test('a worker that cannot be made: load', async () => {
    FakeWorker.made = [];
    const solver = createSolverClient({
      make: () => {
        throw new Error('blocked');
      },
      supported: () => true,
    });
    expect(await reason(solver.solve(INPUT, OPTIONS))).toBe('load');
  });

  test('a worker that fails to load its script (a missing file, a refused script): load', async () => {
    const solver = client((worker) => worker.crash());
    expect(await reason(solver.solve(INPUT, OPTIONS))).toBe('load');
    expect(FakeWorker.made[0]?.terminated).toBe(true);
  });

  test('WebAssembly the browser or the policy refuses: the worker reports failed, and that is load', async () => {
    const solver = client((worker, message) =>
      worker.reply({ id: message.id, failed: 'CompileError: WebAssembly.instantiate(): refused' }),
    );
    const error = await solver.solve(INPUT, OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolverUnavailable);
    expect((error as SolverUnavailable).reason).toBe('load');
    expect((error as SolverUnavailable).message).toContain('CompileError');
  });

  test('no answer in time stops the worker: timeout; the first solve waits longer than later ones', async () => {
    vi.useFakeTimers();
    const solver = client(undefined, { firstLimitMs: 1000, limitMs: 100 });
    const first = reason(solver.solve(INPUT, OPTIONS));
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWorker.made[0]?.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await first).toBe('timeout');
    expect(FakeWorker.made[0]?.terminated).toBe(true);
  });

  test('after a failure the next solve starts a new worker', async () => {
    let attempts = 0;
    const solver = client((worker, message) => {
      attempts++;
      if (attempts === 1) worker.crash();
      else answers(worker, message);
    });
    expect(await reason(solver.solve(INPUT, OPTIONS))).toBe('load');
    await solver.solve(INPUT, OPTIONS);
    expect(FakeWorker.made).toHaveLength(2);
  });

  test('a solve while another runs is refused', async () => {
    const solver = client();
    void solver.solve(INPUT, OPTIONS).catch(() => undefined);
    await expect(solver.solve(INPUT, OPTIONS)).rejects.toThrow('already running');
    solver.close();
  });
});
