// The console's countdown to the nightly wipe.

/** "6 h 12 min", "12 min", "under a minute", or "now" once the time has passed. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

/** "10:00 UTC" for a WallTime string. */
export function utcClock(wallTime: string): string {
  const date = new Date(wallTime);
  if (Number.isNaN(date.getTime())) return wallTime;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "2026-11-05 14:03 UTC" for a WallTime string. */
export function utcStamp(wallTime: string): string {
  const date = new Date(wallTime);
  if (Number.isNaN(date.getTime())) return wallTime;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The top bar's countdown, in round words: "12 h", "40 min", "under a minute", "now". */
export function roughCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
}
