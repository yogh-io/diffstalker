import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawFromLines } from '../git/diffParse.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  countHunks,
  extractHunkPatch,
  getDiff,
  getDiffAgainstHead,
  getDiffForUntracked,
  getHeadOid,
  UNBORN_HEAD_OID,
  getCommitDiff,
  getCandidateBaseBranches,
  getDefaultBaseBranch,
  getCommitCountBetweenRefs,
  getDiffBetweenRefs,
  getCompareDiffWithUncommitted,
  commitExists,
  resolveEffectiveBaseBranch,
  NoCommonHistoryError,
} from './diff.js';
import { stageHunk, unstageHunk } from './status.js';
import { setCachedBaseBranch } from '../utils/baseBranchCache.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
  createRepoWithRemote,
  removeRepoWithRemote,
} from './test-helpers.js';

describe('getDiff / getDiffForUntracked (fixture)', () => {
  const REPO_NAME = 'diff-ops-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'file.txt', 'line1\nline2\nline3\n');
    gitExec(repoPath, 'add file.txt');
    gitExec(repoPath, 'commit -m "initial"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  function resetRepo(): void {
    gitExec(repoPath, 'checkout -- .');
    gitExec(repoPath, 'reset HEAD');
    gitExec(repoPath, 'clean -fd');
  }

  it('getDiff returns diff for unstaged changes', async () => {
    writeFixtureFile(repoPath, 'file.txt', 'line1\nmodified\nline3\n');
    const diff = await getDiff(repoPath, 'file.txt');
    expect(diff.lines.length).toBeGreaterThan(0);
    expect(diff.lines.some((l) => l.type === 'addition')).toBe(true);
    expect(diff.lines.some((l) => l.type === 'deletion')).toBe(true);
    resetRepo();
  });

  it('getDiff returns empty raw for clean file', async () => {
    const diff = await getDiff(repoPath, 'file.txt');
    expect(rawFromLines(diff.lines)).toBe('');
  });

  it('getDiffForUntracked shows entire file as additions', async () => {
    writeFixtureFile(repoPath, 'untracked.txt', 'hello\nworld\n');
    const diff = await getDiffForUntracked(repoPath, 'untracked.txt');
    expect(diff.lines.some((l) => l.type === 'header')).toBe(true);
    expect(diff.lines.some((l) => l.type === 'hunk')).toBe(true);
    const additions = diff.lines.filter((l) => l.type === 'addition');
    expect(additions.length).toBeGreaterThanOrEqual(2);
    resetRepo();
  });

  it('getDiffForUntracked: a trailing newline yields no phantom extra addition', async () => {
    writeFixtureFile(repoPath, 'nl.txt', 'a\nb\n');
    const diff = await getDiffForUntracked(repoPath, 'nl.txt');
    const additions = diff.lines.filter((l) => l.type === 'addition');
    expect(additions.map((l) => l.content)).toEqual(['+a', '+b']);
    expect(rawFromLines(diff.lines)).toContain('@@ -0,0 +1,2 @@');
    expect(rawFromLines(diff.lines)).not.toContain('No newline at end of file');
    resetRepo();
  });

  it('getDiffForUntracked: no trailing newline emits the "\\ No newline" marker', async () => {
    writeFixtureFile(repoPath, 'nonl.txt', 'a\nb');
    const diff = await getDiffForUntracked(repoPath, 'nonl.txt');
    const additions = diff.lines.filter((l) => l.type === 'addition');
    expect(additions.map((l) => l.content)).toEqual(['+a', '+b']);
    expect(rawFromLines(diff.lines)).toContain('@@ -0,0 +1,2 @@');
    expect(rawFromLines(diff.lines)).toContain('\\ No newline at end of file');
    resetRepo();
  });

  it('getDiffForUntracked: an empty file has headers but no hunk, like git', async () => {
    writeFixtureFile(repoPath, 'empty.txt', '');
    const diff = await getDiffForUntracked(repoPath, 'empty.txt');
    expect(diff.lines.some((l) => l.type === 'header')).toBe(true);
    expect(diff.lines.some((l) => l.type === 'hunk')).toBe(false);
    expect(diff.lines.filter((l) => l.type === 'addition')).toEqual([]);
    resetRepo();
  });

  /** A real 1x1 RGBA PNG — magic bytes, an IHDR and a NUL in the first bytes. */
  const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  function writeFixtureBytes(file: string, bytes: Buffer): void {
    fs.writeFileSync(path.join(repoPath, file), bytes);
  }

  it("getDiffForUntracked: a binary file gets git's marker, not a wall of additions", async () => {
    writeFixtureBytes('logo.png', Buffer.from(PNG_1X1_BASE64, 'base64'));
    const diff = await getDiffForUntracked(repoPath, 'logo.png');
    expect(diff.lines.map((l) => l.content)).toEqual([
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/logo.png differ',
    ]);
    // git emits no ---/+++ pair and no hunk for a binary file, and every
    // consumer keys off the marker line, so the shape has to match exactly.
    expect(diff.lines.every((l) => l.type === 'header')).toBe(true);
    expect(diff.lines.filter((l) => l.type === 'addition')).toEqual([]);
    resetRepo();
  });

  it('getDiffForUntracked: any file with a NUL is binary, whatever its name', async () => {
    // The verdict comes from the bytes, never the extension: a .txt full of
    // NULs is binary and a text file is text no matter what it is called.
    writeFixtureBytes('data.txt', Buffer.from([0x68, 0x69, 0x00, 0x21]));
    const binary = await getDiffForUntracked(repoPath, 'data.txt');
    expect(binary.lines.some((l) => l.content.startsWith('Binary files'))).toBe(true);

    writeFixtureFile(repoPath, 'notes.png', 'plain text\n');
    const text = await getDiffForUntracked(repoPath, 'notes.png');
    expect(text.lines.some((l) => l.content.startsWith('Binary files'))).toBe(false);
    expect(text.lines.filter((l) => l.type === 'addition').map((l) => l.content)).toEqual([
      '+plain text',
    ]);
    resetRepo();
  });

  it('getDiffForUntracked: non-ASCII text survives the byte read intact', async () => {
    // The read is a Buffer now; the text path decodes it. Multi-byte UTF-8
    // must come back through that decode unchanged.
    writeFixtureFile(repoPath, 'utf8.txt', 'héllo → wörld\n日本語\n');
    const diff = await getDiffForUntracked(repoPath, 'utf8.txt');
    expect(diff.lines.filter((l) => l.type === 'addition').map((l) => l.content)).toEqual([
      '+héllo → wörld',
      '+日本語',
    ]);
    resetRepo();
  });
});

