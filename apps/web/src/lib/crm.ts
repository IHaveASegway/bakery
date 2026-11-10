// What the CRM screens know without asking: the labels and previews of the fixed templates and
// segments, the table of what a campaign in each state may do, the hint for the earliest send
// time, the stats' rates, the lead stages in order and the rebuild's progress. Every rule here is
// a label or a hint. The API decides: it refuses a send time that is too soon, an edit of a sent
// campaign and a second rebuild, and it counts every member, recipient and event it shows
// (docs/domain.md, "Campaign"; docs/architecture.md, "A campaign send"). Pure functions and two
// small classes, so vitest covers them; the components only draw the answers.
import type {
  BodyTemplate,
  CampaignResponse,
  CampaignState,
  LeadStage,
  LeadStageView,
  RebuildResponse,
  Segment,
  SubjectTemplate,
  TimelineEntry,
} from '../contracts';
import { attemptFor, keepKeyAfter, type Attempt } from './attempt';
import { pollUntil, type PollOptions, type Polled } from './payment';
import { momentText, whenText } from './when';
import { businessTime, mountainToMs } from './slots';

// ---- Segments: a fixed list, evaluated by the API over its projection ----

/** The five segments, in the order the screens list them, with a one-line description each. */
export const SEGMENTS: { segment: Segment; label: string; says: string }[] = [
  { segment: 'everyone', label: 'Everyone', says: 'Every customer in the sandbox.' },
  {
    segment: 'cake-last-30-days',
    label: 'Cake in the last 30 days',
    says: 'Customers with a cake order in the last 30 days.',
  },
  {
    segment: 'delivery-customers',
    label: 'Delivery customers',
    says: 'Customers who have had an order delivered.',
  },
  {
    segment: 'lapsed-60-days',
    label: 'Lapsed for 60 days',
    says: 'Customers with no order in the last 60 days, or none at all.',
  },
  {
    segment: 'catering-leads',
    label: 'Catering leads',
    says: 'Customers with an open catering inquiry, quote or accepted quote.',
  },
];

export const segmentLabel = (segment: string): string =>
  SEGMENTS.find((s) => s.segment === segment)?.label ?? segment.replaceAll('-', ' ');

export const segmentSays = (segment: string): string =>
  SEGMENTS.find((s) => s.segment === segment)?.says ?? '';

// ---- Templates: subjects and bodies are chosen, never typed ----

/** The six subjects: the slug the API takes, a short label for the select, and the text sent. */
export const SUBJECTS: { value: SubjectTemplate; label: string; text: string }[] = [
  { value: 'weekend-bake', label: 'Weekend bake', text: 'This weekend at Proof of Concept Bakery' },
  { value: 'cake-week', label: 'Cake week', text: 'It is cake week' },
  { value: 'new-season', label: 'New season', text: 'New on the seasonal menu' },
  { value: 'we-miss-you', label: 'We miss you', text: 'We have missed you at the counter' },
  { value: 'catering-season', label: 'Catering season', text: 'Catering dates are filling up' },
  { value: 'thank-you', label: 'Thank you', text: 'Thank you for baking with us' },
];

const GREETING = 'Hello from Proof of Concept Bakery. ';

/** The six bodies: the slug, a label, and the message as the inbox will show it. */
export const BODIES: { value: BodyTemplate; label: string; text: string }[] = [
  {
    value: 'announcement',
    label: 'Announcement',
    text: `${GREETING}There is news from the bakery this week. Look in on the storefront to see it.`,
  },
  {
    value: 'fresh-bread',
    label: 'Fresh bread',
    text: `${GREETING}The country loaf and the seeded rye come out of the oven before the counter opens at seven. Order ahead for a pickup slot.`,
  },
  {
    value: 'cake-orders',
    label: 'Cake orders',
    text: `${GREETING}Whole cakes need two days' notice. Pick a slot two days out and we will have it boxed and ready.`,
  },
  {
    value: 'seasonal-menu',
    label: 'Seasonal menu',
    text: `${GREETING}The seasonal items are back while the season lasts. Find them on the menu, marked seasonal.`,
  },
  {
    value: 'come-back',
    label: 'Come back',
    text: `${GREETING}It has been a while. Your loyalty points are waiting, and so is the morning bun.`,
  },
  {
    value: 'catering-invite',
    label: 'Catering invitation',
    text: `${GREETING}Planning a breakfast, a lunch or a celebration? Send an inquiry at least a week ahead and we will quote it.`,
  },
];

/** The subject as sent, or the slug spelled out for one this page does not know. */
export const subjectText = (subject: string): string =>
  SUBJECTS.find((s) => s.value === subject)?.text ?? subject.replaceAll('-', ' ');

