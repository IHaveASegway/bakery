// The newest activity entries the page has loaded, in memory. The console's Activity list polls
// the API every ten seconds and puts what it got here, so the tour can show the events of the
// visitor's last action from the feed the screen already holds, and asks the API itself only when
// nothing fresh is here (any other screen). Not persisted.
import type { ActivityEntry } from '../contracts';

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
  },
  /** The feed for this sandbox if it was loaded within `FRESH_MS` of `now`, else null. */
  fresh(sandboxId: string, now: number = Date.now()): Feed | null {
    return held !== null && held.sandboxId === sandboxId && now - held.at <= FRESH_MS ? held : null;
  },
  clear(): void {
    held = null;
  },
};
