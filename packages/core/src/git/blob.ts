/**
 * Read one file's raw bytes from one side of a repo: the working tree, the
 * index, or HEAD.
 *
 * This is the only place in core that hands repository bytes to a client
 * untouched, so every step is written defensively.
 *
 * **Working tree.** Open the fd FIRST, fstat THAT fd, and read from the same
 * fd. Stat-by-path then open-by-path is two lookups of one name, and anything
 * that happens in between (a rename, a symlink swapped in) makes the inode we
 * checked and the inode we read two different files. One open collapses that
 * window instead of narrowing it. The open carries `O_NONBLOCK` because
 * `open(2)` on a FIFO with no writer blocks until a writer appears — and it
 * blocks a libuv threadpool thread, so it takes down more than this call.
 * Containment (realpath, `.git` refusal, traversal) belongs to the caller and
 * runs before we get here.
 *
 * **Index and HEAD.** Plain `execFile`, never a shell, never `simple-git`.
 * `simple-git`'s `git.raw()` decodes stdout as a string, which replaces every
 * byte that is not valid UTF-8 with U+FFFD — silent, total corruption of
 * exactly the files this module exists to serve. Bytes come out of
 * `git cat-file blob <oid>`: never `git show`, never `--filters`, never
 * `--textconv`, so a `.gitattributes` smudge filter committed by whoever wrote
 * the repo cannot make us run a program.
 *
 * Every invocation carries the same prefix — fsmonitor off (no daemon
 * spawned), pager `cat` (no pager process), hooks path `/dev/null` (no repo
 * hook runs), `--literal-pathspecs` (a path is a path, not a pathspec) — and
 * the caller's path appears in argv exactly once, immediately after `--`.
 * `--literal-pathspecs` plus the leading-`:` refusal below is what stops
 * `:(glob)`, `:(exclude)`, `:(attr:…)` and `:/` from resolving a blob other
 * than the one the caller's guards validated.
 *
 * The size of every side is known before a single byte is read, so an
 * over-cap file costs one metadata call and no transfer.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { BlobSide } from '../utils/blobRef.js';
import { gitEnv } from './gitClient.js';

const execFileAsync = promisify(execFile);

/**
 * Thrown when the path resolves to something other than a regular file: a
 * directory, FIFO, socket or device in the working tree, or a tree
 * (`040000`), symlink (`120000`) or submodule gitlink (`160000`) entry in the
 * index or a commit. None of these are bytes a client may read, and a symlink
 * entry in particular is a stored path that would otherwise be followed.
 */
export class NotRegularBlobError extends Error {
  constructor(relPath: string) {
    super(`Not a regular blob: ${relPath}`);
    this.name = 'NotRegularBlobError';
  }
}

/** Thrown when the file is larger than the caller's cap. Nothing is read. */
export class BlobTooLargeError extends Error {
  readonly size: number;

  constructor(relPath: string, size: number) {
    super(`Blob too large: ${relPath} (${size} bytes)`);
    this.name = 'BlobTooLargeError';
    this.size = size;
  }
}

/**
 * Thrown for a path git could read as something other than a plain path.
 * The daemon rejects these lexically long before this module sees them, so
 * this is a belt: core must not depend on a caller's guards being present.
 */
export class UnsafeBlobPathError extends Error {
  constructor(reason: string) {
    super(`Unsafe blob path: ${reason}`);
    this.name = 'UnsafeBlobPathError';
  }
}

