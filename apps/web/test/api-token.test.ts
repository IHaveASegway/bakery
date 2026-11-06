// The console's API-token panel: the api helpers' exact requests, the panel's state machine, the
// plain words for a refusal, and that the token lives in memory only (docs/security.md, "The API
// token"). Fetch is faked, as in the other streams' tests. Tokens here are made up.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ApiToken from '../src/components/ApiToken';
import type { TokenInfoResponse, TokenResponse } from '../src/contracts';
import { ApiError, apiOrigin, getTokenInfo, issueToken, rotateToken } from '../src/lib/api';
import { INITIAL, describeTokenError, panelReduce } from '../src/lib/api-token';
import { KeyedAction } from '../src/lib/crm';
import { liveToken, tokenStore } from '../src/lib/token-store';
import { fakeFetch, json, problem } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const REPLAY = '01JC8Z6K3W9QF2N4T7XRB5M0HD';
const issued: TokenResponse = {
  token: 'eyJ2IjoxfQ.test-mac-0123456789abcdef',
  token_v: 1,
  issued_at: '2026-11-05T12:00:00.000Z',
  expires_at: '2026-11-06T12:00:00.000Z',
};
const info: TokenInfoResponse = {
  token_v: 1,
  issued_at: issued.issued_at,
  expires_at: issued.expires_at,
  masked: 'eyJ2Ij…cdef',
};
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

describe('the api helpers', () => {
  test('getTokenInfo is a GET of /token with the cookie and no key', async () => {
    fake = fakeFetch([json(info)]);
    expect(await getTokenInfo(SANDBOX)).toEqual(info);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/token`);
    expect(call?.method).toBe('GET');
    expect(call?.headers['Idempotency-Key']).toBeUndefined();
    expect(call?.headers['Authorization']).toBeUndefined();
    expect(call?.body).toBeUndefined();
  });

  test('issueToken is a POST of /token with a key of its own and no body', async () => {
    fake = fakeFetch([json(issued)]);
    expect(await issueToken(SANDBOX)).toEqual(issued);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/token`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['Idempotency-Key']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(call?.body).toBeUndefined();
  });

  test('rotateToken is a POST of /token/rotate, and a caller-named key is the one sent', async () => {
    fake = fakeFetch([json({ ...issued, token_v: 2 })]);
    expect((await rotateToken(SANDBOX, REPLAY)).token_v).toBe(2);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/token/rotate`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['Idempotency-Key']).toBe(REPLAY);
  });

  test('two clicks mint two keys; a retry after a dropped connection keeps its key', async () => {
    fake = fakeFetch([json(issued), json(issued), new Error('offline'), json(issued)]);
    const action = new KeyedAction();
    const send = (key: string) => issueToken(SANDBOX, key);
    await action.run('issue', send);
    await action.run('issue', send);
    await action.run('issue', send).catch(() => undefined);
    await action.run('issue', send);
    const keys = fake.calls.map((c) => c.headers['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
  });

  test('a guest’s 403 is an ApiError with the slug guest-scope, and a 404 is plain too', async () => {
    fake = fakeFetch([
      problem(403, 'guest-scope', 'Sign in for this'),
      problem(404, 'wiped', 'Gone'),
    ]);
    const guest = (await issueToken(SANDBOX).catch((e: unknown) => e)) as ApiError;
    expect(guest).toBeInstanceOf(ApiError);
    expect(guest.slug).toBe('guest-scope');
    const gone = (await getTokenInfo(SANDBOX).catch((e: unknown) => e)) as ApiError;
    expect(gone.status).toBe(404);
  });

  test('the response is never kept by the helpers: they return it and nothing else', async () => {
    const stored: string[] = [];
    vi.stubGlobal('localStorage', {
      setItem: (k: string, v: string) => stored.push(`${k}=${v}`),
      getItem: () => null,
    });
    fake = fakeFetch([json(issued)]);
    await issueToken(SANDBOX);
    vi.unstubAllGlobals();
    expect(stored).toEqual([]);
  });
});

describe('the panel’s state machine', () => {
  test('starts loading, and the first GET makes it ready', () => {
    expect(INITIAL.phase).toBe('loading');
    const ready = panelReduce(INITIAL, { type: 'loaded', info });
    expect(ready).toMatchObject({ phase: 'ready', info, revealed: null, error: null });
  });

  test('issuing shows the token once, with its masked form and a note that it was issued', () => {
    const busy = panelReduce(panelReduce(INITIAL, { type: 'loaded', info: { token_v: 0 } }), {
      type: 'begin',
    });
    expect(busy.phase).toBe('busy');
    const done = panelReduce(busy, { type: 'issued', how: 'issue', token: issued });
    expect(done.phase).toBe('ready');
    expect(done.revealed).toEqual(issued);
    expect(done.said).toBe('issued');
    expect(done.info).toEqual({
      token_v: 1,
      issued_at: issued.issued_at,
      expires_at: issued.expires_at,
      masked: 'eyJ2Ij…cdef',
    });
  });

  test('rotating replaces the revealed token and says it was a rotation', () => {
    const first = panelReduce(INITIAL, { type: 'issued', how: 'issue', token: issued });
    const second = panelReduce(first, {
      type: 'issued',
      how: 'rotate',
      token: { ...issued, token: 'eyJ2IjoyfQ.test-mac-fedcba9876543210', token_v: 2 },
    });
    expect(second.said).toBe('rotated');
    expect(second.info?.token_v).toBe(2);
    expect(second.revealed?.token).toContain('fedcba');
  });

  test('hiding forgets the token from the panel but keeps the masked form', () => {
    const shown = panelReduce(INITIAL, { type: 'issued', how: 'issue', token: issued });
    const hidden = panelReduce(shown, { type: 'hide' });
    expect(hidden.revealed).toBeNull();
    expect(hidden.info?.masked).toBe('eyJ2Ij…cdef');
    expect(JSON.stringify(hidden)).not.toContain(issued.token);
  });

  test('a failure keeps what is shown, and one before any answer is “failed”', () => {
    const error = { title: 'x', detail: null };
    expect(panelReduce(INITIAL, { type: 'failed', error }).phase).toBe('failed');
    const shown = panelReduce(INITIAL, { type: 'issued', how: 'issue', token: issued });
    const failed = panelReduce(panelReduce(shown, { type: 'begin' }), { type: 'failed', error });
    expect(failed.phase).toBe('ready');
    expect(failed.revealed).toEqual(issued);
    expect(failed.error).toEqual(error);
  });

  test('copy results are recorded and cleared by the next begin', () => {
    const copied = panelReduce(INITIAL, { type: 'copied', ok: true });
    expect(copied.copy).toBe('copied');
    expect(panelReduce(copied, { type: 'copied', ok: false }).copy).toBe('failed');
    expect(panelReduce(copied, { type: 'begin' }).copy).toBeNull();
  });
});

describe('plain words for a refusal', () => {
  const err = (status: number, slug: string) =>
    new ApiError(
      {
        status,
        type: `https://bakery.example.test/problems/${slug}`,
        title: 'T',
        detail: null,
        next_free: null,
      },
      null,
    );

  test('a guest is told to sign in', () => {
    expect(describeTokenError(err(403, 'guest-scope')).title).toBe(
      'Tokens are for signed-in sandboxes',
    );
  });

  test('a 404 and a 410 say the sandbox was not found', () => {
    expect(describeTokenError(err(404, 'wiped')).title).toBe('The sandbox was not found');
    expect(describeTokenError(err(410, 'wiped')).title).toBe('The sandbox was not found');
  });

  test('another 403 is not mistaken for a guest, and anything else uses the console’s wording', () => {
    expect(describeTokenError(err(403, 'origin')).title).toBe('The API refused the request');
    expect(describeTokenError(err(429, 'rate-limit')).title).toBe('T');
    expect(describeTokenError(new Error('x')).title).toBe('Something went wrong');
  });
});

