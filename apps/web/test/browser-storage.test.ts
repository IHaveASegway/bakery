// What the browser keeps, held to its two lists: docs/security.md's data inventory and the privacy
// page's table. The bakery promises to say exactly what it keeps, so a key the code uses and a list
// leaves out, or a key a list names that the code no longer uses, fails here. The scan reads the
// source of apps/web/src as text, comments removed, and resolves each storage call's key constant.
// test/order-track.test.ts holds the order page's own, narrower promise and stays as it is.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');
const REPO = join(WEB, '..', '..');
const SECURITY = 'docs/security.md';
const PRIVACY = 'apps/web/src/pages/privacy.astro';

type Kind = 'sessionStorage' | 'localStorage' | 'cookie';

/**
 * The only source files that may touch browser storage, each with the one storage it uses. A new
 * file that touches it fails "only these files" below until it is added here, with its key in
 * both lists.
 */
const ALLOWED: Record<string, Exclude<Kind, 'cookie'>> = {
  'components/Guide.tsx': 'sessionStorage',
  'lib/cart.ts': 'sessionStorage',
  'lib/placed-orders.ts': 'sessionStorage',
  'lib/session.ts': 'localStorage',
  'lib/status.ts': 'localStorage',
};

/** Any way a page can keep something: the two storages, IndexedDB, the Cache API, script cookies, a service worker. */
const TOUCHES =
  /\b(?:sessionStorage|localStorage|indexedDB|cookieStore)\b|\bcaches\s*\.|document\s*\.\s*cookie|navigator\s*\.\s*(?:storage|serviceWorker)\b/;

/** The source as code: block comments, and line comments not inside a URL, removed. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\w])\/\/.*$/, '$1'))
    .join('\n');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|astro|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).split('\\').join('/'),
  text: code(readFileSync(path, 'utf8')),
}));

/** Every string constant in the source, by name, with the file that declares it. */
const constants = files.flatMap(({ name, text }) =>
  [...text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"])([^'"`]+)\2/g)].map((m) => ({
    file: name,
    name: m[1]!,
    value: m[3]!,
  })),
);

function resolveKey(file: string, arg: string): string {
  const literal = /^(['"])(.*)\1$/.exec(arg);
  if (literal) return literal[2]!;
  const own = constants.find((c) => c.file === file && c.name === arg);
  if (own) return own.value;
  const elsewhere = constants.filter((c) => c.name === arg);
  if (elsewhere.length === 1) return elsewhere[0]!.value;
  throw new Error(
    `${file}: the storage key ${arg} is not a string constant this test can read. Name the key in ` +
      'one `const` holding a plain string, so the test and the two lists can see it.',
  );
}

/** The keys the code uses, each with its storage, from every getItem, setItem and removeItem. */
function keysInCode(): Map<string, Kind> {
  const found = new Map<string, Kind>();
  for (const { name, text } of files) {
    for (const call of text.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g)) {
      const kind = ALLOWED[name];
      if (kind === undefined) {
        throw new Error(
          `${name} reads or writes a storage key but is not in ALLOWED in test/browser-storage.test.ts.`,
        );
      }
      found.set(resolveKey(name, call[1]!.trim()), kind);
    }
  }
  return found;
}

/** The cookies the API sets, from crates/app/src/auth/session.rs: the only `Set-Cookie` builders. */
function cookiesFromApi(): string[] {
  const rust = readFileSync(join(REPO, 'crates/app/src/auth/session.rs'), 'utf8');
  return [...rust.matchAll(/pub const \w+_COOKIE: &str = "([^"]+)";/g)].map((m) => m[1]!);
}

/** docs/security.md's "Privacy and data inventory": the table's browser keys, with their storage. */
function inventory(): { section: string; keys: Map<string, Kind> } {
  const doc = readFileSync(join(REPO, SECURITY), 'utf8');
  const start = doc.indexOf('## Privacy and data inventory');
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end);
  const keys = new Map<string, Kind>();
  for (const row of section.split('\n').filter((line) => line.startsWith('| '))) {
    const first = row.split('|')[1] ?? '';
    for (const m of first.matchAll(/`(sessionStorage|localStorage)` `([^`]+)`/g)) {
      keys.set(m[2]!, m[1] as Kind);
    }
  }
  return { section, keys };
}

/** The privacy page's table: each row that names something the browser keeps carries `data-stored`. */
function privacyKeys(): string[] {
  const page = readFileSync(join(REPO, PRIVACY), 'utf8');
  return [...page.matchAll(/<tr\b[^>]*\bdata-stored="([^"]+)"/g)].map((m) => m[1]!);
}

