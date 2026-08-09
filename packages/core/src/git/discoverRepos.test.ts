import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverRepos, readHeadBranch } from './discoverRepos.js';

/**
 * The scanner never runs git, so the fixtures don't either: a `.git`
 * directory with a HEAD file is exactly what it looks at.
 */
let root: string;

function makeRepo(dir: string, head: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
  return dir;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-discover-'));

  makeRepo(path.join(root, 'alpha'), 'ref: refs/heads/main\n');
  makeRepo(path.join(root, 'beta'), 'ref: refs/heads/feat/nested-name\n');
  // Detached HEAD.
  makeRepo(path.join(root, 'gamma'), '0123456789abcdef0123456789abcdef01234567\n');
  // One level deeper, inside a plain grouping directory.
  makeRepo(path.join(root, 'work', 'delta'), 'ref: refs/heads/main\n');
  // Nested inside a repo: must NOT be reported (submodule / vendored copy).
  makeRepo(path.join(root, 'alpha', 'inner'), 'ref: refs/heads/main\n');
  // Skipped by name.
  makeRepo(path.join(root, 'node_modules', 'pkg'), 'ref: refs/heads/main\n');
  makeRepo(path.join(root, '.hidden'), 'ref: refs/heads/main\n');
  // A plain directory with nothing in it.
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });

  // A linked worktree: `.git` is a file pointing at the real git dir.
  const linked = path.join(root, 'alpha-fix');
  fs.mkdirSync(linked, { recursive: true });
  const gitDir = path.join(root, 'alpha', '.git', 'worktrees', 'alpha-fix');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/fix\n');
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${gitDir}\n`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('discoverRepos', () => {
  it('finds direct children and one level deeper, and stops at a repo', async () => {
    const result = await discoverRepos(root);
    const names = result.repos.map((repo) => repo.name).sort();

    expect(names).toEqual(['alpha', 'alpha-fix', 'beta', 'delta', 'gamma']);
    expect(result.capped).toBe(false);
  });

  it('reads the branch from HEAD, short sha when detached', async () => {
    const { repos } = await discoverRepos(root);
    const byName = new Map(repos.map((repo) => [repo.name, repo.branch]));

    expect(byName.get('alpha')).toBe('main');
    expect(byName.get('beta')).toBe('feat/nested-name');
    expect(byName.get('gamma')).toBe('0123456');
    // A linked worktree's HEAD lives in the git dir its .git file names.
    expect(byName.get('alpha-fix')).toBe('fix');
  });

  it('reports last activity, so a client can rank recent work first', async () => {
    const { repos } = await discoverRepos(root);
    const alpha = repos.find((repo) => repo.name === 'alpha');
    // The fixture wrote .git/HEAD moments ago.
    expect(alpha?.lastActivity).toBeGreaterThan(Date.now() - 60_000);
  });

  it('drops a leftover worktree directory whose git dir was pruned', async () => {
    const stale = path.join(root, 'stale-worktree');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(
      path.join(stale, '.git'),
      `gitdir: ${path.join(root, 'alpha', '.git', 'worktrees', 'pruned')}\n`
    );
    try {
      const { repos } = await discoverRepos(root);
      expect(repos.map((repo) => repo.name)).not.toContain('stale-worktree');
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it('depth 1 looks at direct children only', async () => {
    const { repos } = await discoverRepos(root, { depth: 1 });
    expect(repos.map((repo) => repo.name)).not.toContain('delta');
    expect(repos.map((repo) => repo.name)).toContain('alpha');
  });

  it('reports capped instead of silently truncating', async () => {
    const result = await discoverRepos(root, { limit: 2 });
    expect(result.repos).toHaveLength(2);
    expect(result.capped).toBe(true);
  });

  it('throws for an unreadable root', async () => {
    await expect(discoverRepos(path.join(root, 'no-such-dir'))).rejects.toThrow();
  });

  it('returns an empty list for a root with nothing in it', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-empty-'));
    try {
      expect(await discoverRepos(empty)).toEqual({ repos: [], capped: false });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('readHeadBranch', () => {
  it('is null for a directory that is not a repo', async () => {
    expect(await readHeadBranch(path.join(root, 'notes'))).toBe(null);
  });

  it('is null when HEAD is in a shape we do not parse', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-odd-'));
    try {
      makeRepo(dir, 'ref: refs/remotes/origin/main\n');
      expect(await readHeadBranch(dir)).toBe(null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
