import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { CampaignResponse, CampaignState, RebuildResponse } from '../src/contracts';
import { ApiError, NetworkError } from '../src/lib/api';
import {
  BODIES,
  CAMPAIGN_ACTIONS,
  KeyedAction,
  LEAD_STAGES,
  SEGMENTS,
  SUBJECTS,
  bodyLabel,
  bodyPreview,
  campaignActions,
  campaignStateLabel,
  campaignStats,
  canChangeConsent,
  cancelLabel,
  earliestSendAt,
  inputValueOf,
  leadStageLabel,
  newestFirst,
  orderedStages,
  percent,
  percentText,
  rebuildPercent,
  rebuildSays,
  segmentLabel,
  sendAtFromInput,
  subjectText,
  watchRebuild,
  whenText,
  zoneLabel,
} from '../src/lib/crm';

const campaign = (extra: Partial<CampaignResponse> = {}): CampaignResponse => ({
  campaign: '01JTESTCAMPAIGN00000000AA',
  state: 'sent',
  subject: 'cake-week',
  body: 'cake-orders',
  segment: 'everyone',
  send_at: '2026-11-08T09:30:00-07:00',
  recipients: 40,
  delivered: 40,
  opened: 18,
  clicked: 6,
  ...extra,
});

describe('the campaign state table', () => {
  test('a draft is edited, scheduled or cancelled; a scheduled one only cancelled; the rest are done', () => {
    expect(campaignActions('draft')).toEqual(['edit', 'schedule', 'cancel']);
    expect(campaignActions('scheduled')).toEqual(['cancel']);
    expect(campaignActions('sent')).toEqual([]);
    expect(campaignActions('cancelled')).toEqual([]);
  });

  test('every state the contract names has a row and a label', () => {
    const states: CampaignState[] = ['draft', 'scheduled', 'sent', 'cancelled'];
    expect(Object.keys(CAMPAIGN_ACTIONS).sort()).toEqual([...states].sort());
    for (const s of states) expect(campaignStateLabel(s)).not.toBe(s);
  });

  test('cancelling a scheduled campaign is called unscheduling, because it returns to draft', () => {
    expect(cancelLabel('scheduled')).toMatch(/draft/);
    expect(cancelLabel('draft')).toBe('Cancel campaign');
  });
});

describe('the templates and segments', () => {
  test('the contract’s enums, in order, each with a label', () => {
    expect(SUBJECTS.map((s) => s.value)).toEqual([
      'weekend-bake',
      'cake-week',
      'new-season',
      'we-miss-you',
      'catering-season',
      'thank-you',
    ]);
    expect(BODIES.map((b) => b.value)).toEqual([
      'announcement',
      'fresh-bread',
      'cake-orders',
      'seasonal-menu',
      'come-back',
      'catering-invite',
    ]);
    expect(SEGMENTS.map((s) => s.segment)).toEqual([
      'everyone',
      'cake-last-30-days',
      'delivery-customers',
      'lapsed-60-days',
      'catering-leads',
    ]);
    for (const s of SEGMENTS) expect(s.says.length).toBeGreaterThan(10);
  });

  test('labels and previews, and a plain fallback for a slug the page does not know', () => {
    expect(subjectText('cake-week')).toBe('It is cake week');
    expect(bodyLabel('catering-invite')).toBe('Catering invitation');
    expect(bodyPreview('come-back')).toMatch(
      /^Hello from Proof of Concept Bakery\. It has been a while/,
    );
    expect(bodyPreview('nope')).toBe('');
    expect(segmentLabel('lapsed-60-days')).toBe('Lapsed for 60 days');
    expect(segmentLabel('new-segment')).toBe('new segment');
  });

  test('no template holds an address, a link or a name field', () => {
    for (const t of [...SUBJECTS.map((s) => s.text), ...BODIES.map((b) => b.text)]) {
      expect(t).not.toMatch(/@|https?:|www\./);
    }
  });

  const file = fileURLToPath(new URL('../../../crates/domain/src/crm.rs', import.meta.url));
  const rust = existsSync(file) ? readFileSync(file, 'utf8') : null;

  test.skipIf(rust === null)(
    'the subjects, bodies and segments match crates/domain/src/crm.rs',
    () => {
      const text = rust ?? '';
      // `SubjectTemplate::X => "text"` arms appear twice (slug, text); the text arms follow the slugs.
      const arms = [...text.matchAll(/SubjectTemplate::(\w+) => "([^"]+)"/g)].map((m) => m[2]!);
      const slugs = SUBJECTS.map((s) => s.value);
      const texts = SUBJECTS.map((s) => s.text);
      expect(arms.slice(0, 6)).toEqual(slugs);
      expect(arms.slice(6, 12)).toEqual(texts);
      const bodySlugs = [...text.matchAll(/BodyTemplate::\w+ => "([a-z-]+)"/g)].map((m) => m[1]!);
      expect(bodySlugs.slice(0, 6)).toEqual(BODIES.map((b) => b.value));
      for (const b of BODIES) {
        const sentence = b.text
          .replace('Hello from Proof of Concept Bakery. ', '')
          .replaceAll("'", "'");
        expect(text, b.value).toContain(sentence);
      }
      expect(text).toContain('format!("Hello from Proof of Concept Bakery. {text}")');
      const segments = [...text.matchAll(/Segment::\w+ => "([a-z0-9-]+)"/g)].map((m) => m[1]!);
      expect(segments.slice(0, 5)).toEqual(SEGMENTS.map((s) => s.segment));
    },
  );
});