describe('getCommitDiff (fixture)', () => {
  const REPO_NAME = 'commit-diff-test';
  let repoPath: string;
  let commitHash: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'file.txt', 'original\n');
    gitExec(repoPath, 'add file.txt');
    gitExec(repoPath, 'commit -m "first"');

    writeFixtureFile(repoPath, 'file.txt', 'changed\n');
    gitExec(repoPath, 'add file.txt');
    gitExec(repoPath, 'commit -m "second"');

    commitHash = gitExec(repoPath, 'rev-parse HEAD').trim();
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('returns diff for a specific commit', async () => {
    const diff = await getCommitDiff(repoPath, commitHash);
    expect(diff.lines.length).toBeGreaterThan(0);
    expect(diff.lines.some((l) => l.type === 'addition')).toBe(true);
    expect(diff.lines.some((l) => l.type === 'deletion')).toBe(true);
  });

  it('returns empty diff for invalid hash', async () => {
    const diff = await getCommitDiff(repoPath, 'deadbeef000000');
    expect(rawFromLines(diff.lines)).toBe('');
    expect(diff.lines).toEqual([]);
  });

  it('commitExists resolves real commits, refs, and abbreviations', async () => {
    expect(await commitExists(repoPath, commitHash)).toBe(true);
    expect(await commitExists(repoPath, commitHash.slice(0, 7))).toBe(true);
    expect(await commitExists(repoPath, 'HEAD')).toBe(true);
    expect(await commitExists(repoPath, 'main')).toBe(true);
  });

  it('commitExists is false for unknown hashes and refs', async () => {
    expect(await commitExists(repoPath, 'deadbeef000000')).toBe(false);
    expect(await commitExists(repoPath, 'no-such-branch')).toBe(false);
  });
});

