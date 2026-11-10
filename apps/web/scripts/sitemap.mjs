// The sitemap, written from the pages the build made: one <url> per page, none for the 404 and
// none for a page marked noindex (an order's status). A small generator beside the build rather
// than a dependency, so the lockfile stays as it is.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A page that asks to stay out of search (Base.astro's `noindex`) stays out of the sitemap too. */
const NOINDEX = '<meta name="robots" content="noindex">';

const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The URL paths (`/`, `/menu/`) of the built `index.html` files under `dir`, sorted. */
export function pagePaths(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((file) => typeof file === 'string')
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
    .filter((file) => !readFileSync(join(dir, file), 'utf8').includes(NOINDEX))
    .map((file) => `/${file.slice(0, -'index.html'.length)}`)
    .sort();
}

/** The sitemap document for these paths on this origin (`site` has no trailing slash needed). */
export function sitemapXml(site, paths) {
  const origin = site.replace(/\/+$/, '');
  const urls = paths.map((path) => `  <url><loc>${escape(origin + path)}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
