// How long the browser run waits before it starts Playwright, so no test is in flight when the
// bakery wipes its sandboxes. Pure arithmetic on a timestamp, so apps/web/test/e2e-wipe-hold.test.ts
// can check it without the stack. run.mjs is the only caller.

// The hour of the daily wipe, UTC. Keep in step with `WIPE_HOUR_UTC` in crates/app/src/wipe.rs (10).
// That file is Rust and is not parsed here.
export const WIPE_HOUR_UTC = 10;

// How long after the wipe the run starts: the sandbox alarms run on `wrangler dev` too, and need a moment.
export const WIPE_SETTLE_MS = 5_000;

// The guard window: a run that would start less than this long before the wipe holds until after
// it. Eight minutes: the suite took 5.8 minutes for 82 tests on GitHub's runner on 2026-11-10, the
// `e2e` job's `timeout-minutes` is 20 in .github/workflows/ci.yml, and the job spends about 2 minutes
// before the run, so a hold of 8 minutes and a run of 6 still fit. E2E_WIPE_GUARD_S overrides it in
// seconds; 0 never holds.
export const DEFAULT_WIPE_GUARD_MS = 8 * 60 * 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Milliseconds to wait from `nowMs` (epoch ms) before starting, 0 for none. */
export function holdMs(nowMs, guardMs = DEFAULT_WIPE_GUARD_MS) {
  if (!(guardMs > 0)) return 0;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todaysWipe = dayStart + WIPE_HOUR_UTC * HOUR_MS;
  // At the wipe instant itself the wipe is already running, but its alarms still need the settle time.
  const wipe = nowMs <= todaysWipe + WIPE_SETTLE_MS ? todaysWipe : todaysWipe + DAY_MS;
  if (wipe - nowMs >= guardMs) return 0;
  return Math.max(0, wipe + WIPE_SETTLE_MS - nowMs);
}