const both = (key: string) =>
  `Add a row for \`${key}\` to the table in ${SECURITY} ("Privacy and data inventory"), naming ` +
  'its storage and key in the first column, and a row to the table in ' +
  `${PRIVACY} with data-stored="${key}", in plain words for a visitor.`;

describe('what the browser keeps', () => {
  test('only these files touch browser storage', () => {
    const touching = files.filter(({ text }) => TOUCHES.test(text)).map(({ name }) => name);
    const unexpected = touching.filter((name) => !(name in ALLOWED));
    expect(
      unexpected,
      `These files touch browser storage and are not in ALLOWED in test/browser-storage.test.ts: ` +
        `${unexpected.join(', ')}. If the page must keep something, add the file there, and for ` +
        'each key it keeps: ' +
        both('<the key>'),
    ).toEqual([]);
    // A file that leaves the list frees its entry: the list stays as short as the code.
    const stale = Object.keys(ALLOWED).filter((name) => !touching.includes(name));
    expect(
      stale,
      `Remove from ALLOWED, which no longer touch storage: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  test('each allowed file uses the one storage it is listed with', () => {
    for (const { name, text } of files.filter((f) => f.name in ALLOWED)) {
      const kind = ALLOWED[name]!;
      const other = kind === 'sessionStorage' ? 'localStorage' : 'sessionStorage';
      expect(text, `${name} should use ${kind}`).toContain(kind);
      expect(
        text,
        `${name} uses ${other}: change ALLOWED and both lists' rows for its key`,
      ).not.toContain(other);
      expect(text, `${name} touches more than its storage`).not.toMatch(
        /\bindexedDB\b|\bcaches\s*\.|document\s*\.\s*cookie|cookieStore|navigator\s*\.\s*(?:storage|serviceWorker)\b/,
      );
    }
  });

  test('the scan finds the keys the code uses', () => {
    // Read from the code as it stands on 2026-11-10; a change here is a change to both lists.
    expect([...keysInCode().keys()].sort()).toEqual([
      'bakery-guide',
      'bakery.cart.v1',
      'bakery.placed-orders.v1',
      'bakery.signed-in',
      'bakery.status.last-good',
    ]);
    expect(cookiesFromApi().sort()).toEqual(['__Host-oauth', '__Host-session']);
  });

  test('every key the code uses has its row in the security inventory, with its storage', () => {
    const listed = inventory().keys;
    const used = [...keysInCode()];
    const missing = used.filter(([key]) => !listed.has(key)).map(([key]) => key);
    expect(missing, missing.map(both).join('\n')).toEqual([]);
    for (const [key, kind] of used) {
      expect(listed.get(key), `${key} is kept in ${kind}; say so in its row in ${SECURITY}`).toBe(
        kind,
      );
    }
  });

  test('the security inventory names no browser key the code does not use', () => {
    const used = keysInCode();
    const stale = [...inventory().keys.keys()].filter((key) => !used.has(key));
    expect(
      stale,
      `${SECURITY}'s inventory names browser keys no code uses: ${stale.join(', ')}. Remove the ` +
        `row, and its row in ${PRIVACY}, or find the code that should keep it.`,
    ).toEqual([]);
  });

  test('every cookie the API sets is in the security inventory', () => {
    const { section } = inventory();
    for (const cookie of cookiesFromApi()) {
      expect(section, `${cookie} is set by the API. ${both(cookie)}`).toContain(`\`${cookie}\``);
    }
  });

  test('the privacy page has a row for each, and none for anything else', () => {
    const rows = privacyKeys();
    const kept = [...keysInCode().keys(), ...cookiesFromApi()];
    const missing = kept.filter((key) => !rows.includes(key));
    expect(
      missing,
      missing
        .map(
          (key) =>
            `Add a row for ${key} to the table in ${PRIVACY}, with data-stored="${key}" on ` +
            `its <tr>, in plain words for a visitor (its row in ${SECURITY} says what it holds).`,
        )
        .join('\n'),
    ).toEqual([]);
    const extra = rows.filter((key) => !kept.includes(key));
    expect(
      extra,
      `${PRIVACY} has rows for keys nothing keeps: ${extra.join(', ')}. Remove them.`,
    ).toEqual([]);
    expect(new Set(rows).size, `${PRIVACY} names a key on two rows`).toBe(rows.length);
  });
});
