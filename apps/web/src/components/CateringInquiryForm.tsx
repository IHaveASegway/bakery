import { useMemo, useRef, useState } from 'react';
import type { CateringResponse } from '../contracts';
import { ApiError, submitInquiry } from '../lib/api';
import { attemptFor, keepKeyAfter, type Attempt } from '../lib/attempt';
import {
  BRIEF_HINT,
  BRIEF_MAX,
  EMPTY_INQUIRY,
  MAX_HEADCOUNT,
  MIN_HEADCOUNT,
  PACKAGES,
  VENUES,
  briefLength,
  briefWarning,
  inquiryReasons,
  inquiryRequest,
  leadHint,
  openDates,
  packageTotal,
  parseHeadcount,
  type InquiryForm,
} from '../lib/catering';
import { dateIn, describeCateringError, ruleOf } from '../lib/catering-errors';
import { type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { dateLabel } from '../lib/schedule';
import Message from './Message';

/**
 * The inquiry: a date from the open days the lead time allows, a headcount, a package, a venue
 * and a short brief. Nothing personal is asked for. Every rule here is a hint; the API's answer,
 * a 422 naming the rule, is the check.
 */
export default function CateringInquiryForm({
  sandboxId,
  earliest,
  onCreated,
  onLead,
}: {
  sandboxId: string;
  /** The first date the lead time allows, from the sandbox's business clock. */
  earliest: string;
  onCreated: (event: CateringResponse) => void;
  /** The API named a different earliest date than the page computed. */
  onLead: (date: string) => void;
}) {
  const [form, setForm] = useState<InquiryForm>(EMPTY_INQUIRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [retry, setRetry] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const dates = useMemo(() => openDates(earliest), [earliest]);

  const set = (patch: Partial<InquiryForm>) => setForm((f) => ({ ...f, ...patch }));
  const reasons = inquiryReasons(form, earliest);
  const chars = briefLength(form.brief);
  const warning = briefWarning(form.brief);
  const headcount = parseHeadcount(form.headcount);
  const estimateCents = headcount === null ? null : packageTotal(form.package, headcount);

  async function send() {
    const body = inquiryRequest(form, earliest);
    if (body === null || busy) return;
    // The same body is the same intent: a retry keeps its key, a changed form gets a new one.
    const current = attemptFor(attempt.current, JSON.stringify(body));
    attempt.current = current;
    setBusy(true);
    setError(null);
    try {
      const event = await submitInquiry(sandboxId, body, current.key);
      attempt.current = null;
      setRetry(false);
      setForm(EMPTY_INQUIRY);
      onCreated(event);
    } catch (e) {
      const keep = keepKeyAfter(e);
      if (!keep) attempt.current = null;
      setRetry(keep);
      setError(describeCateringError(e));
      if (e instanceof ApiError && e.status === 422 && ruleOf(e.detail) === 'catering-lead') {
        const date = dateIn(e.detail);
        if (date !== null) onLead(date);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-labelledby="inquiry-heading"
      data-tour="catering-inquiry"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h2 id="inquiry-heading">Ask about an event</h2>
      <p>
        <label htmlFor="cat-date">Day</label>
        <select
          id="cat-date"
          value={dates.includes(form.date) ? form.date : ''}
          aria-describedby="cat-date-hint"
          onChange={(e) => set({ date: e.target.value })}
        >
          <option value="">Choose…</option>
          {dates.map((d) => (
            <option key={d} value={d}>
              {dateLabel(d)}
            </option>
          ))}
        </select>
        <span id="cat-date-hint" className="hint">
          {leadHint(earliest)}
        </span>
      </p>
      <p>
        <label htmlFor="cat-headcount">Headcount</label>
        <input
          id="cat-headcount"
          type="number"
          inputMode="numeric"
          min={MIN_HEADCOUNT}
          max={MAX_HEADCOUNT}
          value={form.headcount}
          aria-describedby="cat-headcount-hint"
          onChange={(e) => set({ headcount: e.target.value })}
        />
        <span id="cat-headcount-hint" className="hint">
          {MIN_HEADCOUNT} to {MAX_HEADCOUNT} people.
        </span>
      </p>
      <p>
        <label htmlFor="cat-package">Package</label>
        <select
          id="cat-package"
          value={form.package}
          onChange={(e) => set({ package: e.target.value })}
        >
          <option value="">Choose…</option>
          {PACKAGES.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.label}, {dollars(p.per_head_cents)} a head
            </option>
          ))}
        </select>
        {estimateCents !== null && (
          <span className="hint">
            About {dollars(estimateCents)} at that price for {headcount} people. Staff send the
            quote, and its figures are the ones that count.
          </span>
        )}
      </p>
      <p>
        <label htmlFor="cat-venue">Venue</label>
        <select id="cat-venue" value={form.venue} onChange={(e) => set({ venue: e.target.value })}>
          <option value="">Choose…</option>
          {VENUES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} (made up)
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor="cat-brief">Brief (optional)</label>
        <textarea
          id="cat-brief"
          rows={4}
          value={form.brief}
          aria-describedby="cat-brief-count"
          onChange={(e) => set({ brief: e.target.value })}
        />
        <span id="cat-brief-count" className="hint">
          {chars} of {BRIEF_MAX} characters. {BRIEF_HINT}
        </span>
      </p>
      <p aria-live="polite" className="problem-slot">
        {chars > BRIEF_MAX && (
          <span className="problem">
            The brief is {chars - BRIEF_MAX} characters over the limit.
          </span>
        )}
        {warning !== null && <span className="problem">{warning}</span>}
      </p>
      <p>
        <button type="submit" disabled={busy || reasons.length > 0}>
          {busy ? 'Sending…' : retry ? 'Try again' : 'Send inquiry'}
        </button>
      </p>
      {reasons.length > 0 && (
        <ul className="hint">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {retry && (
        <p className="hint">
          Trying again sends the same request with the same key, so the inquiry cannot be made
          twice.
        </p>
      )}
      <Message error={error} />
    </form>
  );
}
