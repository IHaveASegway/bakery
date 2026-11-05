// One checkout attempt, one Idempotency-Key. The API replays the answer to a key it has seen, so a
// retry of the same attempt (the network dropped before an answer, or the server failed) must send
// the key again, and a new attempt (the cart changed, or the API refused the order) must send a
// new one. A reused key with a different body is a 422 (docs/domain.md, "Idempotency").
import { ApiError, NetworkError } from './api';
import { ulid } from './ulid';

export interface Attempt {
  key: string;
  /** What the attempt sent: the same text means the same intent. */
  fingerprint: string;
}

/** The attempt to send now: the previous one when nothing changed, else a fresh one. */
export function attemptFor(
  previous: Attempt | null,
  fingerprint: string,
  mint: () => string = ulid,
): Attempt {
  return previous !== null && previous.fingerprint === fingerprint
    ? previous
    : { key: mint(), fingerprint };
}

/**
 * Whether the key should be sent again after this failure. An unanswered request and a server
 * error may have been applied, so the retry reuses the key; a refusal (4xx) applied nothing, so
 * the visitor's next try is a new attempt.
 */
export function keepKeyAfter(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && error.status >= 500;
}
