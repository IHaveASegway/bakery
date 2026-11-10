// The guide's entries are data, and this is their build-time check (docs/architecture.md, "The
// guide"; ADR 0014): an entry's request is checked against crates/contracts, so it cannot drift from
// the API. It reads the OpenAPI document that crates/contracts generates and fails when an entry
// names a route, method or path the document does not have, when an example body does not fit the
// request schema, when a trigger is neither a route nor an event in the catalog, when a screen has
// no entries, when a console action has none, or when an entry's words run past their length.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  SCREENS,
  curlText,
  fillPath,
  maskToken,
  sentenceCount,
  shellQuote,
  takesToken,
  type CurlContext,
  type GuideEntry,
} from '../src/lib/guide';
import { check, type Document, type Json, type Schema } from '../src/lib/schema-check';
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
import { RAFT } from '../src/guide/principles';
import { ALL_ENTRIES, CONSOLE_ORDER, ENTRIES, OTHER_WRITES, PATHS } from '../src/guide';
import { DECISIONS, decisionRows } from '../src/guide/decisions';

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

const allSteps: GuideEntry[] = SCREENS.flatMap((screen) => ENTRIES[screen]);

describe('every screen has entries', () => {
  test.each(SCREENS)('%s has at least one entry, all of its own screen', (screen) => {
    expect(ENTRIES[screen].length).toBeGreaterThan(0);
    for (const step of ENTRIES[screen]) expect(step.screen).toBe(screen);
  });

  test('the screens are the ones the brief names, and sign-in', () => {
    expect([...SCREENS].sort()).toEqual(
      [
        'api',
        'catering',
        'checkout',
        'console',
        'order',
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

  test('entry ids are unique and every entry is complete', () => {
    const ids = allSteps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of allSteps) {
      expect(step.title.trim(), step.id).not.toBe('');
      expect(step.what.trim().length, step.id).toBeGreaterThan(30);
      expect(step.why.trim(), step.id).not.toBe('');
      expect(step.whenNot.trim(), step.id).not.toBe('');
      expect(step.api.note.trim(), step.id).not.toBe('');
      expect(step.principle.name.trim(), step.id).not.toBe('');
    }
  });
});

describe('every entry’s API request is in the OpenAPI document', () => {
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

  test('the same check holds for an entry whose example is wrong', () => {
    const order = operations.get('place-order')?.op.requestBody?.content['application/json']
      ?.schema as Schema;
    const bad = { kind: 'courier', slot: '2026-11-07T09:45:00-07:00', lines: [{ variant: 'x' }] };
    const problems = check(doc, order, bad);
    expect(problems.join('\n')).toContain('"courier"');
    expect(problems.join('\n')).toContain('missing required key "qty"');
  });
});

describe('every write the page can make has an entry', () => {
  const covered = new Set(allSteps.map((s) => s.api.routeId));

  test('every write under /v1/sandboxes/{id} appears in some entry’s api, but the token routes', () => {
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

  test('every route an entry names is a real operation, so none is invented to pass the check', () => {
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

  test('every event an entry names is in the catalog', () => {
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
    // Every essay is reached from at least one entry.
    const reached = new Set(
      allSteps.flatMap((s) => (s.principle.essay ? [s.principle.essay.url] : [])),
    );
    expect([...reached].sort()).toEqual(ESSAY_PAGES.map((e) => e.path).sort());
  });

  test('every principle is used by at least one entry', () => {
    const used = new Set(allSteps.map((s) => s.principle.id));
    const unused = PRINCIPLE_TABLE.map((p) => p.id).filter((id) => !used.has(id));
    expect(unused).toEqual([]);
    // The six that PR 12 says must each have a step (docs/roadmap.md, PR 12).
    for (const id of ['idempotency-keys', 'sagas', 'leases', 'admission', 'cqrs', 'time-travel']) {
      expect(used.has(id), id).toBe(true);
    }
  });

  test('an entry’s principle is the page’s principle, the same object, not a copy', () => {
    for (const step of allSteps)
      expect(step.principle, step.id).toBe(PRINCIPLES[step.principle.id]);
  });

  test('every entry’s target is a data-tour attribute that exists in a component or page', () => {
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

  test('the entries hold no email address, key-shaped string or real-looking secret', () => {
    const text = JSON.stringify(allSteps);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b(sk|pk|rk|whsec)_/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe('the request as a curl', () => {
  const origin = 'https://api.example.test';
  const replay = '01JC8Z6K3W9QF2N4T7XRB5M0HD';
  // A made-up token shape for the tests: two base64url parts, nothing signed.
  const token = 'eyJ2IjoxfQ.test-mac-0123456789abcdef';
  const sandboxId = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
  const post: GuideEntry['api'] = {
    routeId: 'set-fault',
    method: 'POST',
    path: '/v1/sandboxes/{id}/faults',
    body: { fault: 'kitchen', on: true },
    note: 'n',
  };
  const get: GuideEntry['api'] = {
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
    const status: GuideEntry['api'] = {
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
    const odd: GuideEntry['api'] = { ...post, body: { fault: "o'ven", on: true } };
    expect(curlText(odd, context(null), 'copy')).toContain(`-d '{"fault":"o'\\''ven","on":true}'`);
  });

  test('a token under 16 characters masks to an ellipsis alone', () => {
    expect(maskToken('short')).toBe('…');
  });

  test('every entry renders to a command that holds no token unless one is given', () => {
    for (const step of allSteps) {
      const bare = curlText(step.api, context(null), 'copy');
      expect(bare, step.id).not.toContain(token);
      expect(bare, step.id).toContain(origin);
      const withToken = curlText(step.api, context(token), 'screen');
      expect(withToken, step.id).not.toContain(token);
    }
  });
});

describe('the words: short enough to read beside a button', () => {
  test.each(allSteps.map((s) => [s.id, s] as const))('%s', (_, entry) => {
    // What: at most three short sentences. Why and when not: one sentence each.
    expect(sentenceCount(entry.what), `${entry.id}: what`).toBeLessThanOrEqual(3);
    expect(entry.what.length, `${entry.id}: what`).toBeLessThanOrEqual(240);
    expect(sentenceCount(entry.why), `${entry.id}: why`).toBe(1);
    expect(sentenceCount(entry.whenNot), `${entry.id}: when not`).toBe(1);
    expect(entry.why.length, `${entry.id}: why`).toBeLessThanOrEqual(150);
    expect(entry.whenNot.length, `${entry.id}: when not`).toBeLessThanOrEqual(150);
    // A when-not is a judgment, said the same way everywhere: "Not for ...", "Not where ...".
    expect(entry.whenNot, entry.id).toMatch(/^Not /);
    // The house style: no em-dash, curly apostrophes.
    for (const text of [entry.what, entry.why, entry.whenNot]) {
      expect(text, entry.id).not.toContain('—');
      expect(text, entry.id).not.toContain("'");
    }
  });

  test('counting sentences ignores a stop inside a number or a path', () => {
    expect(sentenceCount('One. Two.')).toBe(2);
    expect(sentenceCount('A rate of 8.50% applies.')).toBe(1);
    expect(sentenceCount('Until a /v2/, nothing is renamed.')).toBe(1);
    expect(sentenceCount('At 10:00 UTC. Then 36 hours.')).toBe(2);
  });
});

describe('triggers: what opens an entry as a live note', () => {
  const writes = new Set(
    [...operations.entries()]
      .filter(([, { method }]) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method))
      .map(([id]) => id),
  );
  const catalog = new Set<string>();
  for (const line of read('../../../docs/domain.md').split('\n')) {
    if (!line.startsWith('| `')) continue;
    for (const m of (line.split('|')[1] ?? '').matchAll(/`([A-Z][A-Za-z]+)`/g)) {
      catalog.add(m[1] as string);
    }
  }

  test('every trigger is a write route, the kitchen socket, or an event in the catalog', () => {
    for (const entry of allSteps) {
      for (const trigger of entry.triggers) {
        const ok = writes.has(trigger) || trigger === 'kitchen-socket' || catalog.has(trigger);
        expect(ok, `${entry.id}: ${trigger}`).toBe(true);
      }
    }
    expect(operations.get('kitchen-socket')?.method).toBe('GET');
  });

  test('a read never opens a note: no trigger is a GET route but the socket', () => {
    const reads = new Set(
      [...operations.entries()].filter(([, o]) => o.method === 'GET').map(([id]) => id),
    );
    for (const entry of allSteps) {
      for (const t of entry.triggers) {
        if (t !== 'kitchen-socket') expect(reads.has(t), `${entry.id}: ${t}`).toBe(false);
      }
    }
  });

  test('every write route an entry’s api names opens a note on some screen', () => {
    const triggered = new Set(allSteps.flatMap((e) => e.triggers));
    const named = allSteps.map((e) => e.api.routeId).filter((id) => writes.has(id));
    // The heartbeat is the board's own background call, never the visitor's: it opens nothing.
    const missing = named.filter((id) => id !== 'heartbeat' && !triggered.has(id));
    expect([...new Set(missing)]).toEqual([]);
  });

  test('the signature minute: the board’s buttons and placing an order each open a note', () => {
    const board = allSteps.find((e) => e.id === 'kitchen-board');
    expect(board?.triggers).toContain('kitchen-socket');
    expect(board?.triggers).toContain('OrderProductionStarted');
    const checkout = allSteps.find((e) => e.id === 'checkout-form');
    expect(checkout?.triggers).toContain('place-order');
  });
});

describe('the console’s order and the short paths', () => {
  test('the console’s entries are listed in the page’s order, each once', () => {
    expect(ENTRIES.console.map((e) => e.id)).toEqual(CONSOLE_ORDER);
    expect(ALL_ENTRIES).toHaveLength(allSteps.length);
  });

  test('a short path has at most five stops, each an entry of its own screen, with a verb', () => {
    for (const [screen, steps] of Object.entries(PATHS)) {
      expect(steps.length, screen).toBeGreaterThan(0);
      expect(steps.length, screen).toBeLessThanOrEqual(5);
      const ids = ENTRIES[screen as keyof typeof ENTRIES].map((e) => e.id);
      for (const step of steps) {
        expect(ids, `${screen}: ${step.entry}`).toContain(step.entry);
        expect(sentenceCount(step.do), step.entry).toBe(1);
        expect(step.do, step.entry).toMatch(/^[A-Z][a-z]+ /);
      }
    }
  });

  test('the signature minute is walkable: menu, checkout, then the board', () => {
    expect(PATHS.menu?.[0]?.entry).toBe('menu-list');
    expect(PATHS.checkout?.map((s) => s.entry)).toContain('checkout-form');
    expect(PATHS.console?.[0]?.entry).toBe('kitchen-board');
  });
});

describe('the decision table’s rows', () => {
  test('every principle has one row, spoken by an entry of its own principle', () => {
    expect(Object.keys(DECISIONS).sort()).toEqual(PRINCIPLE_TABLE.map((p) => p.id).sort());
    const rows = decisionRows();
    expect(rows.map((e) => e.principle.id)).toEqual(PRINCIPLE_TABLE.map((p) => p.id));
  });
});

describe('the writes no entry names', () => {
  test('are real write routes, with the document’s method and path', () => {
    for (const shape of OTHER_WRITES) {
      const found = operations.get(shape.routeId);
      expect(found, shape.routeId).toBeDefined();
      expect([found?.method, found?.path]).toEqual([shape.method, shape.path]);
    }
  });
});

describe('a hotspot’s name never contains a control’s', () => {
  // A hotspot is a button named "Under the hood: <title>". Role queries match names by substring,
  // so a title holding a control's label (an entry titled "Wipe now") makes the page's own button
  // ambiguous for a screen reader's list and for every spec that presses it. The specs' button
  // names are the controls a visitor presses; the guide's own (its bar and its panel) are left out.
  test('no entry’s hotspot name holds a button name the browser specs press', () => {
    const dir = new URL('../e2e/', import.meta.url);
    const names = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      for (const m of text.matchAll(/getByRole\(\s*'button',\s*\{\s*name:\s*'([^']+)'/g)) {
        names.add(m[1] as string);
      }
    }
    const own = ['Under the hood', 'Show me around', 'Recorder', 'Where the menu came from'];
    const pressed = [...names].filter((n) => !own.some((o) => n.startsWith(o)));
    expect(pressed.length).toBeGreaterThan(5);
    const hits = allSteps.flatMap((entry) =>
      pressed
        .filter((n) => `Under the hood: ${entry.title}`.toLowerCase().includes(n.toLowerCase()))
        .map((n) => `${entry.id} ~ ${n}`),
    );
    expect(hits).toEqual([]);
  });
});