describe('getCandidateBaseBranches / getDefaultBaseBranch / getDiffBetweenRefs (fixture)', () => {
  const REPO_NAME = 'branch-diff-test';
  let repoPath: string;

  beforeAll(() => {
    const result = createRepoWithRemote(REPO_NAME);
    repoPath = result.repoPath;

    // Create initial commit on main
    writeFixtureFile(repoPath, 'base.txt', 'base content\n');
    gitExec(repoPath, 'add base.txt');
    gitExec(repoPath, 'commit -m "base commit"');
    gitExec(repoPath, 'push -u origin main');

    // Create feature branch with changes
    gitExec(repoPath, 'checkout -b feature');
    writeFixtureFile(repoPath, 'feature.txt', 'feature content\n');
    gitExec(repoPath, 'add feature.txt');
    gitExec(repoPath, 'commit -m "feature commit"');
  });

  afterAll(() => {
    removeRepoWithRemote(REPO_NAME);
  });

  it('getCandidateBaseBranches returns remote branches', async () => {
    const candidates = await getCandidateBaseBranches(repoPath);
    expect(candidates.some((c) => c.includes('main'))).toBe(true);
  });

  it('getDefaultBaseBranch returns a branch', async () => {
    const defaultBranch = await getDefaultBaseBranch(repoPath);
    expect(defaultBranch).toBeTruthy();
    expect(defaultBranch).toContain('main');
  });

  it('getDiffBetweenRefs returns diff between feature and main', async () => {
    const diff = await getDiffBetweenRefs(repoPath, 'origin/main');
    expect(diff.baseBranch).toBe('origin/main');
    expect(diff.stats.filesChanged).toBeGreaterThanOrEqual(1);
    expect(diff.files.some((f) => f.path === 'feature.txt')).toBe(true);
    expect(diff.commits.length).toBeGreaterThanOrEqual(1);
    expect(diff.commits.some((c) => c.message === 'feature commit')).toBe(true);
  });

  it('getCommitCountBetweenRefs agrees with the full compare it stands in for', async () => {
    // The whole point of the cheap count is that the tab never contradicts
    // the list, so assert against the real thing rather than a literal.
    const diff = await getDiffBetweenRefs(repoPath, 'origin/main');
    expect(await getCommitCountBetweenRefs(repoPath, 'origin/main')).toBe(diff.commits.length);
  });

  it('getDiffBetweenRefs throws NoCommonHistoryError across unrelated history', async () => {
    // An orphan branch shares no ancestor with HEAD: the empty merge-base
    // must be an explicit error, not a silent HEAD...HEAD empty diff.
    gitExec(repoPath, 'checkout --orphan unrelated');
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "unrelated root"');
    gitExec(repoPath, 'checkout feature');
    await expect(getDiffBetweenRefs(repoPath, 'unrelated')).rejects.toThrow(NoCommonHistoryError);
  });

  it('getCommitCountBetweenRefs throws on unrelated history too, never counts 0', async () => {
    // A 0 would read as "nothing to compare" on the tab; no shared history
    // is a different answer, and the endpoint must be able to tell them apart.
    await expect(getCommitCountBetweenRefs(repoPath, 'unrelated')).rejects.toThrow(
      NoCommonHistoryError
    );
  });

  it('resolveEffectiveBaseBranch prefers the persisted choice over the default', async () => {
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-diff-xdg-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      // Empty cache: the discovered default wins.
      expect(await resolveEffectiveBaseBranch(repoPath)).toBe('origin/main');
      // Persisted choice: it wins over the default.
      setCachedBaseBranch(repoPath, 'main');
      expect(await resolveEffectiveBaseBranch(repoPath)).toBe('main');
    } finally {
      fs.rmSync(cacheHome, { recursive: true, force: true });
      if (savedCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = savedCacheHome;
      }
    }
  });
});