export interface BlobHandle {
  /** null for the worktree side (the file is not a git object). */
  oid: string | null;
  size: number;
  /** Cache key: the oid, or `${size}-${mtimeMs}` for the worktree side. */
  version: string;
  /**
   * At most `n` bytes, always from the start. Reads the SAME fd (worktree) or
   * the SAME oid (index/HEAD) that was checked at open, and never touches the
   * path again — so what was sized and typed is what comes back.
   */
  read(n: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Prefix on every git invocation. See the module comment for the why of each. */
const GIT_PREFIX = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '--literal-pathspecs',
];

/** A wedged git must not hold a request open. */
const GIT_TIMEOUT_MS = 5000;

/** One metadata record is a few hundred bytes; this is already generous. */
const METADATA_MAX_BUFFER = 64 * 1024;

/** SHA-1 (40) or SHA-256 (64) object id. Checked before an oid reaches git. */
const OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Regular file and executable file. Everything else is not readable bytes. */
const ALLOWED_MODES = new Set(['100644', '100755']);

/** One git index/tree record, after the mode and oid have been read out. */
interface GitEntry {
  mode: string;
  oid: string;
  /** Present for a tree entry (`ls-tree -l` prints it); null for the index. */
  sizeText: string | null;
}

/**
 * Refuse a path git could read as an option or a pathspec. `--` and
 * `--literal-pathspecs` already neutralise both, but a path that needs either
 * of them to be safe is a path we do not want to send at all.
 */
function assertSafeRelPath(relPath: string): void {
  if (relPath === '') throw new UnsafeBlobPathError('empty');
  if (relPath.includes('\0')) throw new UnsafeBlobPathError('contains NUL');
  if (relPath.startsWith('-')) throw new UnsafeBlobPathError('starts with "-"');
  if (relPath.startsWith(':')) throw new UnsafeBlobPathError('starts with ":"');
}

/** Run git and return stdout as BYTES. */
async function runGit(repoPath: string, args: string[], maxBuffer: number): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', [...GIT_PREFIX, ...args], {
    cwd: repoPath,
    env: gitEnv(),
    // execFile's default encoding is utf8, which would decode stdout into a
    // string and destroy every non-UTF-8 byte. 'buffer' is the only setting
    // that keeps blob bytes intact.
    encoding: 'buffer',
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

/** Split `-z` output into records. Git terminates each with a NUL. */
function nulRecords(out: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue;
    if (i > start) records.push(out.subarray(start, i));
    start = i + 1;
  }
  if (start < out.length) records.push(out.subarray(start));
  return records;
}

/**
 * Find the record for exactly this path and return its ASCII header fields.
 *
 * The path is compared as BYTES. Git stores raw filename bytes, so decoding
 * first would turn a name that is not valid UTF-8 into U+FFFD and then match
 * the wrong file, or fail to match the right one. Records are NUL-delimited
 * and the path is everything after the record's first TAB, so a filename
 * containing a newline — or a whole forged-looking record — is just data.
 */
function headerFieldsFor(records: Buffer[], relPath: string): string[] | null {
  const want = Buffer.from(relPath, 'utf8');
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    if (!record.subarray(tab + 1).equals(want)) continue;
    return record.subarray(0, tab).toString('utf8').trim().split(/\s+/);
  }
  return null;
}

/** The commit HEAD names, or null when HEAD is unborn. */
async function headCommit(repoPath: string): Promise<string | null> {
  let oid: string;
  try {
    const out = await runGit(
      repoPath,
      ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      METADATA_MAX_BUFFER
    );
    oid = out.toString('utf8').trim();
  } catch {
    // A repo with no commit yet: rev-parse exits non-zero. That is "this side
    // has no bytes", not a failure, so the caller gets null like any other
    // missing path.
    return null;
  }
  return OID_PATTERN.test(oid) ? oid : null;
}

/** `<mode> <type> <oid> <size>\t<path>` from the commit HEAD names. */
async function headEntry(repoPath: string, relPath: string): Promise<GitEntry | null> {
  const commit = await headCommit(repoPath);
  if (commit === null) return null;

  const out = await runGit(
    repoPath,
    ['ls-tree', '-z', '--full-tree', '-l', commit, '--', relPath],
    METADATA_MAX_BUFFER
  );
  const fields = headerFieldsFor(nulRecords(out), relPath);
  if (fields === null || fields.length !== 4) return null;
  return { mode: fields[0], oid: fields[2], sizeText: fields[3] };
}

/**
 * `<mode> <oid> <stage>\t<path>` from the index. Stage 0 only: a conflicted
 * file has stages 1/2/3 and no single "the indexed content", so it reads as
 * absent on this side rather than as an arbitrary one of the three.
 */
async function indexEntry(repoPath: string, relPath: string): Promise<GitEntry | null> {
  const out = await runGit(
    repoPath,
    ['ls-files', '--stage', '-z', '--', relPath],
    METADATA_MAX_BUFFER
  );
  const fields = headerFieldsFor(nulRecords(out), relPath);
  if (fields === null || fields.length !== 3) return null;
  if (fields[2] !== '0') return null;
  return { mode: fields[0], oid: fields[1], sizeText: null };
}

