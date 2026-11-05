import { describe, expect, test } from 'vitest';
import { check, resolveRef, type Document, type Schema } from '../src/lib/schema-check';

// The tour's body check, on its own, against a tiny document: each rule it enforces.
const doc: Document = {
  components: {
    schemas: {
      Kind: { enum: ['pickup', 'delivery'], type: 'string' },
      Step: {
        oneOf: [
          { const: '15m', type: 'string' },
          { const: '1d', type: 'string' },
        ],
      },
      Line: {
        type: 'object',
        additionalProperties: false,
        required: ['variant', 'qty'],
        properties: {
          variant: { type: 'string' },
          qty: { type: 'integer', minimum: 1, maximum: 9 },
        },
      },
      Order: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'lines'],
        properties: {
          kind: { $ref: '#/components/schemas/Kind' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } },
          note: { type: ['string', 'null'] },
          step: { anyOf: [{ $ref: '#/components/schemas/Step' }, { type: 'null' }] },
        },
      },
    },
  },
};
const order = (value: unknown) =>
  check(doc, { $ref: '#/components/schemas/Order' }, value as never);

describe('check', () => {
  test('accepts a body that fits, with optional members left out', () => {
    expect(order({ kind: 'pickup', lines: [{ variant: 'a', qty: 2 }] })).toEqual([]);
    expect(order({ kind: 'delivery', lines: [], note: null, step: '1d' })).toEqual([]);
    expect(order({ kind: 'delivery', lines: [], step: null })).toEqual([]);
  });

  test('names a missing required key, with its path', () => {
    expect(order({ kind: 'pickup' })).toEqual(['$: missing required key "lines"']);
    expect(order({ kind: 'pickup', lines: [{ variant: 'a' }] })).toEqual([
      '$.lines[0]: missing required key "qty"',
    ]);
  });

  test('refuses a key the schema forbids, and allows one where the schema does not forbid it', () => {
    expect(order({ kind: 'pickup', lines: [], extra: 1 })).toEqual(['$: unknown key "extra"']);
    expect(check({}, { type: 'object', properties: {} }, { anything: 1 })).toEqual([]);
  });

  test('refuses a value outside an enum or a union of constants', () => {
    expect(order({ kind: 'courier', lines: [] })[0]).toContain('is not one of');
    expect(order({ kind: 'pickup', lines: [], step: '2d' })[0]).toContain('matches none');
  });

  test('checks types, including integer against number and null where it is allowed', () => {
    expect(order({ kind: 'pickup', lines: 'none' })[0]).toContain('string where array');
    expect(order({ kind: 'pickup', lines: [{ variant: 'a', qty: 1.5 }] })[0]).toContain(
      'number where integer',
    );
    expect(check({}, { type: 'number' }, 3)).toEqual([]);
    expect(order({ kind: 'pickup', lines: [], note: 4 })[0]).toContain(
      'integer where string or null',
    );
  });

  test('checks the limits on a number', () => {
    expect(order({ kind: 'pickup', lines: [{ variant: 'a', qty: 0 }] })[0]).toContain('below 1');
    expect(order({ kind: 'pickup', lines: [{ variant: 'a', qty: 10 }] })[0]).toContain('above 9');
  });

  test('reports a $ref that points nowhere instead of passing', () => {
    expect(check(doc, { $ref: '#/components/schemas/Gone' }, {})).toEqual([
      '$: unresolved #/components/schemas/Gone',
    ]);
    expect(resolveRef(doc, '#/definitions/Kind')).toBeUndefined();
  });

  test('a constant must match exactly', () => {
    const schema: Schema = { const: 'proposed' };
    expect(check({}, schema, 'proposed')).toEqual([]);
    expect(check({}, schema, 'submitted')[0]).toContain('must be "proposed"');
  });
});
