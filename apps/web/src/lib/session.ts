// The one place a page asks the API who the visitor is. `GET /v1/session` answers 401 for a visitor
// with no session, and the browser logs every 401 in the console, so a page that asks once logs at
// most one. Every island that needs the session reads it here (use-session.ts, the header link),
// and they share a single request for the life of the page.
import type { SessionResponse } from '../contracts';
import { ApiError, getSession } from './api';

let probe: Promise<SessionResponse> | null = null;
let known: boolean | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

/** The one browser-side hint that a session exists, so a page with no other reason to ask can. */
export const SIGNED_IN_KEY = 'bakery.signed-in';

type Flag = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function localFlag(): Flag | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser last saw a session. A hint only: the API's answer is the truth. */
export function rememberedSignedIn(store: Flag | null = localFlag()): boolean {
  try {
    return store?.getItem(SIGNED_IN_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(signedIn: boolean, store: Flag | null = localFlag()): void {
  try {
    if (signedIn) store?.setItem(SIGNED_IN_KEY, '1');
    else store?.removeItem(SIGNED_IN_KEY);
  } catch {
    // Private windows and blocked site data: the header then follows the page's own look only.
  }
}

function settle(signedIn: boolean): void {
  known = signedIn;
  remember(signedIn);
  for (const listener of listeners) listener(signedIn);
}

/**
 * The visitor's session, asked once per page however many islands ask. The promise rejects as
 * `getSession` does (an ApiError for 401, a NetworkError offline); every caller gets the same one.
 */
export function readSession(): Promise<SessionResponse> {
  return probe ?? refreshSession();
}

/**
 * A new look, for a screen that changes the session itself and must see the change (the console
 * after it makes a sandbox). It becomes the page's shared answer, so the header follows it too.
 */
export function refreshSession(): Promise<SessionResponse> {
  const asked = getSession();
  probe = asked;
  asked.then(
    () => settle(true),
    (error: unknown) => {
      // Only a 401 says there is no session; a network failure says nothing either way.
      if (error instanceof ApiError && error.status === 401) settle(false);
    },
  );
  return asked;
}

/**
 * Tells `listener` whether there is a session, once the page has asked (now if it already has),
 * without asking itself. Returns the function that stops listening.
 */
export function watchSession(listener: (signedIn: boolean) => void): () => void {
  if (known !== null) listener(known);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The header's session link: where it goes and what it says, for a visitor on `pathname`. */
export function sessionLink(
  signedIn: boolean,
  pathname: string,
): { href: string; label: string; current: boolean } {
  const href = signedIn ? '/app/' : '/signin/';
  return {
    href,
    label: signedIn ? 'Console' : 'Sign in',
    current: pathname === href || pathname.startsWith(href),
  };
}

/** The visitor has just signed out: drop the page's answer and the browser's hint. */
export function forgetSession(): void {
  probe = null;
  settle(false);
}

/** For tests: forget the page's one look. */
export function resetSessionForTests(): void {
  probe = null;
  known = null;
  listeners.clear();
}