function parseSize(text: string, relPath: string): number {
  const size = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`git reported a malformed size for ${relPath}`);
  }
  return size;
}

/** Object size without transferring the object. */
async function blobSize(repoPath: string, oid: string, relPath: string): Promise<number> {
  const out = await runGit(repoPath, ['cat-file', '-s', oid], METADATA_MAX_BUFFER);
  return parseSize(out.toString('utf8').trim(), relPath);
}

/**
 * Read from a fixed position every time, so repeated reads of one handle are
 * idempotent and a caller can never advance past what was sized. A regular
 * file may hand back a short read, hence the loop.
 */
async function readFromFd(
  handle: fs.promises.FileHandle,
  size: number,
  n: number
): Promise<Uint8Array> {
  const want = Math.max(0, Math.min(n, size));
  const buffer = Buffer.alloc(want);
  let filled = 0;
  while (filled < want) {
    const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
    // The file shrank under us. Return what is really there rather than
    // padding the tail with zeroes.
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** ENOENT/ENOTDIR mean "no such file on this side", which is not an error. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function openWorktreeBlob(
  repoPath: string,
  relPath: string,
  maxBytes: number
): Promise<BlobHandle | null> {
  const fullPath = path.join(repoPath, relPath);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new NotRegularBlobError(relPath);
    if (stats.size > maxBytes) throw new BlobTooLargeError(relPath, stats.size);

    const size = stats.size;
    return {
      oid: null,
      size,
      version: `${size}-${stats.mtimeMs}`,
      read: (n) => readFromFd(handle, size, n),
      close: () => handle.close(),
    };
  } catch (err) {
    // Do not leak the fd when the checks refuse the file. A failure to close
    // says nothing useful next to the reason we are here, so it does not
    // replace it.
    try {
      await handle.close();
    } catch {
      /* the original error is the one that matters */
    }
    throw err;
  }
}

async function openGitBlob(
  repoPath: string,
  side: 'index' | 'head',
  relPath: string,
  maxBytes: number
): Promise<BlobHandle | null> {
  const entry =
    side === 'head' ? await headEntry(repoPath, relPath) : await indexEntry(repoPath, relPath);
  if (entry === null) return null;

  if (!ALLOWED_MODES.has(entry.mode)) throw new NotRegularBlobError(relPath);
  if (!OID_PATTERN.test(entry.oid)) {
    throw new Error(`git reported a malformed object id for ${relPath}`);
  }

  const oid = entry.oid;
  const size =
    entry.sizeText === null
      ? await blobSize(repoPath, oid, relPath)
      : parseSize(entry.sizeText, relPath);
  if (size > maxBytes) throw new BlobTooLargeError(relPath, size);

  // The bytes are fetched on the first read, not at open, so refusing an
  // over-cap or wrong-mode blob costs no transfer at all. Once fetched they
  // are kept, so a second read cannot resolve a different object.
  let bytes: Buffer | null = null;
  return {
    oid,
    size,
    version: oid,
    async read(n: number): Promise<Uint8Array> {
      bytes ??= await runGit(repoPath, ['cat-file', 'blob', oid], maxBytes + 4096);
      return bytes.subarray(0, Math.max(0, Math.min(n, bytes.length)));
    },
    close(): Promise<void> {
      bytes = null;
      return Promise.resolve();
    },
  };
}

/**
 * Open one side of one file. Returns null when the path does not exist on
 * that side (including an unborn HEAD), throws NotRegularBlobError for
 * anything that is not a regular file, BlobTooLargeError when it is over
 * `maxBytes`, and UnsafeBlobPathError for a path git could reinterpret.
 */
export async function openBlob(
  repoPath: string,
  side: BlobSide,
  relPath: string,
  maxBytes: number
): Promise<BlobHandle | null> {
  assertSafeRelPath(relPath);
  if (side === 'worktree') return openWorktreeBlob(repoPath, relPath, maxBytes);
  return openGitBlob(repoPath, side, relPath, maxBytes);
}
