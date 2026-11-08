// The tour's steps are data, and this is their build-time check (Q41 · Q-tour, docs/architecture.md,
// "The tour": steps are checked at build against crates/contracts, so a request in a step cannot
// drift from the API). It reads the OpenAPI document that crates/contracts generates and fails
// when a step names a route, method or path the document does not have, when an example body does
// not fit the request schema, when a screen has no tour, or when a console action has no step.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  CLOSED,
  SCREENS,
  curlText,
  fillPath,
  keyAction,
  maskToken,
  parseSeen,
  progressText,
  recentEvents,
  shellQuote,
  takesToken,
  tourReduce,
  withSeen,
  type CurlContext,
  type TourState,
  type TourStep,
} from '../src/lib/tour';
import { check, type Document, type Json, type Schema } from '../src/lib/schema-check';
import { HOW } from '../src/tour/how';
import { PRINCIPLES, PRINCIPLE_TABLE } from '../src/lib/how-its-built';
import {
  ESSAYS,
  ESSAY_PAGES,
  LAB_SLUGS,
  NO_LAB,
  adrFile,
  adrUrl,
  essayOf,
  labUrl,
  type LabName,
} from '../src/lib/links';
import { RAFT } from '../src/tour/principles';
import { TOURS } from '../src/tour';

interface Operation {
  operationId: string;
  requestBody?: { content: Record<string, { schema: Schema }> };
  security?: Record<string, string[]>[];
}
interface Doc extends Document {
  paths: Record<string, Record<string, Operation>>;
}

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const doc = JSON.parse(read('../public/docs/api/openapi.json')) as Doc;

/** operationId -> its method (upper case), path and operation. */
const operations = new Map<string, { method: string; path: string; op: Operation }>();
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      operations.set(op.operationId, { method: method.toUpperCase(), path, op });
    }
  }
}

const allSteps: TourStep[] = SCREENS.flatMap((screen) => TOURS[screen]);

describe('every screen has a tour', () => {
  test.each(SCREENS)('%s has at least one step, all of its own screen', (screen) => {
    expect(TOURS[screen].length).toBeGreaterThan(0);
    for (const step of TOURS[screen]) expect(step.screen).toBe(screen);
  });

  test('the screens are the ones the brief names, and sign-in', () => {
    expect([...SCREENS].sort()).toEqual(
      [
        'api',
        'catering',
        'checkout',
        'console',
        'dispatch',
        'home',
        'inbox',
        'menu',
        'privacy',
        'signin',
        'status',
      ].sort(),
    );
  });

  test('step ids are unique and every step is complete', () => {
    const ids = allSteps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of allSteps) {
      expect(step.title.trim(), step.id).not.toBe('');
      expect(step.what.trim().length, step.id).toBeGreaterThan(30);
      expect(step.api.note.trim(), step.id).not.toBe('');
      expect(step.principle.name.trim(), step.id).not.toBe('');
    }
  });
});

describe('every step’s API request is in the OpenAPI document', () => {
  test.each(allSteps.map((s) => [s.id, s] as const))('%s', (_, step) => {
    const found = operations.get(step.api.routeId);
    expect(found, `route id ${step.api.routeId} is not in the document`).toBeDefined();
    expect(step.api.method).toBe(found?.method);
    expect(step.api.path).toBe(found?.path);
    // The bearer rule the curl uses (the sandbox's routes) matches what the document says.
    const bearer = (found?.op.security ?? []).some((r) => 'bearerToken' in r);
    expect(takesToken(step.api.path), `${step.id}: bearer`).toBe(bearer);
  });

  test.each(allSteps.map((s) => [s.id, s] as const))(
    '%s: the example body fits the request schema',
    (_, step) => {
      const op = operations.get(step.api.routeId)?.op;
      const schema = op?.requestBody?.content['application/json']?.schema;
      if (schema === undefined) {
        expect(step.api.body, 'a body for a route that takes none').toBeUndefined();
        return;
      }
      // A route whose body is optional may send none; otherwise the empty body is checked too.
      const problems = check(doc, schema, (step.api.body ?? {}) as Json);
      expect(problems).toEqual([]);
    },
  );

  test('the check really catches a missing key, an unknown key and a value outside an enum', () => {
    const schema = operations.get('set-fault')?.op.requestBody?.content['application/json']
      ?.schema as Schema;
    expect(check(doc, schema, { fault: 'kitchen', on: true })).toEqual([]);
    expect(check(doc, schema, { fault: 'kitchen' })).toEqual(['$: missing required key "on"']);
    expect(check(doc, schema, { fault: 'oven', on: true })[0]).toContain('is not one of');
    expect(check(doc, schema, { fault: 'kitchen', on: true, extra: 1 })).toEqual([
      '$: unknown key "extra"',
    ]);
    expect(check(doc, schema, { fault: 'kitchen', on: 'yes' })[0]).toContain(
      'string where boolean',
    );
  });

  test('the same check holds for a step whose example is wrong', () => {
    const order = operations.get('place-order')?.op.requestBody?.content['application/json']
      ?.schema as Schema;
    const bad = { kind: 'courier', slot: '2026-11-07T09:45:00-07:00', lines: [{ variant: 'x' }] };
    const problems = check(doc, order, bad);
    expect(problems.join('\n')).toContain('"courier"');
    expect(problems.join('\n')).toContain('missing required key "qty"');
  });
});

