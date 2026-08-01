/**
 * Pure explorer data functions: directory listing with git status
 * annotation, and file reads for display with binary/size/truncation FLAGS
 * (no presentation prose baked into content).
 *
 * Shared by the daemon's stateless /tree and /file endpoints (the CLI's
 * ExplorerViewModel applies its own prose on top of the flags) — one
 * implementation, no duplication.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIgnoredFiles } from './ignoreUtils.js';
import { isBinaryContent } from '../utils/binaryDetect.js';
import { sniffImage, sniffWindow, MAX_IMAGE_BYTES } from '../utils/imageSniff.js';
import type { ImageInfo, ImageRefusal, SniffResult } from '../utils/imageSniff.js';
import type { FileStatus } from './status.js';
import type { GitStatusMap } from './explorerStatus.js';

// Re-export the pure explorer status helpers so existing importers (the
// daemon) keep working through `git/explorerData`. The CLI imports them
// straight from `git/explorerStatus` to avoid pulling this module's
// simple-git dependency (via listDirectory's git check-ignore call).
export { buildGitStatusMap } from './explorerStatus.js';
export type { GitStatusMap } from './explorerStatus.js';

/**
 * Maximum file size served as TEXT (larger files get tooLarge). It is only
 * the text cap: an image is decided by the image caps in utils/imageSniff,
 * which are much higher, so a 4 MiB photo still gets a media verdict.
 */
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/** Maximum lines kept in content before truncation kicks in. */
export const MAX_DISPLAY_LINES = 5000;

/**
 * Thrown by readFileForDisplay when the path resolves to something other
 * than a regular file (directory, FIFO, socket, device). Reading such a
 * path must be refused up front: opening a FIFO blocks the event loop
 * until a writer appears, freezing the whole process.
 */
export class NotRegularFileError extends Error {
  constructor(relPath: string) {
    super(`Not a regular file: ${relPath}`);
    this.name = 'NotRegularFileError';
  }
}

/** One entry of a single-level directory listing. */
export interface DirEntry {
  name: string;
  /** Path relative to the repo root. */
  path: string;
  type: 'file' | 'dir';
  /** For files: working-tree git status, when a status map is supplied. */
  gitStatus?: FileStatus;
  /** For files with a gitStatus: true when the change is staged. */
  staged?: boolean;
  /** For dirs: true when the directory contains changed files. */
  hasChanges?: boolean;
}

export interface ListDirectoryOptions {
  /** Skip dot-prefixed entries (default true). */
  hideHidden: boolean;
  /** Skip gitignored entries via `git check-ignore` (default true).
   *  Pass false for non-git directories to avoid the git call. */
  hideGitignored: boolean;
}

/**
 * What the image sniffer made of a file's magic bytes: either an accepted
 * image, or the reason it is not one we hand to a browser. Exactly one of
 * image/refusal is set.
 */
export interface FileMedia {
  image: ImageInfo | null;
  refusal: ImageRefusal | null;
  /** Cache key for the blob URL; changes when the bytes change. */
  version: string;
}

export interface FileForDisplay {
  /** File text; empty when binary or tooLarge is set. */
  content: string;
  binary: boolean;
  /** Content was cut at MAX_DISPLAY_LINES. */
  truncated: boolean;
  /** File exceeds MAX_FILE_SIZE; content not read. */
  tooLarge: boolean;
  /** File size in bytes. */
  size: number;
  /** Total line count of the file (0 when binary or tooLarge). */
  totalLines: number;
  /**
   * Image verdict, from magic bytes only. Set for binary files, and for
   * oversized files whose bytes said something useful. Absent for text and
   * whenever we learned nothing — a client treats its presence as "this is
   * not text", so it must never ride along on a plain text file.
   */
  media?: FileMedia;
}

/**
 * List one directory level: hidden and gitignored entries filtered,
 * directories first then files, alphabetical within each group. When a
 * statusMap is given, files carry their git status and directories are
 * marked when they contain changes.
 *
 * Throws the raw fs error (ENOENT/ENOTDIR) when relDir does not exist.
 */
