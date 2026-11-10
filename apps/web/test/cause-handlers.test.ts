import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// The route table says which commands name their cause (`names_cause` in
// crates/contracts/src/routes.rs), and the OpenAPI document promises `Bakery-Cause` on each. The
// header is only sent when the handler records the cause (`Cx::caused`), and nothing in the
// compiler ties the two: a new command whose handler forgot the call would answer without the
// header, and the guide could not follow its events. This holds every such handler to the call, by
// reading the Rust source, as test/attempt.test.ts reads it for the rule words.

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(root(path), 'utf8');

const routes = read('crates/contracts/src/routes.rs');
const table = routes.slice(routes.indexOf('pub const ROUTES: &[RouteSpec] = &['));
// A row is `r(<pr>, "<id>", "<METHOD>", <path>, …`, where the path is a string or a constant.
const rows = [
  ...table.matchAll(/\br\(\s*\d+,\s*"([^"]+)",\s*"([A-Z]+)",\s*(?:"([^"]+)"|([A-Z_]+))/g),
].map(([, id = '', method = '', path, constant]) => ({ id, method, path: path ?? constant ?? '' }));
const noCause = new Set(
  [
    ...(/pub const NO_CAUSE: &\[&str\] = &\[([\s\S]*?)\];/.exec(routes)?.[1] ?? '').matchAll(
      /"([^"]+)"/g,
    ),
  ].map(([, id = '']) => id),
);
const named = rows.filter(
  (r) => ['POST', 'PATCH', 'DELETE'].includes(r.method) && !noCause.has(r.id),
);

const dir = 'workers/api/src/http';
const sources = new Map(
  readdirSync(root(dir))
    .filter((f) => f.endsWith('.rs'))
    .map((f) => [f.slice(0, -3), read(`${dir}/${f}`)] as const),
);
// `RouteId::PlaceOrder => orders::place(cx, …)`, with or without a block around the call.
const arms = new Map(
  [
    ...(sources.get('mod') ?? '').matchAll(
      /RouteId::([A-Za-z]+)\s*=>\s*(?:\{\s*)?([a-z_]+)::([a-z_]+)\(/g,
    ),
  ].map(([, variant = '', module = '', fn = '']) => [variant, { module, fn }] as const),
);
const variantOf = (id: string): string =>
  id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

/** A function's text, from its `fn` to the next item of the module. */
function body(module: string, fn: string): string | null {
  const text = sources.get(module) ?? '';
  const start = new RegExp(`(?:pub(?:\\(crate\\))? )?async fn ${fn}\\b`).exec(text);
  if (start === null) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = /\n(?:pub(?:\(crate\))? )?(?:async )?fn |\n#\[cfg\(test\)\]/.exec(rest);
  return start[0] + rest.slice(0, end === null ? rest.length : end.index);
}

/** Whether the handler records a cause itself, or hands `cx` to a helper of its module that does. */
function records(module: string, fn: string): boolean {
  const text = body(module, fn);
  if (text === null) return false;
  if (text.includes('caused(')) return true;
  const helpers = [...text.matchAll(/\b([a-z_]+)\(\s*cx\b/g)].map(([, name = '']) => name);
  return helpers.some((name) => name !== fn && (body(module, name) ?? '').includes('caused('));
}

describe('the commands that name their cause', () => {
  test('the route table and the Worker’s dispatch are both read', () => {
    expect(rows.length).toBeGreaterThan(60);
    expect(arms.size).toBeGreaterThan(60);
    expect(noCause.size).toBeGreaterThan(0);
    expect(named.length).toBeGreaterThan(25);
    for (const id of noCause) expect(rows.map((r) => r.id)).toContain(id);
  });

  test.each(named.map((r) => [r.id, r.method, r.path] as const))(
    '%s (%s %s): its handler records the cause it writes under',
    (id) => {
      const arm = arms.get(variantOf(id));
      expect(arm, `no arm for ${id} in ${dir}/mod.rs`).toBeDefined();
      if (arm === undefined) return;
      expect(
        records(arm.module, arm.fn),
        `${arm.module}::${arm.fn} never calls cx.caused(…), so its answer carries no Bakery-Cause`,
      ).toBe(true);
    },
  );

  test('a handler that forgot the call would be caught', () => {
    // The check's own proof: a read route's handler records no cause.
    const get = arms.get('GetOrder');
    expect(get).toBeDefined();
    if (get !== undefined) expect(records(get.module, get.fn)).toBe(false);
  });
});
