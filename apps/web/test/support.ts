// Fakes shared by the scheduling tests: a ScheduleResponse for a Mountain day, and a fetch that
// records its calls and answers from a queue. Synthetic data only.
import { vi } from 'vitest';
import type { ScheduleResponse } from '../src/contracts';

const two = (n: number) => String(n).padStart(2, '0');

/** A day's schedule, 32 quarter-hour slots from 07:00, every one with `capacity` and `taken` 0 unless told. */
export function scheduleFor(
  date: string,
  options: {
    offset?: string;
    open?: boolean;
    capacity?: number;
    taken?: Record<string, number>;
    zoneTaken?: number;
  } = {},
): ScheduleResponse {
  const offset = options.offset ?? '-07:00';
  const capacity = options.capacity ?? 6;
  const slots = Array.from({ length: 32 }, (_, i) => {
    const minutes = 7 * 60 + i * 15;
    const hhmm = `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
    const taken = options.taken?.[hhmm] ?? 0;
    return {
      start: `${date}T${hhmm}:00${offset}`,
      capacity,
      taken,
      free: Math.max(0, capacity - taken),
    };
  });
  const zoneTaken = options.zoneTaken ?? 0;
  return {
    date,
    open: options.open ?? true,
    slots,
    zones: ['z1', 'z2', 'z3'].map((zone) => ({
      zone,
      capacity: 20,
      taken: zoneTaken,
      free: Math.max(0, 20 - zoneTaken),
      windows: ['09:00', '11:00', '13:00'].map((t) => `${date}T${t}:00${offset}`),
    })),
    items: [{ item: 'croissant', daily_cap: 40, used: 12 }],
    catering: { capacity: 2, taken: 1 },
    bake_list: { version: 0, lines: [] },
    menu_version: 1,
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Replaces `fetch` with a fake that answers each call from `answers` in turn and records it. */
export function fakeFetch(answers: (Response | Error)[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (next === undefined) throw new Error('fetch called more often than the test expected');
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  return { calls, restore: () => vi.unstubAllGlobals() };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export const problem = (
  status: number,
  slug: string,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  json({ type: `https://bakery.example.test/problems/${slug}`, title, status, ...extra }, status);