export const subjectLabel = (subject: string): string =>
  SUBJECTS.find((s) => s.value === subject)?.label ?? subject.replaceAll('-', ' ');

export const bodyLabel = (body: string): string =>
  BODIES.find((b) => b.value === body)?.label ?? body.replaceAll('-', ' ');

/** The preview of a body: the text the inbox will show a recipient. Empty for an unknown body. */
export const bodyPreview = (body: string): string =>
  BODIES.find((b) => b.value === body)?.text ?? '';

// ---- Campaigns: the state decides which buttons exist ----

export type CampaignAction = 'edit' | 'schedule' | 'cancel';

/**
 * What a campaign in each state offers, which mirrors docs/domain.md's diagram: a draft is
 * edited, scheduled or cancelled; a scheduled one can only be cancelled (it returns to draft);
 * a sent or cancelled one is finished. A hint only: the API answers 409 `out-of-order` otherwise.
 */
export const CAMPAIGN_ACTIONS: Record<CampaignState, CampaignAction[]> = {
  draft: ['edit', 'schedule', 'cancel'],
  scheduled: ['cancel'],
  sent: [],
  cancelled: [],
};

export const campaignActions = (state: CampaignState): CampaignAction[] =>
  CAMPAIGN_ACTIONS[state] ?? [];

export const STATE_LABELS: Record<CampaignState, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

export const campaignStateLabel = (state: string): string =>
  STATE_LABELS[state as CampaignState] ?? state;

/** The cancel button's words: from `scheduled` it only unschedules. */
export const cancelLabel = (state: CampaignState): string =>
  state === 'scheduled' ? 'Unschedule (back to draft)' : 'Cancel campaign';

/** One sentence on what a state means, for the card, after the state's own label. */
export function stateSays(state: CampaignState): string {
  switch (state) {
    case 'draft':
      return 'Not scheduled. Edit it, schedule it, or cancel it.';
    case 'scheduled':
      return 'Waiting for its send time. Advance the clock past it and it sends.';
    case 'sent':
      return 'The recipients were fixed at the moment it sent.';
    case 'cancelled':
      return 'Nothing was sent.';
  }
}

/**
 * What the foot of a campaign card says right after Schedule. The state line above already says it
 * is scheduled and what moves it on, so this names only the time that was set.
 */
export const scheduledSaid = (sendAt: string): string => `Send time set: ${sendAtText(sendAt)}.`;

// ---- The send time: Mountain wall clock, minute precision ----

/** The API refuses a send time less than this many minutes ahead of business time. */
export const MIN_LEAD_MINUTES = 15;

/** The earliest send time the page suggests, as the wire writes it: business now plus 15 minutes, up to the next whole minute. */
export function earliestSendAt(businessNowMs: number): string {
  const ms = businessNowMs + MIN_LEAD_MINUTES * 60_000;
  return businessTime(Math.ceil(ms / 60_000) * 60_000);
}

/** What a `datetime-local` input holds for a wire time: `2026-11-08T09:30`. */
export const inputValueOf = (wire: string): string => wire.slice(0, 16);

const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The wire time for what a `datetime-local` input holds (Mountain), or null when it is not a time. */
export function sendAtFromInput(value: string): string | null {
  const m = INPUT.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi] = m;
  const hours = Number(h);
  const minutes = Number(mi);
  if (hours > 23 || minutes > 59) return null;
  const date = `${y}-${mo}-${d}`;
  const ms = mountainToMs(date, hours * 60 + minutes);
  // 2026-11-31 rolls over to December: only a date that survives the round trip is a date.
  const wire = businessTime(ms);
  return wire.slice(0, 10) === date ? wire : null;
}

/** "Sun 8 Nov, 9:30 am" for a send time; the wire text when it cannot be read. */
export function sendAtText(wire: string): string {
  return Number.isNaN(Date.parse(wire)) ? wire : momentText(wire);
}

// ---- The stats ----

/** A share of `whole` as a whole percent, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((100 * part) / whole) : null;
}

/** "45%", or a dash when there is no denominator. */
export const percentText = (part: number, whole: number): string => {
  const p = percent(part, whole);
  return p === null ? '–' : `${p}%`;
};

export interface CampaignStats {
  recipients: number;
  delivered: number;
  opened: number;
  clicked: number;
  /** Opened over delivered, as a percent. */
  openRate: number | null;
  /** Clicked over delivered, as a percent. */
  clickRate: number | null;
}

/** The counts the API gave and the two rates over delivered messages. */
export function campaignStats(c: CampaignResponse): CampaignStats {
  return {
    recipients: c.recipients,
    delivered: c.delivered,
    opened: c.opened,
    clicked: c.clicked,
    openRate: percent(c.opened, c.delivered),
    clickRate: percent(c.clicked, c.delivered),
  };
}

