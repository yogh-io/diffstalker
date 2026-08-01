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
 *
 * **Both routes are gated, and both hold their slot to the last byte.**
 * /media is not the cheap one: it inspects up to two sides, so it costs the
 * same git spawns and the same buffers as /blob. GET is exempt from the CSRF
 * checks by design and a repo id is a hash of a path, so any page the user
 * visits can aim requests at a `--port` daemon — which is what the semaphore,
 * not the origin guard, is there for.
 */

import {
  openBlob,
  BlobTooLargeError,
  NotRegularBlobError,
  UnsafeBlobPathError,
  type BlobHandle,
} from '@diffstalker/core/git/blob';
import {
  sniffImage,
  sniffWindow,
  IMAGE_HEADER_WINDOW,
  MAX_IMAGE_BYTES,
  type ImageInfo,
  type ImageMime,
  type ImageRefusal,
  type SniffResult,
} from '@diffstalker/core/utils/imageSniff';
import type { BlobSide } from '@diffstalker/core/utils/blobRef';
import type { FileEntry } from '@diffstalker/core/git/status';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

/** A prefix of a blob and the verdict those bytes produced. */
interface TypedBytes {
  bytes: Uint8Array;
  sniff: SniffResult;
}

const BLOB_SIDES: readonly string[] = ['worktree', 'index', 'head'];

/** Enough to recognise every signature the sniffer knows; the longest is 12 bytes. */
const PEEK_BYTES = 16;

/**
 * How much of a blob each route needs in hand once it has been typed.
 *
 * /media only ever reports a verdict, so it asks for nothing beyond the window
 * that decides the file: pulling the other 8 MiB of a photo off disk to report
 * its width is resident memory bought for nothing, on a plain GET any page can
 * drive. /blob writes what it read, so it needs every byte.
 *
 * This is a floor on the read, never a ceiling — `readAndType` reads whatever
 * it takes to reach a verdict either way, which is what keeps the two routes
 * from ever disagreeing about what a file is.
 */
const VERDICT_BUDGET = IMAGE_HEADER_WINDOW;
const WHOLE_BLOB_BUDGET = MAX_IMAGE_BYTES;

/** Refusals that mean "too big to be worth decoding", as opposed to "not allowed". */
const OVERSIZE_REFUSALS: readonly ImageRefusal[] = ['too-large', 'too-many-pixels'];

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
 * Read `want` bytes and say what they are.
 *
 * `complete` is whether the buffer really is the whole file, and it is read
 * off the buffer rather than asserted. Claiming it unconditionally would be a
 * lie for a GIF over its own cap, for a file that shrank between the size
 * check and the read, and for anything typed from a header window — and each
 * of those has to be refused, which is exactly what a truthful `false` gets.
 */
async function typeBytes(handle: BlobHandle, want: number): Promise<TypedBytes> {
  const bytes = await handle.read(want);
  return { bytes, sniff: sniffImage(bytes, handle.size, bytes.length >= handle.size) };
}

/**
 * Read as much of a blob as it takes to type it, and no more.
 *
 * `sniffWindow` owns the "how much decides this file" question: a 64 KiB
 * header for PNG and JPEG, the whole file for a GIF, whose frame walk spans
 * it. That window settles ordinary files, and it is all a /media verdict has
 * to read.
 *
 * `header-not-found` is the one verdict that means "more bytes would decide
 * this", and it is not exotic: a JPEG carrying a maximal EXIF APP1 pushes its
 * SOF past 64 KiB, which is what a camera or Photoshop writes when it embeds a
 * thumbnail. So the window is extended to the whole blob and the file is typed
 * again. That extension is what makes the verdict independent of who asked:
 * /media and /blob run the same read and reach the same answer, and a card in
 * the Changes stack can never be dropped for a file /blob would have served.
 *
 * Everything here is bounded. The extension reads at most `size`, which
 * `openBlob` already refused if it was over MAX_IMAGE_BYTES, and the caller
 * holds a semaphore slot across the whole thing.
 */
async function readAndType(handle: BlobHandle, budget: number): Promise<TypedBytes> {
  const { size } = handle;
  const peek = await handle.read(PEEK_BYTES);

  // A GIF over its own cap is refused on declared size alone, so the peek is
  // already the whole answer and nothing more is read.
  const early = sniffImage(peek, size, peek.length >= size);
  if (!early.ok && early.refusal === 'too-large') return { bytes: peek, sniff: early };

  const window = Math.min(sniffWindow(peek, size), size);
  const typed = await typeBytes(handle, Math.max(window, Math.min(budget, size)));
  if (typed.sniff.ok || typed.sniff.refusal !== 'header-not-found') return typed;
  if (typed.bytes.length >= size) return typed;
  return typeBytes(handle, size);
}

