// The API reference page's builder (Q42 · Q-api-access): it turns the OpenAPI document that
// crates/contracts generates (public/docs/api/openapi.json) into a plain view model, at build.
// Nothing here runs in a browser. The Astro page (pages/docs/api/index.astro) draws the model, so
// the document, the table of operations and the schemas on the page are one thing. `$ref`s are
// resolved here, and a ref that points nowhere throws, so the build stops rather than printing a
// gap. Nothing is fetched at runtime and no third-party renderer is involved.
import { check, resolveRef, type Json, type Schema } from './schema-check';
import { fillPath } from './tour';

// ---- The document, as much of it as the page reads ----

interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Schema & { pattern?: string };
  example?: string;
}

interface Media {
  schema?: Schema;
}

interface Response {
  description?: string;
  content?: Record<string, Media>;
  headers?: Record<string, { $ref?: string }>;
  'x-problems'?: string[];
}

interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, Media>; required?: boolean };
  responses: Record<string, Response>;
  security?: Record<string, string[]>[];
  'x-session'?: string;
  'x-pr'?: number;
  'x-websocket'?: SocketDoc;
}

export interface SocketDoc {
  description: string;
  frames: { t: string; direction: string; shape: string; when: string }[];
  protocol?: unknown;
  version?: unknown;
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; summary?: string; description?: string; version: string };
  servers: { url: string; description?: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation | unknown>>;
  components: {
    schemas: Record<string, Schema & { description?: string; title?: string }>;
    parameters?: Record<string, Parameter>;
    securitySchemes?: Record<string, { description?: string }>;
  };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// ---- The view model ----

/** A run of text, either prose or code (a pair of backticks in the document). */
export interface Span {
  text: string;
  code: boolean;
}

export interface Row {
  name: string;
  type: string;
  /** The component schema the type names, for a link. */
  ref: string | null;
  required: boolean;
  /** Allowed values or limits, as words. */
  limits: string;
  description: Span[];
}

export interface SchemaView {
  name: string;
  description: Span[];
  /** The properties of an object; empty for an enum. */
  rows: Row[];
  /** The values of an enum or a union of constants; empty for an object. */
  values: string[];
}

export interface ParamView {
  name: string;
  where: string;
  required: boolean;
  type: string;
  description: Span[];
}

export interface AnswerView {
  status: string;
  description: Span[];
  /** The problem slugs the status can carry. */
  problems: string[];
  contentType: string | null;
  schema: string | null;
}

export interface OperationView {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: Span[][];
  tag: string;
  /** Who may call it, in words. */
  session: string;
  /** Whether an API token stands in for the cookie. */
  bearer: boolean;
  pr: number | null;
  params: ParamView[];
  request: { schema: string; contentType: string; view: SchemaView } | null;
  answers: AnswerView[];
  /** The 2xx answer's schema as a table, when it has one. */
  success: SchemaView | null;
  /** A copyable command, or null with a reason when a terminal cannot call the route. */
  curl: string | null;
  curlNote: string | null;
}

export interface TagView {
  name: string;
  title: string;
  operations: OperationView[];
}

export interface PageModel {
  title: string;
  summary: string;
  intro: Span[][];
  servers: { url: string; description: Span[] }[];
  tags: TagView[];
  schemas: SchemaView[];
  socket: { operation: string; description: Span[]; frames: SocketDoc['frames'] } | null;
  operationCount: number;
}

// ---- Words ----

/** Splits text on backticks into prose and code runs. */
export function spans(text: string | undefined): Span[] {
  if (text === undefined || text === '') return [];
  return text
    .replaceAll('\n', ' ')
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((span) => span.text !== '');
}

/** Paragraphs: a blank line in the source starts a new one; a single newline is a space. */
export function paragraphs(text: string | undefined): Span[][] {
  if (text === undefined) return [];
  return text
    .split(/\n\s*\n/)
    .map((p) => spans(p))
    .filter((p) => p.length > 0);
}

const SESSIONS: Record<string, string> = {
  public: 'Public: no session needed.',
  any: 'Any session, a guest’s included.',
  sandbox: 'A session of this sandbox, a guest’s included.',
  'signed-in': 'A signed-in session of this sandbox; a guest gets 403 guest-scope.',
  cookie: 'The session cookie only.',
  stripe: 'Stripe only, by its signature.',
};

export const sessionWords = (session: string | undefined): string =>
  SESSIONS[session ?? ''] ?? session ?? 'Not stated.';

const TITLES: Record<string, string> = {
  service: 'Service',
  'sign-in': 'Sign-in',
  sandbox: 'Sandbox',
  menu: 'Menu',
  orders: 'Orders',
  kitchen: 'Kitchen',
  traffic: 'Simulated traffic',
  payments: 'Payments',
  schedule: 'Schedule',
  catering: 'Catering',
  crm: 'CRM, inbox and activity',
  dispatch: 'Dispatch',
  token: 'API token',
};

// ---- Schemas ----

const REF_PREFIX = '#/components/schemas/';

/** The name a `$ref` points at; throws on a ref that names no component. */
function refName(doc: OpenApiDoc, ref: string): string {
  if (!ref.startsWith(REF_PREFIX) || resolveRef(doc, ref) === undefined) {
    throw new Error(`The OpenAPI document has a $ref that points nowhere: ${ref}`);
  }
  return ref.slice(REF_PREFIX.length);
}

type Described = Schema & { description?: string; format?: string };

/** The values a schema allows when it is an enum or a union of constants, else []. */
function valuesOf(doc: OpenApiDoc, schema: Schema): string[] {
  if (schema.$ref !== undefined) return valuesOf(doc, resolve(doc, schema));
  if (schema.enum !== undefined) return schema.enum.map((v) => String(v));
  if (schema.const !== undefined) return [String(schema.const)];
  const options = schema.oneOf ?? schema.anyOf;
  if (
    options !== undefined &&
    options.every((o) => o.const !== undefined || o.$ref !== undefined)
  ) {
    return options.flatMap((o) => valuesOf(doc, o));
  }
  return [];
}

function resolve(doc: OpenApiDoc, schema: Schema): Schema {
  let current = schema;
  for (let hops = 0; current.$ref !== undefined; hops++) {
    const target = resolveRef(doc, current.$ref);
    if (target === undefined || hops > 10) refName(doc, current.$ref);
    current = target as Schema;
  }
  return current;
}

/** `string`, `integer or null`, `array of OrderLineRequest`: a schema's type in words, and its ref. */
function typeOf(doc: OpenApiDoc, schema: Schema): { type: string; ref: string | null } {
  if (schema.$ref !== undefined) {
    const name = refName(doc, schema.$ref);
    return { type: name, ref: name };
  }
  const options = schema.anyOf ?? schema.oneOf;
  if (options !== undefined) {
    const values = valuesOf(doc, schema);
    const parts = options.filter((o) => o.type !== 'null');
    const nullable = parts.length < options.length;
    if (values.length > 0 && parts.every((o) => o.const !== undefined)) {
      return { type: `string${nullable ? ' or null' : ''}`, ref: null };
    }
    const inner = parts.map((o) => typeOf(doc, o));
    return {
      type: `${inner.map((i) => i.type).join(' or ')}${nullable ? ' or null' : ''}`,
      ref: inner.length === 1 ? (inner[0]?.ref ?? null) : null,
    };
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type === undefined
      ? []
      : [schema.type];
  const shown = types.map((t) => {
    if (t === 'array' && schema.items !== undefined) {
      return `array of ${typeOf(doc, schema.items).type}`;
    }
    return t;
  });
  const ref = schema.items === undefined ? null : typeOf(doc, schema.items).ref;
  return { type: shown.join(' or ') || 'any', ref };
}

function limitsOf(doc: OpenApiDoc, schema: Schema): string {
  const values = valuesOf(doc, schema);
  if (values.length > 0) return `one of ${values.join(', ')}`;
  const own = resolve(doc, schema);
  const parts: string[] = [];
  if (own.minimum !== undefined && own.maximum !== undefined) {
    parts.push(`${own.minimum} to ${own.maximum}`);
  } else if (own.minimum !== undefined) {
    parts.push(`at least ${own.minimum}`);
  }
  const format = (own as Described).format;
  if (format !== undefined && !/^u?int(8|16|32|64)$/.test(format)) parts.push(format);
  return parts.join(', ');
}

/** One schema as a table of properties, or a list of values. */
export function schemaView(doc: OpenApiDoc, name: string, schema: Schema): SchemaView {
  const own = resolve(doc, schema) as Described;
  const required = new Set(own.required ?? []);
  const rows: Row[] = Object.entries(own.properties ?? {}).map(([property, member]) => {
    const { type, ref } = typeOf(doc, member);
    return {
      name: property,
      type,
      ref,
      required: required.has(property),
      limits: limitsOf(doc, member),
      description: spans((member as Described).description),
    };
  });
  return {
    name,
    description: spans(own.description),
    rows,
    values: rows.length === 0 ? valuesOf(doc, own) : [],
  };
}

// ---- A placeholder body and a command ----

/** A body built from the schema's required members, each a placeholder of the right kind. */
export function exampleBody(doc: OpenApiDoc, schema: Schema, depth = 0): Json {
  const own = resolve(doc, schema);
  const values = valuesOf(doc, own);
  if (values.length > 0) {
    const first = (own.enum ?? own.oneOf ?? own.anyOf ?? []).find((o) => o !== null);
    // Keep the value's real type: a numeric enum stays a number.
    if (own.enum !== undefined) return own.enum[0] ?? null;
    if (first !== undefined && typeof first === 'object' && 'const' in first) {
      return (first as Schema).const ?? null;
    }
    return values[0] ?? null;
  }
  const options = own.anyOf ?? own.oneOf;
  if (options !== undefined) {
    const real = options.find((o) => o.type !== 'null');
    return real === undefined ? null : exampleBody(doc, real, depth + 1);
  }
  const types = Array.isArray(own.type) ? own.type : own.type === undefined ? [] : [own.type];
  const type = types.find((t) => t !== 'null') ?? 'object';
  switch (type) {
    case 'string':
      return '<string>';
    case 'integer':
    case 'number':
      return Math.max(own.minimum ?? 0, 1) <= (own.maximum ?? Infinity)
        ? Math.max(own.minimum ?? 0, 1)
        : (own.minimum ?? 0);
    case 'boolean':
      return false;
    case 'array':
      return own.items === undefined || depth > 3 ? [] : [exampleBody(doc, own.items, depth + 1)];
    default: {
      const body: Record<string, Json> = {};
      for (const key of own.required ?? []) {
        const member = own.properties?.[key];
        if (member !== undefined && depth <= 3) body[key] = exampleBody(doc, member, depth + 1);
      }
      return body;
    }
  }
}

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The command for an operation: placeholders for the token, the key and the path parameters. */
function curlFor(
  doc: OpenApiDoc,
  method: string,
  path: string,
  bearer: boolean,
  request: Schema | null,
): string {
  const server = doc.servers[0]?.url ?? '';
  const parts = [
    `curl${method === 'GET' ? '' : ` -X ${method}`} ${q(`${server}${fillPath(path, null)}`)}`,
  ];
  if (bearer) parts.push(`-H ${q('Authorization: Bearer <your token>')}`);
  if (method === 'POST') parts.push(`-H ${q('Idempotency-Key: <a new ULID>')}`);
  if (request !== null) {
    parts.push(`-H ${q('Content-Type: application/json')}`);
    parts.push(`-d ${q(JSON.stringify(exampleBody(doc, request)))}`);
  }
  return parts.join(' \\\n  ');
}

// ---- The page ----

function jsonSchemaOf(content: Record<string, Media> | undefined): [string, Schema] | null {
  for (const [type, media] of Object.entries(content ?? {})) {
    if (media.schema !== undefined) return [type, media.schema];
  }
  return null;
}

function parameter(doc: OpenApiDoc, p: Parameter): Parameter {
  if (p.$ref === undefined) return p;
  const name = p.$ref.replace('#/components/parameters/', '');
  const found = doc.components.parameters?.[name];
  if (found === undefined)
    throw new Error(`The OpenAPI document has a $ref that points nowhere: ${p.$ref}`);
  return found;
}

export function operationView(
  doc: OpenApiDoc,
  method: string,
  path: string,
  op: Operation,
): OperationView {
  const security = op.security ?? [];
  const names = security.flatMap((requirement) => Object.keys(requirement));
  const bearer = names.includes('bearerToken');
  const publicRoute = security.length === 0 || security.some((r) => Object.keys(r).length === 0);

  const requestPair = jsonSchemaOf(op.requestBody?.content);
  const request =
    requestPair === null
      ? null
      : {
          schema: requestPair[1].$ref === undefined ? 'body' : refName(doc, requestPair[1].$ref),
          contentType: requestPair[0],
          view: schemaView(
            doc,
            requestPair[1].$ref === undefined ? 'body' : refName(doc, requestPair[1].$ref),
            requestPair[1],
          ),
        };

  const answers: AnswerView[] = Object.entries(op.responses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, response]) => {
      const pair = jsonSchemaOf(response.content);
      return {
        status,
        description: spans(response.description),
        problems: response['x-problems'] ?? [],
        contentType: pair?.[0] ?? null,
        schema: pair === null || pair[1].$ref === undefined ? null : refName(doc, pair[1].$ref),
      };
    });

  const ok = Object.entries(op.responses)
    .filter(([status]) => status.startsWith('2'))
    .map(([, response]) => jsonSchemaOf(response.content))
    .find((pair) => pair !== null);
  const success =
    ok === undefined || ok === null || ok[1].$ref === undefined
      ? null
      : schemaView(doc, refName(doc, ok[1].$ref), ok[1]);

  const callable = bearer || publicRoute;
  return {
    id: op.operationId,
    method: method.toUpperCase(),
    path,
    summary: op.summary,
    description: paragraphs(op.description),
    tag: op.tags[0] ?? 'other',
    session: sessionWords(op['x-session']),
    bearer,
    pr: op['x-pr'] ?? null,
    params: (op.parameters ?? []).map((raw) => {
      const p = parameter(doc, raw);
      return {
        name: p.name ?? '',
        where: p.in ?? '',
        required: p.required === true,
        type: p.schema === undefined ? 'string' : typeOf(doc, p.schema).type,
        description: spans(p.description),
      };
    }),
    request,
    answers,
    success,
    curl: callable
      ? curlFor(doc, method.toUpperCase(), path, bearer, requestPair?.[1] ?? null)
      : null,
    curlNote: callable
      ? null
      : op['x-websocket'] !== undefined
        ? 'A WebSocket takes the console’s cookie only; see the kitchen socket below.'
        : 'This route takes the console’s cookie only, so a token cannot call it: a token never mints its successor, and a browser session is the only way to sign in.',
  };
}

