// The API reference page's builder (src/lib/openapi.ts) against the real document: every operation
// is rendered once, every $ref resolves, the socket section is there, and a command's example body
// is one the request schema accepts. The built page itself is checked in dist.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  bodyProblems,
  buildPage,
  exampleBody,
  paragraphs,
  spans,
  type OpenApiDoc,
} from '../src/lib/openapi';
import type { Json, Schema } from '../src/lib/schema-check';

const doc = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/docs/api/openapi.json', import.meta.url)), 'utf8'),
) as OpenApiDoc;
const page = buildPage(doc);
const views = page.tags.flatMap((tag) => tag.operations);

const documented: { id: string; method: string; path: string }[] = [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      documented.push({
        id: (op as { operationId: string }).operationId,
        method: method.toUpperCase(),
        path,
      });
    }
  }
}

describe('every operation is rendered once', () => {
  test('the page has exactly the document’s operations, none twice', () => {
    expect(documented.length).toBeGreaterThanOrEqual(72);
    expect(views.map((v) => v.id).sort()).toEqual(documented.map((d) => d.id).sort());
    expect(new Set(views.map((v) => v.id)).size).toBe(views.length);
    expect(page.operationCount).toBe(documented.length);
  });

  test('each carries its method, path, summary, session words and a described answer', () => {
    for (const d of documented) {
      const v = views.find((x) => x.id === d.id);
      expect(v?.method, d.id).toBe(d.method);
      expect(v?.path, d.id).toBe(d.path);
      expect(v?.summary.trim(), d.id).not.toBe('');
      expect(v?.session.trim(), d.id).not.toBe('');
      expect(v?.answers.length, d.id).toBeGreaterThan(0);
      for (const answer of v?.answers ?? [])
        expect(answer.description.length, d.id).toBeGreaterThan(0);
    }
  });

  test('operations are grouped under the document’s tags, in its order, with a title each', () => {
    expect(page.tags.map((t) => t.name)).toEqual(doc.tags.map((t) => t.name));
    for (const tag of page.tags) {
      expect(tag.title.trim()).not.toBe('');
      expect(tag.operations.length).toBeGreaterThan(0);
    }
  });

  test('the problem slugs of the answers are listed, and an error answer is a problem document', () => {
    const order = views.find((v) => v.id === 'place-order');
    const refused = order?.answers.find((a) => a.status === '422');
    expect(refused?.problems).toEqual(['no-such-slot', 'closed-day', 'order', 'idempotency-key']);
    expect(refused?.contentType).toBe('application/problem+json');
    expect(refused?.schema).toBe('Problem');
    expect(order?.answers.find((a) => a.status === '201')?.schema).toBe('OrderResponse');
  });
});

describe('references and schemas', () => {
  test('every $ref in the document resolves, and the schemas section holds each component once', () => {
    const refs = new Set<string>();
    JSON.stringify(doc, (key, value: unknown) => {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      return value;
    });
    expect(refs.size).toBeGreaterThan(50);
    expect(page.schemas.map((s) => s.name)).toEqual(Object.keys(doc.components.schemas).sort());
    for (const ref of refs) {
      if (ref.startsWith('#/components/schemas/')) {
        expect(
          page.schemas.some((s) => `#/components/schemas/${s.name}` === ref),
          ref,
        ).toBe(true);
      }
    }
  });

  test('a $ref that points nowhere stops the build instead of leaving a gap', () => {
    const broken = structuredClone(doc);
    const post = broken.paths['/v1/sandboxes/{id}/faults']?.['post'] as {
      requestBody: { content: { 'application/json': { schema: { $ref: string } } } };
    };
    post.requestBody.content['application/json'].schema.$ref = '#/components/schemas/Nope';
    expect(() => buildPage(broken)).toThrow(/points nowhere/);
    const loose = structuredClone(doc);
    (loose.paths['/v1/health']?.['get'] as { responses: Record<string, unknown> }).responses[
      '200'
    ] = {
      description: 'x',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
    };
    expect(() => buildPage(loose)).toThrow(/points nowhere/);
  });

  test('a request body becomes a table: names, types, required marks and the allowed values', () => {
    const fault = views.find((v) => v.id === 'set-fault')?.request?.view;
    expect(fault?.name).toBe('FaultRequest');
    expect(fault?.rows.map((r) => [r.name, r.type, r.required, r.limits])).toEqual([
      ['fault', 'FaultName', true, 'one of inbox, kitchen'],
      ['on', 'boolean', true, ''],
    ]);
    expect(fault?.rows[0]?.ref).toBe('FaultName');
  });

  test('numbers show their limits, arrays what they hold, and nullable members say so', () => {
    const traffic = views.find((v) => v.id === 'start-traffic')?.request?.view;
    expect(traffic?.rows[0]).toMatchObject({ name: 'rate', type: 'integer', limits: '0 to 255' });
    const order = views.find((v) => v.id === 'place-order')?.request?.view;
    expect(order?.rows.find((r) => r.name === 'lines')).toMatchObject({
      type: 'array of OrderLineRequest',
      ref: 'OrderLineRequest',
    });
    expect(order?.rows.find((r) => r.name === 'note')?.type).toBe('string or null');
  });

  test('an enum schema is a list of values', () => {
    expect(page.schemas.find((s) => s.name === 'FaultName')?.values).toEqual(['inbox', 'kitchen']);
    expect(page.schemas.find((s) => s.name === 'ClockStep')?.values).toEqual([
      '15m',
      '1h',
      '1d',
      'next-opening',
    ]);
  });

  test('the answer’s schema is drawn as a table too, for an operation that returns one', () => {
    const token = views.find((v) => v.id === 'issue-token')?.success;
    expect(token?.name).toBe('TokenResponse');
    expect(token?.rows.map((r) => r.name)).toEqual(['expires_at', 'issued_at', 'token', 'token_v']);
  });
});

