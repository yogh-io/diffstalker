import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openBlob,
  BlobTooLargeError,
  NotRegularBlobError,
  UnsafeBlobPathError,
  type BlobHandle,
} from './blob.js';
import type { BlobSide } from '../utils/blobRef.js';
import { createFixtureRepo, removeFixtureRepo, gitExec } from './test-helpers.js';

/**
 * Bytes with a NUL, a lone 0xFF/0xFE pair and an incomplete UTF-8 sequence
 * (0xC3 0x28) and a bare continuation byte (0x80). Decoding any of this as
 * UTF-8 replaces it with U+FFFD, so a byte-for-byte assertion is a real test
 * that nothing on the path decoded the blob.
 */
const V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xc3]);
const V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x28, 0x80, 0xfd, 0x11]);
const V3 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80, 0xc3, 0x28, 0x00, 0x42]);
const CLEAN = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0xff]);
const STAGED = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
const GONE = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
const INNER = Buffer.from([0x01, 0x00, 0x02]);
const WEIRD = Buffer.from([0x77, 0x00, 0x88]);

/**
 * Bigger than a pipe read, so reading it spans several chunks: a handle that
 * serves a peek and then the rest has to resume where it stopped, not restart.
 * Every byte value appears, so a decode would show up as a mismatch.
 */
const BIG = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 7 + 13) % 256));

/**
 * A committed filename that spells out a whole extra `ls-files --stage`
 * record. With `-z` the record separator is a NUL, so this is data — but only
 * if the parser really splits on NUL and never on newline.
 */
const FORGED_NAME = 'weird\n100644 0000000000000000000000000000000000000000 0\tpwn.bin';

/**
 * The same trick, aimed. `ls-files -- pwn.bin` is recursive, so asking for a
 * DIRECTORY called `pwn.bin` puts this file's whole name in the output while
 * we are looking for the path `pwn.bin`. Split the output on newlines and the
 * second "record" is a well-formed, allow-listed, valid-oid entry for exactly
 * the path we asked for — pointing at somebody else's blob. Built in
 * beforeAll, since it embeds a real object id.
 */
let trapName: string;

const MAIN = 'blob-test';
const MODES = 'blob-modes-test';
const UNBORN = 'blob-unborn-test';

let repoPath: string;
let modesPath: string;
let unbornPath: string;

function writeBytes(repo: string, relPath: string, bytes: Buffer): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

beforeAll(() => {
  repoPath = createFixtureRepo(MAIN);
  writeBytes(repoPath, 'ok.bin', V1);
  writeBytes(repoPath, 'clean.bin', CLEAN);
  writeBytes(repoPath, 'gone.bin', GONE);
  writeBytes(repoPath, 'big.bin', BIG);
  writeBytes(repoPath, 'dir/inner.bin', INNER);
  writeBytes(repoPath, FORGED_NAME, WEIRD);
  const cleanOid = gitExec(repoPath, 'hash-object clean.bin').trim();
  trapName = `pwn.bin/weird\n100644 ${cleanOid} 0\tpwn.bin`;
  writeBytes(repoPath, trapName, WEIRD);
  fs.symlinkSync('ok.bin', path.join(repoPath, 'link'));
  gitExec(repoPath, 'add -A');
  gitExec(repoPath, 'commit -m "initial"');

  // ok.bin now differs on all three sides: V1 committed, V2 staged, V3 in the
  // working tree. This is the fixture the byte-identity test rests on.
  writeBytes(repoPath, 'ok.bin', V2);
  gitExec(repoPath, 'add ok.bin');
  writeBytes(repoPath, 'ok.bin', V3);

  writeBytes(repoPath, 'staged.bin', STAGED);
  gitExec(repoPath, 'add staged.bin');
  fs.rmSync(path.join(repoPath, 'gone.bin'));

  // Untracked, and created after the commits so `git add` never sees it.
  execSync('mkfifo pipe', { cwd: repoPath });

  // A repo where every non-regular mode is present in BOTH the index and the
  // commit, so the mode allow-list can be checked on both git sides.
  modesPath = createFixtureRepo(MODES);
  writeBytes(modesPath, 'dir/inner.bin', INNER);
  fs.symlinkSync('dir/inner.bin', path.join(modesPath, 'link'));
  gitExec(modesPath, 'add -A');
  gitExec(modesPath, 'commit -m "initial"');
  const someCommit = gitExec(modesPath, 'rev-parse HEAD').trim();
  gitExec(modesPath, `update-index --add --cacheinfo 160000,${someCommit},sub`);
  const tree = gitExec(modesPath, 'write-tree').trim();
  const commit = gitExec(modesPath, `commit-tree ${tree} -p HEAD -m "gitlink"`).trim();
  gitExec(modesPath, `update-ref HEAD ${commit}`);

  // No commit at all: HEAD is unborn, but the index already has content.
  unbornPath = createFixtureRepo(UNBORN);
  writeBytes(unbornPath, 'staged.bin', STAGED);
  gitExec(unbornPath, 'add staged.bin');
});

