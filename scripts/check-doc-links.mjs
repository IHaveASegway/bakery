#!/usr/bin/env node
// Checks the relative links in the repository's Markdown: README.md, AGENTS.md,
// workers/api/README.md and every .md file under docs/ (the ADRs and essays included).
// A link or image whose target is relative must name a file or folder that exists, and a
// #anchor must name a heading in the target (GitHub's slugs: lowercase, spaces to hyphens,
// punctuation other than hyphens and underscores removed, a repeated heading taking -1, -2).
// An #anchor alone points into the same file. Links to http(s) and mailto are not fetched here;
// the storefront's external links are scripts/check-links.mjs's, in the Monday audit.
//
//   node scripts/check-doc-links.mjs    from the repository root
//
// Exit 0: every relative link resolves. 1: the broken links are listed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();

/** @param {string} dir @returns {string[]} */
function markdownUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

const files = [
  ...['README.md', 'AGENTS.md', 'workers/api/README.md'].map((f) => join(root, f)),
  ...markdownUnder(join(root, 'docs')),
].filter((f) => existsSync(f));

/** The text with fenced code blocks blanked, line count kept. @param {string} text */
function withoutFences(text) {
  let fence = '';
  return text
    .split('\n')
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = '';
        return '';
      }
      if (open) {
        fence = open[1];
        return '';
      }
      return line;
    })
    .join('\n');
}

/** GitHub's heading slug. @param {string} heading */
function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // a link or image keeps its text
    .replace(/<[^>]+>/g, '') // inline HTML
    .replace(/[`*]/g, '') // code and emphasis marks
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** @type {Map<string, Set<string>>} */
const anchorCache = new Map();

/** Every anchor a Markdown file offers. @param {string} file */
function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set();
  const seen = new Map();
  for (const line of withoutFences(readFileSync(file, 'utf8')).split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const html of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(html[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Inline links and images, and reference definitions. @param {string} text */
function* targets(text) {
  const lines = withoutFences(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
      yield { line: i + 1, target: m[1].replace(/^<|>$/g, '') };
    }
    const ref = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line); // not a [^footnote]
    if (ref) yield { line: i + 1, target: ref[1].replace(/^<|>$/g, '') };
  }
}

const broken = [];
let checked = 0;
for (const file of files) {
  const name = relative(root, file);
  for (const { line, target } of targets(readFileSync(file, 'utf8'))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // http(s), mailto
    checked++;
    const hash = target.indexOf('#');
    const pathPart = decodeURIComponent(hash < 0 ? target : target.slice(0, hash));
    const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
    const dest = pathPart === '' ? file : resolve(dirname(file), pathPart);
    if (!existsSync(dest)) {
      broken.push(`${name}:${line}: ${target} (no such file)`);
      continue;
    }
    if (anchor && dest.endsWith('.md') && statSync(dest).isFile()) {
      if (!anchorsOf(dest).has(anchor.toLowerCase())) {
        broken.push(
          `${name}:${line}: ${target} (no heading #${anchor} in ${relative(root, dest)})`,
        );
      }
    }
  }
}

if (broken.length > 0) {
  console.log(
    `check-doc-links: ${broken.length} broken of ${checked} relative links in ${files.length} files:`,
  );
  for (const b of broken) console.log(`- ${b}`);
  process.exit(1);
}
console.log(`check-doc-links: ${checked} relative links in ${files.length} files, none broken`);
