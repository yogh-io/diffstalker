/**
 * The blob and media endpoints over a real unix socket. Self-contained: own
 * daemon, own socket, own fixture repo (follow mode off, no watcher).
 *
 * Every image fixture is built here out of bytes, and every hostile fixture is
 * given a friendly NAME on disk: `logo.png` holding `<svg><script>`, `elf.png`
 * holding an ELF header. That is the point of the whole endpoint — the served
 * type comes from magic bytes and nothing else — so a test using a real file
 * with a matching extension would be testing the wrong thing.
 *
 * The Sec-Fetch cases spell the headers out explicitly in BOTH directions.
 * bun's `fetch` sends no `Sec-Fetch-*` headers at all, so a guard that had been
 * deleted would pass every other test in this file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { blobUrl, mediaUrl } from '@diffstalker/core/utils/blobRef';
import { IMAGE_HEADER_WINDOW } from '@diffstalker/core/utils/imageSniff';
import { createDaemon, Daemon } from './server.js';
import { createBlobSemaphore, BLOB_CONCURRENCY, type BlobSemaphore } from './blobSemaphore.js';
import { Router } from './router.js';
import { registerBlobRoutes } from './routes/blob.js';
import type { RouteDeps } from './routes/shared.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

/** Slack for the fixed-size peek the route takes before it picks a window. */
const PEEK_ALLOWANCE = 64;

const FIXTURE = 'daemon-blob';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-blob-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let repoId: string;

// --- byte builders (same shapes core's imageSniff tests use) ---