export async function listDirectory(
  repoPath: string,
  relDir: string,
  options?: Partial<ListDirectoryOptions>,
  statusMap?: GitStatusMap
): Promise<DirEntry[]> {
  const hideHidden = options?.hideHidden ?? true;
  const hideGitignored = options?.hideGitignored ?? true;

  const fullPath = path.join(repoPath, relDir);
  const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

  // Build list of paths for gitignore check
  const pathsToCheck = entries.map((e) => (relDir ? path.join(relDir, e.name) : e.name));
  const ignoredFiles = hideGitignored
    ? await getIgnoredFiles(repoPath, pathsToCheck)
    : new Set<string>();

  const result: DirEntry[] = [];
  for (const entry of entries) {
    // Filter dot-prefixed hidden files
    if (hideHidden && entry.name.startsWith('.')) continue;

    const entryPath = relDir ? path.join(relDir, entry.name) : entry.name;

    // Filter gitignored files
    if (hideGitignored && ignoredFiles.has(entryPath)) continue;

    const isDir = entry.isDirectory();
    const dirEntry: DirEntry = {
      name: entry.name,
      path: entryPath,
      type: isDir ? 'dir' : 'file',
    };

    if (statusMap) {
      if (isDir) {
        if (statusMap.directories.has(entryPath)) dirEntry.hasChanges = true;
      } else {
        const status = statusMap.files.get(entryPath);
        if (status) {
          dirEntry.gitStatus = status.status;
          dirEntry.staged = status.staged;
        }
      }
    }

    result.push(dirEntry);
  }

  // Sort: directories first, then alphabetically
  result.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

/** Bytes of the head needed to tell how much more we must read. */
const PEEK_BYTES = 16;

/**
 * Open read-only, and non-blocking where the platform has it. O_NONBLOCK is
 * what stops open(2) on a FIFO from parking a libuv thread forever if the
 * path is swapped between the stat and the open. Windows has no such flag,
 * hence the fallback to 0.
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read up to `length` bytes from `position`. One read(2) may come back short,
 * so this loops until the buffer is full or the file ends; the returned
 * buffer is exactly what was read.
 */
async function readChunk(
  handle: fs.promises.FileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  const target = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(target, filled, length - filled, position + filled);
    if (bytesRead === 0) break; // shorter than stat said: the file shrank under us
    filled += bytesRead;
  }
  return filled === length ? target : target.subarray(0, filled);
}

/**
 * Sniff the head of an open file for an image, reading a BOUNDED window.
 * Returns the bytes that were read alongside the verdict, so the text path
 * below can reuse them instead of opening the file again.
 *
 * The window comes from the sniffer: 64 KiB for PNG/JPEG (their headers are
 * decidable from a prefix), the whole file for GIF (its frame walk spans the
 * file). This read is what the old 1 MiB text gate accidentally bounded —
 * never readFile().slice(), which would pull a whole 8 MiB photo into memory
 * to look at its first 26 bytes.
 */
async function sniffOpenFile(
  handle: fs.promises.FileHandle,
  size: number
): Promise<{ head: Buffer; result: SniffResult }> {
  const peek = await readChunk(handle, Math.min(PEEK_BYTES, size), 0);

  // A GIF over its own cap is refused on declared size alone, before any walk,
  // so the peek already holds the whole answer — no reason to pull megabytes
  // off disk to be told so.
  const early = sniffImage(peek, size, peek.length >= size);
  if (!early.ok && early.refusal === 'too-large') return { head: peek, result: early };

  const window = Math.min(sniffWindow(peek, size), size);
  const head =
    window <= peek.length
      ? peek.subarray(0, window)
      : Buffer.concat([peek, await readChunk(handle, window - peek.length, peek.length)]);

  return { head, result: sniffImage(head, size, head.length >= size) };
}

function mediaFor(result: SniffResult, version: string): FileMedia {
  return result.ok
    ? { image: result.info, refusal: null, version }
    : { image: null, refusal: result.refusal, version };
}

function notTextFile(size: number, media: FileMedia): FileForDisplay {
  return {
    content: '',
    binary: true,
    truncated: false,
    tooLarge: false,
    size,
    totalLines: 0,
    media,
  };
}