describe('the kitchen socket section', () => {
  test('is built from x-websocket, with every frame', () => {
    expect(page.socket?.operation).toBe('kitchen-socket');
    expect(page.socket?.frames.map((f) => f.t)).toEqual(
      expect.arrayContaining(['snapshot', 'evt', 'presence', 'bye', 'cmd', 'ack', 'nack']),
    );
    expect(page.socket?.frames).toHaveLength(9);
    expect(page.socket?.description.length).toBeGreaterThan(0);
  });

  test('a document without a socket has no section', () => {
    const none = structuredClone(doc);
    delete (none.paths['/v1/sandboxes/{id}/kitchen/ws']?.['get'] as Record<string, unknown>)[
      'x-websocket'
    ];
    expect(buildPage(none).socket).toBeNull();
  });
});

describe('the curl for each operation', () => {
  test('carries the token placeholder exactly where a token is accepted', () => {
    for (const v of views) {
      if (v.curl === null) continue;
      expect(v.curl.includes("'Authorization: Bearer <your token>'"), v.id).toBe(v.bearer);
    }
  });

  test('a POST carries an Idempotency-Key placeholder and a GET does not', () => {
    for (const v of views) {
      if (v.curl === null) continue;
      expect(v.curl.includes('Idempotency-Key'), v.id).toBe(v.method === 'POST');
    }
  });

  test('a route a terminal cannot call says why instead of printing a command that fails', () => {
    for (const id of ['issue-token', 'rotate-token', 'kitchen-socket', 'signout', 'session']) {
      const v = views.find((x) => x.id === id);
      expect(v?.curl, id).toBeNull();
      expect(v?.curlNote, id).not.toBeNull();
    }
    expect(views.find((v) => v.id === 'get-token')?.curl).not.toBeNull();
    expect(views.find((v) => v.id === 'health')?.curl).toBe(
      `curl '${doc.servers[0]?.url}/v1/health'`,
    );
  });

  test('path parameters are placeholders in angle brackets', () => {
    expect(views.find((v) => v.id === 'refund')?.curl).toContain(
      '/v1/sandboxes/<sandbox id>/orders/<oid>/refund',
    );
  });

  test('every example body is one the request schema accepts', () => {
    let checked = 0;
    for (const v of views) {
      if (v.curl === null || v.request === null) continue;
      const body = /-d '(.*)'$/s.exec(v.curl)?.[1];
      expect(body, v.id).toBeDefined();
      const schema = { $ref: `#/components/schemas/${v.request.schema}` } as Schema;
      expect(bodyProblems(doc, schema, JSON.parse(body as string) as Json), v.id).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('a body is built from the required members only, with the first allowed value of an enum', () => {
    const schema = { $ref: '#/components/schemas/ProposeRequest' } as Schema;
    expect(exampleBody(doc, schema)).toEqual({ vans: 1, capacity: 1 });
    expect(exampleBody(doc, { $ref: '#/components/schemas/FaultRequest' } as Schema)).toEqual({
      fault: 'inbox',
      on: false,
    });
  });
});

describe('words', () => {
  test('backticks make code spans, and a single newline is a space', () => {
    expect(spans('A `GET` of\nthe thing')).toEqual([
      { text: 'A ', code: false },
      { text: 'GET', code: true },
      { text: ' of the thing', code: false },
    ]);
    expect(spans(undefined)).toEqual([]);
  });

  test('a blank line starts a new paragraph', () => {
    expect(paragraphs('One.\n\nTwo `x`.')).toHaveLength(2);
    expect(paragraphs(undefined)).toEqual([]);
  });

  test('the document’s own description names the bearer header, the key and the problem type', () => {
    const intro = page.intro
      .flat()
      .map((s) => s.text)
      .join('');
    expect(intro).toContain('Authorization');
    expect(intro).toContain('Idempotency-Key');
    expect(intro).toContain('application/problem+json');
  });
});
