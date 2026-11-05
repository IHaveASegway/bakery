// The API token, in memory for the page's life and nowhere else (docs/security.md, "The API
// token": shown once, kept only in memory). The console's token panel puts it here when the API
// issues or rotates it; the tour reads it to fill the `curl` examples. A new page load starts
// empty. It is never written to localStorage, sessionStorage, a cookie or a URL, and it is
// shared only among the islands of one page because they share this module.
import type { TokenResponse } from '../contracts';

export type HeldToken = TokenResponse;

let held: HeldToken | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const tokenStore = {
  get: (): HeldToken | null => held,
  set(token: HeldToken): void {
    held = token;
    emit();
  },
  clear(): void {
    if (held === null) return;
    held = null;
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The token's text if one is held and has not expired by `nowMs`, else null. */
export function liveToken(nowMs: number): string | null {
  if (held === null) return null;
  const expires = Date.parse(held.expires_at);
  return Number.isFinite(expires) && expires <= nowMs ? null : held.token;
}
