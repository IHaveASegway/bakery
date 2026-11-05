// Small process, hash and stamp helpers shared by the build steps.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Run a program to completion; resolves with its output, rejects with its stderr. */
export function exec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 28, ...options }, (err, stdout, stderr) => {
      if (err)
        reject(
          new Error(`${cmd} ${args.slice(0, 3).join(' ')}... failed: ${stderr || err.message}`),
        );
      else resolve({ stdout, stderr });
    });
  });
}

/** Run a program with its output streamed to `logFile`; resolves with its exit code. */
export function execLogged(cmd, args, logFile, options = {}) {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { stdio: ['ignore', out, out], ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve(code);
    });
  });
}

/** The hex digest of a file, streamed. */
export function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** JSON with object keys sorted, so equal values give equal text. */
export function stableJson(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v instanceof RegExp
        ? v.toString()
        : v,
  );
}

export async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` unless every output exists and the stamp file holds `key`; then write the stamp. A
 * step reruns when its inputs' key changes or an output is gone, and not otherwise.
 */
export async function stamped(stampFile, key, outputs, fn) {
  const digest = sha256(key);
  let current = null;
  try {
    current = (await fsp.readFile(stampFile, 'utf8')).trim();
  } catch {
    /* no stamp yet */
  }
  const present = (await Promise.all(outputs.map(exists))).every(Boolean);
  if (current === digest && present) return false;
  await fn();
  await fsp.mkdir(path.dirname(stampFile), { recursive: true });
  await fsp.writeFile(stampFile, `${digest}\n`);
  return true;
}

/** Write a file by renaming a temporary one into place. */
export async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}
