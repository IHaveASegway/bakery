// The sitemap, written from the pages the build made: one <url> per page, none for the 404. A
// small generator beside the build rather than a dependency, so the lockfile stays as it is.
import { readdirSync } from 'node:fs';

const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The URL paths (`/`, `/menu/`) of the built `index.html` files under `dir`, sorted. */
export function pagePaths(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((file) => typeof file === 'string')
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
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
