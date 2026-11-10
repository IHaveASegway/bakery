// A small, hand-rolled check of a JSON value against the subset of JSON Schema the contracts'
// OpenAPI document uses (2020-12 as schemars writes it): $ref into #/components/schemas, type
// (a name or a list with "null"), enum, const, oneOf and anyOf, required, properties,
// additionalProperties: false, items, and minimum and maximum. It is for the guide's build-time
// check (test/guide.test.ts): an entry's example body must be one the API would accept, so an entry
// cannot drift from the contract. It is not a validator for untrusted input and is not shipped
// to any page.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: Json[];
  const?: Json;
  oneOf?: Schema[];
  anyOf?: Schema[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minimum?: number;
  maximum?: number;
}

export interface Document {
  components?: { schemas?: Record<string, Schema> };
}

const PREFIX = '#/components/schemas/';

/** The schema a `$ref` names, or undefined when it names none. */
export function resolveRef(doc: Document, ref: string): Schema | undefined {
  return ref.startsWith(PREFIX) ? doc.components?.schemas?.[ref.slice(PREFIX.length)] : undefined;
}

function kindOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

/** The problems with `value` against `schema`, each as "path: what", or [] when it fits. */
export function check(doc: Document, schema: Schema, value: Json, path = '$'): string[] {
  if (schema.$ref !== undefined) {
    const target = resolveRef(doc, schema.$ref);
    return target === undefined
      ? [`${path}: unresolved ${schema.$ref}`]
      : check(doc, target, value, path);
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (options !== undefined) {
      const fits = options.filter((option) => check(doc, option, value, path).length === 0);
      // oneOf wants exactly one; the contracts' enums-as-consts never overlap.
      const ok = key === 'oneOf' ? fits.length === 1 : fits.length > 0;
      return ok ? [] : [`${path}: matches none of the ${key} options`];
    }
  }
  const problems: string[] = [];
  if (schema.const !== undefined && !same(schema.const, value)) {
    problems.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => same(option, value))) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const kind = kindOf(value);
    // An integer is a number too.
    if (!types.includes(kind) && !(kind === 'integer' && types.includes('number'))) {
      return [...problems, `${path}: ${kind} where ${types.join(' or ')} is expected`];
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path}: ${value} is below ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path}: ${value} is above ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      problems.push(...check(doc, schema.items as Schema, item, `${path}[${i}]`));
    });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${path}: missing required key "${name}"`);
    }
    const properties = schema.properties ?? {};
    for (const [name, member] of Object.entries(value)) {
      const known = properties[name];
      if (known !== undefined) {
        problems.push(...check(doc, known, member, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}: unknown key "${name}"`);
      }
    }
  }
  return problems;
}
