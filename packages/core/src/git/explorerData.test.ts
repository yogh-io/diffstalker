import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildGitStatusMap,
  listDirectory,
  readFileForDisplay,
  MAX_DISPLAY_LINES,
  MAX_FILE_SIZE,
  NotRegularFileError,
} from './explorerData.js';
import type { FileForDisplay } from './explorerData.js';
import { IMAGE_HEADER_WINDOW, MAX_IMAGE_BYTES } from '../utils/imageSniff.js';
import { getStatus } from './status.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'explorer-data-test';
let repoPath: string;

/**
 * A structurally valid PNG: signature, IHDR, then an IDAT of `payloadSize`
 * zero bytes. The sniffer stops at the first IDAT and never checks a CRC, so
 * this is exactly what it inspects on a real file — and the payload lets a
 * test pick any file size it likes.
 */
function pngFile(width: number, height: number, payloadSize: number): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // colour type: truecolour + alpha
  const idat = Buffer.alloc(8);
  idat.writeUInt32BE(payloadSize, 0);
  idat.write('IDAT', 4, 'ascii');
  return Buffer.concat([header, idat, Buffer.alloc(payloadSize), Buffer.alloc(4)]);
}

/** Canonical 1x1 GIF, the same bytes every GIF encoder emits for it. */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** A minimal RIFF/WEBP header: a known image format that is refused. */
function webpFile(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(24, 4);
  bytes.write('WEBPVP8 ', 8, 'ascii');
  return bytes;
}

function writeBytes(name: string, bytes: Buffer): string {
  fs.writeFileSync(path.join(repoPath, name), bytes);
  return name;
}

/**
 * Run `readFileForDisplay` with fs.promises.open wrapped, so a test can prove
 * how much was opened and read. This is the only way to assert the caps do
 * their work BEFORE the bytes are pulled off disk — the returned flags alone
 * cannot tell a bounded read from a full one.
 */
async function measureRead(
  relPath: string
): Promise<{ file: FileForDisplay; opens: number; bytesRead: number }> {
  type OpenFn = typeof fs.promises.open;
  const realOpen: OpenFn = fs.promises.open;
  let opens = 0;
  let bytesRead = 0;

  const wrapped = (async (...args: Parameters<OpenFn>) => {
    opens++;
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
    const file = await readFileForDisplay(repoPath, relPath);
    return { file, opens, bytesRead };
  } finally {
    (fs.promises as { open: OpenFn }).open = realOpen;
  }
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, '.gitignore', '*.log\n');
  writeFixtureFile(repoPath, 'README.md', 'readme\n');
  writeFixtureFile(repoPath, 'src/app.ts', 'const a = 1;\n');
  writeFixtureFile(repoPath, 'docs/guide.md', 'guide\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');

  // Working-tree state the tests assert on
  writeFixtureFile(repoPath, 'src/app.ts', 'const a = 2;\n'); // modified
  writeFixtureFile(repoPath, 'src/new.ts', 'const b = 1;\n'); // untracked
  writeFixtureFile(repoPath, 'ignored.log', 'noise\n'); // gitignored
  writeFixtureFile(repoPath, 'src/staged.ts', 'const s = 1;\n'); // staged addition
  gitExec(repoPath, 'add src/staged.ts');
});

afterAll(() => {
  removeFixtureRepo(FIXTURE);
});

describe('buildGitStatusMap', () => {
  it('maps files and marks all ancestor directories plus the root', () => {
    const map = buildGitStatusMap([
      { path: 'src/deep/nested.ts', status: 'modified', staged: false },
      { path: 'top.txt', status: 'untracked', staged: false },
    ]);
    expect(map.files.get('src/deep/nested.ts')).toEqual({ status: 'modified', staged: false });
    expect(map.files.get('top.txt')).toEqual({ status: 'untracked', staged: false });
    expect(map.directories.has('src')).toBe(true);
    expect(map.directories.has('src/deep')).toBe(true);
    expect(map.directories.has('')).toBe(true);
  });

  it('is empty for no files', () => {
    const map = buildGitStatusMap([]);
    expect(map.files.size).toBe(0);
    expect(map.directories.size).toBe(0);
  });
});

