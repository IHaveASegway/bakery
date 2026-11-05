import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, placeOrder } from '../src/lib/api';
import { describeOrderError } from '../src/lib/order-errors';
import {
  blockerText,
  dateLabel,
  dateOfStart,
  freeText,
  horizonDates,
  pickable,
  pickupChoices,
  slotConflict,
  startText,
  windowChoices,
} from '../src/lib/schedule';
import { businessTime } from '../src/lib/slots';
import { fakeFetch, json, problem, scheduleFor } from './support';

// Saturday 2026-11-07, 08:07 in Salt Lake City (standard time).
const SATURDAY = Date.UTC(2026, 10, 7, 15, 7, 0);
const DAY = '2026-11-07';
const ctx = { nowMs: SATURDAY, leadMinutes: 0, baked: true };

let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

describe('the days on offer', () => {
  test('are seven bakery dates from business today', () => {
    expect(horizonDates(SATURDAY)).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
  });

  test('business time near midnight can be a day ahead of the wall clock date', () => {
    // 23:30 Mountain on the 7th is the 8th in UTC; the bakery day is still the 7th.
    expect(horizonDates(Date.UTC(2026, 10, 8, 6, 30, 0))[0]).toBe('2026-11-07');
  });

  test('a day reads as its weekday and date', () => {
    expect(dateLabel('2026-11-07')).toBe('Saturday 2026-11-07');
    expect(startText('2026-11-07T10:15:00-07:00')).toBe('10:15 am on Saturday 2026-11-07');
    expect(dateOfStart('2026-11-07T10:15:00-07:00')).toBe('2026-11-07');
    expect(dateOfStart('not a time')).toBe('');
  });
});

describe('pickup choices', () => {
  test('are the 32 slots with the free count the API gave', () => {
    const choices = pickupChoices(scheduleFor(DAY, { taken: { '09:00': 2 } }), ctx);
    expect(choices).toHaveLength(32);
    expect(choices[0]?.label).toBe('7:00 am');
    expect(choices[31]?.label).toBe('2:45 pm');
    const nine = choices.find((c) => c.label === '9:00 am');
    expect(nine?.free).toBe(4);
    expect(freeText(nine!)).toBe('4 free');
  });

  test('a full slot is greyed out and cannot be picked', () => {
    const choices = pickupChoices(scheduleFor(DAY, { taken: { '10:00': 6 } }), ctx);
    const full = choices.find((c) => c.label === '10:00 am');
    expect(full?.blocked).toBe('full');
    expect(pickable(full!)).toBe(false);
    expect(freeText(full!)).toBe('full');
    expect(blockerText('full')).toBe('full');
    expect(choices.filter((c) => c.blocked !== null).length).toBeGreaterThan(0);
    expect(choices.find((c) => c.label === '10:15 am')?.blocked).toBeNull();
  });

  test('a slot sooner than the cart’s lead time is greyed out, a hint the API can still overrule', () => {
    // 08:07 now and a 48 h cake: nothing before 08:07 on the 9th is offered.
    const cake = { ...ctx, leadMinutes: 48 * 60 };
    const today = pickupChoices(scheduleFor(DAY), cake);
    expect(today.every((c) => c.blocked === 'lead')).toBe(true);
    const monday = pickupChoices(scheduleFor('2026-11-09'), cake);
    expect(monday.find((c) => c.label === '8:00 am')?.blocked).toBe('lead');
    const tuesday = pickupChoices(scheduleFor('2026-11-10'), cake);
    expect(tuesday.every((c) => c.blocked === null)).toBe(true);
    // The hint does not forbid; only the API's own refusals do.
    expect(pickable(today[0]!)).toBe(true);
  });

  test('a lead time is measured to the minute', () => {
    const noon = pickupChoices(scheduleFor(DAY), { ...ctx, leadMinutes: 240 });
    // 08:07 + 4 h = 12:07, so 12:00 is too soon and 12:15 is not.
    expect(noon.find((c) => c.label === '12:00 pm')?.blocked).toBe('lead');
    expect(noon.find((c) => c.label === '12:15 pm')?.blocked).toBeNull();
  });

  test('a closed day and a day the cart is not baked are greyed out whole', () => {
    expect(
      pickupChoices(scheduleFor('2026-11-09', { open: false }), ctx).every(
        (c) => c.blocked === 'closed',
      ),
    ).toBe(true);
    expect(
      pickupChoices(scheduleFor(DAY), { ...ctx, baked: false }).every(
        (c) => c.blocked === 'not-baked',
      ),
    ).toBe(true);
    expect(blockerText('closed')).toBe('closed');
    expect(blockerText('not-baked')).toBe('not baked that day');
    expect(blockerText('lead')).toBe('too soon');
  });

  test('summer slots keep the API’s offset in the value that is sent', () => {
    const july = pickupChoices(scheduleFor('2026-07-14', { offset: '-06:00' }), {
      nowMs: Date.UTC(2026, 6, 14, 14, 0, 0),
      leadMinutes: 0,
      baked: true,
    });
    expect(july[31]?.start).toBe('2026-07-14T14:45:00-06:00');
    expect(july[31]?.label).toBe('2:45 pm');
    expect(businessTime(july[31]!.ms)).toBe(july[31]?.start);
  });
});

