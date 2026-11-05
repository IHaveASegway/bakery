import { useState } from 'react';
import { createSandbox } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import Message from './Message';
import Turnstile from './Turnstile';

/** "Try it as a guest": a Turnstile pass buys a sandbox and a cookie, nothing else. */
export default function Guest() {
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [resetKey, setResetKey] = useState(0);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await createSandbox({ turnstile_token: token, replace: false });
      window.location.assign('/app/');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
      setResetKey((k) => k + 1);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby="guest-heading">
      <h2 id="guest-heading">Try it as a guest</h2>
      <p>
        No account. A check that you are a person gets you a sandbox and a cookie. Guests browse,
        order and pay; the console’s writes need a sign-in.
      </p>
      <Turnstile
        onToken={setToken}
        resetKey={resetKey}
        onUnavailable={() => setUnavailable(true)}
      />
      <button type="submit" disabled={busy || unavailable || token === null}>
        {busy ? 'Making your sandbox…' : 'Try it as a guest'}
      </button>
      <Message error={error} />
    </form>
  );
}