function tooLargeFile(size: number, media?: FileMedia): FileForDisplay {
  return {
    content: '',
    binary: false,
    truncated: false,
    tooLarge: true,
    size,
    totalLines: 0,
    media,
  };
}

function textFile(buffer: Buffer, size: number): FileForDisplay {
  let content = buffer.toString('utf-8');
  const lines = content.split('\n');
  let truncated = false;
  if (lines.length > MAX_DISPLAY_LINES) {
    content = lines.slice(0, MAX_DISPLAY_LINES).join('\n');
    truncated = true;
  }
  return { content, binary: false, truncated, tooLarge: false, size, totalLines: lines.length };
}

/**
 * Classify an already-open file: image first, then size, then text.
 *
 * The order matters and is the fix for a real bug: the size check used to run
 * first, so every image over the 1 MiB TEXT cap came back tooLarge with no
 * media verdict and never rendered. An image is decided by its magic bytes
 * and the image caps; only what is left over meets the text cap.
 */
async function classifyOpenFile(
  handle: fs.promises.FileHandle,
  relPath: string
): Promise<FileForDisplay> {
  // fstat on the open fd, not the path: one inode from the check to the read.
  const stats = await handle.stat();
  if (!stats.isFile()) throw new NotRegularFileError(relPath);
  const size = stats.size;
  if (size > MAX_IMAGE_BYTES) return tooLargeFile(size);

  const { head, result } = await sniffOpenFile(handle, size);
  const media = mediaFor(result, `${size}-${stats.mtimeMs}`);
  if (result.ok) return notTextFile(size, media);

  if (size > MAX_FILE_SIZE) {
    // A media verdict on an oversized file only makes sense when the file is
    // really binary, because a client reads any media as "this is not text"
    // and shows the binary note instead of "File too large". The NUL scan over
    // the window we already read is the whole test, and the refusal says
    // nothing about it either way: a refusal is about rendering, and BM, II*\0
    // and MM\0* are two- and four-byte signatures a big TEXT file can open
    // with by accident. So a 2 MiB tarball is a binary we cannot preview, and
    // a 2 MiB README is a file too large — even though the sniffer says
    // 'not-an-image' to both.
    return tooLargeFile(size, isBinaryContent(head) ? media : undefined);
  }

  const buffer =
    head.length >= size
      ? head
      : Buffer.concat([head, await readChunk(handle, size - head.length, head.length)]);

  return isBinaryContent(buffer) ? notTextFile(size, media) : textFile(buffer, size);
}

/**
 * Read a file for display. Returns flags instead of baking warnings into
 * content: binary and oversized files come back with empty content and the
 * matching flag set; text longer than MAX_DISPLAY_LINES is cut there with
 * truncated set (totalLines tells the caller how much was dropped). Binary
 * files also carry a media verdict when their magic bytes said something.
 *
 * Throws the raw fs error (ENOENT, ENOTDIR) when relPath is unreadable and
 * NotRegularFileError when it is not a regular file (a FIFO/socket/device
 * would block the event loop on read; a directory is not displayable).
 *
 * Note on the truncated flag: it means exactly "content was cut at
 * MAX_DISPLAY_LINES". A merely large file (over the caller's warn
 * threshold) that fits within the line limit is NOT marked truncated —
 * unlike the pre-extraction TUI code, which conflated the two.
 */
export async function readFileForDisplay(
  repoPath: string,
  relPath: string
): Promise<FileForDisplay> {
  const fullPath = path.join(repoPath, relPath);
  const stats = await fs.promises.stat(fullPath);

  if (!stats.isFile()) {
    throw new NotRegularFileError(relPath);
  }

  // Past the image cap nothing is previewable and the text cap is far below,
  // so this one is settled without opening the file at all.
  if (stats.size > MAX_IMAGE_BYTES) {
    return tooLargeFile(stats.size);
  }

  const handle = await fs.promises.open(fullPath, READ_FLAGS);
  try {
    return await classifyOpenFile(handle, relPath);
  } finally {
    await handle.close();
  }
}
