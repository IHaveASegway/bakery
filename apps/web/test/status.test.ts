// The status page: the response as the page reads it, the three states in words, the kept answer
// when the API cannot be reached, the one storage key and its failures, the poller that stops while
// the page is hidden, and the page drawn once. Synthetic numbers only.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { StatusView } from '../src/components/Status';
import {
  STORAGE_KEY,
  browserStorage,
  createPoller,
  formatTime,
  loadSnapshot,
  readStatus,
  saveSnapshot,
  stateLabel,
  stateWords,
  unreachableWords,
  type Model,
  type StatusData,
} from '../src/lib/status';

const BASE = {
  day: '2026-11-06',
  demo_account_cap: 100,
  demo_accounts_today: 7,
  flag: 'live',
  guest_cap: 200,
  guests_today: 31,
  sandbox_cap: 300,
  sandboxes_today: 42,
};
const COUNTERS = {
  orders_24h: 18,
  payments_24h: 15,
  payment_failures_24h: 2,
  refunds_24h: 1,
  sandboxes_24h: 44,
  dlq_24h: 0,
  last_wipe: { at: '2026-11-06T10:00:09Z', sandboxes: 40, objects: 612, ms: 845 },
};
const wire = (extra: Record<string, unknown> = {}) => ({
  ...BASE,
  counters: COUNTERS,
  counters_as_of: '2026-11-06T14:15:00Z',
  counters_state: 'live',
  ...extra,
});
const data = (extra: Record<string, unknown> = {}) => readStatus(wire(extra)) as StatusData;

const html = (model: Model) => renderToStaticMarkup(createElement(StatusView, { model }));
const answered = (d: StatusData): Model => ({
  kind: 'answered',
  data: d,
  fetchedAt: '2026-11-06T14:20:00.000Z',
});

class MemoryStore {
  items = new Map<string, string>();
  getItem = (k: string) => this.items.get(k) ?? null;
  setItem = (k: string, v: string) => void this.items.set(k, v);
}

describe('readStatus', () => {
  test('reads a full response', () => {
    const d = data();
    expect(d.counters?.orders_24h).toBe(18);
    expect(d.counters_state).toBe('live');
    expect(d.counters?.last_wipe?.objects).toBe(612);
  });

  test('a response from before the counters existed is "unavailable", never zeros', () => {
    const d = readStatus(BASE)!;
    expect(d.counters).toBeNull();
    expect(d.counters_state).toBe('unavailable');
    expect(d.counters_as_of).toBeNull();
  });

  test('malformed counters read as unavailable; an unknown state reads as stale', () => {
    expect(data({ counters: { orders_24h: 'many' } }).counters_state).toBe('unavailable');
    expect(data({ counters_state: 'fine' }).counters_state).toBe('stale');
  });

  test('a null last wipe stays null; things that are not a response are refused', () => {
    expect(data({ counters: { ...COUNTERS, last_wipe: null } }).counters?.last_wipe).toBeNull();
    for (const bad of [null, 'x', [], {}, { ...BASE, sandboxes_today: -1 }]) {
      expect(readStatus(bad)).toBeNull();
    }
  });
});

describe('the words', () => {
  test('a time is absolute, in UTC', () => {
    expect(formatTime('2026-11-06T14:15:00Z')).toBe('2026-11-06 14:15 UTC');
    expect(formatTime('nonsense')).toBe('an unknown time');
  });

  test('each state has its own label and sentence', () => {
    expect(stateLabel('live')).toBe('Live.');
    expect(stateLabel('stale')).toBe('Older than it should be.');
    expect(stateLabel('unavailable')).toBe('Not available yet.');
    expect(stateWords('live', '2026-11-06T14:15:00Z')).toContain('2026-11-06 14:15 UTC');
    expect(stateWords('stale', '2026-11-06T09:00:00Z')).toContain('last refresh');
    expect(stateWords('unavailable', null)).toContain('every 15 minutes');
  });

  test('the unreachable sentence names the kept answer’s time, or says there is none', () => {
    expect(unreachableWords({ fetchedAt: '2026-11-06T14:20:00Z' })).toBe(
      'The API is unreachable. This is the last answer this browser saw, from 2026-11-06 14:20 UTC.',
    );
    expect(unreachableWords(null)).toContain('no earlier answer');
  });
});

describe('the page, drawn', () => {
  test('live: the state, the sandboxes against the cap, the counters with their time and the wipe', () => {
    const out = html(answered(data()));
    expect(out).toContain('<strong>Live.</strong>');
    expect(out).toContain('42 of 300');
    expect(out).toContain('<progress value="42" max="300">');
    expect(out).toContain('<dt>Orders placed</dt><dd>18</dd>');
    expect(out).toContain('<dt>Payments failed</dt><dd>2</dd>');
    expect(out).toContain('As of 2026-11-06 14:15 UTC');
    expect(out).toContain('2026-11-06 10:00 UTC: 40 sandboxes and 612 objects deleted in 845 ms.');
    expect(out).not.toContain('unreachable');
  });

  test('stale: says the numbers are older than they should be, and shows them', () => {
    const out = html(
      answered(data({ counters_state: 'stale', counters_as_of: '2026-11-06T09:00:00Z' })),
    );
    expect(out).toContain('<strong>Older than it should be.</strong>');
    expect(out).toContain('from 2026-11-06 09:00 UTC');
    expect(out).toContain('<dd>18</dd>');
  });

  test('unavailable: says so, shows the sandboxes, and no counter', () => {
    const out = html(answered(readStatus(BASE)!));
    expect(out).toContain('<strong>Not available yet.</strong>');
    expect(out).toContain('42 of 300');
    expect(out).toContain('No counters yet.');
    expect(out).not.toContain('<dt>');
  });

  test('loading says it is asking', () => {
    expect(html({ kind: 'loading' })).toContain('Asking the API…');
  });

  test('unreachable with a kept answer: the sentence, the kept numbers and their time', () => {
    const out = html({
      kind: 'unreachable',
      cached: { data: data(), fetchedAt: '2026-11-06T14:20:00.000Z' },
    });
    expect(out).toContain('<strong>Unreachable.</strong>');
    expect(out).toContain('The API is unreachable. This is the last answer this browser saw');
    expect(out).toContain('2026-11-06 14:20 UTC');
    expect(out).toContain('<dt>Orders placed</dt><dd>18</dd>');
    expect(out).toContain('As of 2026-11-06 14:15 UTC');
  });

  test('unreachable with nothing kept: the sentence and no numbers', () => {
    const out = html({ kind: 'unreachable', cached: null });
    expect(out).toContain('no earlier answer');
    expect(out).not.toContain('<dt>');
    expect(out).not.toContain('<progress');
  });

  test('says what the counters are and that they are about no visitor', () => {
    const out = html({ kind: 'loading' });
    expect(out).toContain('last 24 hours across every sandbox');
    expect(out).toContain('They say nothing about any visitor');
  });
});

