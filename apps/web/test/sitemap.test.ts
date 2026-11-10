// The sitemap, the canonical link and the share tags. Reads dist/, so build first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pagePaths, sitemapXml } from '../scripts/sitemap.mjs';

const dist = new URL('../dist/', import.meta.url).pathname;
const SITE = 'https://bakery.ihaveasegway.com';

describe('the sitemap generator', () => {
  test('lists the index pages, sorted, and not the 404 or other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sitemap-'));
    for (const page of ['index.html', 'menu/index.html', 'docs/api/index.html']) {
      mkdirSync(join(dir, page, '..'), { recursive: true });
      writeFileSync(join(dir, page), '');
    }
    writeFileSync(join(dir, '404.html'), '');
    writeFileSync(join(dir, '_headers'), '');
    expect(pagePaths(dir)).toEqual(['/', '/docs/api/', '/menu/']);
  });

  test('leaves out a page marked noindex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sitemap-'));
    mkdirSync(join(dir, 'order'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<head></head>');
    writeFileSync(
      join(dir, 'order/index.html'),
      '<head><meta name="robots" content="noindex"></head>',
    );
    expect(pagePaths(dir)).toEqual(['/']);
  });

  test('writes one url per path and escapes the text', () => {
    const xml = sitemapXml(`${SITE}/`, ['/', '/a&b/']);
    expect(xml).toContain('<loc>https://bakery.ihaveasegway.com/</loc>');
    expect(xml).toContain('<loc>https://bakery.ihaveasegway.com/a&amp;b/</loc>');
    expect(xml.match(/<url>/g)).toHaveLength(2);
  });
});

describe('the built site', () => {
  const page = (file: string) => readFileSync(join(dist, file), 'utf8');

  test('dist/sitemap.xml names every built page and not the 404', () => {
    expect(existsSync(join(dist, 'sitemap.xml'))).toBe(true);
    const xml = page('sitemap.xml');
    for (const path of pagePaths(dist)) expect(xml).toContain(`<loc>${SITE}${path}</loc>`);
    expect(xml).not.toContain('404');
  });

  test('a page has a canonical link and og tags that repeat its title and description', () => {
    const html = page('menu/index.html');
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1];
    expect(html).toContain(`<link rel="canonical" href="${SITE}/menu/">`);
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
    expect(html).toContain(`<meta property="og:description" content="${description}">`);
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(`<meta property="og:url" content="${SITE}/menu/">`);
  });

  test('the order’s status page is noindex, has no canonical link and is not in the sitemap', () => {
    const html = page('order/index.html');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('rel="canonical"');
    expect(page('sitemap.xml')).not.toContain('/order/');
  });

  test('the start page is canonical at the root, and the 404 points at nothing', () => {
    expect(page('index.html')).toContain(`<link rel="canonical" href="${SITE}/">`);
    expect(page('404.html')).not.toContain('rel="canonical"');
    expect(page('404.html')).toContain('property="og:title"');
  });
});