describe('the send time hint', () => {
  // 2026-11-05 17:07:30 UTC is 10:07:30 in Salt Lake City.
  const wall = Date.UTC(2026, 10, 5, 17, 7, 30);

  test('business now plus 15 minutes, up to the next whole minute', () => {
    expect(earliestSendAt(wall)).toBe('2026-11-05T10:23:00-07:00');
    expect(earliestSendAt(Date.UTC(2026, 10, 5, 17, 7, 0))).toBe('2026-11-05T10:22:00-07:00');
  });

  test('it follows the clock offset', () => {
    expect(earliestSendAt(wall + 86_400_000)).toBe('2026-11-06T10:23:00-07:00');
  });

  test('it crosses midnight', () => {
    // 2026-11-06 06:50 UTC is 23:50 on the 5th in Salt Lake City.
    expect(earliestSendAt(Date.UTC(2026, 10, 6, 6, 50, 0))).toBe('2026-11-06T00:05:00-07:00');
  });

  test('the input holds the wire time to the minute and reads back as the wire time', () => {
    const wire = earliestSendAt(wall);
    expect(inputValueOf(wire)).toBe('2026-11-05T10:23');
    expect(sendAtFromInput('2026-11-05T10:23')).toBe('2026-11-05T10:23:00-07:00');
  });

  test('the offset follows daylight time', () => {
    expect(sendAtFromInput('2026-07-01T09:00')).toBe('2026-07-01T09:00:00-06:00');
  });

  test('anything that is not a real date and time is null', () => {
    for (const bad of ['', 'tomorrow', '2026-11-31T09:00', '2026-11-05T25:00', '2026-11-05']) {
      expect(sendAtFromInput(bad), bad).toBeNull();
    }
  });
});

describe('the stats', () => {
  test('open and click rates are over delivered, as whole percents', () => {
    expect(campaignStats(campaign())).toEqual({
      recipients: 40,
      delivered: 40,
      opened: 18,
      clicked: 6,
      openRate: 45,
      clickRate: 15,
    });
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
  });

  test('nothing delivered has no rate, not zero and not NaN', () => {
    const none = campaignStats(
      campaign({ state: 'scheduled', delivered: 0, opened: 0, clicked: 0 }),
    );
    expect(none.openRate).toBeNull();
    expect(none.clickRate).toBeNull();
    expect(percentText(0, 0)).toBe('–');
    expect(percentText(18, 40)).toBe('45%');
  });
});

describe('the lead pipeline', () => {
  test('stages run inquiry to accepted, then won, lost and closed', () => {
    expect(LEAD_STAGES.map((s) => s.stage)).toEqual([
      'inquiry',
      'quoted',
      'accepted',
      'won',
      'lost',
      'closed',
    ]);
    expect(leadStageLabel('won')).toMatch(/Won/);
  });

  test('the answer is put in order and a missing stage is a zero', () => {
    const ordered = orderedStages([
      { stage: 'closed', count: 2, events: [] },
      { stage: 'inquiry', count: 5, events: [] },
      { stage: 'won', count: 1, events: [] },
    ]);
    expect(ordered.map((s) => [s.stage, s.count])).toEqual([
      ['inquiry', 5],
      ['quoted', 0],
      ['accepted', 0],
      ['won', 1],
      ['lost', 0],
      ['closed', 2],
    ]);
  });
});

