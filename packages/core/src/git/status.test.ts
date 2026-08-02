import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseStatusCode,
  isUnmergedPair,
  parseNumstat,
  getStatus,
  stageFile,
  unstageFile,
  stageAll,
  unstageAll,
  discardChanges,
  getHeadMessage,
  getCommitHistory,
  switchBranch,
  createBranch,
  cherryPick,
  revertCommit,
  commit,
  stashPop,
  getInProgressOperation,
  abortOperation,
  rebaseContinue,
} from './status.js';
import type { GitStatus } from './status.js';
import { MAX_FILE_DIFF_BYTES } from './diffParse.js';
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

  it('parses U as conflicted', () => {
    expect(parseStatusCode('U')).toBe('conflicted');
  });

  it('returns modified for unknown codes', () => {
    expect(parseStatusCode('X')).toBe('modified');
    expect(parseStatusCode('')).toBe('modified');
  });
});

describe('isUnmergedPair', () => {
  it('matches every porcelain code pair git uses for an unmerged path', () => {
    for (const pair of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      expect(isUnmergedPair(pair[0], pair[1])).toBe(true);
    }
  });

  it('leaves ordinary code pairs alone', () => {
    // Including the two that share a letter with an unmerged pair but are
    // not one: a staged add ('A ') and a staged delete ('D ').
    for (const pair of ['M ', ' M', 'MM', 'A ', 'AM', 'D ', ' D', '??', 'R ', 'C ', '  ']) {
      expect(isUnmergedPair(pair[0], pair[1])).toBe(false);
    }
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

    it('records where a renamed file came from', async () => {
      gitExec(repoPath, 'mv initial.txt renamed.txt');
      const status = await getStatus(repoPath);
      const renamed = status.files.find((f) => f.path === 'renamed.txt' && f.staged);
      expect(renamed).toBeDefined();
      expect(renamed!.status).toBe('renamed');
      // `path` is already the new name, so this is the only route back to the
      // pre-rename blob — what the file lists' "<- old path" suffix and the
      // image diff's old side both need.
      expect(renamed!.originalPath).toBe('initial.txt');
      gitExec(repoPath, 'reset --hard HEAD');
      resetRepo();
    });

    it('leaves originalPath unset when nothing moved', async () => {
      writeFixtureFile(repoPath, 'initial.txt', 'edited\n');
      gitExec(repoPath, 'add initial.txt');
      const status = await getStatus(repoPath);
      const staged = status.files.find((f) => f.path === 'initial.txt' && f.staged);
      expect(staged!.originalPath).toBeUndefined();
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

    it('stages only a file named -u, not the whole tree (no arg injection)', async () => {
      // A tracked file with unstaged modifications that '-u' WOULD stage
      // if the path were read as a flag (git add -u = update tracked files)
      writeFixtureFile(repoPath, 'initial.txt', 'bystander edit\n');
      // The hostile path: an untracked file literally named '-u'
      writeFixtureFile(repoPath, '-u', 'flag-named file\n');

      await stageFile(repoPath, '-u');

      const status = await getStatus(repoPath);
      expect(status.files.some((f) => f.path === '-u' && f.staged)).toBe(true);
      // The bystander must remain unstaged
      const bystander = status.files.find((f) => f.path === 'initial.txt' && f.staged);
      expect(bystander).toBeUndefined();

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

/**
 * Fresh single-commit repo for the guard/recovery tests below. Each test
 * gets its own so a wedged state can never leak between tests.
 */
function makeGuardRepo(name: string): string {
  removeFixtureRepo(name);
  const repoPath = createFixtureRepo(name);
  writeFixtureFile(repoPath, 'base.txt', 'line one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');
  return repoPath;
}

describe('flag injection guards (fixture)', () => {
  it('switchBranch refuses a flag-shaped name and the working tree survives', async () => {
    const name = 'status-guard-switch';
    const repoPath = makeGuardRepo(name);
    try {
      // Uncommitted work that `git checkout -f` would have destroyed.
      writeFixtureFile(repoPath, 'base.txt', 'precious uncommitted change\n');

      await expect(switchBranch(repoPath, '-f')).rejects.toThrow();
      await expect(switchBranch(repoPath, '--detach')).rejects.toThrow();

      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe(
        'precious uncommitted change\n'
      );
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('createBranch refuses flag-shaped names', async () => {
    const name = 'status-guard-create';
    const repoPath = makeGuardRepo(name);
    try {
      await expect(createBranch(repoPath, '-f')).rejects.toThrow();
      await expect(createBranch(repoPath, '--detach')).rejects.toThrow();
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
      // And a legitimate name still works.
      expect(await createBranch(repoPath, 'feat-ok')).toBe('Created feat-ok');
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('feat-ok');
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('cherryPick and revertCommit refuse flag-shaped hashes', async () => {
    const name = 'status-guard-pick';
    const repoPath = makeGuardRepo(name);
    try {
      await expect(cherryPick(repoPath, '--abort')).rejects.toThrow();
      await expect(revertCommit(repoPath, '-n')).rejects.toThrow();
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
    } finally {
      removeFixtureRepo(name);
    }
  });
});

describe('commit failure surfacing (fixture)', () => {
  it('throws when there is nothing to commit instead of reporting success', async () => {
    const name = 'status-guard-emptycommit';
    const repoPath = makeGuardRepo(name);
    try {
      await expect(commit(repoPath, 'phantom commit')).rejects.toThrow(/nothing to commit/i);
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('still commits normally when changes are staged', async () => {
    const name = 'status-guard-realcommit';
    const repoPath = makeGuardRepo(name);
    try {
      writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\n');
      gitExec(repoPath, 'add base.txt');
      await commit(repoPath, 'real commit');
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toBe('real commit');
    } finally {
      removeFixtureRepo(name);
    }
  });
});

describe('stashPop conflict detection (fixture)', () => {
  it('throws on a conflicting pop and git keeps the stash entry', async () => {
    const name = 'status-guard-stashpop';
    const repoPath = makeGuardRepo(name);
    try {
      writeFixtureFile(repoPath, 'base.txt', 'stashed version\n');
      gitExec(repoPath, 'stash push -m "wip"');
      writeFixtureFile(repoPath, 'base.txt', 'committed version\n');
      gitExec(repoPath, 'commit -am "diverge"');

      await expect(stashPop(repoPath)).rejects.toThrow(/conflict/i);
      expect(gitExec(repoPath, 'stash list')).toContain('wip');
    } finally {
      removeFixtureRepo(name);
    }
  });
});

describe('unmerged paths (fixture)', () => {
  it('reports both sides of a UU conflict as conflicted', async () => {
    const name = 'status-conflict-uu';
    const repoPath = makeGuardRepo(name);
    try {
      gitExec(repoPath, 'checkout -b side');
      writeFixtureFile(repoPath, 'base.txt', 'side version\n');
      gitExec(repoPath, 'commit -am "side version"');
      gitExec(repoPath, 'checkout main');
      writeFixtureFile(repoPath, 'base.txt', 'main version\n');
      gitExec(repoPath, 'commit -am "main version"');
      expect(() => gitExec(repoPath, 'merge side')).toThrow();
      expect(gitExec(repoPath, 'status --porcelain')).toContain('UU base.txt');

      const status = await getStatus(repoPath);
      const entries = status.files.filter((f) => f.path === 'base.txt');
      // Two entries per unmerged path on purpose (index side + worktree
      // side) — the file lists count on that shape.
      expect(entries.length).toBe(2);
      expect(entries.map((f) => f.status)).toEqual(['conflicted', 'conflicted']);
      expect(entries.map((f) => f.staged).sort()).toEqual([false, true]);
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('reports an AA conflict as conflicted even though neither column is U', async () => {
    const name = 'status-conflict-aa';
    const repoPath = makeGuardRepo(name);
    try {
      gitExec(repoPath, 'checkout -b side');
      writeFixtureFile(repoPath, 'both.txt', 'side version\n');
      gitExec(repoPath, 'add both.txt');
      gitExec(repoPath, 'commit -m "side adds both.txt"');
      gitExec(repoPath, 'checkout main');
      writeFixtureFile(repoPath, 'both.txt', 'main version\n');
      gitExec(repoPath, 'add both.txt');
      gitExec(repoPath, 'commit -m "main adds both.txt"');
      expect(() => gitExec(repoPath, 'merge side')).toThrow();
      expect(gitExec(repoPath, 'status --porcelain')).toContain('AA both.txt');

      const status = await getStatus(repoPath);
      const entries = status.files.filter((f) => f.path === 'both.txt');
      expect(entries.length).toBe(2);
      expect(entries.map((f) => f.status)).toEqual(['conflicted', 'conflicted']);
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('leaves an ordinary partially staged file unconflicted', async () => {
    const name = 'status-conflict-none';
    const repoPath = makeGuardRepo(name);
    try {
      writeFixtureFile(repoPath, 'base.txt', 'staged edit\n');
      gitExec(repoPath, 'add base.txt');
      writeFixtureFile(repoPath, 'base.txt', 'staged edit\nplus unstaged\n');

      const status = await getStatus(repoPath);
      const entries = status.files.filter((f) => f.path === 'base.txt');
      expect(entries.length).toBe(2);
      expect(entries.map((f) => f.status)).toEqual(['modified', 'modified']);
    } finally {
      removeFixtureRepo(name);
    }
  });
});

describe('untracked line counting size cap (fixture)', () => {
  const NAME = 'status-untracked-cap';
  let repoPath: string;

  beforeAll(() => {
    repoPath = makeGuardRepo(NAME);
  });

  afterAll(() => {
    removeFixtureRepo(NAME);
  });

  /**
   * Run getStatus with fs.promises.readFile wrapped, so a test can prove
   * which untracked files were pulled off disk. The reported stats alone
   * cannot tell "refused to read" from "read and found nothing".
   */
  async function measureStatus(): Promise<{ status: GitStatus; readPaths: string[] }> {
    type ReadFn = typeof fs.promises.readFile;
    const realReadFile: ReadFn = fs.promises.readFile;
    const readPaths: string[] = [];
    const wrapped = ((...args: Parameters<ReadFn>) => {
      readPaths.push(String(args[0]));
      return realReadFile(...args);
    }) as ReadFn;

    (fs.promises as { readFile: ReadFn }).readFile = wrapped;
    try {
      const status = await getStatus(repoPath);
      return { status, readPaths };
    } finally {
      (fs.promises as { readFile: ReadFn }).readFile = realReadFile;
    }
  }

  it('counts the lines of a small untracked file', async () => {
    writeFixtureFile(repoPath, 'small.txt', 'one\ntwo\nthree\n');
    const { status, readPaths } = await measureStatus();

    const entry = status.files.find((f) => f.path === 'small.txt');
    expect(entry!.status).toBe('untracked');
    expect(entry!.insertions).toBe(3);
    expect(entry!.deletions).toBe(0);
    expect(readPaths.some((p) => p.endsWith('small.txt'))).toBe(true);
  });

  it('never reads an untracked file over the cap and reports no line count', async () => {
    writeFixtureFile(repoPath, 'huge.txt', 'x\n'.repeat(MAX_FILE_DIFF_BYTES));
    const { status, readPaths } = await measureStatus();

    expect(readPaths.some((p) => p.endsWith('huge.txt'))).toBe(false);
    const entry = status.files.find((f) => f.path === 'huge.txt');
    expect(entry!.status).toBe('untracked');
    // Absent, not zero: we refused to read it, so the count is unknown.
    expect(entry!.insertions).toBeUndefined();
    expect(entry!.deletions).toBeUndefined();
  });
});

describe('in-progress operation detection and recovery (fixture)', () => {
  it('reports null on a clean repo', async () => {
    const name = 'status-guard-clean';
    const repoPath = makeGuardRepo(name);
    try {
      expect(await getInProgressOperation(repoPath)).toBeNull();
      await expect(abortOperation(repoPath)).rejects.toThrow(/no operation in progress/i);
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('detects and aborts a conflicted cherry-pick', async () => {
    const name = 'status-guard-pickabort';
    const repoPath = makeGuardRepo(name);
    try {
      gitExec(repoPath, 'checkout -b other');
      writeFixtureFile(repoPath, 'base.txt', 'other version\n');
      gitExec(repoPath, 'commit -am "other version"');
      const otherHash = gitExec(repoPath, 'rev-parse HEAD').trim();
      gitExec(repoPath, 'checkout main');
      writeFixtureFile(repoPath, 'base.txt', 'main version\n');
      gitExec(repoPath, 'commit -am "main version"');

      await expect(cherryPick(repoPath, otherHash)).rejects.toThrow(/conflict/i);
      expect(await getInProgressOperation(repoPath)).toBe('cherry-pick');

      expect(await abortOperation(repoPath)).toBe('Aborted cherry-pick');
      expect(await getInProgressOperation(repoPath)).toBeNull();
      expect(gitExec(repoPath, 'status --porcelain').trim()).toBe('');
    } finally {
      removeFixtureRepo(name);
    }
  });

  it('detects a conflicted rebase; rebaseContinue finishes it after resolution', async () => {
    const name = 'status-guard-rebase';
    const repoPath = makeGuardRepo(name);
    try {
      gitExec(repoPath, 'checkout -b side');
      writeFixtureFile(repoPath, 'base.txt', 'side version\n');
      gitExec(repoPath, 'commit -am "side version"');
      gitExec(repoPath, 'checkout main');
      writeFixtureFile(repoPath, 'base.txt', 'main version\n');
      gitExec(repoPath, 'commit -am "main version"');
      gitExec(repoPath, 'checkout side');

      expect(() => gitExec(repoPath, 'rebase main')).toThrow();
      expect(await getInProgressOperation(repoPath)).toBe('rebase');

      writeFixtureFile(repoPath, 'base.txt', 'merged version\n');
      gitExec(repoPath, 'add base.txt');
      expect(await rebaseContinue(repoPath)).toBe('Rebase continued');

      expect(await getInProgressOperation(repoPath)).toBeNull();
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('side');
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toBe('side version');
    } finally {
      removeFixtureRepo(name);
    }
  });
});
