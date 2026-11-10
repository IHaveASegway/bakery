// The pages the `lighthouse` job measures (apps/web/lighthouse-pages.txt) against the pages the
// build emits. A new page fails here until it is listed or excluded below with its reason, so a
// page cannot ship unmeasured by accident. Reads dist/, so build first.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const listFile = fileURLToPath(new URL('../lighthouse-pages.txt', import.meta.url));

/** The paths in the list, in order: one a line, `#` comments and blank lines skipped. */
const listed = readFileSync(listFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

/** Built pages Lighthouse does not measure, each with the reason. */
const EXCLUDED: Record<string, string> = {
  '/404.html': 'The 404 is served for a missing path and is not a page anyone navigates to.',
  '/app/': 'The console needs a staff session, which the job against the preview does not have.',
  '/app/catering/': 'The console needs a staff session, which the job does not have.',
  '/app/customers/': 'The console needs a staff session, which the job does not have.',
  '/app/dispatch/': 'The console needs a staff session, which the job does not have.',
  '/app/menu/': 'The console needs a staff session, which the job does not have.',
  '/app/money/': 'The console needs a staff session, which the job does not have.',
  '/app/system/': 'The console needs a staff session, which the job does not have.',
  '/app/start/':
    'The sign-in’s landing: it needs a session, and without one it goes on to the sign-in page.',
  '/inbox/': 'The inbox shows one sandbox’s messages, so it needs a session to show anything.',
  '/order/': 'The order’s status page is noindex and shows one order, which needs a session.',
};

/** Every page the build emitted, as a URL path: `/menu/` for menu/index.html, `/404.html`. */
function builtPages(): string[] {
  return readdirSync(dist, { recursive: true })
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.html'))
    .map((file) => file.replaceAll('\\', '/'))
    .map((file) =>
      file.endsWith('index.html') ? `/${file.slice(0, -'index.html'.length)}` : `/${file}`,
    )
    .sort();
}

describe('the Lighthouse page list', () => {
  test('is paths, each once, each starting and ending with a slash', () => {
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed).size).toBe(listed.length);
    for (const path of listed) expect(path).toMatch(/^\/([a-z0-9-]+\/)*$/);
  });

  test('every page the build emits is listed or excluded with a reason, never both', () => {
    expect(existsSync(dist), 'run pnpm build first').toBe(true);
    const pages = builtPages();
    const missing = pages.filter((path) => !listed.includes(path) && !(path in EXCLUDED));
    expect(missing, 'list these in lighthouse-pages.txt or exclude them here').toEqual([]);
    for (const path of listed) expect(EXCLUDED).not.toHaveProperty([path]);
    for (const path of listed) expect(pages, `${path} is listed but not built`).toContain(path);
    for (const path of Object.keys(EXCLUDED))
      expect(pages, `${path} is excluded but not built`).toContain(path);
  });

  test('each exclusion is one sentence', () => {
    for (const reason of Object.values(EXCLUDED)) expect(reason).toMatch(/^[A-Z][^.]*\.$/);
  });
});