/**
 * Open one side, type it, close. The single place bytes are read and typed,
 * and — because `readAndType` extends past `budget` whenever the window was
 * inconclusive — the single place the verdict is decided, so /blob and /media
 * cannot disagree about what a file is.
 */
async function inspectBlob(
  repoPath: string,
  side: BlobSide,
  relPath: string,
  budget: number
): Promise<InspectedBlob | null> {
  const handle = await openBlob(repoPath, side, relPath, MAX_IMAGE_BYTES);
  if (handle === null) return null;
  try {
    const { bytes, sniff } = await readAndType(handle, budget);
    return { bytes, size: handle.size, oid: handle.oid, version: handle.version, sniff };
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

/**
 * A refused image: over a budget is a 413, anything else a 415. Zero bytes
 * either way. An APNG is a 415, not a 413: it is not over any budget, it is a
 * format we refuse to serve, and the UI says so in those words.
 */
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
    inspected = await inspectBlob(handle.path, ref.side, rel, VERDICT_BUDGET);
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

/**
 * Whether this request is already over, on either runtime.
 *
 * `res.destroyed` alone is not an answer: bun leaves it `undefined` on an
 * aborted response. The request object is destroyed on both, so it is the one
 * that gets asked.
 */
function requestIsOver(req: IncomingMessage, res: ServerResponse): boolean {
  return res.writableEnded || res.destroyed === true || req.destroyed === true;
}

/**
 * Take a slot for the whole request, or refuse now. A full queue is a 503,
 * never a wait.
 *
 * The slot is held until the RESPONSE is finished, not until the read is
 * done. `sendBytes` hands an up-to-8-MiB buffer to `res.end()`, and that
 * buffer stays resident until the client has drained it, so a release at the
 * end of the handler would bound reads while leaving memory unbounded: a slow
 * reader could push request after request through the gate, each leaving a
 * live buffer behind it.
 *
 * What the release is wired to is BOTH objects, because node and bun do not
 * agree on which one reports the end. A request that we answer ends the
 * response, and both runtimes emit `finish` on it. A request whose client
 * walks away before we answer is the divergence: node destroys the response
 * and emits `close` on it, while bun emits nothing on the response at all —
 * the abort surfaces only on the request, as `close`. Listening to the
 * response alone therefore leaks a slot per abort under bun, and four of those
 * wedge both routes for the life of the daemon. So the guarantee is stated in
 * terms of the pair: every path either ends the response or destroys the
 * request, both runtimes emit an event for whichever happened, and the release
 * is idempotent, so the first one to arrive is the one that counts.
 *
 * Returns false when the client is already gone. Then the slot goes straight
 * back and the route stops rather than working for nobody.
 */
async function holdSlot(
  gate: BlobSemaphore,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const slot = gate.acquire();
  if (slot === null) {
    throw new HttpError(503, 'Too many image requests in flight');
  }
  const release = await slot;
  res.once('finish', release);
  res.once('close', release);
  req.once('close', release);
  if (requestIsOver(req, res)) {
    release();
    return false;
  }
  return true;
}

export function registerBlobRoutes(router: Router, deps: RouteDeps, gate: BlobSemaphore): void {
  const { registry } = deps;

  router.get('/repos/:id/media', async ({ params, query, req, res }) => {
    const handle = requireRepo(registry, params.id);
    const staged = requireStagedParam(query);
    const rel = requireRepoRelPath(handle.path, requirePathParam(query));
    await requireRealRepoPath(handle, rel);

    // The same gate as /blob, taken before the first spawn: describing a pair
    // is two sides, so this is the more expensive of the two routes, not the
    // cheaper one.
    if (!(await holdSlot(gate, req, res))) return;

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

    // 3. A slot BEFORE anything is spawned or opened, held until the last
    //    byte is out.
    if (!(await holdSlot(gate, req, res))) return;

    // 4-7. Read and type the bytes, then give the handle back.
    let inspected: InspectedBlob | null;
    try {
      inspected = await inspectBlob(handle.path, side, rel, WHOLE_BLOB_BUDGET);
    } catch (err) {
      throwBlobError(err);
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
