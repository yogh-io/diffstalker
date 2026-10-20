import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  clearDefaultBaseCache,
  listWorktrees,
  parseWorktreePorcelain,
  pickDefaultWorktree,
  resolveGitDirs,
  type WorktreeInfo,
} from './worktree.js';
import { findDefaultBase } from './diff.js';
import { setCachedBaseBranch } from '../utils/baseBranchCache.js';
import { createFixtureRepo, gitExec, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

/** One recorded git call: the directory it ran in, then its argv. */
interface GitCall {
  cwd: string;
  args: string[];
}

/**
 * Run `body` with a `git` on PATH that records its cwd and argv, then execs
 * the real one. The spawn count is the only witness that a cached listing
 * ran no git for a worktree.
 */
async function withGitProbe(body: (calls: () => GitCall[]) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-worktree-probe-'));
  const logPath = path.join(dir, 'argv.log');
  const realGit = execSync('command -v git', { encoding: 'utf-8' }).trim();
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\0' '--call--' "$PWD" "$@" >> '${logPath}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  try {
    await body(() => readCalls(logPath));
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readCalls(logPath: string): GitCall[] {
  if (!fs.existsSync(logPath)) return [];
  const parts = fs.readFileSync(logPath, 'utf-8').split('\0');
  parts.pop();
  const calls: GitCall[] = [];
  for (const part of parts) {
    if (part === '--call--') calls.push({ cwd: '', args: [] });
    else if (calls[calls.length - 1].cwd === '') calls[calls.length - 1].cwd = part;
    else calls[calls.length - 1].args.push(part);
  }
  return calls;
}

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
    return {
      path: worktreePath,
      branch: name,
      head: 'abc123',
      isBare: false,
      lastActivity: null,
      aheadOfBase: null,
    };
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
      {
        path: oldDir,
        branch: 'old',
        head: 'a',
        isBare: false,
        lastActivity: null,
        aheadOfBase: null,
      },
      {
        path: newDir,
        branch: 'new',
        head: 'b',
        isBare: false,
        lastActivity: null,
        aheadOfBase: null,
      },
    ];
    expect(pickDefaultWorktree(entries)?.path).toBe(newDir);
  });

  it('returns null for an empty list or bare-only list', () => {
    expect(pickDefaultWorktree([])).toBeNull();
    expect(
      pickDefaultWorktree([
        {
          path: '/x/.bare',
          branch: null,
          head: null,
          isBare: true,
          lastActivity: null,
          aheadOfBase: null,
        },
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
  let repoPath: string;
  let linkedPath: string;
  let upstreamTip: string;

  function commit(dir: string, file: string): string {
    writeFixtureFile(dir, file, `${file}\n`);
    gitExec(dir, `add ${file}`);
    gitExec(dir, `commit -m "${file}"`);
    return gitExec(dir, 'rev-parse HEAD').trim();
  }

  /**
   * Main worktree: `feature`, one commit past origin/main. Linked worktree:
   * `on-fork`, one commit past fork/main (and two past origin/main).
   */
  beforeEach(() => {
    clearDefaultBaseCache();
    repoPath = createFixtureRepo(REPO_NAME);
    const root = commit(repoPath, 'root.txt');
    upstreamTip = commit(repoPath, 'upstream.txt');
    gitExec(repoPath, `checkout -q -b fork-main ${root}`);
    const forkTip = commit(repoPath, 'fork.txt');
    for (const [remote, tip] of [
      ['origin', upstreamTip],
      ['fork', forkTip],
    ]) {
      gitExec(repoPath, `remote add ${remote} /nonexistent/${remote}.git`);
      gitExec(repoPath, `update-ref refs/remotes/${remote}/main ${tip}`);
    }
    gitExec(repoPath, `checkout -q -b feature ${upstreamTip}`);
    commit(repoPath, 'feature.txt');
    linkedPath = path.join(repoPath, '..', LINKED_NAME);
    gitExec(repoPath, `worktree add -q -b on-fork "${linkedPath}" ${forkTip}`);
    commit(linkedPath, 'on-fork.txt');
  });

  afterEach(() => {
    removeFixtureRepo(REPO_NAME);
    removeFixtureRepo(LINKED_NAME);
    clearDefaultBaseCache();
  });

  async function aheadByBranch(): Promise<Map<string | null, number | null>> {
    const worktrees = await listWorktrees(repoPath);
    return new Map(worktrees.map((wt) => [wt.branch, wt.aheadOfBase]));
  }

  /** The uncached answer, one findDefaultBase per worktree. */
  async function uncachedAheadByBranch(): Promise<Map<string | null, number | null>> {
    const worktrees = await listWorktrees(repoPath);
    const entries = await Promise.all(
      worktrees.map(
        async (wt) => [wt.branch, (await findDefaultBase(wt.path))?.ahead ?? null] as const
      )
    );
    return new Map(entries);
  }

  /** The git subcommand of a call, past the `-c key=value` pairs. */
  function subcommand(call: GitCall): string {
    const at = call.args.findIndex((a, i) => !a.startsWith('-') && call.args[i - 1] !== '-c');
    return call.args[at];
  }

  function revListCalls(calls: GitCall[]): GitCall[] {
    return calls.filter((c) => subcommand(c) === 'rev-list');
  }

  it('each worktree counts against the default base of its own HEAD', async () => {
    const ahead = await aheadByBranch();
    expect(ahead.get('feature')).toBe(1);
    expect(ahead.get('on-fork')).toBe(1);
  });

  it('a second listing with nothing moved runs no git per worktree', async () => {
    await withGitProbe(async (calls) => {
      const first = await aheadByBranch();
      expect(revListCalls(calls()).length).toBeGreaterThan(0);
      const before = calls().length;

      const second = await aheadByBranch();
      const added = calls().slice(before);
      expect(revListCalls(added)).toEqual([]);
      // Only the family-wide reads: worktree list, remote, for-each-ref.
      expect(added.map(subcommand)).toEqual(['worktree', 'remote', 'for-each-ref']);
      expect(second).toEqual(first);
    });
  });

  it('a new commit on one worktree recounts that worktree only', async () => {
    await withGitProbe(async (calls) => {
      await aheadByBranch();
      const before = calls().length;

      commit(linkedPath, 'more.txt');
      const ahead = await aheadByBranch();
      expect(ahead.get('on-fork')).toBe(2);
      expect(ahead.get('feature')).toBe(1);
      const recounted = new Set(
        revListCalls(calls().slice(before)).map((c) => fs.realpathSync(c.cwd))
      );
      expect(recounted).toEqual(new Set([fs.realpathSync(linkedPath)]));
    });
  });

  it('a mainline ref that moved recounts every worktree', async () => {
    await withGitProbe(async (calls) => {
      await aheadByBranch();
      const before = calls().length;

      // origin/main catches up to feature: feature is 0 ahead of it, and
      // on-fork now counts 1 against fork/main as before.
      const featureTip = gitExec(repoPath, 'rev-parse HEAD').trim();
      gitExec(repoPath, `update-ref refs/remotes/origin/main ${featureTip}`);
      const ahead = await aheadByBranch();
      expect(ahead.get('feature')).toBe(0);
      expect(ahead.get('on-fork')).toBe(1);
      const recounted = new Set(
        revListCalls(calls().slice(before)).map((c) => fs.realpathSync(c.cwd))
      );
      expect(recounted).toEqual(new Set([fs.realpathSync(repoPath), fs.realpathSync(linkedPath)]));
    });
  });

  it('cached and uncached listings agree, before and after a move', async () => {
    expect(await aheadByBranch()).toEqual(await uncachedAheadByBranch());
    commit(repoPath, 'again.txt');
    gitExec(repoPath, `update-ref refs/remotes/fork/main ${upstreamTip}`);
    expect(await aheadByBranch()).toEqual(await uncachedAheadByBranch());
    expect(await aheadByBranch()).toEqual(await uncachedAheadByBranch());
  });

  it('a persisted base choice is counted every time, never from the cache', async () => {
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-worktree-xdg-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      await aheadByBranch();
      setCachedBaseBranch(linkedPath, 'origin/main');
      await withGitProbe(async (calls) => {
        const ahead = await aheadByBranch();
        expect(ahead.get('on-fork')).toBe(2);
        expect(ahead.get('feature')).toBe(1);
        const counted = revListCalls(calls());
        expect(counted.map((c) => fs.realpathSync(c.cwd))).toEqual([fs.realpathSync(linkedPath)]);
        expect(counted[0].args).toContain('origin/main..HEAD');
      });
    } finally {
      fs.rmSync(cacheHome, { recursive: true, force: true });
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
    }
  });

  it('an unborn worktree (zero oid) has no count and runs no git for one', async () => {
    const orphanPath = path.join(repoPath, '..', `${LINKED_NAME}-orphan`);
    gitExec(repoPath, `worktree add -q --orphan -b orphan "${orphanPath}"`);
    try {
      await withGitProbe(async (calls) => {
        const first = await listWorktrees(repoPath);
        const orphan = first.find((wt) => wt.branch === 'orphan');
        expect(orphan?.head).toMatch(/^0+$/);
        expect(orphan?.aheadOfBase).toBeNull();
        const counted = revListCalls(calls()).map((c) => fs.realpathSync(c.cwd));
        expect(counted).not.toContain(fs.realpathSync(orphanPath));
      });
    } finally {
      fs.rmSync(orphanPath, { recursive: true, force: true });
    }
  });
});