describe('every console action has a step', () => {
  const covered = new Set(allSteps.map((s) => s.api.routeId));

  test('every write under /v1/sandboxes/{id} appears in some step’s api, but the token routes', () => {
    const writes = [...operations.entries()].filter(
      ([, { method, path }]) =>
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
        path.startsWith('/v1/sandboxes/{id}'),
    );
    expect(writes.length).toBeGreaterThan(30);
    // The webhook is Stripe's (not under a sandbox), the socket is a GET, and the token routes
    // are the panel's own; those are the only exceptions.
    const exempt = new Set(['issue-token', 'rotate-token']);
    const missing = writes.map(([id]) => id).filter((id) => !exempt.has(id) && !covered.has(id));
    expect(missing).toEqual([]);
  });

  test('the account-level actions the console takes (a new sandbox, a wipe) are covered too', () => {
    expect(covered.has('create-sandbox')).toBe(true);
    expect(covered.has('wipe-sandbox')).toBe(true);
  });

  test('every route a step names is a real operation, so none is invented to pass the check', () => {
    for (const id of covered) expect(operations.has(id), id).toBe(true);
  });
});

describe('events, principles and targets', () => {
  const catalog = new Set<string>();
  for (const line of read('../../../docs/domain.md').split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] ?? '';
    for (const m of first.matchAll(/`([A-Z][A-Za-z]+)`/g)) catalog.add(m[1] as string);
  }

  test('the event catalog was read', () => {
    expect(catalog.size).toBeGreaterThan(60);
    expect(catalog.has('OrderPlaced')).toBe(true);
    expect(catalog.has('ApiTokenRotated')).toBe(true);
  });

  test('every event a step names is in the catalog', () => {
    for (const step of allSteps) {
      for (const name of step.events) expect(catalog.has(name), `${step.id}: ${name}`).toBe(true);
    }
  });

  test('every principle names a lab page from the principle map and an ADR that exists', () => {
    const labs = new Set([
      'Queue Lab',
      'Cache Lab',
      'Backfill Lab',
      'Route Lab',
      'Raft Lab',
      'none yet',
    ]);
    const adrs = readdirSync(fileURLToPath(new URL('../../../docs/adr/', import.meta.url)));
    for (const step of allSteps) {
      expect(labs.has(step.principle.lab), `${step.id}: ${step.principle.lab}`).toBe(true);
      expect(step.principle.adr, step.id).toMatch(/^\d{4}$/);
      expect(
        adrs.some((file) => file.startsWith(`${step.principle.adr}-`)),
        `${step.id}: ADR ${step.principle.adr}`,
      ).toBe(true);
    }
  });

  // The site's five lab pages (IHaveASegway/website, apps/web/src/pages/lab/, read 2026-11-06).
  const LAB_PAGES = [
    'https://ihaveasegway.com/lab/queue/',
    'https://ihaveasegway.com/lab/cache/',
    'https://ihaveasegway.com/lab/backfill/',
    'https://ihaveasegway.com/lab/raft/',
    'https://ihaveasegway.com/lab/routes/',
  ];

  test('every principle with a lab page links one of the five, and one with none links no lab', () => {
    for (const step of allSteps) {
      const { lab, labUrl } = step.principle;
      if (lab === 'none yet') expect(labUrl, step.id).toBeUndefined();
      else expect(LAB_PAGES, `${step.id}: ${lab}`).toContain(labUrl);
    }
    // And the map of names to slugs is the map of the five pages, one to one.
    expect(Object.keys(LAB_SLUGS).map((name) => labUrl(name as LabName))).toEqual(
      expect.arrayContaining(LAB_PAGES),
    );
    expect(Object.keys(LAB_SLUGS)).toHaveLength(LAB_PAGES.length);
    expect(labUrl(NO_LAB)).toBeUndefined();
  });

  test('every ADR URL names a file that exists in docs/adr/, on main', () => {
    const adrs = new Set(
      readdirSync(fileURLToPath(new URL('../../../docs/adr/', import.meta.url))),
    );
    const prefix = 'https://github.com/IHaveASegway/bakery/blob/main/docs/adr/';
    for (const step of allSteps) {
      const { adr, adrUrl } = step.principle;
      expect(adrUrl.startsWith(prefix), step.id).toBe(true);
      const file = adrUrl.slice(prefix.length);
      expect(adrs.has(file), `${step.id}: ${file}`).toBe(true);
      expect(file.startsWith(`${adr}-`), step.id).toBe(true);
    }
  });

  test('the ADR file names come from the directory, and an unknown number is an error', () => {
    expect(adrFile('0004')).toBe('0004-queues-between-objects-and-alarms-for-time.md');
    expect(() => adrFile('0999')).toThrow(/no ADR numbered 0999/);
    expect(() => adrFile('4')).toThrow();
    expect(adrUrl('0001', ['0001-a-made-up-record.md'])).toBe(
      'https://github.com/IHaveASegway/bakery/blob/main/docs/adr/0001-a-made-up-record.md',
    );
  });

  test('every principle links its own section of How it’s built, and one with an essay its essay', () => {
    for (const step of allSteps) {
      expect(step.principle.howUrl, step.id).toBe(`/how-its-built/#${step.principle.id}`);
      expect(step.principle.essay !== undefined, step.id).toBe(
        Object.hasOwn(ESSAYS, step.principle.id),
      );
      // Every principle has an essay, with a lab page or without.
      expect(step.principle.essay, step.id).toBeDefined();
      const essay = essayOf(step.principle.id);
      expect(step.principle.essay, step.id).toEqual(
        essay === undefined ? undefined : { url: essay.path, title: essay.title },
      );
    }
    expect(RAFT.essay).toEqual({
      url: '/how-its-built/single-writer/',
      title: 'Why a single-writer object needs no consensus',
    });
    // Every essay is reached from at least one tour step.
    const reached = new Set(
      allSteps.flatMap((s) => (s.principle.essay ? [s.principle.essay.url] : [])),
    );
    expect([...reached].sort()).toEqual(ESSAY_PAGES.map((e) => e.path).sort());
  });

  test('every principle is used by at least one tour step', () => {
    const used = new Set(allSteps.map((s) => s.principle.id));
    const unused = PRINCIPLE_TABLE.map((p) => p.id).filter((id) => !used.has(id));
    expect(unused).toEqual([]);
    // The six that PR 12 says must each have a step (docs/roadmap.md, PR 12).
    for (const id of ['idempotency-keys', 'sagas', 'leases', 'admission', 'cqrs', 'time-travel']) {
      expect(used.has(id), id).toBe(true);
    }
  });

  test('a step’s principle is the page’s principle, the same object, not a copy', () => {
    for (const step of allSteps)
      expect(step.principle, step.id).toBe(PRINCIPLES[step.principle.id]);
  });

  test('every step’s target is a data-tour attribute that exists in a component or page', () => {
    const files: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(next);
        else if (/\.(tsx|astro)$/.test(entry.name)) files.push(readFileSync(next, 'utf8'));
      }
    };
    walk(new URL('../src/', import.meta.url));
    const text = files.join('\n');
    for (const step of allSteps) {
      // Written as data-tour="x", or as data-tour={cond ? 'x' : undefined} where only one of many
      // elements is the target (the menu's first card).
      expect(text, `${step.id}: data-tour="${step.target}"`).toMatch(
        new RegExp(`data-tour=(?:"${step.target}"|\\{[^}]*'${step.target}')`),
      );
    }
  });

  test('the “How this works” lines are the tour’s steps: the same words, not a copy', () => {
    const whats = new Set(allSteps.map((s) => s.what));
    for (const [name, text] of Object.entries(HOW)) {
      expect(whats.has(text), `HOW.${name} is a step`).toBe(true);
    }
    // And the first step of each screen that carries one is that line, except the menu's, which
    // is the last because its line is the last thing on the page.
    expect(TOURS.menu.at(-1)?.what).toBe(HOW.menuSeed);
    expect(TOURS.catering[0]?.what).toBe(HOW.catering);
    expect(TOURS.inbox[0]?.what).toBe(HOW.inbox);
    expect(TOURS.dispatch[0]?.what).toBe(HOW.dispatch);
  });

  test('the tour holds no email address, key-shaped string or real-looking secret', () => {
    const text = JSON.stringify(allSteps);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b(sk|pk|rk|whsec)_/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe('moving through a tour', () => {
  const open = (index = 0): TourState => ({ open: true, index });

  test('open starts at the first step, or a named one kept inside the tour', () => {
    expect(tourReduce(CLOSED, { type: 'open' }, 9)).toEqual({ open: true, index: 0 });
    expect(tourReduce(CLOSED, { type: 'open', index: 4 }, 9)).toEqual({ open: true, index: 4 });
    expect(tourReduce(CLOSED, { type: 'open', index: 99 }, 9).index).toBe(8);
    expect(tourReduce(CLOSED, { type: 'open' }, 0).open).toBe(false);
  });

  test('next and back move one step, back stops at the first, and next on the last ends the tour', () => {
    expect(tourReduce(open(2), { type: 'next' }, 9).index).toBe(3);
    expect(tourReduce(open(2), { type: 'back' }, 9).index).toBe(1);
    expect(tourReduce(open(0), { type: 'back' }, 9).index).toBe(0);
    expect(tourReduce(open(8), { type: 'next' }, 9).open).toBe(false);
  });

  test('first and last jump; close keeps the place; nothing moves while closed', () => {
    expect(tourReduce(open(4), { type: 'first' }, 9).index).toBe(0);
    expect(tourReduce(open(4), { type: 'last' }, 9).index).toBe(8);
    expect(tourReduce(open(4), { type: 'close' }, 9)).toEqual({ open: false, index: 4 });
    expect(tourReduce(CLOSED, { type: 'next' }, 9)).toEqual(CLOSED);
    expect(tourReduce(CLOSED, { type: 'last' }, 9)).toEqual(CLOSED);
  });

  test('the progress reads “3 of 9”, counting from one', () => {
    expect(progressText(2, 9)).toBe('3 of 9');
    expect(progressText(0, 1)).toBe('1 of 1');
  });

  test('a tour can be walked end to end with next and ends, never past the last step', () => {
    for (const screen of SCREENS) {
      const total = TOURS[screen].length;
      let state = tourReduce(CLOSED, { type: 'open' }, total);
      let seen = 1;
      while (state.open) {
        state = tourReduce(state, { type: 'next' }, total);
        if (state.open) seen++;
      }
      expect(seen, screen).toBe(total);
    }
  });
});

describe('the keyboard', () => {
  test('arrows move, home and end jump, escape closes', () => {
    expect(keyAction('ArrowRight', false)).toEqual({ type: 'next' });
    expect(keyAction('ArrowDown', true)).toEqual({ type: 'next' });
    expect(keyAction('ArrowLeft', false)).toEqual({ type: 'back' });
    expect(keyAction('ArrowUp', true)).toEqual({ type: 'back' });
    expect(keyAction('Home', false)).toEqual({ type: 'first' });
    expect(keyAction('End', false)).toEqual({ type: 'last' });
    expect(keyAction('Escape', true)).toEqual({ type: 'close' });
  });

  test('enter goes forward on the card but belongs to a button or a link when the focus is on one', () => {
    expect(keyAction('Enter', false)).toEqual({ type: 'next' });
    expect(keyAction('Enter', true)).toBeNull();
  });

  test('Tab and every other key are left alone, so the focus is never trapped', () => {
    for (const key of ['Tab', 'Shift', 'a', ' ', 'PageDown'])
      expect(keyAction(key, false)).toBeNull();
  });
});

describe('seen, the one thing remembered', () => {
  test('reads only known screens set to true, and survives garbage', () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen('not json')).toEqual({});
    expect(parseSeen('[1,2]')).toEqual({});
    expect(parseSeen('{"menu":true,"nowhere":true,"home":"yes"}')).toEqual({ menu: true });
  });

  test('marking a screen seen keeps the others', () => {
    expect(withSeen({ menu: true }, 'home')).toEqual({ menu: true, home: true });
  });
});