/** Builds the whole page from the document. */
export function buildPage(doc: OpenApiDoc): PageModel {
  const views: OperationView[] = [];
  let socket: PageModel['socket'] = null;
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (op === undefined) continue;
      views.push(operationView(doc, method, path, op));
      if (op['x-websocket'] !== undefined) {
        socket = {
          operation: op.operationId,
          description: spans(op['x-websocket'].description),
          frames: op['x-websocket'].frames,
        };
      }
    }
  }
  const tags = doc.tags.map((tag) => ({
    name: tag.name,
    title: TITLES[tag.name] ?? tag.name,
    operations: views
      .filter((v) => v.tag === tag.name)
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  }));
  // An operation under a tag the document does not list still gets a home.
  const listed = new Set(doc.tags.map((t) => t.name));
  for (const name of new Set(views.map((v) => v.tag))) {
    if (!listed.has(name)) {
      tags.push({ name, title: name, operations: views.filter((v) => v.tag === name) });
    }
  }
  // Every $ref in the document must resolve, wherever it is.
  JSON.stringify(doc, (key, value: unknown) => {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
      refName(doc, value);
    }
    return value;
  });
  return {
    title: doc.info.title,
    summary: doc.info.summary ?? '',
    intro: paragraphs(doc.info.description),
    servers: doc.servers.map((s) => ({ url: s.url, description: spans(s.description) })),
    tags: tags.filter((t) => t.operations.length > 0),
    schemas: Object.entries(doc.components.schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => schemaView(doc, name, schema)),
    socket,
    operationCount: views.length,
  };
}

/** The problems with an example body against its request schema (used by the tests). */
export const bodyProblems = (doc: OpenApiDoc, schema: Schema, body: Json): string[] =>
  check(doc, schema, body);
