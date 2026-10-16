import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  listWorktrees,
  parseWorktreePorcelain,
  pickDefaultWorktree,
  resolveGitDirs,
  type WorktreeInfo,
} from './worktree.js';
import { createFixtureRepo, gitExec, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

describe('parseWorktreePorcelain', () => {
  it('parses a bare-repo layout with several worktrees', () => {
    const output = [
      'worktree /repo/.bare',
      'bare',
      '',
      'worktree /repo/main',
      'HEAD 54a99695f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature',
      'HEAD ab9371014d0000000000000000000000000000000',
      'branch refs/heads/feature',
      '',
      'worktree /repo/detached',
      'HEAD 4fa2f4b2ed0000000000000000000000000000000',
      'detached',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(output);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      path: '/repo/.bare',
      branch: null,
      head: null,
      isBare: true,
      // git lists the main worktree first — here the bare git dir itself.
      isMain: true,
    });
    expect(result[1]).toMatchObject({ path: '/repo/main', branch: 'main', isBare: false });
    expect(result[2]).toMatchObject({ path: '/repo/feature', branch: 'feature' });
    // A detached worktree keeps its HEAD but has no branch.
    expect(result[3]).toMatchObject({ path: '/repo/detached', branch: null, isBare: false });
    expect(result[3].head).toBe('4fa2f4b2ed0000000000000000000000000000000');
  });

  it('parses a single non-bare worktree without a trailing blank line', () => {
    const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main'].join('\n');
    const result = parseWorktreePorcelain(output);
    expect(result).toEqual([
      { path: '/repo', branch: 'main', head: 'abc123', isBare: false, isMain: true },
    ]);
  });

  it('returns an empty array for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('pickDefaultWorktree', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Create a fake linked worktree: a working dir whose `.git` file points at
   * a gitdir under `<root>/.bare/worktrees/<name>` containing an index whose
   * mtime is `indexAgeMs` in the past.
   */
  function makeWorktree(name: string, indexAgeMs: number): WorktreeInfo {
    const worktreePath = path.join(root, name);
    const gitDir = path.join(root, '.bare', 'worktrees', name);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'index'), '');
    const mtime = new Date(Date.now() - indexAgeMs);
    fs.utimesSync(path.join(gitDir, 'index'), mtime, mtime);
    return { path: worktreePath, branch: name, head: 'abc123', isBare: false, lastActivity: null, aheadOfBase: null };
  }

  it('picks the worktree with the most recent git index activity', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-wt-'));
    const stale = makeWorktree('stale', 60 * 60 * 1000);
    const fresh = makeWorktree('fresh', 0);
    const older = makeWorktree('older', 24 * 60 * 60 * 1000);

    expect(pickDefaultWorktree([stale, fresh, older])).toBe(fresh);
  });

  it('skips bare entries', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-wt-'));
    const only = makeWorktree('only', 0);
    const bare: WorktreeInfo = {
      path: path.join(root, '.bare'),
      branch: null,
      head: null,
      isBare: true,
      lastActivity: null,
      aheadOfBase: null,
    };

    expect(pickDefaultWorktree([bare, only])).toBe(only);
  });

  it('falls back to the working directory mtime when there is no git dir', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-wt-'));
    // No .git at all — only the directories themselves exist.
    const oldDir = path.join(root, 'old');
    const newDir = path.join(root, 'new');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(newDir);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(oldDir, past, past);

    const entries: WorktreeInfo[] = [
      { path: oldDir, branch: 'old', head: 'a', isBare: false, lastActivity: null, aheadOfBase: null },
      { path: newDir, branch: 'new', head: 'b', isBare: false, lastActivity: null, aheadOfBase: null },
    ];
    expect(pickDefaultWorktree(entries)?.path).toBe(newDir);
  });

  it('returns null for an empty list or bare-only list', () => {
    expect(pickDefaultWorktree([])).toBeNull();
    expect(
      pickDefaultWorktree([
        { path: '/x/.bare', branch: null, head: null, isBare: true, lastActivity: null, aheadOfBase: null },
      ])
    ).toBeNull();
  });
});

describe('resolveGitDirs', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a plain repo: gitDir and commonDir are both <repo>/.git', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-gd-'));
    const repo = path.join(root, 'repo');
    const gitDir = path.join(repo, '.git');
    fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });

    expect(resolveGitDirs(repo)).toEqual({ gitDir, commonDir: gitDir });
  });

  it('a linked worktree: per-worktree gitDir, shared commonDir via commondir', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-gd-'));
    const wt = path.join(root, 'fix-a');
    const bare = path.join(root, '.bare');
    const gitDir = path.join(bare, 'worktrees', 'fix-a');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    // .git is a POINTER FILE, not a dir; commondir names the shared dir.
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');

    expect(resolveGitDirs(wt)).toEqual({ gitDir, commonDir: bare });
  });

  it('returns null for a non-repo directory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-gd-'));
    expect(resolveGitDirs(root)).toBeNull();
  });
});

describe('listWorktrees aheadOfBase (fixture)', () => {
  const REPO_NAME = 'worktree-ahead-test';
  const LINKED_NAME = `${REPO_NAME}-linked`;

  afterEach(() => {
    removeFixtureRepo(REPO_NAME);
    removeFixtureRepo(LINKED_NAME);
  });

  function commit(repoPath: string, file: string): string {
    writeFixtureFile(repoPath, file, `${file}\n`);
    gitExec(repoPath, `add ${file}`);
    gitExec(repoPath, `commit -m "${file}"`);
    return gitExec(repoPath, 'rev-parse HEAD').trim();
  }

  it('each worktree counts against the default base of its own HEAD', async () => {
    const repoPath = createFixtureRepo(REPO_NAME);
    const root = commit(repoPath, 'root.txt');
    const upstreamTip = commit(repoPath, 'upstream.txt');
    gitExec(repoPath, `checkout -q -b fork-main ${root}`);
    const forkTip = commit(repoPath, 'fork.txt');
    for (const [remote, tip] of [['origin', upstreamTip], ['fork', forkTip]]) {
      gitExec(repoPath, `remote add ${remote} /nonexistent/${remote}.git`);
      gitExec(repoPath, `update-ref refs/remotes/${remote}/main ${tip}`);
    }

    // Main worktree: a branch cut from origin/main.
    gitExec(repoPath, `checkout -q -b feature ${upstreamTip}`);
    commit(repoPath, 'feature.txt');
    // Linked worktree: a branch cut from fork/main. Against origin/main it
    // would count 2 (fork.txt and its own commit).
    const linkedPath = path.join(repoPath, '..', LINKED_NAME);
    gitExec(repoPath, `worktree add -q -b on-fork "${linkedPath}" ${forkTip}`);
    commit(linkedPath, 'on-fork.txt');

    const worktrees = await listWorktrees(repoPath);
    const ahead = new Map(worktrees.map((wt) => [wt.branch, wt.aheadOfBase]));
    expect(ahead.get('feature')).toBe(1);
    expect(ahead.get('on-fork')).toBe(1);
  });
});
