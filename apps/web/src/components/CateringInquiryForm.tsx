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
  inquiryFieldErrors,
  inquiryMissing,
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
import { dayText } from '../lib/when';
import Message from './Message';

/** The ids a control is described by: its hint, then its error when it has one. */
const described = (...ids: (string | false | undefined)[]) =>
  ids.filter((id): id is string => typeof id === 'string' && id !== '').join(' ');

/** A field's error in its own words, announced as it appears; nothing when the value is fine. */
function FieldError({ id, text }: { id: string; text: string | undefined }) {
  return (
    <span id={id} className="error" aria-live="polite">
      {text ?? ''}
    </span>
  );
}

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
  now,
}: {
  sandboxId: string;
  /** The first date the lead time allows, from the sandbox's business clock. */
  earliest: string;
  onCreated: (event: CateringResponse) => void;
  /** The API named a different earliest date than the page computed. */
  onLead: (date: string) => void;
  /** Business now (wall clock plus the sandbox's offset), so "this year" is the bakery's. */
  now?: number | undefined;
}) {
  const [form, setForm] = useState<InquiryForm>(EMPTY_INQUIRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [retry, setRetry] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const dates = useMemo(() => openDates(earliest), [earliest]);

  const set = (patch: Partial<InquiryForm>) => setForm((f) => ({ ...f, ...patch }));
  const reasons = inquiryReasons(form, earliest);
  const fieldErrors = inquiryFieldErrors(form, earliest);
  const missing = inquiryMissing(form);
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
      setError(describeCateringError(e, now));
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
      {/* Laid out as the checkout's fields are: each a label, its control, its hint and, when a
          value it holds will not do, the reason in the field's own words, marked invalid. */}
      <div className="inquiry-fields">
        <p className="field">
          <label htmlFor="cat-date">Day</label>
          <select
            id="cat-date"
            value={dates.includes(form.date) ? form.date : ''}
            aria-describedby={described('cat-date-hint', fieldErrors.date && 'cat-date-error')}
            aria-invalid={fieldErrors.date ? true : undefined}
            onChange={(e) => set({ date: e.target.value })}
          >
            <option value="">Choose…</option>
            {dates.map((d) => (
              <option key={d} value={d}>
                {dayText(d, { now })}
              </option>
            ))}
          </select>
          <span id="cat-date-hint" className="hint">
            {leadHint(earliest, now)}
          </span>
          <FieldError id="cat-date-error" text={fieldErrors.date} />
        </p>
        <p className="field">
          <label htmlFor="cat-headcount">Headcount</label>
          <input
            id="cat-headcount"
            type="number"
            inputMode="numeric"
            min={MIN_HEADCOUNT}
            max={MAX_HEADCOUNT}
            value={form.headcount}
            aria-describedby={described(
              'cat-headcount-hint',
              fieldErrors.headcount && 'cat-headcount-error',
            )}
            aria-invalid={fieldErrors.headcount ? true : undefined}
            onChange={(e) => set({ headcount: e.target.value })}
          />
          <span id="cat-headcount-hint" className="hint">
            {MIN_HEADCOUNT} to {MAX_HEADCOUNT} people.
          </span>
          <FieldError id="cat-headcount-error" text={fieldErrors.headcount} />
        </p>
        <p className="field">
          <label htmlFor="cat-package">Package</label>
          <select
            id="cat-package"
            value={form.package}
            aria-describedby={estimateCents !== null ? 'cat-package-hint' : undefined}
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
            <span id="cat-package-hint" className="hint">
              About {dollars(estimateCents)} for {headcount} people. Staff send the quote, and its
              figures are the ones that count.
            </span>
          )}
        </p>
        <p className="field">
          <label htmlFor="cat-venue">Venue</label>
          <select
            id="cat-venue"
            value={form.venue}
            onChange={(e) => set({ venue: e.target.value })}
          >
            <option value="">Choose…</option>
            {VENUES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} (made up)
              </option>
            ))}
          </select>
        </p>
        <p className="field inquiry-brief">
          <label htmlFor="cat-brief">Brief (optional)</label>
          <textarea
            id="cat-brief"
            rows={4}
            value={form.brief}
            aria-describedby={described('cat-brief-count', fieldErrors.brief && 'cat-brief-error')}
            aria-invalid={fieldErrors.brief ? true : undefined}
            onChange={(e) => set({ brief: e.target.value })}
          />
          <span id="cat-brief-count" className="hint">
            {chars} of {BRIEF_MAX} characters. {BRIEF_HINT}
          </span>
          <FieldError id="cat-brief-error" text={fieldErrors.brief} />
          {warning !== null && (
            <span className="problem" aria-live="polite">
              {warning}
            </span>
          )}
        </p>
      </div>
      {/* Send stays off until the form could be sent, as the checkout's Place order does; what is
          still missing is said beside it, and what is wrong is said at its field. */}
      <p className="step-actions inquiry-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || reasons.length > 0}
          aria-describedby={missing !== null ? 'cat-missing' : undefined}
        >
          {busy ? 'Sending…' : retry ? 'Try again' : 'Send inquiry'}
        </button>
        {missing !== null && (
          <span id="cat-missing" className="hint">
            {missing}
          </span>
        )}
      </p>
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