describe('getCompareDiffWithUncommitted (fixture)', () => {
  const REPO_NAME = 'compare-uncommitted-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'tracked.txt', 'a\nb\nc\nd\ne\n');
    writeFixtureFile(repoPath, '.gitignore', 'ignored.txt\n');
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "base"');
    gitExec(repoPath, 'checkout -b feature');
    // A commit on the branch touching the same file the working tree will.
    writeFixtureFile(repoPath, 'tracked.txt', 'a\nB\nc\nd\ne\n');
    gitExec(repoPath, 'commit -am "branch edit"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  function resetRepo(): void {
    gitExec(repoPath, 'checkout -- .');
    gitExec(repoPath, 'reset HEAD');
    gitExec(repoPath, 'checkout -- .');
    gitExec(repoPath, 'clean -fd');
  }

  it('lists a file changed BOTH by a branch commit and uncommitted as two entries', async () => {
    // The bug: only the committed entry survived, so an edit on top of a
    // file the branch already touches simply vanished from the compare.
    writeFixtureFile(repoPath, 'tracked.txt', 'a\nB\nc\nD\ne\n');
    try {
      const diff = await getCompareDiffWithUncommitted(repoPath, 'main');
      const entries = diff.files.filter((f) => f.path === 'tracked.txt');
      expect(entries).toHaveLength(2);
      expect(entries.map((f) => f.isUncommitted ?? false)).toEqual([false, true]);
      // Both carry a real diff, not just a header.
      for (const entry of entries) {
        expect(entry.diff.lines.some((l) => l.type === 'addition')).toBe(true);
      }
      // The uncommitted entry shows the working-tree edit, not the commit's.
      expect(entries[1].diff.lines.some((l) => l.content.includes('+D'))).toBe(true);
    } finally {
      resetRepo();
    }
  });

  it('carries staged AND unstaged edits to one file in a single entry', async () => {
    // Read as two diffs, the staged chunk won and the unstaged one was
    // dropped — while the stats still counted both.
    writeFixtureFile(repoPath, 'tracked.txt', 'a\nB\nc\nSTAGED\ne\n');
    gitExec(repoPath, 'add tracked.txt');
    writeFixtureFile(repoPath, 'tracked.txt', 'a\nB\nUNSTAGED\nSTAGED\ne\n');
    try {
      const diff = await getCompareDiffWithUncommitted(repoPath, 'main');
      const entry = diff.files.find((f) => f.path === 'tracked.txt' && f.isUncommitted);
      expect(entry).toBeDefined();
      const raw = entry!.diff.lines.map((l) => l.content).join('\n');
      expect(raw).toContain('+STAGED');
      expect(raw).toContain('+UNSTAGED');
      expect(entry!.additions).toBe(2);
      expect(entry!.deletions).toBe(2);
    } finally {
      resetRepo();
    }
  });

  it('includes untracked files and skips ignored ones', async () => {
    writeFixtureFile(repoPath, 'new.txt', 'fresh\n');
    writeFixtureFile(repoPath, 'ignored.txt', 'noise\n');
    try {
      const diff = await getCompareDiffWithUncommitted(repoPath, 'main');
      const untracked = diff.files.find((f) => f.path === 'new.txt');
      expect(untracked).toMatchObject({ status: 'added', isUncommitted: true, additions: 1 });
      expect(untracked!.diff.lines.some((l) => l.content === '+fresh')).toBe(true);
      expect(diff.files.some((f) => f.path === 'ignored.txt')).toBe(false);
    } finally {
      resetRepo();
    }
  });
});

