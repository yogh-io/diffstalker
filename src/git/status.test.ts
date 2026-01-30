import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseStatusCode,
  parseNumstat,
  getStatus,
  stageFile,
  unstageFile,
  stageAll,
  unstageAll,
  discardChanges,
  getHeadMessage,
  getCommitHistory,
} from './status.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

describe('parseStatusCode', () => {
  it('parses M as modified', () => {
    expect(parseStatusCode('M')).toBe('modified');
  });

  it('parses A as added', () => {
    expect(parseStatusCode('A')).toBe('added');
  });

  it('parses D as deleted', () => {
    expect(parseStatusCode('D')).toBe('deleted');
  });

  it('parses ? as untracked', () => {
    expect(parseStatusCode('?')).toBe('untracked');
  });

  it('parses R as renamed', () => {
    expect(parseStatusCode('R')).toBe('renamed');
  });

  it('parses C as copied', () => {
    expect(parseStatusCode('C')).toBe('copied');
  });

  it('returns modified for unknown codes', () => {
    expect(parseStatusCode('U')).toBe('modified');
    expect(parseStatusCode('X')).toBe('modified');
    expect(parseStatusCode('')).toBe('modified');
  });
});

describe('parseNumstat', () => {
  it('parses single file numstat', () => {
    const result = parseNumstat('10\t5\tfile.ts');
    expect(result.get('file.ts')).toEqual({ insertions: 10, deletions: 5 });
  });

  it('parses multiple files', () => {
    const output = `10\t5\tfile1.ts
20\t3\tfile2.ts
1\t0\tfile3.ts`;
    const result = parseNumstat(output);

    expect(result.size).toBe(3);
    expect(result.get('file1.ts')).toEqual({ insertions: 10, deletions: 5 });
    expect(result.get('file2.ts')).toEqual({ insertions: 20, deletions: 3 });
    expect(result.get('file3.ts')).toEqual({ insertions: 1, deletions: 0 });
  });

  it('handles binary files (marked with -)', () => {
    const result = parseNumstat('-\t-\timage.png');
    expect(result.get('image.png')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('handles empty output', () => {
    const result = parseNumstat('');
    expect(result.size).toBe(0);
  });

  it('handles output with only whitespace', () => {
    const result = parseNumstat('  \n  \n  ');
    expect(result.size).toBe(0);
  });

  it('handles paths with tabs', () => {
    const result = parseNumstat('5\t3\tpath\twith\ttabs.ts');
    expect(result.get('path\twith\ttabs.ts')).toEqual({ insertions: 5, deletions: 3 });
  });

  it('handles zero insertions and deletions', () => {
    const result = parseNumstat('0\t0\tfile.ts');
    expect(result.get('file.ts')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('handles large numbers', () => {
    const result = parseNumstat('1000\t500\tlarge.ts');
    expect(result.get('large.ts')).toEqual({ insertions: 1000, deletions: 500 });
  });

  it('skips malformed lines', () => {
    const output = `10\t5\tvalid.ts
malformed line
20\t3\talso-valid.ts`;
    const result = parseNumstat(output);

    expect(result.size).toBe(2);
    expect(result.has('valid.ts')).toBe(true);
    expect(result.has('also-valid.ts')).toBe(true);
  });
});

describe('git status operations (fixture)', () => {
  const REPO_NAME = 'status-ops-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'initial.txt', 'initial content\n');
    gitExec(repoPath, 'add initial.txt');
    gitExec(repoPath, 'commit -m "initial commit"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  /** Reset the working tree to a clean state between tests */
  function resetRepo(): void {
    gitExec(repoPath, 'checkout -- .');
    gitExec(repoPath, 'reset HEAD');
    // Remove any untracked files
    gitExec(repoPath, 'clean -fd');
  }

  describe('getStatus', () => {
    it('reports isRepo for a valid repo', async () => {
      const status = await getStatus(repoPath);
      expect(status.isRepo).toBe(true);
    });

    it('reports branch info', async () => {
      const status = await getStatus(repoPath);
      expect(status.branch.current).toBeTruthy();
    });

    it('detects modified files', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'modified content\n');
      const status = await getStatus(repoPath);
      const modified = status.files.find((f) => f.path === 'initial.txt' && !f.staged);
      expect(modified).toBeDefined();
      expect(modified!.status).toBe('modified');
      resetRepo();
    });

    it('detects untracked files', async () => {
      writeFixtureFile(repoPath, 'newfile.txt', 'new\n');
      const status = await getStatus(repoPath);
      const untracked = status.files.find((f) => f.path === 'newfile.txt');
      expect(untracked).toBeDefined();
      expect(untracked!.status).toBe('untracked');
      resetRepo();
    });

    it('detects staged files', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'staged content\n');
      gitExec(repoPath, 'add initial.txt');
      const status = await getStatus(repoPath);
      const staged = status.files.find((f) => f.path === 'initial.txt' && f.staged);
      expect(staged).toBeDefined();
      expect(staged!.status).toBe('modified');
      resetRepo();
    });

    it('returns isRepo false for non-repo path', async () => {
      const status = await getStatus('/tmp');
      expect(status.isRepo).toBe(false);
      expect(status.files).toEqual([]);
    });
  });

  describe('stageFile / unstageFile', () => {
    it('stages a specific file', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'to stage\n');
      await stageFile(repoPath, 'initial.txt');
      const status = await getStatus(repoPath);
      expect(status.files.some((f) => f.path === 'initial.txt' && f.staged)).toBe(true);
      resetRepo();
    });

    it('unstages a specific file', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'to unstage\n');
      gitExec(repoPath, 'add initial.txt');
      await unstageFile(repoPath, 'initial.txt');
      const status = await getStatus(repoPath);
      const staged = status.files.find((f) => f.path === 'initial.txt' && f.staged);
      expect(staged).toBeUndefined();
      resetRepo();
    });
  });

  describe('stageAll / unstageAll', () => {
    it('stages all changes', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'changed\n');
      writeFixtureFile(repoPath, 'another.txt', 'new file\n');
      await stageAll(repoPath);
      const status = await getStatus(repoPath);
      const staged = status.files.filter((f) => f.staged);
      expect(staged.length).toBeGreaterThanOrEqual(2);
      resetRepo();
    });

    it('unstages all changes', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'changed\n');
      gitExec(repoPath, 'add -A');
      await unstageAll(repoPath);
      const status = await getStatus(repoPath);
      const staged = status.files.filter((f) => f.staged);
      expect(staged.length).toBe(0);
      resetRepo();
    });
  });

  describe('discardChanges', () => {
    it('discards working directory changes for a file', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'temporary edit\n');
      await discardChanges(repoPath, 'initial.txt');
      const status = await getStatus(repoPath);
      const modified = status.files.find((f) => f.path === 'initial.txt');
      expect(modified).toBeUndefined();
    });
  });

  describe('getHeadMessage', () => {
    it('returns the latest commit message', async () => {
      const msg = await getHeadMessage(repoPath);
      expect(msg).toBe('initial commit');
    });
  });

  describe('getCommitHistory', () => {
    it('returns commit history', async () => {
      const history = await getCommitHistory(repoPath, 10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].message).toBe('initial commit');
      expect(history[0].hash).toBeTruthy();
      expect(history[0].author).toBe('Test User');
    });

    it('respects count limit', async () => {
      // Add a second commit
      writeFixtureFile(repoPath, 'second.txt', 'second\n');
      gitExec(repoPath, 'add second.txt');
      gitExec(repoPath, 'commit -m "second commit"');

      const one = await getCommitHistory(repoPath, 1);
      expect(one.length).toBe(1);
      expect(one[0].message).toBe('second commit');
    });
  });
});
