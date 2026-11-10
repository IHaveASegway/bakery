import { useEffect, useState } from 'react';
import { createSandbox } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { DEFAULT_NEXT, NEXT_PATHS, nextFrom, type NextPath } from '../lib/next';
import Message from './Message';
import Turnstile from './Turnstile';

/**
 * "Continue as a guest", the sign-in page's first choice: a Turnstile pass buys a sandbox and a
 * cookie, nothing else, and the visitor goes on to the page that sent them here (`next`, G2).
 */
export default function Guest() {
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // Read after mount, so the server's HTML and the first render agree.
  const [next, setNext] = useState<NextPath>(DEFAULT_NEXT);
  useEffect(() => setNext(nextFrom(window.location.search)), []);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await createSandbox({ turnstile_token: token, replace: false });
      window.location.assign(next);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
      setResetKey((k) => k + 1);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-labelledby="guest-heading"
      className="way-in way-in-first"
      data-tour="signin-guest"
    >
      <p className="way-in-tag">Quickest</p>
      <h2 id="guest-heading">Continue as a guest</h2>
      <p>
        Order, pay with a test card and watch your order reach the kitchen. No account, no email.
      </p>
      <Turnstile
        onToken={setToken}
        resetKey={resetKey}
        onUnavailable={() => setUnavailable(true)}
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || unavailable || token === null}
      >
        {busy ? 'Making your sandbox…' : 'Continue as a guest'}
      </button>
      {next !== DEFAULT_NEXT && <p className="hint">Then on to {NEXT_PATHS[next]}.</p>}
      <Message error={error} />
    </form>
  );
}
