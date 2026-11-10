// The guide's reader of the flight recorder (src/lib/recorder.ts): the panel's fallback when the
// recorder's socket is refused, as on a preview whose Origin is not the API's. The socket and the
// read are stand-ins; no network.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reads: number[] = [];
vi.mock('../src/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  getTrace: (_id: string, after: number) => {
    reads.push(after);
    return Promise.resolve({ hops: [], cursor: after, more: false, missed: false });
  },
  traceSocketUrl: (id: string) => `wss://api.example.test/v1/sandboxes/${id}/trace/ws`,
}));

/** A socket the server refuses: it closes without ever opening, as a refused upgrade does. */
class RefusedSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  constructor() {
    setTimeout(() => this.onclose?.(), 0);
  }
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  reads.length = 0;
  vi.stubGlobal('WebSocket', RefusedSocket);
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the recorder panel when its socket is refused', () => {
  test('it reads instead, says so, and stops reading when the panel closes', async () => {
    const { PANEL_POLL_MS, recorderState, tailForPanel } = await import('../src/lib/recorder');
    const stop = tailForPanel('sbx-one');
    await vi.advanceTimersByTimeAsync(0);
    expect(recorderState.get().panel).toBe('polling');
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 2);
    expect(reads).toHaveLength(3);
    stop();
    expect(recorderState.get().panel).toBe('off');
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 3);
    expect(reads).toHaveLength(3);
  });

  test('a note reads on time three times, then late until about 30 s, and stops at the first read that saw everything', async () => {
    const { NOTE_READS_MS, NOTE_READS_ON_TIME, followWrite } = await import('../src/lib/recorder');
    const { recorderSource } = await import('../src/lib/trace');
    // How far the reads got is told to the trace store, on the write's own trace.
    const said = new Map<string, string>();
    recorderSource.connect({
      record: (e) => {
        if (e.kind === 'reads') said.set(e.key, e.state);
      },
    });
    let seen = false;
    const done = followWrite('sbx-two', 'cause-two', () => seen);
    await vi.advanceTimersByTimeAsync(NOTE_READS_MS[0]);
    expect(reads).toHaveLength(1);
    seen = true;
    await vi.advanceTimersByTimeAsync(NOTE_READS_MS[1]);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toHaveLength(2);
    reads.length = 0;
    expect(said.get('cause-two')).toBe('done');
    const never = followWrite('sbx-three', 'cause-three', () => false);
    const onTime = NOTE_READS_MS.slice(0, NOTE_READS_ON_TIME).reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(onTime);
    expect(reads).toHaveLength(NOTE_READS_ON_TIME);
    // Not seen in the first three reads: late, and still listened for.
    expect(said.get('cause-three')).toBe('late');
    await vi.advanceTimersByTimeAsync(40_000);
    await never;
    expect(reads).toHaveLength(NOTE_READS_MS.length);
    expect(NOTE_READS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(31_000);
    expect(said.get('cause-three')).toBe('done');
  });
});
