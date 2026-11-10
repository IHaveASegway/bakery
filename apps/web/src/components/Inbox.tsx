import { useCallback, useEffect, useState } from 'react';
import type { MessageResponse } from '../contracts';
import { getMessage, listInbox } from '../lib/api';
import { whenText } from '../lib/crm';
import {
  ALL_KINDS,
  MESSAGE_KINDS,
  countText,
  engagementText,
  filterOf,
  kindLabel,
  namesOf,
  recipientName,
} from '../lib/inbox';
import { describeError, type Message as Text } from '../lib/messages';
import { useCustomers } from '../lib/use-customers';
import { useSandboxPhase } from '../lib/use-session';
import Message from './Message';
import StatusLine from './StatusLine';

/** The default the API applies, asked for by name so the page and the count agree. */
const LIMIT = 50;

/**
 * The /inbox/ island: every message the bakery has sent anyone in the visitor's sandbox, newest
 * first, with the kind, who it went to, its subject and when it was delivered, opened and
 * clicked, and the open one's body beside it. A guest reads it too. The list looks again every
 * five seconds, since opens and clicks arrive from the Inbox’s own alarms and not from this page.
 */
export default function Inbox() {
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const [kind, setKind] = useState<string>(ALL_KINDS);
  const [messages, setMessages] = useState<MessageResponse[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageResponse | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const { customers } = useCustomers(sandboxId);
  const names = namesOf(customers ?? []);

  const load = useCallback(() => {
    if (sandboxId === null) return;
    listInbox(sandboxId, filterOf(kind, '', LIMIT)).then(
      (answer) => {
        setMessages(answer.messages);
        setTotal(answer.total);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId, kind]);

  useEffect(() => {
    setMessages(null);
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  // The open message is asked for by id, so its opens and clicks are the latest the API has.
  useEffect(() => {
    setDetail(null);
    if (sandboxId === null || selected === null) return;
    let stopped = false;
    const look = () =>
      getMessage(sandboxId, selected).then(
        (m) => !stopped && setDetail(m),
        () => undefined,
      );
    void look();
    const timer = setInterval(() => void look(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sandboxId, selected]);

  const listed = messages?.find((m) => m.message === selected) ?? null;
  const open = detail ?? listed;

  return (
    <>
      <StatusLine phase={phase} signedOut="You have no sandbox yet, so the inbox is empty." />
      {sandboxId !== null && (
        <>
          <p data-tour="inbox-list">
            <label htmlFor="inbox-kind">Show</label>
            <select
              id="inbox-kind"
              value={kind}
              onChange={(e) => {
                const next = e.target.value;
                setKind(next);
                // A message the new filter hides is closed, not left open below a list without it.
                if (open !== null && next !== ALL_KINDS && open.kind !== next) setSelected(null);
              }}
            >
              <option value={ALL_KINDS}>All messages</option>
              {MESSAGE_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </p>
          <Message error={error} />
          {messages === null ? (
            error === null && <p aria-live="polite">Loading the inbox…</p>
          ) : (
            <>
              <p className="hint" aria-live="polite">
                {countText(messages.length, total, kind)}
              </p>
              {messages.length > 0 && (
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">Messages, newest first</caption>
                    <thead>
                      <tr>
                        <th scope="col">Kind</th>
                        <th scope="col">To</th>
                        <th scope="col">Subject</th>
                        <th scope="col">Delivered</th>
                        <th scope="col">Opened</th>
                        <th scope="col">Clicked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {messages.map((m) => (
                        <tr key={m.message}>
                          <td>{kindLabel(m.kind)}</td>
                          <td>{recipientName(names, m.to)}</td>
                          <th scope="row">
                            <button
                              type="button"
                              className="link"
                              aria-pressed={m.message === selected}
                              onClick={() => setSelected(m.message === selected ? null : m.message)}
                            >
                              {m.subject}
                            </button>
                          </th>
                          <td>
                            <time dateTime={m.delivered_at}>{whenText(m.delivered_at)}</time>
                          </td>
                          <td>{m.opened_at ? whenText(m.opened_at) : '–'}</td>
                          <td>{m.clicked_at ? whenText(m.clicked_at) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {open && (
            <section aria-labelledby="message-heading" data-tour="inbox-message">
              <h2 id="message-heading">{open.subject}</h2>
              <p className="hint">
                {kindLabel(open.kind)} to {recipientName(names, open.to)}, delivered{' '}
                {whenText(open.delivered_at)}. {engagementText(open)}.
              </p>
              <p className="brief">{open.body}</p>
            </section>
          )}
        </>
      )}
    </>
  );
}
