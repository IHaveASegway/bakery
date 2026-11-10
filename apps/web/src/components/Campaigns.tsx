import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BodyTemplate,
  CampaignRequest,
  CampaignResponse,
  Segment,
  SubjectTemplate,
} from '../contracts';
import {
  cancelCampaign,
  createCampaign,
  editCampaign,
  listCampaigns,
  scheduleCampaign,
} from '../lib/api';
import {
  BODIES,
  KeyedAction,
  MIN_LEAD_MINUTES,
  SEGMENTS,
  SUBJECTS,
  bodyLabel,
  bodyPreview,
  campaignActions,
  campaignStateLabel,
  campaignStats,
  cancelLabel,
  earliestSendAt,
  inputValueOf,
  percentText,
  segmentLabel,
  segmentSays,
  sendAtFromInput,
  scheduledSaid,
  sendAtText,
  stateSays,
  subjectLabel,
  subjectText,
} from '../lib/crm';
import { describeCrmError, earliestOf } from '../lib/crm-errors';
import { describeError, type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';
import { HOW } from '../tour/how';
import HowItWorks from './HowItWorks';

/** The business time now, from the wall clock and the sandbox's offset. */
const businessNow = (offsetS: number) => Date.now() + offsetS * 1000;

/**
 * Campaigns: compose one from the fixed templates (subject, body and segment are selects, never
 * text), see what the message will look like, schedule it, cancel it, and watch its numbers. The
 * send is the campaign's own timer, never a button: advance the clock past the send time (the
 * clock control below) and the list, which looks again every five seconds, shows it sent. Every
 * rule about states, send times and who may do what is the API’s; this page shows the buttons a
 * state allows and the API’s words when it refuses.
 */
export default function Campaigns({
  sandboxId,
  isGuest,
  clockOffsetS,
}: {
  sandboxId: string;
  isGuest: boolean;
  clockOffsetS: number;
}) {
  const [campaigns, setCampaigns] = useState<CampaignResponse[] | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [subject, setSubject] = useState<SubjectTemplate>(SUBJECTS[0]!.value);
  const [body, setBody] = useState<BodyTemplate>(BODIES[0]!.value);
  const [segment, setSegment] = useState<Segment>(SEGMENTS[0]!.segment);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const clicks = useRef(new KeyedAction());

  const load = useCallback(() => {
    listCampaigns(sandboxId).then(
      (answer) => {
        setCampaigns(answer.campaigns);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId]);

  // Again when the clock moves, since a send is what that was for, and every five seconds.
  useEffect(load, [load, clockOffsetS]);
  useEffect(() => {
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  const take = useCallback((campaign: CampaignResponse) => {
    setCampaigns((list) => {
      const all = list ?? [];
      return all.some((c) => c.campaign === campaign.campaign)
        ? all.map((c) => (c.campaign === campaign.campaign ? campaign : c))
        : [campaign, ...all];
    });
  }, []);

  async function save() {
    const request: CampaignRequest = { subject, body, segment };
    setBusy(true);
    setError(null);
    setSaved('');
    try {
      const answer = await clicks.current.run(
        `${editing ?? 'new'}:${JSON.stringify(request)}`,
        (key) =>
          editing === null
            ? createCampaign(sandboxId, request, key)
            : editCampaign(sandboxId, editing, request, key),
      );
      take(answer);
      setSaved(
        editing === null
          ? 'Draft saved. It is the first card below; schedule it there.'
          : 'Changes saved.',
      );
      setEditing(null);
    } catch (e) {
      setError(describeCrmError(e));
    } finally {
      setBusy(false);
    }
  }

  function edit(c: CampaignResponse) {
    setEditing(c.campaign);
    setSubject(c.subject);
    setBody(c.body);
    setSegment(c.segment);
  }

  return (
    <section aria-labelledby="campaigns-heading">
      <h3 id="campaigns-heading" tabIndex={-1} data-tour="crm-campaigns">
        Campaigns
      </h3>
      <p className="hint">
        Schedule one, move the clock past its send time, and find it in the{' '}
        <a href="/inbox/">inbox</a>.
      </p>
      {isGuest && <GuestNote />}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <h4>{editing === null ? 'New campaign' : 'Edit the draft'}</h4>
        <p>
          <label htmlFor="campaign-subject">Subject</label>
          <select
            id="campaign-subject"
            value={subject}
            disabled={busy || isGuest}
            onChange={(e) => setSubject(e.target.value as SubjectTemplate)}
          >
            {SUBJECTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="campaign-body">Body</label>
          <select
            id="campaign-body"
            value={body}
            disabled={busy || isGuest}
            onChange={(e) => setBody(e.target.value as BodyTemplate)}
          >
            {BODIES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="campaign-segment">Segment</label>
          <select
            id="campaign-segment"
            value={segment}
            disabled={busy || isGuest}
            onChange={(e) => setSegment(e.target.value as Segment)}
          >
            {SEGMENTS.map((s) => (
              <option key={s.segment} value={s.segment}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="hint">
            {segmentSays(segment)} Customers who have said no are left out.
          </span>
        </p>
        <div className="draft" aria-label="Preview of the message">
          <p>
            <strong>{subjectText(subject)}</strong>
          </p>
          <p>{bodyPreview(body)}</p>
        </div>
        <p className="actions">
          {/* Busy is aria-disabled, not disabled, so the keyboard's focus stays on the button. */}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isGuest}
            aria-disabled={busy || undefined}
          >
            {busy ? 'Saving…' : editing === null ? 'Save draft' : 'Save changes'}
          </button>
          {editing !== null && (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Stop editing
            </button>
          )}
        </p>
      </form>

      <Message error={error}>{saved !== '' && <p className="hint">{saved}</p>}</Message>
      {campaigns === null ? (
        error === null && <p aria-live="polite">Loading the campaigns…</p>
      ) : campaigns.length === 0 ? (
        <p className="hint">No campaigns yet. Save a draft above.</p>
      ) : (
        <ul className="queue">
          {campaigns.map((c) => (
            <CampaignCard
              key={c.campaign}
              sandboxId={sandboxId}
              campaign={c}
              isGuest={isGuest}
              clockOffsetS={clockOffsetS}
              onChange={take}
              onEdit={edit}
            />
          ))}
        </ul>
      )}

      <HowItWorks>
        <p>{HOW.campaigns}</p>
      </HowItWorks>
    </section>
  );
}

/** Each campaign state's status tone (components.css, .badge[data-tone]). */
const CAMPAIGN_TONE: Record<CampaignResponse['state'], string> = {
  draft: 'done',
  scheduled: 'pending',
  sent: 'ready',
  cancelled: 'problem',
};

/** One campaign: its facts, its numbers, and the buttons its state allows. */
export function CampaignCard({
  sandboxId,
  campaign,
  isGuest,
  clockOffsetS,
  onChange,
  onEdit,
}: {
  sandboxId: string;
  campaign: CampaignResponse;
  isGuest: boolean;
  clockOffsetS: number;
  onChange: (campaign: CampaignResponse) => void;
  onEdit: (campaign: CampaignResponse) => void;
}) {
  const id = campaign.campaign;
  const actions = isGuest ? [] : campaignActions(campaign.state);
  const stats = campaignStats(campaign);
  const [when, setWhen] = useState(() => inputValueOf(earliestSendAt(businessNow(clockOffsetS))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const clicks = useRef(new KeyedAction());

  async function act(fingerprint: string, run: (key: string) => Promise<CampaignResponse>) {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      onChange(await clicks.current.run(fingerprint, run));
      return true;
    } catch (e) {
      setError(describeCrmError(e));
      // A send time that was too soon: put the API's earliest in the box.
      const earliest = earliestOf(e);
      if (earliest !== null) setWhen(earliest);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function schedule() {
    const sendAt = sendAtFromInput(when);
    if (sendAt === null) {
      setError({ title: 'Choose a send time', detail: 'Pick a date and a time.' });
      return;
    }
    const ok = await act(`${id}:schedule:${sendAt}`, (key) =>
      scheduleCampaign(sandboxId, id, { send_at: sendAt }, key),
    );
    if (ok) setSaid(scheduledSaid(sendAt));
  }

  return (
    <li>
      <h4>{subjectText(campaign.subject)}</h4>
      <p>
        <strong className="badge" data-tone={CAMPAIGN_TONE[campaign.state]}>
          {campaignStateLabel(campaign.state)}
        </strong>{' '}
        {stateSays(campaign.state)}
      </p>
      <dl>
        <dt>Template</dt>
        <dd>
          {subjectLabel(campaign.subject)}, {bodyLabel(campaign.body)}
        </dd>
        <dt>Segment</dt>
        <dd>{segmentLabel(campaign.segment)}</dd>
        {campaign.send_at && (
          <>
            <dt>Send at</dt>
            <dd>
              <time dateTime={campaign.send_at}>{sendAtText(campaign.send_at)}</time>
            </dd>
          </>
        )}
        <dt>Recipients</dt>
        <dd>{stats.recipients}</dd>
        <dt>Delivered</dt>
        <dd>{stats.delivered}</dd>
        <dt>Opened</dt>
        <dd>
          {stats.opened} ({percentText(stats.opened, stats.delivered)})
        </dd>
        <dt>Clicked</dt>
        <dd>
          {stats.clicked} ({percentText(stats.clicked, stats.delivered)})
        </dd>
      </dl>

      {actions.includes('schedule') && (
        <p className="inline-action">
          <label htmlFor={`when-${id}`}>Send at (the bakery’s time)</label>
          <input
            id={`when-${id}`}
            type="datetime-local"
            value={when}
            disabled={busy}
            aria-describedby={`when-${id}-says`}
            onChange={(e) => setWhen(e.target.value)}
          />{' '}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void schedule()}
          >
            Schedule
          </button>{' '}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => setWhen(inputValueOf(earliestSendAt(businessNow(clockOffsetS))))}
          >
            Use the earliest time
          </button>
          <span id={`when-${id}-says`} className="hint">
            The earliest is about {MIN_LEAD_MINUTES} minutes after business time now; the API checks
            it.
          </span>
        </p>
      )}
      {(actions.includes('edit') || actions.includes('cancel')) && (
        <p className="actions">
          {actions.includes('edit') && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => onEdit(campaign)}
            >
              Edit
            </button>
          )}
          {actions.includes('cancel') && (
            <button
              type="button"
              className={
                campaign.state === 'scheduled'
                  ? 'btn btn-secondary btn-sm'
                  : 'btn btn-danger btn-sm'
              }
              disabled={busy}
              onClick={() =>
                void act(`${id}:cancel:${campaign.state}`, (key) =>
                  cancelCampaign(sandboxId, id, key),
                )
              }
            >
              {cancelLabel(campaign.state)}
            </button>
          )}
        </p>
      )}
      {/* "Scheduled…" is about the scheduled state; once it sends or goes back, the card says so. */}
      <Message error={error}>
        {said !== null && campaign.state === 'scheduled' && <p className="hint">{said}</p>}
      </Message>
    </li>
  );
}