function b(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function str(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  return b((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u16be(value: number): Uint8Array {
  return b((value >>> 8) & 0xff, value & 0xff);
}

function u16le(value: number): Uint8Array {
  return b(value & 0xff, (value >>> 8) & 0xff);
}

/** The sniffer never validates a CRC, so four zeroes stand in for it. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat(u32be(data.length), str(type), data, b(0, 0, 0, 0));
}

function ihdr(width: number, height: number): Uint8Array {
  return pngChunk('IHDR', concat(u32be(width), u32be(height), b(8, 6, 0, 0, 0)));
}

const PNG_SIGNATURE = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_IDAT = pngChunk('IDAT', b(0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01));

function buildPng(...chunks: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks);
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(b(0xff, marker), u16be(payload.length + 2), payload);
}

const JFIF_APP0 = jpegSegment(
  0xe0,
  concat(str('JFIF'), b(0), b(1, 1, 0), u16be(1), u16be(1), b(0, 0))
);

/** SOF payload: precision, height, width, component count, one component. */
function sof(width: number, height: number): Uint8Array {
  return jpegSegment(0xc0, concat(b(8), u16be(height), u16be(width), b(1, 1, 0x11, 0)));
}

function buildJpeg(...segments: Uint8Array[]): Uint8Array {
  return concat(b(0xff, 0xd8), ...segments, b(0xff, 0xd9));
}

function gifHeader(width: number, height: number): Uint8Array {
  return concat(str('GIF89a'), u16le(width), u16le(height), b(0, 0, 0));
}

/** Descriptor, LZW minimum code size, one data sub-block, terminator. */
function gifFrame(width: number, height: number): Uint8Array {
  return concat(
    b(0x2c),
    u16le(0),
    u16le(0),
    u16le(width),
    u16le(height),
    b(0),
    b(0x02),
    b(0x01, 0x44),
    b(0x00)
  );
}

function buildGif(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts, b(0x3b));
}

// --- fixtures ---

/** Three different PNGs for one path, so the three sides cannot be confused. */
const PNG_AT_HEAD = buildPng(ihdr(1, 1), PNG_IDAT);
const PNG_AT_INDEX = buildPng(ihdr(2, 2), PNG_IDAT);
const PNG_IN_WORKTREE = buildPng(ihdr(3, 3), PNG_IDAT);

const CLEAN_JPEG = buildJpeg(JFIF_APP0, sof(5, 7));
const STILL_GIF = buildGif(gifHeader(1, 1), gifFrame(1, 1));
const ANIMATED_GIF = buildGif(gifHeader(4, 4), gifFrame(4, 4), gifFrame(4, 4), gifFrame(4, 4));

/**
 * A GIF that is also JavaScript. A real polyglot: the header is a valid GIF
 * and the tail is script the browser would run if anything ever let it decide
 * for itself what this file is.
 */
const POLYGLOT_JS = '/*GIF*/;window.pwned=1;alert(1)//';
const POLYGLOT_GIF = concat(STILL_GIF, str(POLYGLOT_JS));

const SVG_BYTES = str('<svg xmlns="https://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
const HTML_BYTES = str('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>\n');
const ELF_BYTES = concat(b(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), new Uint8Array(56));

/** 40-odd bytes of header claiming 3.6 gigapixels, padded to ~300 bytes. */
const DIMENSION_BOMB = buildPng(
  ihdr(60000, 60000),
  pngChunk('tEXt', new Uint8Array(220)),
  PNG_IDAT
);

/** acTL before IDAT: an animated PNG, which is a second animation decoder. */
const APNG = buildPng(ihdr(4, 4), pngChunk('acTL', concat(u32be(3), u32be(0))), PNG_IDAT);

/** Over MAX_IMAGE_BYTES (8 MiB): refused on size alone, before any read. */
const OVERSIZED_PNG = concat(buildPng(ihdr(64, 64), PNG_IDAT), new Uint8Array(9 * 1024 * 1024));

/**
 * A servable PNG that is megabytes long, with its IHDR and IDAT in the first
 * few dozen bytes. Everything after the first IDAT is pixels as far as the
 * sniffer is concerned, so this file is decided by its header — which is the
 * whole point of the /media read budget.
 */
const BIG_PNG = concat(buildPng(ihdr(64, 64), PNG_IDAT), new Uint8Array(4 * 1024 * 1024));

/** Over MAX_GIF_BYTES (2 MiB): a valid GIF that is simply too big to walk. */
const OVERSIZED_GIF = concat(STILL_GIF, new Uint8Array(3 * 1024 * 1024));

/**
 * A JPEG whose frame header sits behind a MAXIMAL EXIF segment: 65,533 bytes
 * of APP1 payload, the largest a u16 length can describe, which puts the SOF
 * past the 64 KiB window. Nothing exotic — that is what a camera or Photoshop
 * writes when it embeds a thumbnail alongside the EXIF tags.
 */
const EXIF_JPEG = buildJpeg(
  jpegSegment(0xe1, concat(str('Exif\0\0'), new Uint8Array(65_527))),
  sof(9, 11)
);

function writeBytes(relPath: string, bytes: Uint8Array): void {
  fs.writeFileSync(path.join(repoPath, relPath), bytes);
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

function blobRequest(
  relPath: string,
  side: 'worktree' | 'index' | 'head',
  init?: RequestInit
): Promise<Response> {
  return request(blobUrl(repoId, { path: relPath, side }), init);
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? '';
}

/** The object id git stores for a rev, for the etag assertions. */
function oidOf(rev: string): string {
  return gitExec(repoPath, `rev-parse ${rev}`).trim();
}

interface WireMediaSide {
  path: string;
  side: string;
  bytes: number;
  oid: string | null;
  image: { format: string; width: number; height: number; frames?: number } | null;
  refusal: string | null;
  version: string;
}

interface WireMediaPair {
  old: WireMediaSide | null;
  new: WireMediaSide | null;
}

async function mediaFor(relPath: string, staged: boolean): Promise<WireMediaPair> {
  const res = await request(mediaUrl(repoId, relPath, staged));
  expect(res.status).toBe(200);
  return (await res.json()) as WireMediaPair;
}

/**
 * Measure the file reads one request performs on a path: how many read()
 * calls, and how many bytes they moved. Counting bytes is what turns "the
 * cap did its work" from an assumption into an assertion — a refusal that
 * read nothing and a verdict that read a header window both look the same
 * from the outside. fs.promises.open is writable under bun; the wrapper is
 * always restored.
 */
async function readsFor(
  needle: string,
  fn: () => Promise<void>
): Promise<{ calls: number; bytes: number }> {
  const target = fs.promises as { open: typeof fs.promises.open };
  const realOpen = target.open;
  const counted = { calls: 0, bytes: 0 };
  target.open = (async (...args: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(
      ...args
    );
    if (String(args[0]).includes(needle)) {
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<{
        bytesRead: number;
      }>;
      Object.defineProperty(handle, 'read', {
        value: async (...readArgs: unknown[]) => {
          counted.calls++;
          const result = await realRead(...readArgs);
          counted.bytes += result.bytesRead;
          return result;
        },
      });
    }
    return handle;
  }) as typeof fs.promises.open;
  try {
    await fn();
  } finally {
    target.open = realOpen;
  }
  return counted;
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  // *.fifo is gitignored so the working-dir watcher never sees the FIFO the
  // non-regular-file test creates: bun's fs.watch blocks the whole event loop
  // when an unignored FIFO appears in a watched directory. The two oversized
  // fixtures are ignored to keep them out of the object store — /blob is
  // status-independent, so the worktree side serves them regardless.
  writeFixtureFile(repoPath, '.gitignore', '*.fifo\nhuge.png\nbig.gif\n');
  writeFixtureFile(repoPath, 'README.md', 'hello blob\n');

  writeBytes('logo.png', PNG_AT_HEAD);
  writeBytes('photo.jpg', CLEAN_JPEG);
  writeBytes('anim.gif', ANIMATED_GIF);
  writeBytes('gone.png', PNG_AT_HEAD);
  writeBytes('old-name.png', PNG_AT_INDEX);
  writeBytes('fake.png', SVG_BYTES);
  writeBytes('page.png', HTML_BYTES);
  writeBytes('elf.png', ELF_BYTES);
  writeBytes('poly.gif', POLYGLOT_GIF);
  writeBytes('bomb.png', DIMENSION_BOMB);
  writeBytes('apng.png', APNG);
  // A committed symlink out of the repo: a 120000 entry on the git sides, and
  // a realpath escape in the working tree.
  fs.symlinkSync('/etc/shadow', path.join(repoPath, 'secret.png'));
  gitExec(repoPath, 'add -A .');
  gitExec(repoPath, 'commit -m "initial"');

  // logo.png differs on all three sides: HEAD keeps 1x1, the index gets 2x2,
  // the working tree 3x3.
  writeBytes('logo.png', PNG_AT_INDEX);
  gitExec(repoPath, 'add logo.png');
  writeBytes('logo.png', PNG_IN_WORKTREE);

  fs.rmSync(path.join(repoPath, 'gone.png')); // unstaged deletion
  gitExec(repoPath, 'mv old-name.png new-name.png'); // staged rename
  writeBytes('untracked.png', PNG_AT_HEAD);
  // Untracked on purpose: /media needs a status entry, and these two are what
  // the frame count and the read budget are asserted on.
  writeBytes('untracked-anim.gif', ANIMATED_GIF);
  writeBytes('exif.jpg', EXIF_JPEG);
  writeBytes('big.png', BIG_PNG);
  writeBytes('huge.png', OVERSIZED_PNG);
  writeBytes('big.gif', OVERSIZED_GIF);

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });

  const res = await request('/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  expect(res.status).toBe(201);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('GET /blob — content and headers', () => {
  test('the three sides serve their own bytes, byte for byte', async () => {
    const cases: Array<['worktree' | 'index' | 'head', Uint8Array]> = [
      ['head', PNG_AT_HEAD],
      ['index', PNG_AT_INDEX],
      ['worktree', PNG_IN_WORKTREE],
    ];
    for (const [side, expected] of cases) {
      const res = await blobRequest('logo.png', side);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect([...(await bodyBytes(res))]).toEqual([...expected]);
    }
  });

  test('content-length matches the body and content-disposition carries no filename', async () => {
    const res = await blobRequest('logo.png', 'worktree');
    expect(res.status).toBe(200);
    // A filename parameter would put a repo-supplied string in a header.
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-length')).toBe(String(PNG_IN_WORKTREE.length));
  });

  test('the response re-asserts nosniff, CORP and vary', async () => {
    const res = await blobRequest('logo.png', 'worktree');
    expect(res.status).toBe(200);
    // Exactly once: the server.ts choke point sets these too, and a duplicate
    // would come back comma-joined.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('vary')).toBe('sec-fetch-site, sec-fetch-dest');
  });

  test('the mutable worktree side is never stored and carries no validator', async () => {
    const res = await blobRequest('logo.png', 'worktree');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('etag')).toBeNull();
  });

  test('the oid-addressed sides revalidate against an etag', async () => {
    for (const side of ['head', 'index'] as const) {
      const res = await blobRequest('logo.png', side);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(res.headers.get('etag')).toBe(
        `"${oidOf(side === 'head' ? 'HEAD:logo.png' : ':logo.png')}"`
      );
    }
  });

  test('JPEG and GIF get their own magic-derived types', async () => {
    const jpeg = await blobRequest('photo.jpg', 'worktree');
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get('content-type')).toBe('image/jpeg');
    expect([...(await bodyBytes(jpeg))]).toEqual([...CLEAN_JPEG]);

    const gif = await blobRequest('anim.gif', 'worktree');
    expect(gif.status).toBe(200);
    expect(gif.headers.get('content-type')).toBe('image/gif');
    expect([...(await bodyBytes(gif))]).toEqual([...ANIMATED_GIF]);
  });

  test('the `v` cache key is accepted and ignored', async () => {
    // It is never a lookup input, so a nonsense value changes nothing.
    const url = blobUrl(repoId, { path: 'logo.png', side: 'head', version: '../../etc/passwd' });
    const res = await request(url);
    expect(res.status).toBe(200);
    expect([...(await bodyBytes(res))]).toEqual([...PNG_AT_HEAD]);
  });

  test('a clean committed image is reachable on head AND worktree (the Explorer case)', async () => {
    // photo.jpg is in no diff and no status entry. /blob never resolves a
    // status entry, which is exactly what keeps this from 404ing.
    for (const side of ['head', 'worktree', 'index'] as const) {
      const res = await blobRequest('photo.jpg', side);
      expect(res.status).toBe(200);
      expect([...(await bodyBytes(res))]).toEqual([...CLEAN_JPEG]);
    }
  });

  test('an unknown repo id is a 404', async () => {
    const res = await request(blobUrl('no-such-repo', { path: 'logo.png', side: 'head' }));
    expect(res.status).toBe(404);
  });

  test('a path absent on that side is a 404', async () => {
    const res = await blobRequest('untracked.png', 'head');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toContain('untracked.png');
  });
});

describe('GET /blob — the format allow-list, on bytes not names', () => {
  test('a file NAMED .png holding SVG is refused, and its script never comes back', async () => {
    const res = await blobRequest('fake.png', 'worktree');
    expect(res.status).toBe(415);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = new TextDecoder().decode(await bodyBytes(res));
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('svg');
  });

  test('HTML and an ELF binary named .png are refused too', async () => {
    for (const name of ['page.png', 'elf.png']) {
      const res = await blobRequest(name, 'worktree');
      expect(res.status).toBe(415);
      expect(await errorOf(res)).toContain('not-an-image');
    }
  });

  test('plain text is refused', async () => {
    const res = await blobRequest('README.md', 'head');
    expect(res.status).toBe(415);
  });

  test('a GIF/JS polyglot is served as image/gif with nosniff, never as script', async () => {
    // The bytes really are a valid GIF, so we serve them — the defense is that
    // the browser is told image/gif and forbidden from re-deciding.
    const res = await blobRequest('poly.gif', 'worktree');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const text = new TextDecoder().decode(await bodyBytes(res));
    expect(text).toContain(POLYGLOT_JS);
  });

  test('the refusal is identical on every side (no side is a softer path)', async () => {
    for (const side of ['head', 'index', 'worktree'] as const) {
      const res = await blobRequest('fake.png', side);
      expect(res.status).toBe(415);
    }
  });
});

describe('GET /blob — caps and bombs', () => {
  test('a 300-byte PNG declaring 60000x60000 is a 413 with no bytes', async () => {
    const res = await blobRequest('bomb.png', 'worktree');
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toContain('too-many-pixels');
  });

  test('a 9 MiB PNG is a 413 and is never read', async () => {
    // Prove the counter is live first, or "zero reads" is vacuously true.
    const served = await readsFor('logo.png', async () => {
      expect((await blobRequest('logo.png', 'worktree')).status).toBe(200);
    });
    expect(served.calls).toBeGreaterThan(0);

    let status = 0;
    const refused = await readsFor('huge.png', async () => {
      status = (await blobRequest('huge.png', 'worktree')).status;
    });
    expect(status).toBe(413);
    // The size came from an fstat on the open fd; not one byte was moved.
    expect(refused.calls).toBe(0);
    expect(refused.bytes).toBe(0);
  });

  test('a 3 MiB GIF is a 413 (the GIF cap is tighter than the image cap)', async () => {
    const res = await blobRequest('big.gif', 'worktree');
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toContain('too-large');
  });

  test('an APNG is a 415: a refused format, not an oversized one', async () => {
    // It is nowhere near a budget — it is a second animation decoder we do
    // not serve, which is a format refusal and reads as one in the UI.
    const res = await blobRequest('apng.png', 'worktree');
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toContain('animation');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('GET /blob — path guards', () => {
  const traversal = ['../../etc/passwd', '/etc/passwd', '..', '.', './../..'];

  test('traversal and absolute paths are 400s', async () => {
    for (const raw of traversal) {
      const res = await request(blobUrl(repoId, { path: raw, side: 'worktree' }));
      expect(res.status).toBe(400);
    }
  });

  test('a percent-encoded traversal is decoded before it is judged', async () => {
    const res = await request(`/repos/${repoId}/blob?path=..%2f..%2fetc%2fpasswd&side=worktree`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('escapes');
  });

  test('a NUL byte in the path is a 400', async () => {
    const res = await request(`/repos/${repoId}/blob?path=README%00.png&side=worktree`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('NUL');
  });

  test('every spelling of the git directory is a 400, on every side', async () => {
    const spellings = [
      '.git',
      '.git/config',
      './.git/config',
      'src/../.git/config',
      '.GIT/config',
      '.git./config',
      'worktrees/x/.git/config',
    ];
    for (const spelling of spellings) {
      for (const side of ['worktree', 'head', 'index'] as const) {
        const res = await request(blobUrl(repoId, { path: spelling, side }));
        expect(res.status).toBe(400);
        expect(await errorOf(res)).toContain('git directory');
      }
    }
  });

  test('a committed symlink out of the repo is refused on every side', async () => {
    // The working tree catches it by realpath; the git sides catch it because
    // a 120000 entry is a stored path, not bytes.
    for (const side of ['worktree', 'head', 'index'] as const) {
      const res = await blobRequest('secret.png', side);
      expect(res.status).toBe(400);
    }
  });

  test('a FIFO is a prompt 400 and the daemon stays responsive', async () => {
    const fifoPath = path.join(repoPath, 'pipe.fifo');
    execSync(`mkfifo "${fifoPath}"`);
    try {
      const res = await blobRequest('pipe.fifo', 'worktree', {
        signal: AbortSignal.timeout(2000),
      });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('Not a regular blob');

      const health = await request('/health', { signal: AbortSignal.timeout(2000) });
      expect(health.status).toBe(200);
    } finally {
      fs.rmSync(fifoPath, { force: true });
    }
  });

  test('a directory in the working tree is a 400, not a read', async () => {
    fs.mkdirSync(path.join(repoPath, 'assets'), { recursive: true });
    try {
      const res = await blobRequest('assets', 'worktree');
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('Not a regular blob');
    } finally {
      fs.rmSync(path.join(repoPath, 'assets'), { recursive: true, force: true });
    }
  });
});

describe('GET /blob — parameter injection', () => {
  test('a bogus or option-shaped side is a 400 and never reaches git', async () => {
    // If `side` were ever interpolated into argv, this one writes a file.
    const pwnPath = path.join(os.tmpdir(), `diffstalker-blob-pwn-${process.pid}`);
    for (const side of [`--output=${pwnPath}`, 'bogus', 'HEAD', '', 'commit']) {
      const res = await request(
        `/repos/${repoId}/blob?path=logo.png&side=${encodeURIComponent(side)}`
      );
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('side');
    }
    expect(fs.existsSync(pwnPath)).toBe(false);
  });

  test('a missing side is a 400', async () => {
    const res = await request(`/repos/${repoId}/blob?path=logo.png`);
    expect(res.status).toBe(400);
  });

  test('a git option or pathspec as the path is a 400', async () => {
    const cases: Array<[string, string]> = [
      ['-foo.png', '"-"'],
      ['./-foo.png', '"-"'],
      [':(glob)**', '":"'],
      [':/etc/passwd', '":"'],
    ];
    for (const [raw, expected] of cases) {
      const res = await request(blobUrl(repoId, { path: raw, side: 'head' }));
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(expected);
    }
  });

  test('a missing or empty path is a 400', async () => {
    expect((await request(`/repos/${repoId}/blob?side=head`)).status).toBe(400);
    expect((await request(`/repos/${repoId}/blob?path=&side=head`)).status).toBe(400);
  });
});

describe('GET /blob — origin and subresource guards', () => {
  test('a rebound Host is a 421 (the global guard)', async () => {
    const res = await blobRequest('logo.png', 'worktree', { headers: { host: 'evil.com' } });
    expect(res.status).toBe(421);
  });

  test('a cross-site fetch is a 403', async () => {
    const res = await blobRequest('logo.png', 'worktree', {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain('Cross-site');
  });

  test('every non-image destination is a 403', async () => {
    for (const dest of ['document', 'iframe', 'object', 'embed', 'script', 'style', 'empty']) {
      const res = await blobRequest('logo.png', 'worktree', {
        headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': dest },
      });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toContain('destination');
    }
  });

  test('the real browser <img> case is a 200', async () => {
    // The positive half matters: bun sends no Sec-Fetch-* headers of its own,
    // so a guard that rejected everything would still pass the rest of this
    // file.
    const res = await blobRequest('logo.png', 'worktree', {
      headers: {
        'sec-fetch-site': 'same-origin',
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('the SPA fetch shape is a 200 on /media (the guard is not on it)', async () => {
    const res = await request(mediaUrl(repoId, 'logo.png', false), {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
    });
    expect(res.status).toBe(200);
  });

  test('a cross-site /media fetch still passes the global GET guard', async () => {
    // guardRequest exempts GET from the Sec-Fetch-Site check by design, and
    // CORP is what stops the response reaching the embedding page.
    const res = await request(mediaUrl(repoId, 'logo.png', false), {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

describe('GET /media — sides', () => {
  test('modified, unstaged: index on the old side, working tree on the new', async () => {
    const pair = await mediaFor('logo.png', false);
    expect(pair.old).toMatchObject({ path: 'logo.png', side: 'index', oid: oidOf(':logo.png') });
    expect(pair.old?.image).toMatchObject({ format: 'png', width: 2, height: 2 });
    expect(pair.new).toMatchObject({ path: 'logo.png', side: 'worktree', oid: null });
    expect(pair.new?.image).toMatchObject({ width: 3, height: 3 });
    expect(pair.new?.bytes).toBe(PNG_IN_WORKTREE.length);
  });

  test('modified, staged: HEAD on the old side, index on the new', async () => {
    const pair = await mediaFor('logo.png', true);
    expect(pair.old).toMatchObject({ side: 'head', oid: oidOf('HEAD:logo.png') });
    expect(pair.old?.image).toMatchObject({ width: 1, height: 1 });
    expect(pair.new).toMatchObject({ side: 'index', oid: oidOf(':logo.png') });
  });

  test('the version is the oid on the git sides and size-mtime on the working tree', async () => {
    const pair = await mediaFor('logo.png', false);
    expect(pair.old?.version).toBe(oidOf(':logo.png'));
    expect(pair.new?.version).toMatch(/^\d+-\d/);
  });

  test('untracked: a new side only', async () => {
    const pair = await mediaFor('untracked.png', false);
    expect(pair.old).toBeNull();
    expect(pair.new).toMatchObject({ path: 'untracked.png', side: 'worktree' });
    expect((await blobRequest('untracked.png', 'head')).status).toBe(404);
  });

  test('deleted: an old side only', async () => {
    const pair = await mediaFor('gone.png', false);
    expect(pair.old).toMatchObject({ path: 'gone.png', side: 'index' });
    expect(pair.old?.image).toMatchObject({ width: 1, height: 1 });
    expect(pair.new).toBeNull();
  });

  test('an animated GIF reports its frame count', async () => {
    // The count is the whole reason a GIF is walked to its trailer, and it is
    // what the UI labels the frame badge with — so assert the number, not
    // just that a GIF came back. untracked-anim.gif has three frames.
    const pair = await mediaFor('untracked-anim.gif', false);
    expect(pair.new?.image).toMatchObject({
      format: 'gif',
      width: 4,
      height: 4,
      frames: 3,
    });
    expect(pair.new?.refusal).toBeNull();
  });

  test('a non-image binary side reports a refusal instead of an image', async () => {
    writeBytes('fake.png', concat(SVG_BYTES, str('<!-- changed -->')));
    const pair = await mediaFor('fake.png', false);
    expect(pair.new?.image).toBeNull();
    expect(pair.new?.refusal).toBe('not-an-image');
    expect(pair.new?.bytes).toBeGreaterThan(0);
  });

  test('a renamed file keeps the new side on the post-rename path', async () => {
    const pair = await mediaFor('new-name.png', true);
    expect(pair.new).toMatchObject({ path: 'new-name.png', side: 'index' });
    expect(pair.new?.image).toMatchObject({ width: 2, height: 2 });
  });

  test('the pre-rename blob is still reachable on head by its old path', async () => {
    const res = await blobRequest('old-name.png', 'head');
    expect(res.status).toBe(200);
    expect([...(await bodyBytes(res))]).toEqual([...PNG_AT_INDEX]);
  });

  test('the old side of a rename is the pre-rename path in HEAD', async () => {
    // The whole point of resolving sides server-side: the client asks about
    // the path it can see (the new name) and gets told where the old bytes
    // actually live. HEAD has never heard of new-name.png, so without
    // originalPath this side would be a 404 and a renamed image would show
    // as an addition.
    const pair = await mediaFor('new-name.png', true);
    expect(pair.old).toMatchObject({ path: 'old-name.png', side: 'head' });
    expect(pair.old?.image).toMatchObject({ width: 2, height: 2 });
  });

  test('a path with no status entry is a 404', async () => {
    const res = await request(mediaUrl(repoId, 'photo.jpg', false));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toContain('not in status');
  });

  test('staged must be spelled 0 or 1', async () => {
    for (const raw of ['true', '', 'yes', '2']) {
      const res = await request(`/repos/${repoId}/media?path=logo.png&staged=${raw}`);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('staged');
    }
    expect((await request(`/repos/${repoId}/media?path=logo.png`)).status).toBe(400);
  });

  test('/media applies the same path guards as /blob', async () => {
    for (const raw of ['.git/config', '../../etc/passwd', '-foo.png']) {
      const res = await request(mediaUrl(repoId, raw, false));
      expect(res.status).toBe(400);
    }
  });
});

describe('the read budget', () => {
  test('a /media verdict reads the header window, not the 4 MiB file', async () => {
    // A verdict is all /media returns, and a PNG is decided by its header, so
    // reading the rest would be four megabytes of resident memory per request
    // on an endpoint any page can drive.
    const verdict = await readsFor('big.png', async () => {
      const pair = await mediaFor('big.png', false);
      expect(pair.new?.image).toMatchObject({ format: 'png', width: 64, height: 64 });
      // The size reported is the real one, whatever was read to learn it.
      expect(pair.new?.bytes).toBe(BIG_PNG.length);
    });
    expect(verdict.bytes).toBeGreaterThan(0);
    expect(verdict.bytes).toBeLessThanOrEqual(IMAGE_HEADER_WINDOW + PEEK_ALLOWANCE);
  });

  test('a header past the window is typed the same way by /media and /blob', async () => {
    // The window decides ordinary files, but a maximal EXIF segment pushes the
    // frame header out of it. A verdict that stopped at the window would call
    // this header-not-found on /media while /blob served the very same bytes as
    // a JPEG — and header-not-found has no refusal text, so the Changes stack
    // would drop the card with no reason given.
    const verdict = await readsFor('exif.jpg', async () => {
      const pair = await mediaFor('exif.jpg', false);
      expect(pair.new?.refusal).toBeNull();
      expect(pair.new?.image).toMatchObject({ format: 'jpeg', width: 9, height: 11 });
    });
    // Inconclusive at the window, so the read was extended — bounded by the
    // file, which openBlob already held under MAX_IMAGE_BYTES.
    expect(verdict.bytes).toBe(EXIF_JPEG.length);

    const res = await blobRequest('exif.jpg', 'worktree');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect([...(await bodyBytes(res))]).toEqual([...EXIF_JPEG]);
  });

  test('/blob still reads every byte it is going to write', async () => {
    const served = await readsFor('big.png', async () => {
      const res = await blobRequest('big.png', 'worktree');
      expect(res.status).toBe(200);
      // Drain it: the route holds its semaphore slot until the response is
      // finished, so an undrained 4 MiB body would keep the slot.
      expect((await bodyBytes(res)).length).toBe(BIG_PNG.length);
    });
    expect(served.bytes).toBeGreaterThanOrEqual(BIG_PNG.length);
  });
});

describe('both byte routes are gated', () => {
  /**
   * Drive one request through a router whose gate has no slots at all.
   *
   * The daemon builds its own semaphore internally, so the alternative is
   * racing 69 real requests to fill a 64-deep queue — a flaky way to ask a
   * yes/no question. This asks the real registered handler instead.
   */
  async function statusWithNoSlots(pathname: string): Promise<number> {
    const router = new Router();
    const handle = daemon.getRepo(repoId);
    const registry = { getRepo: (id: string) => (id === repoId ? handle : undefined) };
    registerBlobRoutes(router, { registry } as unknown as RouteDeps, createBlobSemaphore(0, 0));

    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end() {
        return this;
      },
      once() {
        return this;
      },
    };
    const req = { method: 'GET', url: pathname, headers: {} } as IncomingMessage;
    await router.handle(req, res as unknown as ServerResponse);
    return status;
  }

  interface GatedServer {
    gate: BlobSemaphore;
    request(pathname: string, init?: RequestInit): Promise<Response>;
    close(): Promise<void>;
  }

  /**
   * A second http server on its own socket, serving the real blob routes
   * through a semaphore this test can look inside.
   *
   * Reading `gate.active` is what keeps the release assertions honest: from
   * outside, a request that never reached the handler and a request whose slot
   * came back look exactly alike. The daemon builds its semaphore internally,
   * so borrowing the routes into a server of our own is the only way to watch
   * the counter that a leak moves.
   */
  async function startGatedServer(limit: number, queueLimit: number): Promise<GatedServer> {
    const gate = createBlobSemaphore(limit, queueLimit);
    const router = new Router();
    const handle = daemon.getRepo(repoId);
    const registry = { getRepo: (id: string) => (id === repoId ? handle : undefined) };
    registerBlobRoutes(router, { registry } as unknown as RouteDeps, gate);

    const server = http.createServer((req, res) => {
      void router.handle(req, res);
    });
    const socketPath = path.join(os.tmpdir(), `diffstalkerd-blob-gate-${process.pid}.sock`);
    fs.rmSync(socketPath, { force: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    return {
      gate,
      request: (pathname, init) =>
        fetch(`http://localhost${pathname}`, { ...init, unix: socketPath } as RequestInit),
      close: async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(socketPath, { force: true });
      },
    };
  }

  /**
   * Poll until something is true, or fail saying what never happened. The
   * deadline is well inside bun's own test timeout so the failure names the
   * thing that did not happen rather than the test that ran long.
   */
  async function waitFor(what: string, ready: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  test('/media refuses with 503 when the gate is empty, exactly like /blob', async () => {
    // /media is the more expensive route, not the cheaper one: it inspects up
    // to two sides, so leaving it ungated would leave the budget meaningless.
    expect(await statusWithNoSlots(mediaUrl(repoId, 'logo.png', false))).toBe(503);
    expect(await statusWithNoSlots(blobUrl(repoId, { path: 'logo.png', side: 'worktree' }))).toBe(
      503
    );
  });

  test('a /blob refusal gives its slot back, so the gate does not silt up', async () => {
    // Ten refusals is well past the concurrency limit, so a slot leaked on the
    // error path would leave nothing for the request after them.
    for (let i = 0; i < 10; i++) {
      expect((await blobRequest('fake.png', 'worktree')).status).toBe(415);
    }
    const res = await blobRequest('logo.png', 'worktree', { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).length).toBe(PNG_IN_WORKTREE.length);
  });

  test('a /media refusal gives its slot back too', async () => {
    // /media takes its slot before it resolves the status entry, so this 404
    // is raised with the slot in hand and the release has to happen on the
    // throw. photo.jpg is clean and committed, so it is in no status entry.
    for (let i = 0; i < 10; i++) {
      const res = await request(mediaUrl(repoId, 'photo.jpg', false), {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(404);
    }
    const pair = await mediaFor('logo.png', false);
    expect(pair.new?.image).toMatchObject({ width: 3, height: 3 });
  });

  test('a client that walks away mid-request gives its slot back', async () => {
    // The one leak the other tests cannot see, and it is runtime-specific: on
    // an abort node destroys the RESPONSE and emits `close` on it, while bun
    // emits nothing on the response at all — the abort surfaces only on the
    // request. Wired to the response alone, every abort keeps its slot, and
    // BLOB_CONCURRENCY of them wedge /blob and /media for the life of the
    // daemon. The shipped bin is node, but the documented dev daemon is bun.
    const gated = await startGatedServer(BLOB_CONCURRENCY, 0);
    try {
      for (let i = 0; i < BLOB_CONCURRENCY + 1; i++) {
        const controller = new AbortController();
        // side=head spawns git, so the handler is still working when we abort.
        const aborted = gated
          .request(blobUrl(repoId, { path: 'logo.png', side: 'head' }), {
            signal: controller.signal,
          })
          .catch(() => null);
        // Not decoration: if the request had already finished, the abort would
        // prove nothing, so failing to observe the slot fails the test.
        await waitFor('the slot to be taken', () => gated.gate.active === 1);
        controller.abort();
        await aborted;
        await waitFor('the aborted request to give its slot back', () => gated.gate.active === 0);
      }
      // This gate has no queue at all, so one leaked slot is a 503 here.
      const res = await gated.request(blobUrl(repoId, { path: 'logo.png', side: 'worktree' }), {
        signal: AbortSignal.timeout(2000),
      });
      expect(res.status).toBe(200);
      expect((await bodyBytes(res)).length).toBe(PNG_IN_WORKTREE.length);
    } finally {
      await gated.close();
    }
  });
});

describe('blob semaphore', () => {
  test('lets the concurrency limit through immediately', async () => {
    const gate = createBlobSemaphore(4, 64);
    const releases = await Promise.all([1, 2, 3, 4].map(() => gate.acquire()!));
    expect(gate.active).toBe(4);
    expect(gate.queued).toBe(0);
    for (const release of releases) release();
    expect(gate.active).toBe(0);
  });

  test('queues past the limit and hands the slot to the next waiter', async () => {
    const gate = createBlobSemaphore(2, 64);
    const first = await gate.acquire()!;
    await gate.acquire()!;
    let handedOver = false;
    const waiting = gate.acquire()!.then((release) => {
      handedOver = true;
      return release;
    });
    expect(gate.queued).toBe(1);
    expect(handedOver).toBe(false);

    first();
    await waiting;
    expect(handedOver).toBe(true);
    // The slot moved rather than freeing: still two in flight, none queued.
    expect(gate.active).toBe(2);
    expect(gate.queued).toBe(0);
  });

  test('refuses rather than queueing without bound', async () => {
    const gate = createBlobSemaphore(2, 3);
    await gate.acquire()!;
    await gate.acquire()!;
    for (let i = 0; i < 3; i++) {
      expect(gate.acquire()).not.toBeNull();
    }
    expect(gate.queued).toBe(3);
    // The overflow request gets nothing to await — that is the 503.
    expect(gate.acquire()).toBeNull();
  });

  test('a slot released twice does not become two slots', async () => {
    const gate = createBlobSemaphore(1, 8);
    const release = await gate.acquire()!;
    release();
    release();
    expect(gate.active).toBe(0);
    // Still exactly one slot on offer.
    expect(gate.acquire()).not.toBeNull();
    expect(gate.active).toBe(1);
    expect(gate.acquire()).not.toBeNull();
    expect(gate.queued).toBe(1);
  });

  test('the queue drains in order', async () => {
    const gate = createBlobSemaphore(1, 8);
    const held = await gate.acquire()!;
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      gate.acquire()!.then((release) => {
        order.push(n);
        release();
      })
    );
    held();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(gate.active).toBe(0);
  });
});