describe('the request as a curl', () => {
  const origin = 'https://api.example.test';
  const replay = '01JC8Z6K3W9QF2N4T7XRB5M0HD';
  // A made-up token shape for the tests: two base64url parts, nothing signed.
  const token = 'eyJ2IjoxfQ.test-mac-0123456789abcdef';
  const sandboxId = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
  const post: TourStep['api'] = {
    routeId: 'set-fault',
    method: 'POST',
    path: '/v1/sandboxes/{id}/faults',
    body: { fault: 'kitchen', on: true },
    note: 'n',
  };
  const get: TourStep['api'] = {
    routeId: 'get-sandbox',
    method: 'GET',
    path: '/v1/sandboxes/{id}',
    note: 'n',
  };
  const context = (t: string | null, id: string | null = sandboxId): CurlContext => ({
    origin,
    sandboxId: id,
    token: t,
    key: replay,
  });

  test('masks the token on screen and carries it whole in the copy', () => {
    const screen = curlText(post, context(token), 'screen');
    const copy = curlText(post, context(token), 'copy');
    expect(maskToken(token)).toBe('eyJ2Ij…cdef');
    expect(screen).toContain('Authorization: Bearer eyJ2Ij…cdef');
    expect(screen).not.toContain(token);
    expect(copy).toContain(`Authorization: Bearer ${token}`);
  });

  test('says <your token> when the page holds none, on screen and in the copy', () => {
    for (const mode of ['screen', 'copy'] as const) {
      expect(curlText(post, context(null), mode)).toContain("'Authorization: Bearer <your token>'");
    }
  });

  test('is the exact command: method, URL, key, content type and the body', () => {
    expect(curlText(post, context(token), 'copy')).toBe(
      [
        `curl -X POST '${origin}/v1/sandboxes/${sandboxId}/faults'`,
        `-H 'Authorization: Bearer ${token}'`,
        `-H 'Idempotency-Key: ${replay}'`,
        `-H 'Content-Type: application/json'`,
        `-d '{"fault":"kitchen","on":true}'`,
      ].join(' \\\n  '),
    );
    expect(curlText(get, context(null), 'screen')).toBe(
      [
        `curl '${origin}/v1/sandboxes/${sandboxId}'`,
        `-H 'Authorization: Bearer <your token>'`,
      ].join(' \\\n  '),
    );
  });

  test('fills {id} from the sandbox and shows every other parameter as <name>', () => {
    expect(fillPath('/v1/sandboxes/{id}/orders/{oid}/refund', sandboxId)).toBe(
      `/v1/sandboxes/${sandboxId}/orders/<oid>/refund`,
    );
    expect(fillPath('/v1/sandboxes/{id}', null)).toBe('/v1/sandboxes/<sandbox id>');
  });

  test('a public route carries no Authorization header, and a GET no Idempotency-Key', () => {
    const status: TourStep['api'] = {
      routeId: 'status',
      method: 'GET',
      path: '/v1/status',
      note: 'n',
    };
    const text = curlText(status, context(token), 'copy');
    expect(text).toBe(`curl '${origin}/v1/status'`);
    expect(text).not.toContain(token);
  });

  test('quotes a single quote in a body so the shell reads it as written', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const odd: TourStep['api'] = { ...post, body: { fault: "o'ven", on: true } };
    expect(curlText(odd, context(null), 'copy')).toContain(`-d '{"fault":"o'\\''ven","on":true}'`);
  });

  test('a token under 16 characters masks to an ellipsis alone', () => {
    expect(maskToken('short')).toBe('…');
  });

  test('every step renders to a command that holds no token unless one is given', () => {
    for (const step of allSteps) {
      const bare = curlText(step.api, context(null), 'copy');
      expect(bare, step.id).not.toContain(token);
      expect(bare, step.id).toContain(origin);
      const withToken = curlText(step.api, context(token), 'screen');
      expect(withToken, step.id).not.toContain(token);
    }
  });
});

