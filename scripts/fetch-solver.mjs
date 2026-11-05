// Fetches the dispatch screen's solver at build time, verifies it against apps/web/solver.lock.json
// and leaves it in apps/web/public/app/dispatch/solver/<folder>/, a git-ignored folder (ADR 0012,
// decision 6). The files are the site's Route Lab solver, VROOM 1.15.0 compiled to WebAssembly,
// read from the site's repository at the commit the lock pins: a shallow fetch of that one commit
// into a temporary bare repository, then `git show <commit>:<path>` for each file. An anonymous
// git read, never a GitHub API or a raw URL. Node 22, no dependency.
//
//   node scripts/fetch-solver.mjs            fetch what is missing or wrong, verify, exit 1 on a mismatch
//   node scripts/fetch-solver.mjs --check    verify the folder only; exit 1 if it is absent or wrong
//
// FETCH_SOLVER_REPOSITORY replaces the lock's repository URL (a local clone for an offline run). The
// commit is still the lock's, and every byte is still checked against the lock's hashes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB = resolve(here, '..', 'apps', 'web');
export const LOCK_FILE = join(WEB, 'solver.lock.json');

/** The folder under public/ the solver is served from. */
export const solverRoot = (web = WEB) => join(web, 'public', 'app', 'dispatch', 'solver');

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function readLock(file = LOCK_FILE) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const { source, folder, files } = lock;
  if (!source?.repository || !/^[0-9a-f]{40}$/.test(source.commit ?? '') || !source.path) {
    throw new Error(`${file}: source needs a repository, a full 40-digit commit and a path`);
  }
  if (!folder || /[\\/]/.test(folder)) throw new Error(`${file}: folder must be a bare name`);
  if (!files || Object.keys(files).length === 0) throw new Error(`${file}: no files`);
  for (const [name, entry] of Object.entries(files)) {
    if (/[\\/]/.test(name) || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      throw new Error(`${file}: bad entry ${name}`);
    }
  }
  return lock;
}

/**
 * Checks bytes against the lock: every file present with the locked length and SHA-256, and no
 * other file in the folder. Returns the problems, empty when the folder is the locked one.
 * @param {Record<string, Uint8Array>} found
 */
export function mismatches(found, lock) {
  const problems = [];
  for (const [name, want] of Object.entries(lock.files)) {
    const bytes = found[name];
    if (bytes === undefined) {
      problems.push(`${name}: missing`);
    } else if (bytes.length !== want.bytes) {
      problems.push(`${name}: ${bytes.length} bytes, the lock says ${want.bytes}`);
    } else if (sha256(bytes) !== want.sha256) {
      problems.push(`${name}: SHA-256 ${sha256(bytes)}, the lock says ${want.sha256}`);
    }
  }
  for (const name of Object.keys(found)) {
    if (!(name in lock.files)) problems.push(`${name}: not in the lock`);
  }
  return problems;
}

/** The files of a folder, by name; an empty record for a folder that is not there. */
export function readFolder(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, new Uint8Array(readFileSync(join(dir, name)))]),
  );
}

/** Problems with the folder on disk, or an empty list when it is the locked one. */
export function verifyFolder(dir, lock) {
  return existsSync(dir) ? mismatches(readFolder(dir), lock) : [`${dir}: absent`];
}

/** Reads the locked files from the repository at the locked commit, into memory. */
export function readFromGit(lock, repository = lock.source.repository) {
  const bare = mkdtempSync(join(tmpdir(), 'solver-'));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: bare,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000, // an offline fetch ends in a failure, not a hang
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  try {
    git(['init', '--bare', '--quiet', '.']);
    git(['fetch', '--quiet', '--depth', '1', repository, lock.source.commit]);
    const fetched = git(['rev-parse', 'FETCH_HEAD']).toString('utf8').trim();
    if (fetched !== lock.source.commit) {
      throw new Error(`fetched ${fetched}, the lock pins ${lock.source.commit}`);
    }
    return Object.fromEntries(
      Object.keys(lock.files).map((name) => [
        name,
        new Uint8Array(git(['show', `${lock.source.commit}:${lock.source.path}/${name}`])),
      ]),
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

/**
 * Makes the locked folder exist under `root`: nothing to do when it already verifies, else a fetch,
 * a check and a rename into place. Throws, leaving no folder, when a byte differs from the lock.
 * @returns {{ dir: string, fetched: boolean }}
 */
export function fetchSolver({
  lock = readLock(),
  root = solverRoot(),
  read = (l) => readFromGit(l, process.env.FETCH_SOLVER_REPOSITORY || undefined),
} = {}) {
  const dir = join(root, lock.folder);
  if (verifyFolder(dir, lock).length === 0) return { dir, fetched: false };
  const files = read(lock);
  const problems = mismatches(files, lock);
  if (problems.length > 0) {
    throw new Error(`the solver does not match solver.lock.json:\n  ${problems.join('\n  ')}`);
  }
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, '.staging-'));
  chmodSync(staging, 0o755); // mkdtemp makes 0700
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(staging, name), bytes);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { dir, fetched: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const lock = readLock();
    if (process.argv.includes('--check')) {
      const problems = verifyFolder(join(solverRoot(), lock.folder), lock);
      if (problems.length > 0) throw new Error(problems.join('\n  '));
      console.log(`solver: ${lock.folder} matches the lock`);
    } else {
      const { dir, fetched } = fetchSolver({ lock });
      console.log(
        `solver: ${fetched ? 'fetched' : 'already in place'}, ${Object.keys(lock.files).length} files verified in ${dir}`,
      );
    }
  } catch (error) {
    console.error(`solver: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