describe('delivery choices', () => {
  test('are the zone’s three windows, sharing the zone’s stops', () => {
    const choices = windowChoices(scheduleFor(DAY, { zoneTaken: 18 }), 'z2', ctx);
    expect(choices.map((c) => c.label)).toEqual([
      '9:00 am to 11:00 am',
      '11:00 am to 1:00 pm',
      '1:00 pm to 3:00 pm',
    ]);
    expect(choices.every((c) => c.free === 2 && c.capacity === 20)).toBe(true);
  });

  test('all three are full together when the zone’s stops are spent', () => {
    const choices = windowChoices(scheduleFor(DAY, { zoneTaken: 20 }), 'z1', ctx);
    expect(choices.every((c) => c.blocked === 'full')).toBe(true);
  });

  test('a window already started is too soon', () => {
    const choices = windowChoices(scheduleFor(DAY), 'z1', {
      ...ctx,
      nowMs: Date.UTC(2026, 10, 7, 16, 30, 0), // 09:30
    });
    expect(choices[0]?.blocked).toBe('lead');
    expect(choices[1]?.blocked).toBeNull();
  });
});

describe('a slot that filled first', () => {
  const ORDER = {
    kind: 'pickup' as const,
    slot: '2026-11-07T10:00:00-07:00',
    lines: [{ variant: 'croissant/each', qty: 1 }],
  };

  test('409 slot-full brings the next free slot the problem names', async () => {
    fake = fakeFetch([
      problem(409, 'slot-full', 'That slot is full', {
        detail: 'slot-full: the next free start is 10:15',
        next_free: '2026-11-07T10:15:00-07:00',
      }),
    ]);
    const error = await placeOrder('01JC8YV2D4QK7S1M9E3PZ6W8AN', ORDER, 'K1').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const conflict = slotConflict(error);
    expect(conflict).toEqual({ next_free: '2026-11-07T10:15:00-07:00' });
    expect(startText(conflict!.next_free!)).toBe('10:15 am on Saturday 2026-11-07');
    // The order itself still sends `slot` as before.
    expect(fake.calls[0]?.body).toMatchObject({ slot: '2026-11-07T10:00:00-07:00' });
  });

  test('when nothing later that day is free the conflict has no next slot', async () => {
    fake = fakeFetch([problem(409, 'slot-full', 'That slot is full')]);
    const error = await placeOrder('01JC8YV2D4QK7S1M9E3PZ6W8AN', ORDER, 'K2').catch(
      (e: unknown) => e,
    );
    expect(slotConflict(error)).toEqual({ next_free: null });
  });

  test('item-cap and other 409s are not a slot conflict, and say what the API said', async () => {
    fake = fakeFetch([
      problem(409, 'item-cap', 'Sold out for that day', {
        detail: 'item-cap: croissant has 2 left that day',
      }),
    ]);
    const error = await placeOrder('01JC8YV2D4QK7S1M9E3PZ6W8AN', ORDER, 'K3').catch(
      (e: unknown) => e,
    );
    expect(slotConflict(error)).toBeNull();
    expect(describeOrderError(error)).toEqual({
      title: 'Sold out for that day',
      detail: 'item-cap: croissant has 2 left that day',
    });
  });

  test('422 no-such-slot and closed-day get a sentence naming the rule', async () => {
    fake = fakeFetch([
      problem(422, 'order', 'Order refused', { detail: 'no-such-slot' }),
      problem(422, 'order', 'Order refused', { detail: 'closed-day' }),
    ]);
    const a = await placeOrder('01JC8YV2D4QK7S1M9E3PZ6W8AN', ORDER, 'K4').catch((e: unknown) => e);
    const b = await placeOrder('01JC8YV2D4QK7S1M9E3PZ6W8AN', ORDER, 'K5').catch((e: unknown) => e);
    expect(describeOrderError(a).detail).toMatch(/quarter hour/);
    expect(describeOrderError(b).detail).toMatch(/closed that day/);
    expect(slotConflict(a)).toBeNull();
  });

  test('a successful read of the day after the refusal shows the slot full', async () => {
    fake = fakeFetch([json(scheduleFor(DAY, { taken: { '10:00': 6 } }))]);
    const { getSchedule } = await import('../src/lib/api');
    const day = await getSchedule('01JC8YV2D4QK7S1M9E3PZ6W8AN', DAY);
    const full = pickupChoices(day, ctx).find((c) => c.start === ORDER.slot);
    expect(full?.blocked).toBe('full');
  });
});