describe('the token lives in memory only', () => {
  beforeEach(() => tokenStore.clear());

  test('set, get and clear, and subscribers hear each change', () => {
    const heard = vi.fn();
    const off = tokenStore.subscribe(heard);
    expect(tokenStore.get()).toBeNull();
    tokenStore.set(issued);
    expect(tokenStore.get()).toEqual(issued);
    tokenStore.clear();
    tokenStore.clear();
    off();
    tokenStore.set(issued);
    expect(heard).toHaveBeenCalledTimes(2);
    tokenStore.clear();
  });

  test('an expired token is not offered to the tour', () => {
    tokenStore.set(issued);
    expect(liveToken(Date.parse('2026-11-05T13:00:00.000Z'))).toBe(issued.token);
    expect(liveToken(Date.parse('2026-11-06T12:00:00.000Z'))).toBeNull();
    tokenStore.clear();
    expect(liveToken(0)).toBeNull();
  });

  test('no source file in the storefront writes the token to storage, a cookie or a URL', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      '../src/lib/token-store.ts',
      '../src/lib/api-token.ts',
      '../src/components/ApiToken.tsx',
    ]) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(
        /localStorage|sessionStorage|document\.cookie|indexedDB|history\.(push|replace)State/,
      );
    }
  });
});

describe('the panel drawn', () => {
  test('a guest sees both buttons off and the guest note, and makes no request', () => {
    fake = fakeFetch([]);
    const html = renderToStaticMarkup(
      createElement(ApiToken, { sandboxId: SANDBOX, isGuest: true }),
    );
    expect(html).toContain('data-tour="console-token"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Sign in to use the console');
    expect(html).not.toContain('Copy token');
    expect(fake.calls).toEqual([]);
  });

  test('a signed-in panel starts with the buttons off while it loads, and shows no token', () => {
    const html = renderToStaticMarkup(
      createElement(ApiToken, { sandboxId: SANDBOX, isGuest: false }),
    );
    expect(html).toContain('none issued');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Issue token');
    expect(html).toContain('Rotate');
    expect(html).not.toContain('eyJ');
    expect(html).toContain('Authorization: Bearer');
  });
});
