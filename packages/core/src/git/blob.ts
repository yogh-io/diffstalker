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
 *
 * **Reads are bounded by what was asked for.** `read(n)` transfers at most `n`
 * bytes on every side: the working tree reads that many from the fd, and the
 * git sides read that many off `cat-file`'s pipe and then pause it. A caller
 * that peeks and then asks for only what the peek says it needs — the blob
 * route reads 16 bytes, then just the window that decides that format —
 * really does read less.
 *
 * **And a peek plus a read is one pass, on both sides.** The fd stays open and
 * the `cat-file` child stays alive between reads, so a bigger second read
 * continues where the first stopped instead of starting the file over. The
 * price is that `close()` is not optional on either side: it releases the fd
 * and kills a git that would otherwise sit paused on a pipe.
 */

import { execFile, spawn } from 'node:child_process';
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
   * At most `n` bytes, always from the start, and never more than `n`
   * transferred. Reads the SAME fd (worktree) or the SAME oid (index/HEAD)
   * that was checked at open, and never touches the path again — so what was
   * sized and typed is what comes back.
   *
   * The handle keeps the longest prefix it has already fetched, so calling
   * `read` twice returns the same bytes twice and a small peek followed by a
   * big read costs one pass over the bytes, not two. One read at a time, and
   * none after `close()`.
   */
  read(n: number): Promise<Uint8Array>;
  /** Release the fd and drop the buffered prefix. */
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

/** Exit code of `rev-parse --verify --quiet` when its argument names no object. */
const REV_PARSE_NO_SUCH_REV = 1;

/**
 * The commit HEAD names, or null when HEAD is unborn.
 *
 * `--quiet` is what makes the two cases tellable apart: with it, rev-parse
 * exits 1 and says nothing when HEAD simply names no commit (a repo with no
 * commit yet), while every real failure — not a repo, an unreadable object
 * store, a bad config — still exits 128, and a timeout kills the process with
 * no exit code at all. Only the first is "this side has no bytes"; the rest
 * are propagated, because reporting a broken repo as an empty HEAD would turn
 * it into a 404 and hide the actual problem.
 */