afterAll(() => {
  removeFixtureRepo(MAIN);
  removeFixtureRepo(MODES);
  removeFixtureRepo(UNBORN);
});

/** Open, read everything, close. Fails loudly when the side has no bytes. */
async function readAll(
  repo: string,
  side: BlobSide,
  relPath: string,
  cap = 4096
): Promise<{ bytes: Buffer; handle: BlobHandle }> {
  const handle = await openBlob(repo, side, relPath, cap);
  if (handle === null) throw new Error(`expected bytes for ${side}:${relPath}`);
  const bytes = Buffer.from(await handle.read(cap));
  await handle.close();
  return { bytes, handle };
}

/** Return the rejection instead of it escaping, so it can be asserted on. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got a resolved promise');
}

describe('openBlob — working tree', () => {
  it('reads the exact bytes with no oid and a size-mtime version', async () => {
    const { bytes, handle } = await readAll(repoPath, 'worktree', 'ok.bin');
    expect(bytes).toEqual(V3);
    expect(handle.oid).toBeNull();
    expect(handle.size).toBe(V3.length);
    const mtimeMs = fs.statSync(path.join(repoPath, 'ok.bin')).mtimeMs;
    expect(handle.version).toBe(`${V3.length}-${mtimeMs}`);
  });

  it('caps a read at n, never overruns the file, and repeats identically', async () => {
    const handle = await openBlob(repoPath, 'worktree', 'ok.bin', 4096);
    if (handle === null) throw new Error('expected a handle');
    expect(Buffer.from(await handle.read(4))).toEqual(V3.subarray(0, 4));
    expect(Buffer.from(await handle.read(99999))).toEqual(V3);
    expect(Buffer.from(await handle.read(4))).toEqual(V3.subarray(0, 4));
    expect(Buffer.from(await handle.read(0))).toEqual(Buffer.alloc(0));
    await handle.close();
  });

  it('reads the file once across a peek and a full read', async () => {
    // The route peeks four bytes for GIF magic before it picks a cap. The
    // handle keeps that peek, so the file is not pulled off disk twice.
    const { result, bytesRead } = await withFdMeter(async () => {
      const handle = await openBlob(repoPath, 'worktree', 'ok.bin', 4096);
      if (handle === null) throw new Error('expected a handle');
      const peek = Buffer.from(await handle.read(4));
      const all = Buffer.from(await handle.read(4096));
      await handle.close();
      return { peek, all };
    });

    expect(result.peek).toEqual(V3.subarray(0, 4));
    expect(result.all).toEqual(V3);
    expect(bytesRead).toBe(V3.length);
  });

  it('returns null for a missing path and for one deleted from the tree', async () => {
    expect(await openBlob(repoPath, 'worktree', 'nope.bin', 4096)).toBeNull();
    expect(await openBlob(repoPath, 'worktree', 'gone.bin', 4096)).toBeNull();
    expect(await openBlob(repoPath, 'worktree', 'dir/nope/deeper.bin', 4096)).toBeNull();
  });

  it('refuses a directory', async () => {
    const err = await caught(() => openBlob(repoPath, 'worktree', 'dir', 4096));
    expect(err).toBeInstanceOf(NotRegularBlobError);
  });

  it('refuses a FIFO without blocking on it', async () => {
    // Without O_NONBLOCK this open never returns and the test times out.
    const err = await caught(() => openBlob(repoPath, 'worktree', 'pipe', 4096));
    expect(err).toBeInstanceOf(NotRegularBlobError);
  });

  it('refuses a file over the cap and reports its size', async () => {
    const err = await caught(() => openBlob(repoPath, 'worktree', 'ok.bin', V3.length - 1));
    expect(err).toBeInstanceOf(BlobTooLargeError);
    expect((err as BlobTooLargeError).size).toBe(V3.length);
  });

  it('accepts a file exactly at the cap', async () => {
    const { bytes } = await readAll(repoPath, 'worktree', 'ok.bin', V3.length);
    expect(bytes).toEqual(V3);
  });
});

describe('openBlob — index and HEAD', () => {
  it('returns byte-identical content for all three sides of one file', async () => {
    const head = await readAll(repoPath, 'head', 'ok.bin');
    const index = await readAll(repoPath, 'index', 'ok.bin');
    const worktree = await readAll(repoPath, 'worktree', 'ok.bin');

    expect(head.bytes).toEqual(V1);
    expect(index.bytes).toEqual(V2);
    expect(worktree.bytes).toEqual(V3);
    // The guard that would catch a string round trip: decoding these bytes as
    // UTF-8 and re-encoding them does NOT give the same bytes back.
    expect(Buffer.from(head.bytes.toString('utf-8'), 'utf-8')).not.toEqual(V1);
  });

  it('reports the object id as both oid and version, and the sides differ', async () => {
    const head = await readAll(repoPath, 'head', 'ok.bin');
    const index = await readAll(repoPath, 'index', 'ok.bin');

    expect(head.handle.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(head.handle.version).toBe(head.handle.oid as string);
    expect(head.handle.size).toBe(V1.length);
    expect(index.handle.size).toBe(V2.length);
    expect(index.handle.oid).not.toBe(head.handle.oid);
    expect(index.handle.oid).toBe(gitExec(repoPath, 'rev-parse :ok.bin').trim());
  });

  it('serves a clean committed file on head, index and worktree alike', async () => {
    // The Explorer case: an unmodified image must be readable on every side.
    for (const side of ['head', 'index', 'worktree'] as BlobSide[]) {
      const { bytes } = await readAll(repoPath, side, 'clean.bin');
      expect(bytes).toEqual(CLEAN);
    }
  });

  it('has an added file in the index only', async () => {
    expect(await openBlob(repoPath, 'head', 'staged.bin', 4096)).toBeNull();
    const { bytes } = await readAll(repoPath, 'index', 'staged.bin');
    expect(bytes).toEqual(STAGED);
  });

  it('keeps a deleted file readable on the git sides', async () => {
    expect((await readAll(repoPath, 'head', 'gone.bin')).bytes).toEqual(GONE);
    expect((await readAll(repoPath, 'index', 'gone.bin')).bytes).toEqual(GONE);
    expect(await openBlob(repoPath, 'worktree', 'gone.bin', 4096)).toBeNull();
  });

  it('returns null for a path missing on that side', async () => {
    expect(await openBlob(repoPath, 'head', 'nope.bin', 4096)).toBeNull();
    expect(await openBlob(repoPath, 'index', 'nope.bin', 4096)).toBeNull();
    expect(await openBlob(repoPath, 'head', 'dir/nope.bin', 4096)).toBeNull();
  });

  it('returns null for an unborn HEAD instead of throwing', async () => {
    expect(await openBlob(unbornPath, 'head', 'staged.bin', 4096)).toBeNull();
    // Same repo, same path: the index side still has the bytes.
    expect((await readAll(unbornPath, 'index', 'staged.bin')).bytes).toEqual(STAGED);
  });

  it('propagates a real git failure instead of calling it an unborn HEAD', async () => {
    // Only "HEAD names no commit" may read as an empty side. A directory that
    // is not a repo at all is a failure, and swallowing it would surface as a
    // 404 "no such blob" with the real reason gone.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-not-a-repo-'));
    try {
      const err = await caught(() => openBlob(outside, 'head', 'staged.bin', 4096));
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotRegularBlobError);
      expect(String((err as Error).message)).toContain('git');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses an over-cap blob on both git sides', async () => {
    const headErr = await caught(() => openBlob(repoPath, 'head', 'ok.bin', V1.length - 1));
    expect(headErr).toBeInstanceOf(BlobTooLargeError);
    expect((headErr as BlobTooLargeError).size).toBe(V1.length);

    const indexErr = await caught(() => openBlob(repoPath, 'index', 'ok.bin', V2.length - 1));
    expect(indexErr).toBeInstanceOf(BlobTooLargeError);
    expect((indexErr as BlobTooLargeError).size).toBe(V2.length);
  });

  it('caps a read at n and repeats identically', async () => {
    const handle = await openBlob(repoPath, 'head', 'ok.bin', 4096);
    if (handle === null) throw new Error('expected a handle');
    expect(Buffer.from(await handle.read(3))).toEqual(V1.subarray(0, 3));
    expect(Buffer.from(await handle.read(4096))).toEqual(V1);
    expect(Buffer.from(await handle.read(3))).toEqual(V1.subarray(0, 3));
    await handle.close();
  });
});

describe('openBlob — mode allow-list', () => {
  it('refuses a symlink entry (120000) on both git sides', async () => {
    for (const side of ['head', 'index'] as BlobSide[]) {
      const err = await caught(() => openBlob(modesPath, side, 'link', 4096));
      expect(err).toBeInstanceOf(NotRegularBlobError);
    }
  });

  it('refuses a gitlink entry (160000) on both git sides', async () => {
    for (const side of ['head', 'index'] as BlobSide[]) {
      const err = await caught(() => openBlob(modesPath, side, 'sub', 4096));
      expect(err).toBeInstanceOf(NotRegularBlobError);
    }
  });

  it('refuses a tree entry (040000) on head', async () => {
    const err = await caught(() => openBlob(modesPath, 'head', 'dir', 4096));
    expect(err).toBeInstanceOf(NotRegularBlobError);
  });

  it('has no index entry for a directory path', async () => {
    // ls-files lists the files under it, none of which IS the directory.
    expect(await openBlob(modesPath, 'index', 'dir', 4096)).toBeNull();
  });

  it('still serves the regular file the symlink pointed at', async () => {
    expect((await readAll(modesPath, 'head', 'dir/inner.bin')).bytes).toEqual(INNER);
  });
});

describe('openBlob — path guards', () => {
  const rejected = ['-foo.png', '--output=/tmp/pwn', ':(glob)**', ':/etc/passwd', '', 'a\0b.png'];

  it('refuses a path git could read as an option or a pathspec', async () => {
    for (const side of ['worktree', 'index', 'head'] as BlobSide[]) {
      for (const relPath of rejected) {
        const err = await caught(() => openBlob(repoPath, side, relPath, 4096));
        expect(err).toBeInstanceOf(UnsafeBlobPathError);
      }
    }
  });

  it('accepts an ordinary path that merely contains a dash or a colon', async () => {
    writeBytes(repoPath, 'a-b:c.bin', CLEAN);
    const { bytes } = await readAll(repoPath, 'worktree', 'a-b:c.bin');
    expect(bytes).toEqual(CLEAN);
    fs.rmSync(path.join(repoPath, 'a-b:c.bin'));
  });
});

describe('openBlob — record parsing', () => {
  it('reads a committed filename that spells out a whole extra record', async () => {
    const { bytes } = await readAll(repoPath, 'head', FORGED_NAME);
    expect(bytes).toEqual(WEIRD);
  });

  it('reads the aimed trap file by its own name too', async () => {
    expect((await readAll(repoPath, 'index', trapName)).bytes).toEqual(WEIRD);
  });

  it('does not let a filename forge a record for the path being asked for', async () => {
    // `pwn.bin` is a directory. Its one child's name contains a line that
    // reads as a valid index record for `pwn.bin` pointing at clean.bin's
    // blob, and that line is in the ls-files output for this very query. A
    // newline-splitting parser hands back CLEAN here.
    expect(await openBlob(repoPath, 'index', 'pwn.bin', 4096)).toBeNull();

    // ls-tree is not recursive, so on the head side the query only ever sees
    // the directory's own entry — refused on its mode.
    const err = await caught(() => openBlob(repoPath, 'head', 'pwn.bin', 4096));
    expect(err).toBeInstanceOf(NotRegularBlobError);
  });

  it('does not match a path by prefix', async () => {
    expect(await openBlob(repoPath, 'head', 'ok', 4096)).toBeNull();
    expect(await openBlob(repoPath, 'head', 'ok.bin.bak', 4096)).toBeNull();
  });
});

/**
 * Put a stand-in `git` first on PATH for the duration of `body`. The script
 * factory gets the real git's path and the throwaway directory it lives in.
 */
