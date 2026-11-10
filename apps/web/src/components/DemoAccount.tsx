import { useEffect, useId, useRef, useState } from 'react';
import { createSandbox, demoSignin, demoSignup } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { NEXT_PATHS, nextFrom } from '../lib/next';
import { hydrating, useMounted } from '../lib/use-mounted';
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

/** What became of the sandbox the new account's press also asked for. */
type Made = { sandbox: true } | { sandbox: false; error: Text };

/**
 * Creates the account, then its sandbox, in the one press (audit G11, 2026-11-10): the page says
 * each way in gives a private sandbox, and "Continue to the console" landed on "You have no
 * sandbox" with one press more to make it. An account's sandbox needs no Turnstile pass. If the
 * sandbox cannot be started, the card says so and the console's own New sandbox is the way on.
 */
function CreateAccount() {
  const id = useId();
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);
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
      // The account exists and its session is set; its sandbox is asked for at once.
      try {
        await createSandbox({ replace: false });
        setMade({ sandbox: true });
      } catch (e) {
        setMade({ sandbox: false, error: describeError(e) });
      }
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
    // Only after the visitor's own action, so reading the address here cannot split the render.
    const next = nextFrom(window.location.search);
    return (
      <section aria-labelledby={`${id}-done`}>
        <h3 id={`${id}-done`}>Your demo account</h3>
        <p>
          Your username is <code className="username">{username}</code>. It is shown once and nobody
          can look it up later, so write it down now, with the password you chose.
        </p>
        {made?.sandbox === true && (
          <p className="made">Your sandbox is made too: your own bakery, until 10:00 UTC.</p>
        )}
        {made?.sandbox === false && (
          <p className="problem made">
            <strong>Your sandbox could not be started: {made.error.title}.</strong>{' '}
            {made.error.detail} You can start one on the next page.
          </p>
        )}
        {/* Two actions a card holds as the provider buttons do: a list with the stack's gap. */}
        <ul className="choices">
          <li>
            <button type="button" className="btn btn-secondary" onClick={copy}>
              Copy username
            </button>
          </li>
          <li>
            <a className="btn btn-primary" href={next}>
              Continue to {NEXT_PATHS[next]}
            </a>
          </li>
        </ul>
        <Message>
          {copied === 'yes' && <p>Copied.</p>}
          {copied === 'no' && <p>Copying failed. Select the username above and copy it by hand.</p>}
        </Message>
      </section>
    );
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`} data-tour="signin-demo">
      <h3 id={`${id}-heading`}>Create a demo account</h3>
      <p className="hint">
        The bakery makes up your username. There is <strong>no password reset</strong>, and an
        account unused for 30 days deletes itself.
      </p>
      <p className="field">
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
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || unavailable || token === null}
      >
        {busy ? 'Creating your account and sandbox…' : 'Create a demo account'}
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
  // Before hydration a press would submit the form natively. The fields carry no name, so nothing
  // would be sent, but the page would load again and what was typed would be lost.
  const mounted = useMounted();
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
      window.location.assign(nextFrom(window.location.search));
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`} className="demo-signin">
      <h3 id={`${id}-heading`}>Sign in to a demo account</h3>
      <p className="field">
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
      <p className="field">
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
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={busy || !mounted}
        {...hydrating(mounted)}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <Message error={error} />
    </form>
  );
}

/** The demo account, the sign-in page's second choice: make one, or sign in to the one you made. */
export default function DemoAccount() {
  return (
    <section aria-labelledby="demo-heading" className="way-in">
      <h2 id="demo-heading">Use a demo account</h2>
      <p>Everything, the console’s controls and the API token included, with no email.</p>
      <CreateAccount />
      <SignIn />
    </section>
  );
}
