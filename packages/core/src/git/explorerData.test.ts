import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildGitStatusMap,
  listDirectory,
  readFileForDisplay,
  MAX_DISPLAY_LINES,
  NotRegularFileError,
} from './explorerData.js';
import { getStatus } from './status.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'explorer-data-test';
let repoPath: string;

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
