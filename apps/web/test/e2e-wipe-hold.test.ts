import { describe, expect, it } from 'vitest';
import { holdMs } from '../e2e/wipe-hold.mjs';

const GUARD = 8 * 60 * 1000;
const at = (hms: string) => Date.parse(`2026-11-10T${hms}Z`);
const WIPE_PLUS_5 = at('10:00:05');

// The browser run holds rather than cross the daily 10:00 UTC wipe (e2e/wipe-hold.mjs).
describe('e2e wipe hold', () => {
  it('does not hold when the wipe is the guard or more away', () => {
    expect(holdMs(at('09:51:59.000'), GUARD)).toBe(0);
    expect(holdMs(at('09:52:00.000'), GUARD)).toBe(0);
  });

  it('holds until 5 seconds after the wipe once inside the guard', () => {
    const now = at('09:52:00.001');
    expect(now + holdMs(now, GUARD)).toBe(WIPE_PLUS_5);
  });

  it('holds about 5 seconds just before the wipe', () => {
    const now = at('09:59:59.999');
    expect(holdMs(now, GUARD)).toBe(5_001);
    expect(now + holdMs(now, GUARD)).toBe(WIPE_PLUS_5);
  });

  it('holds 5 seconds at the wipe instant', () => {
    expect(holdMs(at('10:00:00.000'), GUARD)).toBe(5_000);
  });

  it('does not hold from 5 seconds after the wipe', () => {
    expect(holdMs(WIPE_PLUS_5, GUARD)).toBe(0);
    expect(holdMs(at('10:30:00.000'), GUARD)).toBe(0);
  });

  it('never holds with a guard of 0', () => {
    expect(holdMs(at('09:59:59.999'), 0)).toBe(0);
    expect(holdMs(at('10:00:00.000'), 0)).toBe(0);
  });

  it('does not hold late in the day, far from the next wipe', () => {
    expect(holdMs(at('23:59:00.000'), GUARD)).toBe(0);
  });

  it('looks across midnight to the next day when the guard is long', () => {
    const now = at('23:59:00.000');
    const long = 11 * 3_600_000;
    expect(now + holdMs(now, long)).toBe(Date.parse('2026-11-11T10:00:05Z'));
  });
});
