// The console's API-token panel as a state machine (docs/security.md, "The API token"): what it
// shows after each answer. The token is in `revealed` only until the visitor hides it, and in
// lib/token-store.ts (memory) for the tour's curl examples; this state is never persisted.
import type { TokenInfoResponse, TokenResponse } from '../contracts';
import { ApiError } from './api';
import { describeError, type Message } from './messages';
import { maskToken } from './tour';

export interface PanelState {
  /** `loading` until the first GET answers; `busy` while an issue or a rotate is out. */
  phase: 'loading' | 'ready' | 'busy' | 'failed';
  info: TokenInfoResponse | null;
  /** The token as issued, shown once; null once hidden or before the first issue. */
  revealed: TokenResponse | null;
  /** What the last successful action did, so the panel can say what it means. */
  said: 'issued' | 'rotated' | null;
  /** The last copy attempt. */
  copy: 'copied' | 'failed' | null;
  error: Message | null;
}

export const INITIAL: PanelState = {
  phase: 'loading',
  info: null,
  revealed: null,
  said: null,
  copy: null,
  error: null,
};

export type PanelAction =
  | { type: 'loaded'; info: TokenInfoResponse }
  | { type: 'failed'; error: Message }
  | { type: 'begin' }
  | { type: 'issued'; how: 'issue' | 'rotate'; token: TokenResponse }
  | { type: 'hide' }
  | { type: 'copied'; ok: boolean };

export function panelReduce(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'loaded':
      return { ...state, phase: 'ready', info: action.info, error: null };
    case 'failed':
      // A failure keeps what is already shown (a revealed token stays copyable).
      return { ...state, phase: state.info === null ? 'failed' : 'ready', error: action.error };
    case 'begin':
      return { ...state, phase: 'busy', error: null, copy: null };
    case 'issued':
      return {
        phase: 'ready',
        info: {
          token_v: action.token.token_v,
          issued_at: action.token.issued_at,
          expires_at: action.token.expires_at,
          masked: maskToken(action.token.token),
        },
        revealed: action.token,
        said: action.how === 'issue' ? 'issued' : 'rotated',
        copy: null,
        error: null,
      };
    case 'hide':
      return { ...state, revealed: null, copy: null };
    case 'copied':
      return { ...state, copy: action.ok ? 'copied' : 'failed' };
  }
}

/**
 * Plain words for what the token routes refuse with. A guest is sent to sign in; a missing
 * sandbox says so; anything else is the console's usual wording.
 */
export function describeTokenError(error: unknown): Message {
  if (error instanceof ApiError && error.status === 403 && error.slug === 'guest-scope') {
    return {
      title: 'Tokens are for signed-in sandboxes',
      detail: 'A guest cannot issue one. Sign in to get a token.',
    };
  }
  if (error instanceof ApiError && error.status === 403) {
    return {
      title: 'The API refused the request',
      detail: 'The page was not allowed to do this. Reload and try again.',
    };
  }
  if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
    return {
      title: 'The sandbox was not found',
      detail: 'It may have been wiped. Make a new sandbox to get a token.',
    };
  }
  return describeError(error);
}

/**
 * Whether Rotate has a token to replace. Before the first issue (and after a rotation until the
 * next, as the API reports it) `issued_at` is absent, and a rotate would only issue a first token
 * while saying the old one stopped working.
 */
export const canRotate = (info: TokenInfoResponse | null): boolean => info?.issued_at != null;