async function headCommit(repoPath: string): Promise<string | null> {
  let oid: string;
  try {
    const out = await runGit(
      repoPath,
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
      METADATA_MAX_BUFFER
    );
    oid = out.toString('utf8').trim();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === REV_PARSE_NO_SUCH_REV) return null;
    throw err;
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

/** The one empty read, so a zero-length read allocates nothing. */
const NO_BYTES = Buffer.alloc(0);

/**
 * Read `length` bytes from `position`. A regular file may hand back a short
 * read, hence the loop; a read of nothing means the file ended early (it
 * shrank under us), and then what is really there is returned rather than a
 * tail padded with zeroes.
 */
async function readAt(
  handle: fs.promises.FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

interface PrefixReader {
  read(n: number): Promise<Uint8Array>;
  release(): void;
}

/**
 * Serve every read from the longest prefix fetched so far, and go back to the
 * source only when a caller asks for more than that.
 *
 * Two properties fall out of it. A read never transfers more than the caller
 * asked for, so the caller's cap really is the bound on the work — the route
 * peeks a few bytes to see which signature it is holding, then asks for the
 * window that decides that format, and /media stops there rather than pulling
 * the other 8 MiB of a photo off disk to report its width. And a peek followed
 * by a larger read costs one pass over the bytes instead of two, on both sides:
 * every `extend` gets what is already held and is expected to fetch only the
 * difference.
 *
 * `extend(want, have)` returns a prefix of at most `want` bytes starting with
 * `have`; anything shorter than `want` means the source has no more to give,
 * and there is no point asking again.
 */
function prefixReader(
  size: number,
  extend: (want: number, have: Buffer) => Promise<Buffer>
): PrefixReader {
  let have: Buffer = NO_BYTES;
  let exhausted = false;
  return {
    async read(n: number): Promise<Uint8Array> {
      const want = Math.max(0, Math.min(n, size));
      if (want > have.length && !exhausted) {
        const grown = await extend(want, have);
        exhausted = grown.length < want;
        have = grown;
      }
      return have.subarray(0, Math.min(want, have.length));
    },
    release(): void {
      have = NO_BYTES;
      exhausted = false;
    },
  };
}

interface BlobStream {
  /** At most `want` bytes from the start, fetching only what is still missing. */
  read(want: number): Promise<Buffer>;
  /** Drop the buffered bytes and kill the child. Not optional. */
  release(): void;
}

/**
 * One `git cat-file blob`, read in as many bites as the caller takes.
 *
 * `execFile`'s maxBuffer cannot express a budget: it is a kill-and-fail
 * threshold, so asking for four bytes of a 5 MiB blob with it would be an
 * error rather than a short read, and sizing it for the whole object — which
 * is what this used to do — transfers the whole object no matter how little
 * the caller allowed. Spawning hands us the pipe itself: take what was asked
 * for and pause it, so an 8 MiB photo costs a 64 KiB read when a 64 KiB header
 * is all the caller will look at.
 *
 * The child then STAYS, paused, and a larger read resumes the same pipe where
 * the last one stopped. Re-running `cat-file` instead would be correct — a
 * blob is addressed by its content, so a refetch cannot return different bytes
 * — but it doubles the process count on exactly the route whose semaphore
 * exists because one viewport must not become a process table full of git.
 * Peek-then-read is one child here, the same one pass the fd side gets.
 *
 * A paused pipe fills and then git blocks on its next write, which is the
 * point: an unread blob costs one pipe buffer, not a resident copy. It also
 * means `release()` must run — see the module comment.
 *
 * The pipe reads in chunks, so a 16-byte peek really takes one chunk, and the
 * whole chunk is kept: those bytes are already paid for and the next read
 * starts from them.
 */
function catFileStream(repoPath: string, oid: string): BlobStream {
  let child: ReturnType<typeof spawn> | null = null;
  const chunks: Buffer[] = [];
  let total = 0;
  let stdoutEnded = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let failure: Error | null = null;
  let released = false;
  let waiter: {
    want: number;
    resolve: (bytes: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /** Nothing more will arrive: stdout is done AND the process is gone. */
  const drained = (): boolean => stdoutEnded && exit !== null;

  /** Collapse to one buffer so repeated reads do not re-concat the chunks. */
  const collapse = (): Buffer => {
    if (chunks.length !== 1) {
      const joined = Buffer.concat(chunks, total);
      chunks.length = 0;
      chunks.push(joined);
    }
    return chunks[0];
  };

  function wake(): void {
    if (waiter === null) return;
    // A non-zero exit is only ours to report while a read is waiting on it; a
    // signal means we did the killing, in release() or on the timeout.
    if (failure === null && drained() && exit?.signal === null && exit.code !== 0) {
      failure = new Error(`git cat-file blob failed for ${oid} (exit ${exit.code ?? 'null'})`);
    }
    if (failure === null && total < waiter.want && !drained()) return;

    const settled = waiter;
    waiter = null;
    clearTimeout(settled.timer);
    // Nobody is asking any more, so stop pulling the object into memory.
    child?.stdout?.pause();
    if (failure !== null) settled.reject(failure);
    else settled.resolve(collapse().subarray(0, Math.min(settled.want, total)));
  }

  function fail(err: Error): void {
    failure ??= err;
    wake();
  }

  function start(): void {
    const spawned = spawn('git', [...GIT_PREFIX, 'cat-file', 'blob', oid], {
      cwd: repoPath,
      env: gitEnv(),
      // stderr goes nowhere: nothing here reads it, and a pipe nobody drains
      // is a pipe git can block on forever.
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child = spawned;
    spawned.stdout?.on('data', (chunk: Buffer) => {
      // A chunk already in flight when release() ran must not refill the
      // buffer it just emptied.
      if (released) return;
      chunks.push(chunk);
      total += chunk.length;
      wake();
    });
    spawned.stdout?.on('end', () => {
      stdoutEnded = true;
      wake();
    });
    spawned.stdout?.on('error', fail);
    spawned.on('error', fail);
    spawned.on('close', (code, signal) => {
      exit = { code, signal };
      wake();
    });
  }

  return {
    read(want: number): Promise<Buffer> {
      if (failure !== null) return Promise.reject(failure);
      if (released) return Promise.reject(new Error(`read after close for ${oid}`));
      if (want <= total || drained()) {
        return Promise.resolve(collapse().subarray(0, Math.min(want, total)));
      }
      // One reader at a time: a second one would replace the first's waiter and
      // leave that promise hanging for good.
      if (waiter !== null) return Promise.reject(new Error(`concurrent read of ${oid}`));

      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          child?.kill('SIGKILL');
          fail(new Error(`git cat-file blob timed out for ${oid}`));
        }, GIT_TIMEOUT_MS);
        waiter = { want, resolve, reject, timer };
        // Resuming can emit synchronously, so the waiter is in place first.
        if (child === null) start();
        else child.stdout?.resume();
      });
    },
    release(): void {
      released = true;
      if (waiter !== null) fail(new Error(`git cat-file blob closed while reading ${oid}`));
      chunks.length = 0;
      total = 0;
      child?.kill('SIGKILL');
      child = null;
    },
  };
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
    // Each extension reads only the part that is missing, from the position
    // right after what we hold, so a peek plus a full read is one pass over
    // the file.
    const reader = prefixReader(size, async (want, have) => {
      const tail = await readAt(handle, have.length, want - have.length);
      return have.length === 0 ? tail : Buffer.concat([have, tail]);
    });
    return {
      oid: null,
      size,
      version: `${size}-${stats.mtimeMs}`,
      read: (n) => reader.read(n),
      close: () => {
        reader.release();
        return handle.close();
      },
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

  // Nothing is spawned at open, so refusing an over-cap or wrong-mode blob
  // costs no transfer at all — and every read that follows takes only the
  // bytes it asked for from the one child, never the handle's whole cap.
  const stream = catFileStream(repoPath, oid);
  const reader = prefixReader(size, (want) => stream.read(want));
  return {
    oid,
    size,
    version: oid,
    read: (n) => reader.read(n),
    close(): Promise<void> {
      reader.release();
      stream.release();
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
