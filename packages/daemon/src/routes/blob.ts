/**
 * Image bytes for the web UI, plus the metadata that tells it which bytes to
 * ask for.
 *
 *   GET /repos/:id/media?path=<rel>&staged=<0|1>                  -> MediaPair
 *   GET /repos/:id/blob?path=<rel>&side=<worktree|index|head>[&v=] -> bytes
 *
 * This is the only place the daemon hands raw repository bytes to a browser,
 * so the whole module is built around one rule: what we say a file IS comes
 * from its magic bytes, re-derived from the exact buffer we are about to
 * write, on every single request. Never from the extension, never from a
 * query parameter, never from a verdict an earlier /file or /media response
 * cached. `staticFiles.ts`'s CONTENT_TYPES maps `.svg`, `.html` and `.wasm`
 * and must never be reused for repo content: a repo file called `logo.png`
 * holding `<svg><script>` is same-origin script the moment we agree with its
 * name. Only PNG, JPEG and GIF are ever served; everything else gets zero
 * bytes and a refusal.
 *
 * **The blob route is status-independent.** It takes only (path, side) and never
 * resolves a status entry. That is what lets the Explorer preview a clean,
 * committed image — the common case, which is in no diff and no status — and
 * it keeps an expensive `git status` refresh off the byte path entirely. `v`
 * is accepted and ignored: it is a cache key for the browser, never a lookup
 * key and never part of a path.
 *
 * **Renames are resolved here, not by the client.** /media reads the status
 * entry once and answers with the path to use for each side, so the web never
 * learns a rev vocabulary and never carries an originalPath of its own.
 *
 * **Nothing is written before the last step.** `router.handle()` can only
 * `res.end()` once headers are out, so a failure after the first write would
 * reach the browser as a truncated 200 it will happily try to decode. Every
 * refusal — path, size, format, concurrency — is therefore raised before
 * `sendBytes` is reached, and `sendBytes` is called exactly once, last.
 *
 * `guardImageSubresource` runs on /blob and NEVER on /media: it demands
 * `Sec-Fetch-Dest: image`, and the SPA's own `fetch()` for /media sends
 * `Sec-Fetch-Dest: empty`.
 */

import {
  openBlob,
  BlobTooLargeError,
  NotRegularBlobError,
  UnsafeBlobPathError,
} from '@diffstalker/core/git/blob';
import {
  sniffImage,
  MAX_GIF_BYTES,
  MAX_IMAGE_BYTES,
  type ImageInfo,
  type ImageMime,
  type ImageRefusal,
  type SniffResult,
} from '@diffstalker/core/utils/imageSniff';
import type { BlobSide } from '@diffstalker/core/utils/blobRef';
import type { FileEntry } from '@diffstalker/core/git/status';
import { Router, HttpError, sendJson, sendBytes } from '../router.js';
import { guardImageSubresource } from '../security.js';
import type { BlobSemaphore } from '../blobSemaphore.js';
import type { RepoHandle } from '../repoRegistry.js';
import {
  requireRepo,
  requireRealRepoPath,
  requireRepoRelPath,
  resolveFileEntry,
  type RouteDeps,
} from './shared.js';

/** One side of a changed file: where its bytes are, and what they turned out to be. */
export interface MediaSide {
  /** The path to ask /blob for on this side — already rename-resolved. */
  path: string;
  side: BlobSide;
  /** The blob's real size, reported even when it was refused. */
  bytes: number;
  /** The git object id, or null for the working tree (not a git object). */
  oid: string | null;
  image: ImageInfo | null;
  refusal: ImageRefusal | null;
  /** Cache key for the blob URL. Empty when there is nothing to fetch. */
  version: string;
}

/** Old and new sides of one changed file. A missing side is null, not an error. */
export interface MediaPair {
  old: MediaSide | null;
  new: MediaSide | null;
}

/** Which blob a side points at, before anything has been read. */
interface SideRef {
  side: BlobSide;
  path: string;
}

/** What one blob turned out to be, after it was read and typed. */
interface InspectedBlob {
  bytes: Uint8Array;
  size: number;
  oid: string | null;
  version: string;
  sniff: SniffResult;
}

const BLOB_SIDES: readonly string[] = ['worktree', 'index', 'head'];

/**
 * "GIF8", the prefix shared by GIF87a and GIF89a.
 *
 * This decides how many bytes to READ, nothing else — `sniffImage` owns the
 * verdict. A GIF is only valid when the whole file is in hand, which is why
 * it has a tighter byte cap; reading 8 MiB of a file we would refuse at 2 is
 * pointless work. A wrong guess here can only change the read size: a file
 * whose first four bytes are these is either a GIF or nothing we serve.
 */
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];