// ---- The lead pipeline ----

/** The stages in the order a lead moves through them, then the three ways it ends. */
export const LEAD_STAGES: { stage: LeadStage; label: string }[] = [
  { stage: 'inquiry', label: 'Inquiry' },
  { stage: 'quoted', label: 'Quoted' },
  { stage: 'accepted', label: 'Accepted' },
  { stage: 'won', label: 'Won (deposit paid)' },
  { stage: 'lost', label: 'Lost' },
  { stage: 'closed', label: 'Closed (delivered and paid)' },
];

export const leadStageLabel = (stage: string): string =>
  LEAD_STAGES.find((s) => s.stage === stage)?.label ?? stage;

/** The answer's stages in pipeline order, with a zero for any stage the answer left out. */
export function orderedStages(stages: LeadStageView[]): LeadStageView[] {
  const known = LEAD_STAGES.map(
    ({ stage }) => stages.find((s) => s.stage === stage) ?? { stage, count: 0, events: [] },
  );
  const unknown = stages.filter((s) => !LEAD_STAGES.some((l) => l.stage === s.stage));
  return [...known, ...unknown];
}

// ---- The rebuild ----

/** The progress bar's percent: 100 when finished, 0 when nothing is known, else applied over total. */
export function rebuildPercent(r: Pick<RebuildResponse, 'state' | 'applied' | 'total'>): number {
  if (r.state === 'finished') return 100;
  if (r.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((100 * r.applied) / r.total)));
}

/** One sentence on where the rebuild is. */
export function rebuildSays(r: RebuildResponse): string {
  switch (r.state) {
    case 'idle':
      return 'No rebuild is running.';
    case 'rebuilding':
      return `Rebuilding: ${r.applied} of ${r.total} events replayed.`;
    case 'finished':
      return `Finished: ${r.applied} of ${r.total} events replayed${r.ms == null ? '' : ` in ${r.ms} ms`}.`;
  }
}

/** Reading the rebuild every second, for up to two minutes (the replay is 200 events per alarm). */
export const REBUILD_POLL: Pick<PollOptions, 'intervalMs' | 'limitMs'> = {
  intervalMs: 1_000,
  limitMs: 120_000,
};

/**
 * Asks for the rebuild every second until it is no longer `rebuilding`. `onTick` sees every answer,
 * so the bar moves. The sleep and the stop flag are parameters so a test runs it in no time.
 */
export function watchRebuild(
  read: () => Promise<RebuildResponse>,
  onTick: (r: RebuildResponse) => void,
  options: PollOptions,
): Promise<Polled<RebuildResponse>> {
  return pollUntil(
    async () => {
      const answer = await read();
      onTick(answer);
      return answer;
    },
    (r) => (r.state === 'rebuilding' ? null : 'paid'),
    { ...REBUILD_POLL, ...options },
  );
}

// ---- Customers ----

/** "Zone 1" for `z1`. */
export const zoneLabel = (zone: string): string => {
  const m = /^z(\d+)$/.exec(zone);
  return m === null ? zone : `Zone ${m[1]}`;
};

/**
 * Whether the page offers the consent toggle: staff (a signed-in session) always, a guest only for
 * their own persona. A hint: the API answers 403 `guest-scope` otherwise.
 */
export const canChangeConsent = (
  isGuest: boolean,
  personaId: string,
  customerId: string,
): boolean => !isGuest || personaId === customerId;

export const consentLabel = (marketing: boolean): string =>
  marketing ? 'Marketing email: yes' : 'Marketing email: no';

/** A bakery date or a business time, in words (lib/when.ts, the one formatter). */
export { whenText };

/** The timeline newest first. The sort is stable, so entries at one instant keep the API's order. */
export function newestFirst<T extends Pick<TimelineEntry, 'at'>>(entries: T[]): T[] {
  return [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || 0);
}

// ---- Idempotency keys ----

/**
 * One intent, one key. The same fingerprint after an unanswered request or a 5xx sends the same
 * key, so the API replays the first answer; after an answer or a refusal the next click is a new
 * intent with a new key (lib/attempt.ts). The consent toggle, the campaign buttons and the
 * rebuild each keep one of these.
 */
export class KeyedAction {
  private previous: Attempt | null = null;
  private readonly mint: (() => string) | undefined;

  constructor(mint?: () => string) {
    this.mint = mint;
  }

  async run<T>(fingerprint: string, send: (key: string) => Promise<T>): Promise<T> {
    const current = attemptFor(this.previous, fingerprint, this.mint);
    this.previous = current;
    try {
      const answer = await send(current.key);
      this.previous = null;
      return answer;
    } catch (e) {
      if (!keepKeyAfter(e)) this.previous = null;
      throw e;
    }
  }
}