async function withFakeGit(
  script: (realGit: string, dir: string) => string,
  body: () => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-git-probe-'));
  const realGit = execSync('command -v git', { encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(dir, 'git'), script(realGit, dir), { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  try {
    await body();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readCalls(logPath: string): string[][] {
  if (!fs.existsSync(logPath)) return [];
  const parts = fs.readFileSync(logPath).toString('utf-8').split('\0');
  parts.pop(); // the trailing empty piece after the final NUL
  const calls: string[][] = [];
  for (const part of parts) {
    if (part === '--call--') calls.push([]);
    else calls[calls.length - 1].push(part);
  }
  return calls;
}

/**
 * Run `body` with a `git` that records its argv and then execs the real one.
 * Nothing else can prove what actually reached the process — the point of the
 * exercise is that the caller's path is an operand, never an option, and never
 * a pathspec.
 */
async function withGitProbe(body: (calls: () => string[][]) => Promise<void>): Promise<void> {
  let logPath = '';
  await withFakeGit(
    (realGit, dir) => {
      logPath = path.join(dir, 'argv.log');
      return `#!/bin/sh\nprintf '%s\\0' '--call--' "$@" >> '${logPath}'\nexec '${realGit}' "$@"\n`;
    },
    () => body(() => readCalls(logPath))
  );
}

/**
 * Run `body` with a `git` whose `cat-file blob` never stops writing; every
 * other subcommand is the real one, so sizes and modes still come from the
 * fixture repo. A read that waits for the object to end simply never returns
 * here, which is what makes this a real test of the read budget rather than of
 * the returned length.
 */
function withStreamingGit(body: () => Promise<void>): Promise<void> {
  return withFakeGit(
    (realGit) =>
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "blob" ]; then exec cat /dev/zero; fi\ndone\nexec '${realGit}' "$@"\n`,
    body
  );
}

/**
 * Count the bytes `body` pulls off disk, by wrapping every file handle it
 * opens. The returned bytes alone cannot tell one bounded read from two.
 */
async function withFdMeter<T>(body: () => Promise<T>): Promise<{ result: T; bytesRead: number }> {
  type OpenFn = typeof fs.promises.open;
  const realOpen: OpenFn = fs.promises.open;
  let bytesRead = 0;

  const wrapped = (async (...args: Parameters<OpenFn>) => {
    const handle = await realOpen(...args);
    const realRead = handle.read.bind(handle) as typeof handle.read;
    Object.defineProperty(handle, 'read', {
      value: async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await realRead(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      },
    });
    return handle;
  }) as OpenFn;

  (fs.promises as { open: OpenFn }).open = wrapped;
  try {
    return { result: await body(), bytesRead };
  } finally {
    (fs.promises as { open: OpenFn }).open = realOpen;
  }
}

describe('openBlob — git argv', () => {
  const PREFIX = [
    '-c',
    'core.fsmonitor=',
    '-c',
    'core.pager=cat',
    '-c',
    'core.hooksPath=/dev/null',
    '--literal-pathspecs',
  ];

  it('prefixes every invocation and passes the path only after --', async () => {
    await withGitProbe(async (calls) => {
      const { bytes } = await readAll(repoPath, 'head', 'clean.bin');
      expect(bytes).toEqual(CLEAN);

      const recorded = calls();
      expect(recorded.length).toBeGreaterThan(0);
      for (const args of recorded) {
        expect(args.slice(0, PREFIX.length)).toEqual(PREFIX);
        expect(args).not.toContain('--filters');
        expect(args).not.toContain('--textconv');
        expect(args).not.toContain('show');

        const hits = args.filter((a) => a === 'clean.bin');
        expect(hits.length).toBeLessThanOrEqual(1);
        const at = args.indexOf('clean.bin');
        if (at !== -1) expect(args[at - 1]).toBe('--');
      }
    });
  });

  it('runs the same prefix for the index side', async () => {
    await withGitProbe(async (calls) => {
      await readAll(repoPath, 'index', 'clean.bin');
      for (const args of calls()) {
        expect(args.slice(0, PREFIX.length)).toEqual(PREFIX);
        const at = args.indexOf('clean.bin');
        if (at !== -1) expect(args[at - 1]).toBe('--');
      }
    });
  });

  it('spawns no git at all for a refused path', async () => {
    await withGitProbe(async (calls) => {
      for (const side of ['index', 'head'] as BlobSide[]) {
        expect(await caught(() => openBlob(repoPath, side, '-foo.png', 4096))).toBeInstanceOf(
          UnsafeBlobPathError
        );
        expect(await caught(() => openBlob(repoPath, side, ':(glob)**', 4096))).toBeInstanceOf(
          UnsafeBlobPathError
        );
      }
      expect(calls()).toEqual([]);
    });
  });

  it('never fetches the bytes of an over-cap blob', async () => {
    await withGitProbe(async (calls) => {
      expect(await caught(() => openBlob(repoPath, 'head', 'ok.bin', 1))).toBeInstanceOf(
        BlobTooLargeError
      );
      expect(await caught(() => openBlob(repoPath, 'index', 'ok.bin', 1))).toBeInstanceOf(
        BlobTooLargeError
      );
      const fetched = calls().filter((args) => args.includes('cat-file') && args.includes('blob'));
      expect(fetched).toEqual([]);
    });
  });

  it('never fetches the bytes of a refused mode', async () => {
    await withGitProbe(async (calls) => {
      expect(await caught(() => openBlob(modesPath, 'head', 'link', 4096))).toBeInstanceOf(
        NotRegularBlobError
      );
      const fetched = calls().filter((args) => args.includes('cat-file') && args.includes('blob'));
      expect(fetched).toEqual([]);
    });
  });
});

describe('openBlob — read budget', () => {
  it('stops a git-side read at n, whatever the object is', async () => {
    // git here writes zeros forever, so only a read that stops at its own
    // budget ever returns. The old code sized its buffer from the handle's
    // cap, so a 5 MiB GIF was transferred in full before it could be refused.
    await withStreamingGit(async () => {
      const handle = await openBlob(repoPath, 'head', 'ok.bin', 4096);
      if (handle === null) throw new Error('expected a handle');

      // Zeros, not V1: proof the endless stand-in really served this read.
      expect(Buffer.from(await handle.read(4))).toEqual(Buffer.alloc(4));
      // n above the object size clamps to the size git reported.
      expect(Buffer.from(await handle.read(4096))).toEqual(Buffer.alloc(V1.length));
      expect(Buffer.from(await handle.read(0))).toEqual(Buffer.alloc(0));
      await handle.close();
    });
  });

  /** Only the calls that transfer an object; `cat-file -s` asks for a size. */
  const fetches = (calls: string[][]): string[][] =>
    calls.filter((args) => args.includes('cat-file') && args.includes('blob'));

  it('fetches a git blob once across a peek and a full read', async () => {
    // The git-side twin of the working tree's fd meter. The route peeks for
    // GIF magic before it picks a cap, and that peek used to cost a whole
    // second `cat-file` — on the one route whose semaphore exists because a
    // viewport must not become a process table full of git.
    for (const side of ['head', 'index'] as BlobSide[]) {
      await withGitProbe(async (calls) => {
        const handle = await openBlob(repoPath, side, 'clean.bin', 4096);
        if (handle === null) throw new Error('expected a handle');
        const peek = Buffer.from(await handle.read(4));
        const all = Buffer.from(await handle.read(4096));
        await handle.close();

        expect(peek).toEqual(CLEAN.subarray(0, 4));
        expect(all).toEqual(CLEAN);
        expect(fetches(calls()).length).toBe(1);
      });
    }
  });

  it('resumes one fetch across a peek and a multi-chunk read', async () => {
    // A blob larger than one pipe read: the second read has to pick the same
    // child back up mid-object. A handle that restarts instead still returns
    // the right bytes, so only the spawn count catches it.
    await withGitProbe(async (calls) => {
      const handle = await openBlob(repoPath, 'head', 'big.bin', BIG.length);
      if (handle === null) throw new Error('expected a handle');
      const peek = Buffer.from(await handle.read(16));
      const all = Buffer.from(await handle.read(BIG.length));
      await handle.close();

      expect(peek).toEqual(BIG.subarray(0, 16));
      expect(all).toEqual(BIG);
      expect(fetches(calls()).length).toBe(1);
    });
  });

  it('spawns nothing for a zero-length git read', async () => {
    await withGitProbe(async (calls) => {
      const handle = await openBlob(repoPath, 'head', 'ok.bin', 4096);
      if (handle === null) throw new Error('expected a handle');
      expect(Buffer.from(await handle.read(0))).toEqual(Buffer.alloc(0));
      await handle.close();
      const fetched = calls().filter((args) => args.includes('cat-file') && args.includes('blob'));
      expect(fetched).toEqual([]);
    });
  });
});