function isGifMagic(peek: Uint8Array): boolean {
  return GIF_MAGIC.every((byte, i) => peek[i] === byte);
}

/** Refusals that mean "too big to be worth decoding", as opposed to "not allowed". */
const OVERSIZE_REFUSALS: readonly ImageRefusal[] = ['too-large', 'too-many-pixels', 'animation'];

function requirePathParam(query: URLSearchParams): string {
  const raw = query.get('path');
  if (raw === null) {
    throw new HttpError(400, 'Missing "path" query parameter');
  }
  return raw;
}

/**
 * The side to read. A closed set: anything else — a bogus word, a git option
 * like `--output=/tmp/pwn` — is refused here and never reaches git.
 */
function requireSideParam(query: URLSearchParams): BlobSide {
  const raw = query.get('side');
  if (raw === null || !BLOB_SIDES.includes(raw)) {
    throw new HttpError(400, 'Invalid "side" (expected worktree, index or head)');
  }
  return raw as BlobSide;
}

/** `staged` is spelled 0/1 by blobRef's mediaUrl, and is required. */
function requireStagedParam(query: URLSearchParams): boolean {
  const raw = query.get('staged');
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new HttpError(400, 'Invalid "staged" (expected 0 or 1)');
}

/**
 * Core's refusals as HTTP statuses. UnsafeBlobPathError is unreachable behind
 * requireRepoRelPath, but mapping it keeps a belt from becoming a 500.
 * Anything else is a genuine failure and stays a 500.
 */
function throwBlobError(err: unknown): never {
  if (err instanceof NotRegularBlobError) throw new HttpError(400, err.message);
  if (err instanceof UnsafeBlobPathError) throw new HttpError(400, err.message);
  if (err instanceof BlobTooLargeError) throw new HttpError(413, err.message);
  throw err;
}

/**
 * Open one side, read at most the cap for its format, type the bytes, close.
 * The single place bytes are read and typed, so /blob and /media can never
 * disagree about what a file is.
 *
 * `complete` is whether the buffer really is the whole file. It normally is
 * (openBlob already refused anything over MAX_IMAGE_BYTES), and claiming it
 * unconditionally would be a lie in the two cases where it is not: a GIF over
 * its own cap, and a file that shrank between the size check and the read.
 * Both then have to be refused, which is exactly what a truthful `false` does.
 */
async function inspectBlob(
  repoPath: string,
  side: BlobSide,
  relPath: string
): Promise<InspectedBlob | null> {
  const handle = await openBlob(repoPath, side, relPath, MAX_IMAGE_BYTES);
  if (handle === null) return null;
  try {
    const peek = await handle.read(GIF_MAGIC.length);
    const bytes = await handle.read(isGifMagic(peek) ? MAX_GIF_BYTES : MAX_IMAGE_BYTES);
    return {
      bytes,
      size: handle.size,
      oid: handle.oid,
      version: handle.version,
      sniff: sniffImage(bytes, handle.size, bytes.length >= handle.size),
    };
  } finally {
    await handle.close();
  }
}

/**
 * The exact header set for a served image.
 *
 * `content-disposition: inline` carries NO filename parameter: the filename
 * is repo-supplied, and no repo string may ever be interpolated into a
 * header. `nosniff` and CORP already ride along from the server.ts choke
 * point and are re-asserted here so this response is correct on its own
 * terms — the browser must not be free to re-type these bytes, and no other
 * origin may embed them. The `vary` names the two request headers the route
 * guard reads, so a cache cannot serve a guarded response to a request that
 * would have been refused.
 *
 * Caching splits by side. The working tree is mutable and is never stored;
 * the index and HEAD sides are addressed by an immutable object id, so they
 * get a validator and `no-cache` (revalidate, do not blindly reuse). The oid
 * is safe in a header because core validated it against /^[0-9a-f]{40,64}$/
 * before it went anywhere near git.
 */
function blobHeaders(side: BlobSide, mime: ImageMime, oid: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    vary: 'sec-fetch-site, sec-fetch-dest',
    'cache-control': side === 'worktree' ? 'no-store' : 'private, no-cache',
  };
  if (side !== 'worktree' && oid !== null) {
    headers.etag = `"${oid}"`;
  }
  return headers;
}

/** A refused image: over a budget is a 413, anything else a 415. Zero bytes either way. */
function refusalError(refusal: ImageRefusal): HttpError {
  const status = OVERSIZE_REFUSALS.includes(refusal) ? 413 : 415;
  return new HttpError(status, `Image not served: ${refusal}`);
}

