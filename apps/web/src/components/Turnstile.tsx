import { useEffect, useRef, useState } from 'react';

// Turnstile's documented always-pass test key (Cloudflare, "Testing"): it needs no account and
// passes every visitor. The production key is set through PUBLIC_TURNSTILE_SITE_KEY at launch; since
// 2026-11-08 the deploy job refuses a bundle that still carries this one (ci.yml), so the fallback is
// for local runs and previews only.
const TEST_SITE_KEY = '1x00000000000000000000AA';
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/** Loads Turnstile's script once per page. Only the sign-in page ever calls this. */
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'));
    script.onerror = () => {
      loading = undefined; // a later widget may try again
      reject(new Error('script failed'));
    };
    document.head.append(script);
  });
  return loading;
}

interface Props {
  /** The token, or null when it expired or the challenge failed. */
  onToken: (token: string | null) => void;
  /** Change this to ask for a fresh challenge: a token works once. */
  resetKey: number;
  /** Tells the form the widget cannot load, so it can disable its submit. */
  onUnavailable: () => void;
}

export default function Turnstile({ onToken, resetKey, onUnavailable }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The latest callbacks, so the widget is rendered once and never re-created by a parent render.
  const callbacks = useRef({ onToken, onUnavailable });
  callbacks.current = { onToken, onUnavailable };

  useEffect(() => {
    let cancelled = false;
    const siteKey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || TEST_SITE_KEY;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !box.current) return;
        widget.current = api.render(box.current, {
          sitekey: siteKey,
          callback: (token) => callbacks.current.onToken(token),
          'error-callback': () => callbacks.current.onToken(null),
          'expired-callback': () => callbacks.current.onToken(null),
        });
      },
      () => {
        if (cancelled) return;
        setFailed(true);
        callbacks.current.onUnavailable();
      },
    );
    return () => {
      cancelled = true;
      if (widget.current !== null) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, []);

  useEffect(() => {
    if (resetKey > 0 && widget.current !== null) {
      callbacks.current.onToken(null);
      window.turnstile?.reset(widget.current);
    }
  }, [resetKey]);

  return (
    <div className="challenge">
      <div ref={box} />
      {failed && (
        <p className="note" role="alert">
          The check that tells people from bots did not load, so this form is turned off. Reload the
          page, or allow challenges.cloudflare.com and try again.
        </p>
      )}
    </div>
  );
}