describe('extractHunkPatch round-trip (fixture)', () => {
  const REPO_NAME = 'hunk-patch-test';
  let repoPath: string;

  const baseLines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
  const baseContent = baseLines.join('\n') + '\n';

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'code.txt', baseContent);
    gitExec(repoPath, 'add code.txt');
    gitExec(repoPath, 'commit -m "initial"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  /** Reset index and working copy of code.txt back to HEAD */
  function resetRepo(): void {
    gitExec(repoPath, 'reset HEAD -- code.txt');
    gitExec(repoPath, 'checkout -- code.txt');
  }

  /** Modify two well-separated lines so git produces two hunks. */
  function modifyTwoPlaces(): void {
    const lines = [...baseLines];
    lines[2] = 'line3 modified';
    lines[24] = 'line25 modified';
    writeFixtureFile(repoPath, 'code.txt', lines.join('\n') + '\n');
  }

  it('staging the first hunk stages only that change', () => {
    modifyTwoPlaces();
    const raw = gitExec(repoPath, 'diff');
    expect(countHunks(raw)).toBe(2);

    const patch = extractHunkPatch(raw, 0);
    expect(patch).not.toBeNull();
    stageHunk(repoPath, patch!);

    const cached = gitExec(repoPath, 'diff --cached');
    expect(countHunks(cached)).toBe(1);
    expect(cached).toContain('+line3 modified');
    expect(cached).not.toContain('line25 modified');

    const unstaged = gitExec(repoPath, 'diff');
    expect(countHunks(unstaged)).toBe(1);
    expect(unstaged).toContain('+line25 modified');
    expect(unstaged).not.toContain('line3 modified');

    // Working tree still has both changes
    const content = fs.readFileSync(path.join(repoPath, 'code.txt'), 'utf-8');
    expect(content).toContain('line3 modified');
    expect(content).toContain('line25 modified');
    resetRepo();
  });

  it('staging the second hunk stages only that change', () => {
    modifyTwoPlaces();
    const raw = gitExec(repoPath, 'diff');
    expect(countHunks(raw)).toBe(2);

    const patch = extractHunkPatch(raw, 1);
    expect(patch).not.toBeNull();
    stageHunk(repoPath, patch!);

    const cached = gitExec(repoPath, 'diff --cached');
    expect(countHunks(cached)).toBe(1);
    expect(cached).toContain('+line25 modified');
    expect(cached).not.toContain('line3 modified');

    const unstaged = gitExec(repoPath, 'diff');
    expect(countHunks(unstaged)).toBe(1);
    expect(unstaged).toContain('+line3 modified');

    const content = fs.readFileSync(path.join(repoPath, 'code.txt'), 'utf-8');
    expect(content).toContain('line3 modified');
    expect(content).toContain('line25 modified');
    resetRepo();
  });

  it('unstaging one hunk via reverse apply leaves the other staged', () => {
    modifyTwoPlaces();
    gitExec(repoPath, 'add code.txt');

    const cachedRaw = gitExec(repoPath, 'diff --cached');
    expect(countHunks(cachedRaw)).toBe(2);

    const patch = extractHunkPatch(cachedRaw, 0);
    expect(patch).not.toBeNull();
    unstageHunk(repoPath, patch!);

    const cachedAfter = gitExec(repoPath, 'diff --cached');
    expect(countHunks(cachedAfter)).toBe(1);
    expect(cachedAfter).toContain('+line25 modified');
    expect(cachedAfter).not.toContain('line3 modified');

    const unstagedAfter = gitExec(repoPath, 'diff');
    expect(countHunks(unstagedAfter)).toBe(1);
    expect(unstagedAfter).toContain('+line3 modified');

    const content = fs.readFileSync(path.join(repoPath, 'code.txt'), 'utf-8');
    expect(content).toContain('line3 modified');
    expect(content).toContain('line25 modified');
    resetRepo();
  });
});

