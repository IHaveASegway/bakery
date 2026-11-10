// The session reader: one request per page however many islands ask, a 401 that says "signed out"
// and a network failure that says nothing, the one browser hint, and the header link (audit C17, P2).
import { beforeEach, describe, expect, test, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('../src/lib/api', async () => {
  class ApiError extends Error {
    constructor(readonly status: number) {
      super('problem');
    }
  }
  class NetworkError extends Error {}
  return { ApiError, NetworkError, getSession: () => getSession() };
});

const api = await import('../src/lib/api');
const {
  SIGNED_IN_KEY,
  forgetSession,
  readSession,
  rememberedSignedIn,
  resetSessionForTests,
  sessionLink,
  watchSession,
} = await import('../src/lib/session');

const SESSION = { kind: 'demo', sandbox: null };
const unauthorized = () => new (api.ApiError as unknown as new (s: number) => Error)(401);

class Store {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

beforeEach(() => {
  getSession.mockReset();
  resetSessionForTests();
  vi.stubGlobal('localStorage', new Store());
});

describe('readSession', () => {
  test('many readers make one request and get the same answer', async () => {
    getSession.mockResolvedValue(SESSION);
    const [a, b, c] = await Promise.all([readSession(), readSession(), readSession()]);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(a).toBe(SESSION);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('many readers of a 401 make one request and all see the 401', async () => {
    getSession.mockRejectedValue(unauthorized());
    const results = await Promise.allSettled([readSession(), readSession()]);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  test('a session is remembered, and a 401 forgets it', async () => {
    getSession.mockResolvedValueOnce(SESSION);
    await readSession();
    expect(localStorage.getItem(SIGNED_IN_KEY)).toBe('1');
    expect(rememberedSignedIn()).toBe(true);

    resetSessionForTests();
    getSession.mockRejectedValueOnce(unauthorized());
    await readSession().catch(() => undefined);
    expect(rememberedSignedIn()).toBe(false);
  });

  test('a network failure changes neither the hint nor the listeners', async () => {
    localStorage.setItem(SIGNED_IN_KEY, '1');
    const heard = vi.fn();
    watchSession(heard);
    getSession.mockRejectedValue(new (api.NetworkError as unknown as new () => Error)());
    await readSession().catch(() => undefined);
    expect(heard).not.toHaveBeenCalled();
    expect(rememberedSignedIn()).toBe(true);
  });
});

describe('forgetSession', () => {
  test('signing out drops the hint, tells listeners, and lets the next look ask again', async () => {
    getSession.mockResolvedValue(SESSION);
    await readSession();
    const heard = vi.fn();
    watchSession(heard);
    forgetSession();
    expect(heard).toHaveBeenLastCalledWith(false);
    expect(rememberedSignedIn()).toBe(false);
    await readSession();
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});

describe('watchSession', () => {
  test('hears the answer whoever asked, and hears an earlier one at once', async () => {
    const early = vi.fn();
    watchSession(early);
    getSession.mockResolvedValue(SESSION);
    await readSession();
    expect(early).toHaveBeenCalledWith(true);

    const late = vi.fn();
    watchSession(late);
    expect(late).toHaveBeenCalledWith(true);
  });

  test('asks nothing itself', () => {
    watchSession(() => undefined);
    expect(getSession).not.toHaveBeenCalled();
  });

  test('blocked storage is not an error', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(rememberedSignedIn()).toBe(false);
    getSession.mockResolvedValue(SESSION);
    await expect(readSession()).resolves.toBe(SESSION);
  });
});

describe('sessionLink', () => {
  test('the same words with a session or without; only the address follows it (audit F14)', () => {
    expect(sessionLink(false, '/menu/')).toEqual({
      href: '/signin/',
      label: 'Your bakery',
      current: false,
    });
    expect(sessionLink(false, '/signin/').current).toBe(true);
    expect(sessionLink(true, '/menu/')).toEqual({
      href: '/app/',
      label: 'Your bakery',
      current: false,
    });
    expect(sessionLink(true, '/app/dispatch/').current).toBe(true);
  });
});