describe('listDirectory', () => {
  it('lists one level with dirs first, then files, alphabetically', async () => {
    const entries = await listDirectory(repoPath, '');
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['docs', 'src', 'README.md']);
    expect(entries[0].type).toBe('dir');
    expect(entries[2].type).toBe('file');
  });

  it('excludes gitignored and hidden entries by default', async () => {
    const entries = await listDirectory(repoPath, '');
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('ignored.log');
    expect(names).not.toContain('.gitignore');
    expect(names).not.toContain('.git');
  });

  it('includes hidden entries when hideHidden is false', async () => {
    const entries = await listDirectory(repoPath, '', { hideHidden: false });
    const names = entries.map((e) => e.name);
    expect(names).toContain('.gitignore');
  });

  it('annotates git status per file and marks changed directories', async () => {
    const status = await getStatus(repoPath);
    const statusMap = buildGitStatusMap(status.files);

    const root = await listDirectory(repoPath, '', undefined, statusMap);
    const src = root.find((e) => e.name === 'src');
    expect(src?.hasChanges).toBe(true);
    const docs = root.find((e) => e.name === 'docs');
    expect(docs?.hasChanges).toBeUndefined();

    const srcEntries = await listDirectory(repoPath, 'src', undefined, statusMap);
    expect(srcEntries.find((e) => e.name === 'app.ts')?.gitStatus).toBe('modified');
    expect(srcEntries.find((e) => e.name === 'new.ts')?.gitStatus).toBe('untracked');
  });

  it('carries the staged flag alongside gitStatus', async () => {
    const status = await getStatus(repoPath);
    const statusMap = buildGitStatusMap(status.files);

    const srcEntries = await listDirectory(repoPath, 'src', undefined, statusMap);
    const staged = srcEntries.find((e) => e.name === 'staged.ts');
    expect(staged?.gitStatus).toBe('added');
    expect(staged?.staged).toBe(true);
    const unstaged = srcEntries.find((e) => e.name === 'app.ts');
    expect(unstaged?.staged).toBe(false);
    // Unchanged files carry neither status nor the flag.
    const clean = (await listDirectory(repoPath, '', undefined, statusMap)).find(
      (e) => e.name === 'README.md'
    );
    expect(clean?.gitStatus).toBeUndefined();
    expect(clean?.staged).toBeUndefined();
  });

  it('leaves gitStatus unset without a status map', async () => {
    const entries = await listDirectory(repoPath, 'src');
    for (const entry of entries) {
      expect(entry.gitStatus).toBeUndefined();
    }
  });

  it('rejects a nonexistent directory with an fs error', async () => {
    await expect(listDirectory(repoPath, 'no-such-dir')).rejects.toThrow();
  });
});

describe('readFileForDisplay', () => {
  it('returns plain text content with all flags off', async () => {
    const file = await readFileForDisplay(repoPath, 'README.md');
    expect(file.content).toBe('readme\n');
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.tooLarge).toBe(false);
    expect(file.size).toBe(7);
    expect(file.totalLines).toBe(2); // trailing newline yields an empty last line
  });

  it('flags binary files and returns empty content (no prose)', async () => {
    fs.writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const file = await readFileForDisplay(repoPath, 'blob.bin');
    expect(file.binary).toBe(true);
    expect(file.content).toBe('');
    expect(file.size).toBe(4);
  });

  it('leaves plain text without a media verdict', async () => {
    const file = await readFileForDisplay(repoPath, 'README.md');
    expect(file.media).toBeUndefined();
  });

  it('flags oversized files without reading content', async () => {
    fs.writeFileSync(path.join(repoPath, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));
    const file = await readFileForDisplay(repoPath, 'huge.txt');
    expect(file.tooLarge).toBe(true);
    expect(file.content).toBe('');
    expect(file.size).toBe(1024 * 1024 + 1);
  });

  it('truncates long files at MAX_DISPLAY_LINES and reports totalLines', async () => {
    const totalLines = MAX_DISPLAY_LINES + 500;
    const text = Array.from({ length: totalLines }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(repoPath, 'long.txt'), text);
    const file = await readFileForDisplay(repoPath, 'long.txt');
    expect(file.truncated).toBe(true);
    expect(file.content.split('\n')).toHaveLength(MAX_DISPLAY_LINES);
    expect(file.totalLines).toBe(totalLines);
    expect(file.content).not.toContain('truncated'); // flags, not prose
  });

  it('rejects a missing file with an fs error', async () => {
    await expect(readFileForDisplay(repoPath, 'nope.txt')).rejects.toThrow();
  });

  it('rejects a directory with NotRegularFileError', async () => {
    await expect(readFileForDisplay(repoPath, 'src')).rejects.toThrow(NotRegularFileError);
  });

  it('rejects a FIFO with NotRegularFileError instead of blocking on read', async () => {
    // Opening a FIFO with no writer blocks forever; the stat-based guard
    // must refuse it before any read is attempted.
    const fifoPath = path.join(repoPath, 'pipe.fifo');
    execSync(`mkfifo "${fifoPath}"`);
    try {
      await expect(readFileForDisplay(repoPath, 'pipe.fifo')).rejects.toThrow(NotRegularFileError);
    } finally {
      fs.rmSync(fifoPath, { force: true });
    }
  });
});

