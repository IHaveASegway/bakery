import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  LOCK_FILE,
  fetchSolver,
  mismatches,
  readFolder,
  readFromGit,
  readLock,
  sha256,
  solverRoot,
  verifyFolder,
} from '../../../scripts/fetch-solver.mjs';

// The solver is fetched at build, never committed, and checked against solver.lock.json: a byte
// that differs fails the build (ADR 0012, decision 6). These tests prove the check on made-up files
// and on a throwaway git repository, so they need no network; the last block checks the real folder
// when the build has fetched it.

const scratch = mkdtempSync(join(tmpdir(), 'bakery-solver-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const FILES = { 'a.wasm': bytes('\0asm-one'), 'b.mjs': bytes('export const b = 1;\n') };
const lockOf = (files: Record<string, Uint8Array>, commit = 'a'.repeat(40)) => ({
  source: { repository: 'https://example.test/site.git', commit, path: 'solver' },
  folder: 'vroom-test-00000000',
  files: Object.fromEntries(
    Object.entries(files).map(([name, b]) => [name, { sha256: sha256(b), bytes: b.length }]),
  ),
});
const fresh = (name: string) => join(scratch, name);

describe('the committed lock', () => {
  const lock = readLock();

  test('pins the site’s repository at one full commit and the five solver files', () => {
    expect(lock.source.repository).toBe('https://github.com/IHaveASegway/website.git');
    expect(lock.source.commit).toMatch(/^34b4515[0-9a-f]{33}$/);
    expect(lock.source.path).toBe('apps/web/public/lab/routes/solver/vroom-1.15.0-870d7d5e');
    expect(Object.keys(lock.files).sort()).toEqual(
      ['LICENSES.txt', 'vroom-solver.mjs', 'vroom-worker.mjs', 'vroom.mjs', 'vroom.wasm'].sort(),
    );
    expect(lock.folder).toBe('vroom-1.15.0-870d7d5e');
    expect(lock.files['vroom.wasm']).toEqual({
      sha256: '60086074ad9ffd3bfcf5afb053bdbd479e0356128b373c0e30dc9fa95f43af51',
      bytes: 919_927,
    });
  });

  test('a lock without a full commit, or with a path in a file name, is refused', () => {
    const write = (lock: unknown) => {
      const file = fresh(`lock-${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(lock));
      return file;
    };
    const good = lockOf(FILES);
    expect(() =>
      readLock(write({ ...good, source: { ...good.source, commit: '34b4515' } })),
    ).toThrow('commit');
    expect(() => readLock(write({ ...good, files: { '../x': good.files['a.wasm'] } }))).toThrow(
      'bad entry',
    );
    expect(readLock(write(good)).folder).toBe(good.folder);
  });
});

describe('mismatches', () => {
  const lock = lockOf(FILES);

  test('the locked bytes are clean', () => {
    expect(mismatches(FILES, lock)).toEqual([]);
  });

  test('one tampered byte fails, naming the file and both hashes', () => {
    const tampered = { ...FILES, 'a.wasm': new Uint8Array(FILES['a.wasm']) };
    tampered['a.wasm'][2] = (tampered['a.wasm'][2] ?? 0) ^ 1;
    const problems = mismatches(tampered, lock);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a.wasm');
    expect(problems[0]).toContain(sha256(tampered['a.wasm']));
    expect(problems[0]).toContain(lock.files['a.wasm']?.sha256);
  });

  test('a short file, a missing file and a file the lock does not name all fail', () => {
    expect(mismatches({ ...FILES, 'a.wasm': bytes('\0asm') }, lock)[0]).toContain('bytes');
    expect(mismatches({ 'a.wasm': FILES['a.wasm'] }, lock)).toEqual(['b.mjs: missing']);
    expect(mismatches({ ...FILES, 'extra.js': bytes('x') }, lock)).toEqual([
      'extra.js: not in the lock',
    ]);
  });
});

describe('fetchSolver', () => {
  test('writes the locked files and nothing else, then does nothing the second time', () => {
    const root = fresh('ok');
    const lock = lockOf(FILES);
    let reads = 0;
    const read = () => (reads++, FILES);
    expect(fetchSolver({ lock, root, read })).toEqual({
      dir: join(root, lock.folder),
      fetched: true,
    });
    expect(readdirSync(root)).toEqual([lock.folder]);
    expect(verifyFolder(join(root, lock.folder), lock)).toEqual([]);
    expect(fetchSolver({ lock, root, read }).fetched).toBe(false);
    expect(reads).toBe(1);
  });

  test('a tampered byte fails the fetch and leaves no folder to serve', () => {
    const root = fresh('tampered');
    const lock = lockOf(FILES);
    const bad = { ...FILES, 'b.mjs': bytes('export const b = 2;\n') };
    expect(() => fetchSolver({ lock, root, read: () => bad })).toThrow(/does not match.*b\.mjs/s);
    expect(existsSync(join(root, lock.folder))).toBe(false);
    // Nothing was created at all: the check comes before the first write.
    expect(existsSync(root)).toBe(false);
  });

  test('a folder on disk with a changed byte is fetched again, not trusted', () => {
    const root = fresh('stale');
    const lock = lockOf(FILES);
    fetchSolver({ lock, root, read: () => FILES });
    writeFileSync(join(root, lock.folder, 'b.mjs'), 'export const b = 3;\n');
    expect(verifyFolder(join(root, lock.folder), lock)[0]).toContain('b.mjs');
    expect(fetchSolver({ lock, root, read: () => FILES }).fetched).toBe(true);
    expect(readFolder(join(root, lock.folder))['b.mjs']).toEqual(FILES['b.mjs']);
  });

  test('a folder with a file the lock does not name is not the locked folder', () => {
    const root = fresh('extra');
    const lock = lockOf(FILES);
    fetchSolver({ lock, root, read: () => FILES });
    writeFileSync(join(root, lock.folder, 'extra.mjs'), 'x');
    expect(verifyFolder(join(root, lock.folder), lock)).toEqual(['extra.mjs: not in the lock']);
  });
});

describe('readFromGit, on a throwaway repository', () => {
  // An anonymous git read: a shallow fetch of one commit into a temporary bare repository, then
  // `git show <commit>:<path>/<file>`. The repository here is made in the test; no network.
  const repo = fresh('repo');
  mkdirSync(join(repo, 'solver'), { recursive: true });
  for (const [name, b] of Object.entries(FILES)) writeFileSync(join(repo, 'solver', name), b);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'solver files');
  const commit = git('rev-parse', 'HEAD');
  const url = `file://${repo}`;

  test('reads each locked file at the locked commit, byte for byte', () => {
    const lock = lockOf(FILES, commit);
    const read = readFromGit(lock, url);
    expect(Object.keys(read).sort()).toEqual(['a.wasm', 'b.mjs']);
    expect(mismatches(read, lock)).toEqual([]);
  });

  test('fetchSolver over it fetches, verifies and installs', () => {
    const root = fresh('from-git');
    const lock = lockOf(FILES, commit);
    expect(fetchSolver({ lock, root, read: (l) => readFromGit(l, url) }).fetched).toBe(true);
    expect(verifyFolder(join(root, lock.folder), lock)).toEqual([]);
  });

  test('a lock whose hash is not the commit’s content fails the build', () => {
    const lock = lockOf({ ...FILES, 'b.mjs': bytes('something else') }, commit);
    const root = fresh('from-git-bad');
    expect(() => fetchSolver({ lock, root, read: (l) => readFromGit(l, url) })).toThrow(
      /b\.mjs: (SHA-256|\d+ bytes)/,
    );
    expect(existsSync(join(root, lock.folder))).toBe(false);
  });

  test('a commit the repository does not have fails', () => {
    expect(() => readFromGit(lockOf(FILES, 'b'.repeat(40)), url)).toThrow();
  });
});

describe('the real folder', () => {
  const lock = readLock();
  const dir = join(solverRoot(), lock.folder);
  const present = existsSync(dir);
  if (!present) {
    console.warn(
      `solver-lock: ${dir} is absent (run pnpm --filter web build); skipping its checks`,
    );
  }

  test.skipIf(!present)('matches the committed lock', () => {
    expect(verifyFolder(dir, lock)).toEqual([]);
  });

  test.skipIf(!present)('one flipped bit in vroom.wasm is caught', () => {
    const copy = fresh('real-copy');
    cpSync(dir, copy, { recursive: true });
    const wasm = readFileSync(join(copy, 'vroom.wasm'));
    const middle = wasm.length >> 1;
    wasm[middle] = (wasm[middle] ?? 0) ^ 1;
    writeFileSync(join(copy, 'vroom.wasm'), wasm);
    const problems = verifyFolder(copy, lock);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vroom.wasm');
  });

  test('the lock file is the one the script reads', () => {
    expect(LOCK_FILE.endsWith('apps/web/solver.lock.json')).toBe(true);
  });
});
