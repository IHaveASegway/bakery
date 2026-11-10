// The newest activity entries the page has loaded, in memory. The console's Activity list polls
// the API every ten seconds and puts what it got here, and the guide's trace (lib/trace.ts) hears
// each read, so an expected event the page holds no socket for can still be seen to happen.
// Not persisted.
import type { ActivityEntry } from '../contracts';
import { traces } from './trace';

export interface Feed {
  entries: ActivityEntry[];
  /** When the entries were loaded, in wall-clock milliseconds. */
  at: number;
  sandboxId: string;
}

/** How long a feed counts as "already loaded": one Activity poll and a little more. */
export const FRESH_MS = 12_000;

let held: Feed | null = null;

export const activityFeed = {
  set(sandboxId: string, entries: ActivityEntry[], at: number = Date.now()): void {
    held = { sandboxId, entries, at };
    // The guide's trace: an entry new since the last read is evidence for an expected event.
    traces.feed(sandboxId, entries);
  },
  /** The feed for this sandbox if it was loaded within `FRESH_MS` of `now`, else null. */
  fresh(sandboxId: string, now: number = Date.now()): Feed | null {
    return held !== null && held.sandboxId === sandboxId && now - held.at <= FRESH_MS ? held : null;
  },
  clear(): void {
    held = null;
  },
};