describe('the rebuild', () => {
  const r = (state: RebuildResponse['state'], applied: number, total: number, ms?: number) =>
    ({ state, applied, total, ...(ms === undefined ? {} : { ms }) }) as RebuildResponse;

  test('progress is applied over total, rounded down, and 100 once finished', () => {
    expect(rebuildPercent(r('rebuilding', 0, 722))).toBe(0);
    expect(rebuildPercent(r('rebuilding', 200, 722))).toBe(27);
    expect(rebuildPercent(r('rebuilding', 721, 722))).toBe(99);
    expect(rebuildPercent(r('finished', 722, 722, 41))).toBe(100);
  });

  test('an empty log or a cursor past the end cannot break the bar', () => {
    expect(rebuildPercent(r('idle', 0, 0))).toBe(0);
    expect(rebuildPercent(r('rebuilding', 5, 0))).toBe(0);
    expect(rebuildPercent(r('rebuilding', 900, 722))).toBe(100);
  });

  test('the sentence names the counts and the milliseconds', () => {
    expect(rebuildSays(r('rebuilding', 200, 722))).toBe('Rebuilding: 200 of 722 events replayed.');
    expect(rebuildSays(r('finished', 722, 722, 41))).toBe(
      'Finished: 722 of 722 events replayed in 41 ms.',
    );
    expect(rebuildSays(r('idle', 0, 0))).toBe('No rebuild is running.');
  });

  test('the watch reads every second until the state is not rebuilding, and shows every answer', async () => {
    const answers = [
      r('rebuilding', 0, 722),
      r('rebuilding', 400, 722),
      r('finished', 722, 722, 30),
    ];
    const seen: number[] = [];
    const slept: number[] = [];
    const result = await watchRebuild(
      async () => answers.shift()!,
      (x) => seen.push(rebuildPercent(x)),
      { sleep: async (ms) => void slept.push(ms) },
    );
    expect(result.kind).toBe('paid');
    expect(seen).toEqual([0, 55, 100]);
    expect(slept).toEqual([1000, 1000]);
  });

  test('a failed read is a missed look; a stop ends the watch', async () => {
    let calls = 0;
    const result = await watchRebuild(
      async () => {
        calls += 1;
        if (calls === 1) throw new NetworkError();
        return r('finished', 10, 10, 1);
      },
      () => undefined,
      { sleep: async () => undefined },
    );
    expect(result.kind).toBe('paid');
    const stopped = await watchRebuild(
      async () => r('rebuilding', 1, 2),
      () => undefined,
      { sleep: async () => undefined, stopped: () => true },
    );
    expect(stopped.kind).toBe('stopped');
  });

  test('a rebuild that never ends times out after two minutes of looks', async () => {
    let slept = 0;
    const result = await watchRebuild(
      async () => r('rebuilding', 1, 2),
      () => undefined,
      { sleep: async (ms) => void (slept += ms) },
    );
    expect(result.kind).toBe('timeout');
    expect(slept).toBeGreaterThanOrEqual(120_000);
  });
});

describe('customers', () => {
  test('a guest may change only their own persona’s consent; a signed-in session anyone’s', () => {
    expect(canChangeConsent(true, 'A', 'A')).toBe(true);
    expect(canChangeConsent(true, 'A', 'B')).toBe(false);
    expect(canChangeConsent(false, 'A', 'B')).toBe(true);
  });

  test('zones, dates and the timeline order', () => {
    expect(zoneLabel('z2')).toBe('Zone 2');
    expect(zoneLabel('elsewhere')).toBe('elsewhere');
    expect(whenText(null)).toBe('never');
    expect(whenText('2026-11-07')).toBe('Saturday 2026-11-07');
    expect(whenText('2026-11-07T10:15:00-07:00')).toBe('10:15 am on Saturday 2026-11-07');
    expect(whenText('soon')).toBe('soon');
    const entries = [
      { at: '2026-11-01T09:00:00-07:00', n: 1 },
      { at: '2026-11-03T09:00:00-07:00', n: 2 },
      { at: '2026-11-02T09:00:00-07:00', n: 3 },
    ];
    expect(newestFirst(entries).map((e) => e.n)).toEqual([2, 3, 1]);
    expect(entries.map((e) => e.n)).toEqual([1, 2, 3]);
  });
});

describe('one intent, one key', () => {
  const problem = (status: number) =>
    new ApiError({ status, type: 'x/y', title: 't', detail: null, next_free: null }, null);
  const keys = () => {
    let n = 0;
    return () => `K${++n}`;
  };

  test('a retry after an unanswered request or a 5xx sends the same key', async () => {
    const used: string[] = [];
    const action = new KeyedAction(keys());
    const send = (outcome: unknown) => async (key: string) => {
      used.push(key);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    await action.run('a', send(new NetworkError())).catch(() => undefined);
    await action.run('a', send(problem(503))).catch(() => undefined);
    await action.run('a', send('ok'));
    expect(used).toEqual(['K1', 'K1', 'K1']);
  });

  test('after an answer, a refusal or a different intent the key is new', async () => {
    const used: string[] = [];
    const action = new KeyedAction(keys());
    const send = (outcome: unknown) => async (key: string) => {
      used.push(key);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    await action.run('a', send('ok'));
    await action.run('a', send(problem(422))).catch(() => undefined);
    await action.run('a', send('ok'));
    await action.run('b', send(new NetworkError())).catch(() => undefined);
    await action.run('c', send('ok'));
    expect(used).toEqual(['K1', 'K2', 'K3', 'K4', 'K5']);
  });
});