describe('getDiffAgainstHead / getHeadOid (fixture)', () => {
  const REPO_NAME = 'head-diff-ops-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'seven.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n');
    writeFixtureFile(repoPath, 'other.txt', 'one\ntwo\n');
    gitExec(repoPath, 'add seven.txt other.txt');
    gitExec(repoPath, 'commit -m "initial"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  function resetRepo(): void {
    gitExec(repoPath, 'reset --hard HEAD');
    gitExec(repoPath, 'clean -fd');
  }

  it('getHeadOid returns the commit oid', async () => {
    const oid = await getHeadOid(repoPath);
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(oid).toBe(gitExec(repoPath, 'rev-parse HEAD').trim());
  });

  it('getHeadOid returns the unborn sentinel on a fresh repo', async () => {
    const freshPath = createFixtureRepo('head-oid-unborn-test');
    try {
      expect(await getHeadOid(freshPath)).toBe(UNBORN_HEAD_OID);
    } finally {
      removeFixtureRepo('head-oid-unborn-test');
    }
  });

  it('getHeadOid rejects on a non-repo instead of conflating it with an unborn HEAD', async () => {
    // Only the unborn signature maps to the sentinel; any other failure
    // must throw, or the journal would diff against the empty tree and
    // record a phantom mass-create.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-oid-'));
    try {
      await expect(getHeadOid(nonRepo)).rejects.toThrow();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('combines staged and unstaged changes against HEAD', async () => {
    writeFixtureFile(repoPath, 'seven.txt', 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n');
    gitExec(repoPath, 'add seven.txt');
    writeFixtureFile(repoPath, 'other.txt', 'one\nCHANGED\n');

    const diff = await getDiffAgainstHead(repoPath);
    expect(rawFromLines(diff.lines)).toContain('diff --git a/seven.txt b/seven.txt');
    expect(rawFromLines(diff.lines)).toContain('diff --git a/other.txt b/other.txt');
    expect(rawFromLines(diff.lines)).toContain('+CHANGED');
    resetRepo();
  });

  it('diffs against the empty tree when HEAD is unborn', async () => {
    const freshPath = createFixtureRepo('head-diff-unborn-test');
    try {
      writeFixtureFile(freshPath, 'new.txt', 'hello\n');
      gitExec(freshPath, 'add new.txt');
      const diff = await getDiffAgainstHead(freshPath);
      expect(rawFromLines(diff.lines)).toContain('diff --git a/new.txt b/new.txt');
      expect(rawFromLines(diff.lines)).toContain('new file mode');
      expect(rawFromLines(diff.lines)).toContain('+hello');
    } finally {
      removeFixtureRepo('head-diff-unborn-test');
    }
  });

  it('pins -U3: a diff.context=0 repo config does not change hunk geometry', async () => {
    gitExec(repoPath, 'config diff.context 0');
    try {
      writeFixtureFile(repoPath, 'seven.txt', 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n');
      const diff = await getDiffAgainstHead(repoPath);
      // With -U3 honored the single mid-file change carries 3 context
      // lines on each side; with diff.context=0 winning there would be none.
      const contextLines = diff.lines.filter((l) => l.type === 'context');
      expect(contextLines.length).toBe(6);
      expect(rawFromLines(diff.lines)).toContain('@@ -1,7 +1,7 @@');
    } finally {
      gitExec(repoPath, 'config --unset diff.context');
      resetRepo();
    }
  });

  it('PROPAGATES errors instead of swallowing them to an empty diff', async () => {
    // The one deliberate convention break in this file: a transient git
    // failure must never read as "clean" (phantom mass revert in the
    // journal). A non-repo directory makes the diff read fail loudly.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      await expect(getDiffAgainstHead(nonRepo)).rejects.toThrow();
      // Contrast: the sibling swallows the same failure.
      const swallowed = await getDiff(nonRepo);
      expect(swallowed).toEqual({ lines: [] });
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('diff.context is pinned, not inherited (fixture)', () => {
  // A user with `diff.context` set in their git config must not get
  // different hunk geometry than anyone else. Context width decides where
  // hunks merge and split, and hunk boundaries are an identity here: the
  // per-file hunk badges count them, hunkTimes keys an edit time by a hash
  // of a hunk's body, and extractHunkPatch builds staging patches from
  // them. Only getDiffAgainstHead pinned -U3 before this; the rest took
  // git's default, so the same repo read differently on two machines.
  //
  // The fixture is built so the difference is visible: two edits 12 lines
  // apart are two hunks at -U3 and ONE hunk at the configured -U20.
  const REPO_NAME = 'diff-context-pin-test';
  let repoPath: string;

  const BASE = Array.from({ length: 16 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  const EDITED = BASE.replace('line2\n', 'EDITED2\n').replace('line15\n', 'EDITED15\n');

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'wide.txt', BASE);
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "base"');
    // The config under test. Wide enough to merge the two hunks together.
    gitExec(repoPath, 'config diff.context 20');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  /** Back to a clean HEAD, staged or not — these tests dirty both sides. */
  function resetRepo(): void {
    gitExec(repoPath, 'reset --hard HEAD');
    gitExec(repoPath, 'clean -fd');
  }

  it('the fixture actually distinguishes the two widths', () => {
    // Guards the test itself: if git ever stopped honouring diff.context,
    // or the file got too short to split, every assertion below would pass
    // for the wrong reason.
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    expect(countHunks(gitExec(repoPath, 'diff -- wide.txt'))).toBe(1);
    expect(countHunks(gitExec(repoPath, 'diff -U3 -- wide.txt'))).toBe(2);
    resetRepo();
  });

  it('getDiff pins context on the unstaged side', async () => {
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    const diff = await getDiff(repoPath, 'wide.txt');
    expect(countHunks(rawFromLines(diff.lines))).toBe(2);
    resetRepo();
  });

  it('getDiff pins context on the staged side', async () => {
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    gitExec(repoPath, 'add wide.txt');
    const diff = await getDiff(repoPath, 'wide.txt', true);
    expect(countHunks(rawFromLines(diff.lines))).toBe(2);
    resetRepo();
  });

  it('getDiffAgainstHead pins context', async () => {
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    const diff = await getDiffAgainstHead(repoPath);
    expect(countHunks(rawFromLines(diff.lines))).toBe(2);
    resetRepo();
  });

  it('getCommitDiff pins context', async () => {
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    gitExec(repoPath, 'commit -am "edit"');
    const diff = await getCommitDiff(repoPath, 'HEAD');
    expect(countHunks(rawFromLines(diff.lines))).toBe(2);
    gitExec(repoPath, 'reset --hard HEAD~1');
  });

  it('getDiffBetweenRefs pins context', async () => {
    gitExec(repoPath, 'checkout -b ctx-feature');
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    gitExec(repoPath, 'commit -am "branch edit"');
    const compare = await getDiffBetweenRefs(repoPath, 'main');
    const file = compare.files.find((f) => f.path === 'wide.txt');
    expect(file).toBeDefined();
    expect(countHunks(rawFromLines(file!.diff.lines))).toBe(2);
    gitExec(repoPath, 'checkout main');
    gitExec(repoPath, 'branch -D ctx-feature');
    resetRepo();
  });

  it('getCompareDiffWithUncommitted pins context on the uncommitted side', async () => {
    gitExec(repoPath, 'checkout -b ctx-uncommitted');
    writeFixtureFile(repoPath, 'wide.txt', EDITED);
    const compare = await getCompareDiffWithUncommitted(repoPath, 'main');
    const file = compare.files.find((f) => f.path === 'wide.txt');
    expect(file).toBeDefined();
    expect(countHunks(rawFromLines(file!.diff.lines))).toBe(2);
    resetRepo();
    gitExec(repoPath, 'checkout main');
    gitExec(repoPath, 'branch -D ctx-uncommitted');
  });
});
