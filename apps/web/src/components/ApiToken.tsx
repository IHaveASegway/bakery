import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getTokenInfo, issueToken, rotateToken } from '../lib/api';
import { INITIAL, canRotate, describeTokenError, panelReduce } from '../lib/api-token';
import { KeyedAction } from '../lib/crm';
import { tokenStore } from '../lib/token-store';
import { utcStamp } from '../lib/countdown';
import GuestNote from './GuestNote';
import Message from './Message';

/**
 * The console's API token (Q42 · Q-api-access, docs/security.md, "The API token"). Signed-in
 * sandboxes only. "Issue token" shows the new token once, in a box with a copy button; "Rotate"
 * makes a new one and the old stops at once. The token is held in this page's memory
 * (lib/token-store.ts) so the tour can fill its curl examples, and nowhere else: not localStorage,
 * not a cookie, not a URL. A guest sees the panel switched off.
 */
export default function ApiToken({ sandboxId, isGuest }: { sandboxId: string; isGuest: boolean }) {
  const [state, dispatch] = useReducer(panelReduce, INITIAL);
  // A retry of the same click after a dropped connection keeps its key; a new click gets a new one.
  const issuing = useRef(new KeyedAction());
  const rotating = useRef(new KeyedAction());

  useEffect(() => {
    if (isGuest) return;
    let stopped = false;
    getTokenInfo(sandboxId).then(
      (info) => !stopped && dispatch({ type: 'loaded', info }),
      (e: unknown) => !stopped && dispatch({ type: 'failed', error: describeTokenError(e) }),
    );
    // Leaving the sandbox (a wipe, a new one, a reload) forgets the token.
    return () => {
      stopped = true;
      tokenStore.clear();
    };
  }, [sandboxId, isGuest]);

  const run = useCallback(
    async (how: 'issue' | 'rotate') => {
      if (
        how === 'rotate' &&
        !window.confirm('Rotate the token? The one you have now stops working at once.')
      ) {
        return;
      }
      dispatch({ type: 'begin' });
      try {
        const action = how === 'issue' ? issuing.current : rotating.current;
        const token = await action.run(`${how}:${sandboxId}`, (key) =>
          how === 'issue' ? issueToken(sandboxId, key) : rotateToken(sandboxId, key),
        );
        tokenStore.set(token);
        dispatch({ type: 'issued', how, token });
      } catch (e) {
        dispatch({ type: 'failed', error: describeTokenError(e) });
      }
    },
    [sandboxId],
  );

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: 'copied', ok: true });
    } catch {
      dispatch({ type: 'copied', ok: false });
    }
  }

  const busy = state.phase === 'busy' || state.phase === 'loading';
  const { info, revealed } = state;
  const hasToken = canRotate(info);
  return (
    <section aria-labelledby="token-heading" data-tour="console-token">
      <h3 id="token-heading" tabIndex={-1}>
        API token
      </h3>
      <p>
        A bearer token lets <code>curl</code> call this sandbox’s API without the cookie. It lasts
        24 hours, stops when the sandbox is wiped or the token is rotated, and goes in an{' '}
        <code>Authorization: Bearer</code> header, never in a URL. The API reference is at{' '}
        <a href="/docs/api/">/docs/api/</a>.
      </p>
      {isGuest ? (
        <>
          <p className="actions">
            <button type="button" className="btn btn-primary" disabled>
              Issue token
            </button>
            <button type="button" className="btn btn-secondary" disabled>
              Rotate
            </button>
          </p>
          <GuestNote />
        </>
      ) : (
        <>
          <dl>
            <dt>Version</dt>
            <dd>{info === null ? 'not known yet' : info.token_v}</dd>
            <dt>Issued</dt>
            <dd>{info?.issued_at ? utcStamp(info.issued_at) : 'no token yet'}</dd>
            <dt>Expires</dt>
            <dd>{info?.expires_at ? utcStamp(info.expires_at) : 'no token yet'}</dd>
            <dt>Token</dt>
            <dd>
              <code>{info?.masked ?? 'none issued'}</code>
            </dd>
          </dl>
          <p className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void run('issue')}
            >
              Issue token
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !hasToken}
              aria-describedby="token-rotate-says"
              onClick={() => void run('rotate')}
            >
              Rotate
            </button>
          </p>
          <p id="token-rotate-says" className="hint">
            {hasToken
              ? 'Rotate makes a new token, and the one you have stops working at once.'
              : 'Rotate needs a token to replace. Issue one first.'}
          </p>
        </>
      )}
      {revealed !== null && (
        <div className="reveal" role="group" aria-label="Your new API token">
          <p>
            <strong>Copy this token now. It is shown once.</strong> This page keeps it in memory
            until you leave or wipe the sandbox; it cannot be shown again.
          </p>
          <label htmlFor="token-value">Your API token</label>
          <input
            id="token-value"
            type="text"
            readOnly
            value={revealed.token}
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void copy(revealed.token)}
            >
              Copy token
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => dispatch({ type: 'hide' })}
            >
              Hide it
            </button>
          </p>
        </div>
      )}
      <Message error={state.error}>
        {state.said === 'issued' && <p>A token was issued. It expires {when(state)}.</p>}
        {state.said === 'rotated' && (
          <p>
            The token was rotated. The old one stopped working at once; the new one expires{' '}
            {when(state)}.
          </p>
        )}
        {state.copy === 'copied' && <p>Copied.</p>}
        {state.copy === 'failed' && <p>Copy failed: select the token and copy it by hand.</p>}
      </Message>
    </section>
  );
}

const when = (state: typeof INITIAL) =>
  state.info?.expires_at ? `at ${utcStamp(state.info.expires_at)}` : 'in 24 hours';
