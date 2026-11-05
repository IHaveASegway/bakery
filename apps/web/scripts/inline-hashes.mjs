// Astro writes two inline pieces into any page with a hydrated island: a script that defines the
// <astro-island> element and the `client:load` loader, and a one-rule stylesheet. They differ only
// when Astro is upgraded, so the page policy allows each by its SHA-256 hash instead of by
// 'unsafe-inline'. The hashes are read from the built HTML, never typed, and only the pages that
// carry the code get them (docs/security.md, "The storefront's policy").
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The hashes of the inline scripts and styles in one HTML document, sorted and unique. */
export function inlineHashes(html) {
  const find = (pattern) =>
    [...new Set([...html.matchAll(pattern)].map((m) => m[1]).filter((body) => body.trim() !== ''))]
      .map(hash)
      .sort();
  return {
    // A script with a src is external and allowed by 'self'.
    script: find(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
    style: find(/<style[^>]*>([\s\S]*?)<\/style>/g),
  };
}

/**
 * Hashes per policy rule. `rules` are the paths that get their own policy (`/signin/*`); every
 * other page belongs to `/*`. Returns { '/*': {script, style}, '/signin/*': ... }.
 */
export function hashesByRule(dir, rules) {
  const out = Object.fromEntries(['/*', ...rules].map((rule) => [rule, { script: [], style: [] }]));
  for (const file of readdirSync(dir, { recursive: true })) {
    if (typeof file !== 'string' || !file.endsWith('.html')) continue;
    const url = `/${file.replaceAll('\\', '/')}`;
    // The longest matching prefix wins: /app/dispatch/* is under /app/*.
    const rule =
      rules.filter((r) => url.startsWith(r.slice(0, -1))).sort((x, y) => y.length - x.length)[0] ??
      '/*';
    const found = inlineHashes(readFileSync(join(dir, file), 'utf8'));
    for (const kind of ['script', 'style']) {
      out[rule][kind] = [...new Set([...out[rule][kind], ...found[kind]])].sort();
    }
  }
  return out;
}
