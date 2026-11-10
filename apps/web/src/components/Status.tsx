import { Fragment, useEffect, useState } from 'react';
import { getStatus } from '../lib/api';
import {
  breakerWords,
  browserStorage,
  createPoller,
  failureLabel,
  failureStatus,
  formatTime,
  loadSnapshot,
  pastWipeWords,
  readStatus,
  saveSnapshot,
  stateLabel,
  stateWords,
  unreachableWords,
  type Model,
  type StatusData,
} from '../lib/status';

/** The numbers beside their names, in the order the kept queries list them (docs/operations.md). */
const ROWS = [
  ['Sandboxes created', 'sandboxes_24h'],
  ['Orders placed', 'orders_24h'],
  ['Payments succeeded', 'payments_24h'],
  ['Payments failed', 'payment_failures_24h'],
  ['Refunds issued', 'refunds_24h'],
  ['Messages dead-lettered', 'dlq_24h'],
] as const;

/** The page, drawn from what is known. Pure: the island below feeds it. */
export function StatusView({ model }: { model: Model }) {
  const shown: { data: StatusData; fetchedAt: string } | null =
    model.kind === 'answered' ? model : model.kind === 'unreachable' ? model.cached : null;
  const data = shown?.data ?? null;
  const unreachable = model.kind === 'unreachable';

  return (
    <div className="status" data-kind={model.kind}>
      <p aria-live="polite" data-testid="status-line">
        {model.kind === 'loading' && 'Asking the API…'}
        {unreachable && (
          <>
            <strong>{failureLabel(model.status)}</strong>{' '}
            {unreachableWords(model.cached, model.status)}
          </>
        )}
        {data !== null && model.kind === 'answered' && (
          <>
            <strong>{stateLabel(data.counters_state)}</strong>{' '}
            {stateWords(data.counters_state, data.counters_as_of)}
          </>
        )}
      </p>

      {data !== null && (
        <>
          <h2>Sandboxes today</h2>
          <p>
            <progress value={data.sandboxes_today} max={Math.max(1, data.sandbox_cap)}>
              {data.sandboxes_today} of {data.sandbox_cap}
            </progress>{' '}
            <span data-testid="status-sandboxes">
              {data.sandboxes_today} of {data.sandbox_cap}
            </span>{' '}
            sandboxes admitted on {data.day} (UTC); {data.guests_today} of {data.guest_cap} were
            guests, and {data.demo_accounts_today} of {data.demo_account_cap} demo accounts were
            made.
          </p>

          <p data-testid="status-breaker" data-tour="status-breaker">
            <strong>Breaker:</strong> {breakerWords(data.breaker)}
          </p>

          <p data-testid="status-past-wipe">
            <strong>Sandboxes past their wipe:</strong> {pastWipeWords(data.sandboxes_past_wipe)}
          </p>

          <h2>The last 24 hours</h2>
          {data.counters === null ? (
            <p data-testid="status-counters">No counters yet.</p>
          ) : (
            <>
              <p className="hint">
                As of{' '}
                {data.counters_as_of === null ? 'an unknown time' : formatTime(data.counters_as_of)}
                .
              </p>
              <dl data-testid="status-counters">
                {ROWS.map(([label, key]) => (
                  <Fragment key={key}>
                    <dt>{label}</dt>
                    <dd>{data.counters![key]}</dd>
                  </Fragment>
                ))}
              </dl>
              <h2>The last wipe</h2>
              <p data-testid="status-wipe">
                {data.counters.last_wipe === null
                  ? 'No wipe has been recorded yet.'
                  : `${formatTime(data.counters.last_wipe.at)}: ${data.counters.last_wipe.sandboxes} sandboxes and ${data.counters.last_wipe.objects} objects deleted in ${data.counters.last_wipe.ms} ms.`}
              </p>
            </>
          )}
        </>
      )}

      <p className="note">
        These are counts of what happened in the last 24 hours across every sandbox, kept as numbers
        and nothing else. They say nothing about any visitor, you included: no count holds a name,
        an address, an IP address or a sandbox id.
      </p>
    </div>
  );
}

/** The status page's island: looks on load and every minute while the page is visible. */
export default function Status() {
  const [model, setModel] = useState<Model>({ kind: 'loading' });

  useEffect(() => {
    const store = browserStorage();
    const poller = createPoller({
      load: getStatus,
      visible: () => document.visibilityState !== 'hidden',
      every: (run, ms) => setInterval(run, ms),
      cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      deliver: (raw, failure) => {
        const data = raw === null ? null : readStatus(raw);
        if (data !== null) {
          const fetchedAt = new Date().toISOString();
          saveSnapshot(store, data, fetchedAt);
          setModel({ kind: 'answered', data, fetchedAt });
        } else {
          const status = failureStatus(failure);
          setModel({
            kind: 'unreachable',
            cached: loadSnapshot(store),
            ...(status === undefined ? {} : { status }),
          });
        }
      },
    });
    const onVisibility = () => poller.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
  }, []);

  return <StatusView model={model} />;
}
