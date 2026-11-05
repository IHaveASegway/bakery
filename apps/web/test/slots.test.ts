import { describe, expect, test } from 'vitest';
import { dayAccepts, leadMinutesFor } from '../src/lib/cart';
import { STATIC_MENU, findVariant } from '../src/lib/menu';
import {
  businessTime,
  byDate,
  deliveryWindows,
  firstQuarter,
  mountainLocal,
  mountainOffsetMinutes,
  mountainToMs,
  pickupSlots,
} from '../src/lib/slots';

// Thursday 2026-11-05, 10:07 in Salt Lake City (standard time, UTC-7).
const THURSDAY = Date.UTC(2026, 10, 5, 17, 7, 0);
const accept = dayAccepts(STATIC_MENU, []);

describe('the Mountain offset', () => {
  test('is -07:00 in standard time and -06:00 in summer', () => {
    expect(mountainOffsetMinutes(THURSDAY)).toBe(-420);
    expect(mountainOffsetMinutes(Date.UTC(2026, 6, 1, 16, 0, 0))).toBe(-360);
  });

  test('a business time is written with its offset', () => {
    expect(businessTime(THURSDAY)).toBe('2026-11-05T10:07:00-07:00');
    expect(businessTime(Date.UTC(2026, 6, 1, 16, 0, 0))).toBe('2026-07-01T10:00:00-06:00');
  });

  test('the clock change days keep the wall time the visitor chose', () => {
    // 2026-03-08 springs forward and 2026-11-01 falls back; 07:00 is after both changes.
    expect(businessTime(mountainToMs('2026-03-08', 7 * 60))).toBe('2026-03-08T07:00:00-06:00');
    expect(businessTime(mountainToMs('2026-11-01', 7 * 60))).toBe('2026-11-01T07:00:00-07:00');
  });
});

describe('pickup slots', () => {
  test('start at the next quarter hour after now plus the lead time', () => {
    expect(businessTime(firstQuarter(THURSDAY, 0))).toBe('2026-11-05T10:15:00-07:00');
    expect(businessTime(firstQuarter(THURSDAY, 120))).toBe('2026-11-05T12:15:00-07:00');
    // Exactly on a quarter is not "the next" one.
    expect(businessTime(firstQuarter(Date.UTC(2026, 10, 5, 17, 15, 0), 0))).toBe(
      '2026-11-05T10:30:00-07:00',
    );
  });

  test('all fall on the quarter hour, inside 07:00 to 14:45 Mountain', () => {
    const slots = pickupSlots(THURSDAY, { leadMinutes: 0, accept });
    expect(slots.length).toBeGreaterThan(30);
    expect(slots[0]?.value).toBe('2026-11-05T10:15:00-07:00');
    for (const slot of slots) {
      const l = mountainLocal(slot.ms);
      expect(l.minute % 15).toBe(0);
      expect(l.hour * 60 + l.minute).toBeGreaterThanOrEqual(7 * 60);
      expect(l.hour * 60 + l.minute).toBeLessThanOrEqual(14 * 60 + 45);
    }
  });

  test('the same wall time gets the summer offset in summer', () => {
    const slots = pickupSlots(Date.UTC(2026, 6, 1, 16, 0, 0), { leadMinutes: 0, accept });
    expect(slots[0]?.value).toBe('2026-07-01T10:15:00-06:00');
  });

  test('Mondays are closed: no slot falls on one', () => {
    const slots = pickupSlots(THURSDAY, { leadMinutes: 0, accept, days: 14 });
    expect(slots.some((s) => s.weekday === 'tue')).toBe(true);
    expect(slots.some((s) => s.weekday === 'mon')).toBe(false);
    expect(slots.some((s) => s.date === '2026-11-09')).toBe(false);
  });

  test('after Sunday closes the next slot is Tuesday at 07:00', () => {
    const sundayLate = Date.UTC(2026, 10, 8, 21, 50, 0); // Sunday 14:50 Mountain
    const slots = pickupSlots(sundayLate, { leadMinutes: 0, accept });
    expect(slots[0]?.value).toBe('2026-11-10T07:00:00-07:00');
  });

  test('a cart item keeps the slots to the days it is baked', () => {
    const cart = [{ variant: 'seeded-rye/whole', qty: 1 }];
    const rye = findVariant(STATIC_MENU, 'seeded-rye/whole')!.item;
    const slots = pickupSlots(THURSDAY, {
      leadMinutes: leadMinutesFor(cart, STATIC_MENU),
      accept: dayAccepts(STATIC_MENU, cart),
      days: 10,
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => rye.days_baked.includes(s.weekday))).toBe(true);
    expect(rye.days_baked).not.toContain('tue');
  });

  test('a cake pushes the first slot out by 48 hours', () => {
    const cart = [{ variant: 'chocolate-layer-cake/6-inch', qty: 1 }];
    const found = findVariant(STATIC_MENU, cart[0]!.variant);
    expect(found?.variant.lead_minutes).toBe(2880);
    const slots = pickupSlots(THURSDAY, {
      leadMinutes: leadMinutesFor(cart, STATIC_MENU),
      accept: dayAccepts(STATIC_MENU, cart),
      days: 10,
    });
    expect(slots[0]!.ms - THURSDAY).toBeGreaterThanOrEqual(2880 * 60_000);
  });

  test('groups by calendar date, in order', () => {
    const groups = byDate(pickupSlots(THURSDAY, { leadMinutes: 0, accept }));
    expect(groups[0]?.date).toBe('2026-11-05');
    expect(groups.map((g) => g.date)).toEqual([...groups.map((g) => g.date)].sort());
  });
});

describe('delivery windows', () => {
  test('start at 09:00, 11:00 and 13:00 and are two hours long', () => {
    const windows = deliveryWindows(THURSDAY, { leadMinutes: 0, accept });
    expect(windows[0]?.value).toBe('2026-11-05T11:00:00-07:00');
    expect(windows[0]?.label).toBe('11:00 am to 1:00 pm');
    expect(windows[1]?.value).toBe('2026-11-05T13:00:00-07:00');
    expect(windows[2]?.value).toBe('2026-11-06T09:00:00-07:00');
    expect(windows.every((w) => [9, 11, 13].includes(mountainLocal(w.ms).hour))).toBe(true);
  });

  test('skip Mondays and respect the lead time', () => {
    const windows = deliveryWindows(THURSDAY, { leadMinutes: 12 * 60, accept, days: 14 });
    expect(windows.some((w) => w.weekday === 'mon')).toBe(false);
    expect(windows[0]!.ms - THURSDAY).toBeGreaterThan(12 * 60 * 60_000);
  });
});