/**
 * Which blob each side of a change points at.
 *
 * The unstaged view compares the index with the working tree; the staged view
 * compares HEAD with the index. A rename only ever moves the OLD side: the
 * bytes it used to have live under the pre-rename path, which is why /media
 * exists at all — the client would otherwise need to know that.
 */
function sidesFor(entry: FileEntry, staged: boolean): { old: SideRef | null; new: SideRef | null } {
  const oldPath = entry.originalPath ?? entry.path;
  switch (entry.status) {
    case 'untracked':
      return { old: null, new: { side: 'worktree', path: entry.path } };
    case 'added':
      return { old: null, new: { side: staged ? 'index' : 'worktree', path: entry.path } };
    case 'deleted':
      return { old: { side: staged ? 'head' : 'index', path: oldPath }, new: null };
    default:
      // modified, renamed, copied: two real sides.
      return staged
        ? { old: { side: 'head', path: oldPath }, new: { side: 'index', path: entry.path } }
        : { old: { side: 'index', path: oldPath }, new: { side: 'worktree', path: entry.path } };
  }
}

/** A side we know the size of but will not preview. */
function refusedSide(ref: SideRef, bytes: number, refusal: ImageRefusal): MediaSide {
  return { path: ref.path, side: ref.side, bytes, oid: null, image: null, refusal, version: '' };
}

/**
 * Metadata for one side. Null means "no bytes on this side": the path does
 * not exist there, or what is there is not a blob at all (a symlink, a
 * submodule gitlink, a directory). A pair of nulls is not an error — the UI
 * falls back to its plain note.
 */
async function describeSide(handle: RepoHandle, ref: SideRef): Promise<MediaSide | null> {
  // The path comes from git status rather than the client here, but it is
  // still handed to git, so it goes through the same pair as any other.
  const rel = requireRepoRelPath(handle.path, ref.path);
  await requireRealRepoPath(handle, rel);

  let inspected: InspectedBlob | null;
  try {
    inspected = await inspectBlob(handle.path, ref.side, rel);
  } catch (err) {
    // An over-cap file is real and worth reporting a size for; anything that
    // is not a regular blob simply has nothing to show.
    if (err instanceof BlobTooLargeError) return refusedSide(ref, err.size, 'too-large');
    if (err instanceof NotRegularBlobError) return null;
    throwBlobError(err);
  }
  if (inspected === null) return null;
  return {
    path: ref.path,
    side: ref.side,
    bytes: inspected.size,
    oid: inspected.oid,
    version: inspected.version,
    image: inspected.sniff.ok ? inspected.sniff.info : null,
    refusal: inspected.sniff.ok ? null : inspected.sniff.refusal,
  };
}

export function registerBlobRoutes(router: Router, deps: RouteDeps, gate: BlobSemaphore): void {
  const { registry } = deps;

  router.get('/repos/:id/media', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const staged = requireStagedParam(query);
    const rel = requireRepoRelPath(handle.path, requirePathParam(query));
    await requireRealRepoPath(handle, rel);

    const entry = await resolveFileEntry(handle.manager.workingTree, rel, staged);
    const sides = sidesFor(entry, staged);
    const pair: MediaPair = {
      old: sides.old === null ? null : await describeSide(handle, sides.old),
      new: sides.new === null ? null : await describeSide(handle, sides.new),
    };
    sendJson(res, 200, pair);
  });

  router.get('/repos/:id/blob', async ({ params, query, req, res }) => {
    // 1. Repo, then the subresource guard.
    const handle = requireRepo(registry, params.id);
    const blocked = guardImageSubresource(req);
    if (blocked) {
      throw new HttpError(blocked.status, blocked.message);
    }

    // 2. A closed side, and a path through both guards, in that order.
    const side = requireSideParam(query);
    const rel = requireRepoRelPath(handle.path, requirePathParam(query));
    await requireRealRepoPath(handle, rel);

    // 3. A slot BEFORE anything is spawned or opened. A full queue is a 503,
    //    not a wait.
    const slot = gate.acquire();
    if (slot === null) {
      throw new HttpError(503, 'Too many image requests in flight');
    }
    const release = await slot;

    // 4-7. Read and type the bytes, then give the slot and the handle back.
    let inspected: InspectedBlob | null;
    try {
      inspected = await inspectBlob(handle.path, side, rel);
    } catch (err) {
      throwBlobError(err);
    } finally {
      release();
    }

    if (inspected === null) {
      throw new HttpError(404, `No such blob on side ${side}: ${rel}`);
    }
    if (!inspected.sniff.ok) {
      throw refusalError(inspected.sniff.refusal);
    }

    // 8. The first and only write.
    const headers = blobHeaders(side, inspected.sniff.info.mime, inspected.oid);
    sendBytes(res, 200, inspected.bytes, headers);
  });
}