describe('readFileForDisplay media verdicts', () => {
  it('reports an image with its dimensions, mime and a version key', async () => {
    writeBytes('logo.png', pngFile(64, 32, 128));
    const file = await readFileForDisplay(repoPath, 'logo.png');

    expect(file.binary).toBe(true);
    expect(file.content).toBe('');
    expect(file.tooLarge).toBe(false);
    expect(file.media?.image).toMatchObject({
      format: 'png',
      mime: 'image/png',
      width: 64,
      height: 32,
    });
    expect(file.media?.refusal).toBeNull();
    // size-mtime, so the blob URL changes the moment the bytes do.
    expect(file.media?.version).toMatch(/^\d+-\d/);
  });

  it('reports a GIF', async () => {
    writeBytes('dot.gif', GIF_1X1);
    const file = await readFileForDisplay(repoPath, 'dot.gif');
    expect(file.media?.image).toMatchObject({ format: 'gif', mime: 'image/gif' });
  });

  it('serves an image over the text cap instead of calling it too large', async () => {
    // The ordering regression: the size check used to run first, so every
    // image over 1 MiB came back tooLarge with no verdict and never rendered.
    const bytes = pngFile(800, 600, 1536 * 1024);
    writeBytes('big.png', bytes);
    const file = await readFileForDisplay(repoPath, 'big.png');

    expect(file.tooLarge).toBe(false);
    expect(file.binary).toBe(true);
    expect(file.size).toBe(bytes.length);
    expect(file.size).toBeGreaterThan(MAX_FILE_SIZE);
    expect(file.media?.image).toMatchObject({ width: 800, height: 600, bytes: bytes.length });
  });

  it('classifies a large image from a bounded window, not the whole file', async () => {
    const bytes = pngFile(800, 600, 3 * 1024 * 1024);
    writeBytes('huge.png', bytes);
    const { file, bytesRead } = await measureRead('huge.png');

    expect(file.media?.image).toMatchObject({ format: 'png' });
    expect(bytesRead).toBeLessThanOrEqual(IMAGE_HEADER_WINDOW);
    expect(bytesRead).toBeLessThan(bytes.length);
  });

  it('refuses a file past the image cap without opening it', async () => {
    fs.writeFileSync(path.join(repoPath, 'enormous.png'), pngFile(64, 32, MAX_IMAGE_BYTES));
    const { file, opens, bytesRead } = await measureRead('enormous.png');

    expect(file.tooLarge).toBe(true);
    expect(file.media).toBeUndefined();
    expect(opens).toBe(0);
    expect(bytesRead).toBe(0);
  });

  it('names a refusal for a known image format that is not served', async () => {
    writeBytes('shot.webp', webpFile());
    const file = await readFileForDisplay(repoPath, 'shot.webp');

    expect(file.binary).toBe(true);
    expect(file.media?.image).toBeNull();
    expect(file.media?.refusal).toBe('unsupported-format');
  });

  it('reports not-an-image for binary bytes with no image signature', async () => {
    writeBytes('data.bin', Buffer.from([0x01, 0x00, 0x02, 0x03]));
    const file = await readFileForDisplay(repoPath, 'data.bin');

    expect(file.binary).toBe(true);
    expect(file.media?.refusal).toBe('not-an-image');
  });

  it('ignores the extension: an SVG named .png stays text with no image', async () => {
    writeBytes('vector.png', Buffer.from('<svg xmlns="https://www.w3.org/2000/svg"></svg>\n'));
    const file = await readFileForDisplay(repoPath, 'vector.png');

    expect(file.binary).toBe(false);
    expect(file.media).toBeUndefined();
    expect(file.content).toContain('<svg');
  });

  it('still flags a large text file as too large, with no media verdict', async () => {
    // 'not-an-image' is what a big text file looks like to the sniffer, so it
    // must not ride along — a client reads any media as "this is not text".
    fs.writeFileSync(path.join(repoPath, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
    const file = await readFileForDisplay(repoPath, 'big.txt');

    expect(file.tooLarge).toBe(true);
    expect(file.content).toBe('');
    expect(file.media).toBeUndefined();
  });

  it('refuses an oversized GIF from the peek alone', async () => {
    // A GIF is decided on the whole file, so it has its own tighter cap. Past
    // it the answer is settled by the declared size, and reading megabytes to
    // be told so would be pure waste.
    const bytes = Buffer.concat([GIF_1X1, Buffer.alloc(3 * 1024 * 1024)]);
    writeBytes('huge.gif', bytes);
    const { file, bytesRead } = await measureRead('huge.gif');

    expect(file.media?.refusal).toBe('too-large');
    expect(bytesRead).toBeLessThanOrEqual(64);
  });

  it('keeps the refusal on a large file whose bytes said something', async () => {
    const bytes = Buffer.concat([webpFile(), Buffer.alloc(2 * 1024 * 1024)]);
    writeBytes('big.webp', bytes);
    const file = await readFileForDisplay(repoPath, 'big.webp');

    expect(file.tooLarge).toBe(true);
    expect(file.media?.refusal).toBe('unsupported-format');
  });
});
