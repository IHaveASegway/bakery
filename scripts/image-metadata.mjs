#!/usr/bin/env node
// Rejects images and PDFs that carry metadata: EXIF, XMP or IPTC in an image (location, device
// owner, file paths), C2PA Content Credentials (which can embed the same, and an author), and PDF
// Info fields other than Title and Author. A diff never shows a binary file's metadata, so the
// content firewall cannot see it (security.md, "What regex cannot see").
//
//   node scripts/image-metadata.mjs --tracked    every tracked image and PDF (verify)
//   node scripts/image-metadata.mjs --staged     every staged image and PDF (the pre-commit hook)
//   node scripts/image-metadata.mjs <file>...    the files named
//
// Exit 0: clean. 1: metadata found. 2: cannot tell (an unknown format, an unreadable file, or a
// PDF without pdfinfo). The type is read from the bytes, not trusted from the extension.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKED = /\.(png|jpe?g|gif|webp|avif|heic|tiff?|svg|ico|pdf)$/i;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {Buffer} b @returns {string[]} what the PNG carries that is metadata */
function png(b) {
  const found = [];
  for (let at = 8; at + 8 <= b.length;) {
    const length = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    // Text chunks hold XMP (iTXt), and EXIF or IPTC as raw profiles (tEXt, zTXt); eXIf is EXIF;
    // caBX holds C2PA Content Credentials, which can carry EXIF (location, device) and an author.
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'caBX'].includes(type))
      found.push(`PNG ${type} chunk`);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return found;
}

/** @param {Buffer} b */
function jpeg(b) {
  const found = [];
  for (let at = 2; at + 4 <= b.length && b[at] === 0xff;) {
    const marker = b[at + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan, end of image
    const length = b.readUInt16BE(at + 2);
    if (marker === 0xe1) found.push('JPEG APP1 (EXIF or XMP)');
    if (marker === 0xeb) found.push('JPEG APP11 (JUMBF: C2PA Content Credentials)');
    if (marker === 0xed) found.push('JPEG APP13 (IPTC)');
    if (marker === 0xfe) found.push('JPEG comment');
    at += 2 + length;
  }
  return found;
}

/** @param {Buffer} b */
function gif(b) {
  const s = b.toString('latin1');
  const found = [];
  if (s.includes('XMP DataXMP')) found.push('GIF XMP');
  if (s.includes('\x21\xfe')) found.push('GIF comment');
  return found;
}

/** @param {Buffer} b */
function webp(b) {
  const found = [];
  for (let at = 12; at + 8 <= b.length;) {
    const type = b.toString('latin1', at, at + 4);
    const length = b.readUInt32LE(at + 4);
    if (['EXIF', 'XMP ', 'C2PA'].includes(type)) found.push(`WebP ${type.trim()} chunk`);
    at += 8 + length + (length % 2);
  }
  return found;
}

/** @param {Buffer} b */
function ico(b) {
  const found = [];
  const count = b.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const size = b.readUInt32LE(6 + i * 16 + 8);
    const offset = b.readUInt32LE(6 + i * 16 + 12);
    const image = b.subarray(offset, offset + size);
    if (image.subarray(0, 8).equals(PNG))
      found.push(...png(image).map((f) => `ICO image ${i}: ${f}`));
  }
  return found; // a BMP image inside an ICO has no metadata block
}

/** @param {Buffer} b */
function svg(b) {
  const s = b.toString('utf8');
  // Editors write their metadata in these namespaces; a hand-written or generated icon has none.
  const marks = [
    '<metadata',
    'rdf:',
    'xmlns:dc=',
    'xmlns:cc=',
    'sodipodi:',
    'inkscape:',
    'x:xmpmeta',
    'xmlns:xmp',
  ];
  const text = s.toLowerCase();
  return marks.filter((m) => text.includes(m)).map((m) => `SVG ${m}`);
}

/** @param {string} file */
function pdf(file) {
  let info;
  try {
    info = execFileSync('pdfinfo', [file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('pdfinfo is missing or cannot read the file');
  }
  const found = [];
  for (const line of info.split('\n')) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (
      ['Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'].includes(key ?? '')
    ) {
      found.push(`PDF Info ${key}`);
    }
    if ((key === 'Custom Metadata' || key === 'Metadata Stream') && value === 'yes')
      found.push(`PDF ${key}`);
  }
  return found;
}

/** @param {Buffer} b @param {() => string} onDisk a path pdfinfo can read */
function inspect(b, onDisk) {
  if (b.subarray(0, 8).equals(PNG)) return png(b);
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.toString('latin1', 0, 4) === 'GIF8') return gif(b);
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return webp(b);
  if (b.readUInt32BE(0) === 0x00000100) return ico(b);
  if (b.toString('latin1', 0, 5) === '%PDF-') return pdf(onDisk());
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.toString('utf8', 0, 512))) return svg(b);
  throw new Error(
    'a format this check cannot read: strip its metadata, or teach this script the format',
  );
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 28 });
}

const args = process.argv.slice(2);
/** @type {{ name: string, read: () => Buffer }[]} */
let files;
if (args[0] === '--tracked' || args[0] === '--staged') {
  const list =
    args[0] === '--tracked'
      ? git('ls-files', '-z')
      : git('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z');
  files = list
    .toString('utf8')
    .split('\0')
    .filter((name) => CHECKED.test(name))
    .map((name) => ({
      name,
      read: () =>
        args[0] === '--tracked' ? readFileSync(name) : git('cat-file', 'blob', `:${name}`),
    }));
} else {
  files = args.map((name) => ({ name, read: () => readFileSync(name) }));
}

const scratch = mkdtempSync(join(tmpdir(), 'image-metadata-'));
let status = 0;
try {
  for (const { name, read } of files) {
    try {
      const bytes = read();
      const onDisk = () => {
        const path = join(scratch, 'file.pdf');
        writeFileSync(path, bytes);
        return path;
      };
      const found = inspect(bytes, onDisk);
      if (found.length > 0) {
        console.error(`image-metadata: ${name}: ${found.join(', ')}`);
        status = Math.max(status, 1);
      }
    } catch (error) {
      console.error(
        `image-metadata: ${name}: cannot tell: ${error instanceof Error ? error.message : error}`,
      );
      status = 2;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (status === 0) console.log(`image-metadata: ${files.length} file(s) carry no metadata`);
process.exit(status);
