import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { MessageResponse } from '../contracts';
import { getMessage, listInbox } from '../lib/api';
import { businessNowMs, momentText, whenText } from '../lib/when';
import {
  ALL_KINDS,
  MESSAGE_KINDS,
  countText,
  inboxToText,
  engagementText,
  filterOf,
  kindLabel,
  namesOf,
  receiptOf,
  receiptOrder,
  recipientName,
} from '../lib/inbox';
import { describeError, type Message as Text } from '../lib/messages';
import { useCustomers } from '../lib/use-customers';
import { useSandboxPhase } from '../lib/use-session';
import Message from './Message';
import StatusLine from './StatusLine';

/** The default the API applies, asked for by name so the page and the count agree. */
const LIMIT = 50;

/** The table's columns, so the open message's row spans them all. */
const COLUMNS = 6;

/**
 * The /inbox/ island: every message the bakery has sent anyone in the visitor's sandbox, newest
 * first, with the kind, who it went to, its subject and when it was delivered, opened and
 * clicked. A guest reads it too. The list looks again every five seconds, since opens and clicks
 * arrive from the Inbox’s own alarms and not from this page.
 *
 * A pressed subject opens its message in a row of its own directly under that message's row, at
 * every width, and its heading takes the focus (the audit of 2026-11-10: on a phone the message
 * opened under the whole list, thousands of pixels below the press, and nothing seemed to happen).
 * The subject again, Close or Escape closes it and gives the focus back to the subject. One message
 * is open at a time. `?receipt=<order id>`, the order page's link, opens that order's receipt once
 * the list holds it; an order with no receipt in the list leaves the plain list.
 */
export default function Inbox() {
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  // Business now: "this year" is the sandbox's, not the browser's.
  const now = businessNowMs(phase.name === 'live' ? phase.clockOffsetS : 0);
  const [kind, setKind] = useState<string>(ALL_KINDS);
  const [messages, setMessages] = useState<MessageResponse[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageResponse | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const { customers } = useCustomers(sandboxId);
  const names = namesOf(customers ?? []);
  // The order whose receipt the address asks for, until the list has shown it once.
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => setWanted(receiptOrder(window.location.search)), []);
  // The heading takes the focus when a message opens; Close and Escape give it back to the subject.
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  const focusOnOpen = useRef(false);

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

  // The order page's link: open its receipt once the list holds it, and only once.
  useEffect(() => {
    if (wanted === null || messages === null) return;
    const receipt = receiptOf(messages, wanted);
    if (receipt === null) return;
    setWanted(null);
    focusOnOpen.current = true;
    setSelected(receipt);
  }, [wanted, messages]);

  const listed = messages?.find((m) => m.message === selected) ?? null;
  const open = listed === null ? null : detail?.message === listed.message ? detail : listed;

  // Once the open message is drawn, its heading takes the focus and the message is scrolled only as
  // far as it needs to be in view: it is directly under the pressed subject, so the page barely
  // moves, and never by more than the message's own height.
  const openId = open?.message ?? null;
  useEffect(() => {
    if (openId === null || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    heading.current?.focus({ preventScroll: true });
    section.current?.scrollIntoView({ block: 'nearest' });
  }, [openId]);

  function press(id: string) {
    // The visitor's own choice wins over a receipt the address asked for and the list lacks yet.
    setWanted(null);
    if (id === selected) return setSelected(null);
    focusOnOpen.current = true;
    setSelected(id);
  }

  /** Close the open message and give the focus back to its subject. */
  function close() {
    if (selected === null) return;
    const subject = document.getElementById(subjectId(selected));
    setSelected(null);
    subject?.focus();
  }

  return (
    <>
      <StatusLine
        phase={phase}
        signedOut="You have no sandbox yet, so the inbox is empty."
        signedOutNext={
          <>
            <a href="/menu/">Start at the menu</a>: an order’s receipt lands here.
          </>
        }
      />
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
                <p className="hint" data-testid="inbox-to">
                  {inboxToText(phase.name === 'live' ? phase.personaName : null)}
                </p>
              )}
              {messages.length > 0 && (
                <div
                  className="table-scroll"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && selected !== null) close();
                  }}
                >
                  <table className="inbox-table">
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
                        <Fragment key={m.message}>
                          <tr data-open={m.message === selected ? '' : undefined}>
                            <td data-label="Kind">{kindLabel(m.kind)}</td>
                            <td data-label="To">{recipientName(names, m.to)}</td>
                            <th scope="row" data-label="Subject">
                              <button
                                type="button"
                                id={subjectId(m.message)}
                                className="link"
                                aria-expanded={m.message === selected}
                                aria-controls={m.message === selected ? 'inbox-open' : undefined}
                                onClick={() => press(m.message)}
                              >
                                {m.subject}
                              </button>
                            </th>
                            <td data-label="Delivered">
                              <time dateTime={m.delivered_at} title={whenText(m.delivered_at)}>
                                {momentText(m.delivered_at, { now })}
                              </time>
                            </td>
                            <td data-label="Opened">
                              {m.opened_at ? momentText(m.opened_at, { now }) : ''}
                            </td>
                            <td data-label="Clicked">
                              {m.clicked_at ? momentText(m.clicked_at, { now }) : ''}
                            </td>
                          </tr>
                          {open !== null && m.message === open.message && (
                            <tr className="inbox-open">
                              <td colSpan={COLUMNS}>
                                <section
                                  id="inbox-open"
                                  aria-labelledby="message-heading"
                                  data-tour="inbox-message"
                                  ref={section}
                                >
                                  <h2 id="message-heading" ref={heading} tabIndex={-1}>
                                    {open.subject}
                                  </h2>
                                  <p className="hint">
                                    {kindLabel(open.kind)} to {recipientName(names, open.to)}, a
                                    made-up customer, delivered{' '}
                                    {momentText(open.delivered_at, { now })}.{' '}
                                    {engagementText(open, now)}.
                                  </p>
                                  <p className="brief">{open.body}</p>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={close}
                                  >
                                    Close
                                  </button>
                                </section>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** The subject's button, by message: the focus goes back to it when its message closes. */
const subjectId = (message: string) => `subject-${message}`;