describe('the kept answer', () => {
  test('is saved under one key and read back', () => {
    const store = new MemoryStore();
    expect(saveSnapshot(store, data(), '2026-11-06T14:20:00.000Z')).toBe(true);
    expect([...store.items.keys()]).toEqual([STORAGE_KEY]);
    const back = loadSnapshot(store)!;
    expect(back.fetchedAt).toBe('2026-11-06T14:20:00.000Z');
    expect(back.data.counters?.orders_24h).toBe(18);
  });

  test('a store that throws, is missing or holds junk gives nothing and breaks nothing', () => {
    const closed = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(saveSnapshot(closed, data(), '2026-11-06T14:20:00Z')).toBe(false);
    expect(loadSnapshot(closed)).toBeNull();
    expect(saveSnapshot(null, data(), '2026-11-06T14:20:00Z')).toBe(false);
    expect(loadSnapshot(null)).toBeNull();
    for (const junk of ['{', '[]', '{"fetchedAt":"x"}', '{"fetchedAt":"2026-11-06T14:20:00Z"}']) {
      const store = new MemoryStore();
      store.setItem(STORAGE_KEY, junk);
      expect(loadSnapshot(store)).toBeNull();
    }
  });

  test('browserStorage is null when the browser refuses or has none', () => {
    expect(browserStorage()).toBeNull(); // node: no localStorage
    vi.stubGlobal('localStorage', undefined);
    expect(browserStorage()).toBeNull();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(browserStorage()).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('the cached path: a failing fetch delivers null, and the kept answer is what the page shows', async () => {
    const store = new MemoryStore();
    saveSnapshot(store, data(), '2026-11-06T14:20:00.000Z');
    const delivered: unknown[] = [];
    const poller = createPoller({
      load: () => Promise.reject(new Error('offline')),
      deliver: (raw) => delivered.push(raw),
      visible: () => true,
      every: () => 1,
      cancel: () => undefined,
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual([null]);
    const model: Model = { kind: 'unreachable', cached: loadSnapshot(store) };
    expect(html(model)).toContain('The API is unreachable');
    expect(html(model)).toContain('<dd>18</dd>');
  });
});

describe('the poller', () => {
  const rig = (visible = true) => {
    const state = { visible, timers: new Map<number, () => void>(), next: 1 };
    const load = vi.fn(() => Promise.resolve(wire()));
    const deliver = vi.fn();
    const poller = createPoller({
      load,
      deliver,
      visible: () => state.visible,
      every: (run) => {
        state.timers.set(state.next, run);
        return state.next++;
      },
      cancel: (h) => void state.timers.delete(h as number),
    });
    return { state, load, deliver, poller };
  };

  test('looks on load and then on every tick', async () => {
    const { state, load, deliver, poller } = rig();
    poller.start();
    expect(load).toHaveBeenCalledTimes(1);
    [...state.timers.values()][0]!();
    expect(load).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test('uses a sixty-second interval by default', () => {
    const every = vi.fn(() => 1);
    createPoller({
      load: () => Promise.resolve(null),
      deliver: () => undefined,
      visible: () => true,
      every,
      cancel: () => undefined,
    }).start();
    expect(every).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  test('stops while hidden and looks at once when shown again', () => {
    const { state, load, poller } = rig();
    poller.start();
    expect(poller.running).toBe(true);
    state.visible = false;
    poller.visibilityChanged();
    expect(poller.running).toBe(false);
    expect(state.timers.size).toBe(0);
    state.visible = true;
    poller.visibilityChanged();
    expect(load).toHaveBeenCalledTimes(2);
    expect(state.timers.size).toBe(1);
    poller.visibilityChanged(); // already running: no second timer, no extra look
    expect(load).toHaveBeenCalledTimes(2);
    expect(state.timers.size).toBe(1);
  });

  test('a page opened hidden does not look until it is shown', () => {
    const { state, load, poller } = rig(false);
    poller.start();
    expect(load).not.toHaveBeenCalled();
    state.visible = true;
    poller.visibilityChanged();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('after stop, an answer in flight is dropped and nothing restarts', async () => {
    const { state, deliver, poller, load } = rig();
    poller.start();
    poller.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    poller.visibilityChanged();
    expect(load).toHaveBeenCalledTimes(1);
    expect(state.timers.size).toBe(0);
  });
});
