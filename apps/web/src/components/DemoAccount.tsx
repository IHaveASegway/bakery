import { useEffect, useId, useRef, useState } from 'react';
import { demoSignin, demoSignup } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import Message from './Message';
import Turnstile from './Turnstile';

/**
 * Text typed before the island hydrated sits in the DOM field, and React's controlled value would
 * wipe it. On mount, take what the field already holds into state (audit C25).
 */
function useKeepTyped(setters: [React.RefObject<HTMLInputElement | null>, (v: string) => void][]) {
  useEffect(() => {
    for (const [ref, set] of setters) {
      const typed = ref.current?.value ?? '';
      if (typed !== '') set(typed);
    }
    // Once, on mount: later typing is the controlled value's business.
  }, []);
}

function CreateAccount() {
  const id = useId();
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);
  useKeepTyped([[passwordRef, setPassword]]);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const created = await demoSignup({ password, turnstile_token: token });
      setPassword('');
      setUsername(created.username);
    } catch (e) {
      setError(describeError(e));
      setResetKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(username ?? '');
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  }

  if (username !== null) {
    return (
      <section aria-labelledby={`${id}-done`}>
        <h2 id={`${id}-done`}>Your demo account</h2>
        <p>
          Your username is <code className="username">{username}</code>. It is shown once and nobody
          can look it up later, so write it down now, with the password you chose.
        </p>
        <p>
          <button type="button" onClick={copy}>
            Copy username
          </button>
        </p>
        <Message>
          {copied === 'yes' && <p>Copied.</p>}
          {copied === 'no' && <p>Copying failed. Select the username above and copy it by hand.</p>}
        </Message>
        <p>
          <a className="action" href="/app/">
            Continue to the console
          </a>
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`} data-tour="signin-demo">
      <h2 id={`${id}-heading`}>Create a demo account</h2>
      <p>
        The bakery makes up a username for you and keeps a hash of your password. It never asks for
        an email, so there is <strong>no password reset</strong>: if you forget the password, make a
        new account. An account you do not sign in to for 30 days deletes itself.
      </p>
      <p>
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          ref={passwordRef}
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={`${id}-rule`}
        />
        <span id={`${id}-rule`} className="hint">
          12 to 128 characters. Use one you use nowhere else.
        </span>
      </p>
      <Turnstile
        onToken={setToken}
        resetKey={resetKey}
        onUnavailable={() => setUnavailable(true)}
      />
      <button type="submit" disabled={busy || unavailable || token === null}>
        {busy ? 'Creating…' : 'Create a demo account'}
      </button>
      <Message error={error} />
    </form>
  );
}

function SignIn() {
  const id = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useKeepTyped([
    [usernameRef, setUsername],
    [passwordRef, setPassword],
  ]);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await demoSignin({ username: username.trim(), password });
      window.location.assign('/app/');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Sign in to a demo account</h2>
      <p>
        <label htmlFor={`${id}-username`}>Username</label>
        <input
          ref={usernameRef}
          id={`${id}-username`}
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </p>
      <p>
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          ref={passwordRef}
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </p>
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <Message error={error} />
    </form>
  );
}

/** The two demo-account forms. */
export default function DemoAccount() {
  return (
    <>
      <CreateAccount />
      <SignIn />
    </>
  );
}