describe('the events of the last action', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');
  const entry = (type: string, secondsAgo: number) => ({
    type,
    at: new Date(now - secondsAgo * 1000).toISOString(),
    summary: `${type} happened`,
  });
  const feed = [
    entry('FaultSet', 5),
    entry('ClockAdvanced', 20),
    entry('FaultSet', 300),
    entry('MenuPublished', -2),
  ];

  test('keeps the step’s event types from the last minute, in the feed’s order', () => {
    expect(recentEvents(feed, ['FaultSet'], now).map((e) => e.type)).toEqual(['FaultSet']);
    expect(recentEvents(feed, ['FaultSet', 'ClockAdvanced'], now)).toHaveLength(2);
    expect(recentEvents(feed, ['OrderPlaced'], now)).toEqual([]);
  });

  test('leaves out an entry older than a minute and allows a few seconds of clock skew ahead', () => {
    expect(recentEvents([entry('FaultSet', 61)], ['FaultSet'], now)).toEqual([]);
    expect(recentEvents([entry('FaultSet', 60)], ['FaultSet'], now)).toHaveLength(1);
    expect(recentEvents(feed, ['MenuPublished'], now)).toHaveLength(1);
    expect(recentEvents([entry('FaultSet', -30)], ['FaultSet'], now)).toEqual([]);
  });

  test('an entry with an unreadable time is left out', () => {
    expect(
      recentEvents([{ type: 'FaultSet', at: 'soon', summary: 's' }], ['FaultSet'], now),
    ).toEqual([]);
  });
});
