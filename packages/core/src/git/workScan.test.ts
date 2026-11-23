import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  MAX_CHANGED_STATS,
  porcelainPaths,
  readGithubIdentities,
  scanWorkRepo,
} from './workScan.js';
import { clearDefaultBaseCache } from './worktree.js';
import {
  createFixtureRepo,
  createRepoWithRemote,
  gitExec,
  removeFixtureRepo,
  removeRepoWithRemote,
  writeFixtureFile,
} from './test-helpers.js';
import type { WorkRepoFacts } from '../types/work.js';

describe('porcelainPaths', () => {
  it('gives one path per entry: the new path of a rename, not the old one', () => {
    expect(porcelainPaths('R  new.txt\0old.txt\0?? untracked.txt\0 M modified.txt\0')).toEqual([
      'new.txt',
      'untracked.txt',
      'modified.txt',
    ]);
    expect(porcelainPaths('C  copy.txt\0a\0')).toEqual(['copy.txt']);
    expect(porcelainPaths(' R renamed.txt\0b\0A  added.txt\0')).toEqual([
      'renamed.txt',
      'added.txt',
    ]);
  });

  it('is empty for empty output', () => {
    expect(porcelainPaths('')).toEqual([]);
  });
});

describe('changedAt (fixture)', () => {
  const EDITED = 'work-scan-changed';
  const MANY = 'work-scan-many';

  function setMtime(file: string, ms: number): void {
    fs.utimesSync(file, new Date(ms), new Date(ms));
  }

  function committed(name: string, files: string[]): string {
    removeFixtureRepo(name);
    const dir = createFixtureRepo(name);
    for (const file of files) writeFixtureFile(dir, file, `${file}\n`);
    gitExec(dir, 'add .');
    gitExec(dir, 'commit -q -m initial');
    return dir;
  }

  afterAll(() => {
    removeFixtureRepo(EDITED);
    removeFixtureRepo(MANY);
  });

  it('is the newest mtime of the changed paths; a deleted file is skipped quietly', async () => {
    const dir = committed(EDITED, ['edited.txt', 'deleted.txt']);
    writeFixtureFile(dir, 'edited.txt', 'edited\n');
    writeFixtureFile(dir, 'new/untracked.txt', 'new\n');
    fs.rmSync(path.join(dir, 'deleted.txt'));
    const untracked = Date.parse('2026-04-01T10:00:00Z');
    setMtime(path.join(dir, 'edited.txt'), Date.parse('2026-03-01T10:00:00Z'));
    setMtime(path.join(dir, 'new/untracked.txt'), untracked);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let scanned: WorkRepoFacts;
    try {
      scanned = (await scanWorkRepo(dir))!;
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain(' warn ');
    } finally {
      stderr.mockRestore();
    }
    expect(scanned.worktrees[0]).toMatchObject({ uncommitted: 3, changedAt: untracked });
  });

  it('is null for a clean worktree', async () => {
    const scanned = (await scanWorkRepo(committed(EDITED, ['a.txt'])))!;
    expect(scanned.worktrees[0]).toMatchObject({ uncommitted: 0, changedAt: null });
  });

  it(`reads at most ${MAX_CHANGED_STATS} paths`, async () => {
    const dir = committed(MANY, ['a.txt']);
    const base = Date.parse('2026-01-01T00:00:00Z');
    const count = MAX_CHANGED_STATS + 50;
    // Status lists untracked files by name, so the newest ones come last and are not read.
    for (let i = 0; i < count; i++) {
      const file = `bulk/f${String(i).padStart(3, '0')}.txt`;
      writeFixtureFile(dir, file, 'x\n');
      setMtime(path.join(dir, file), base + i * 1000);
    }
    const scanned = (await scanWorkRepo(dir))!;
    expect(scanned.worktrees[0]).toMatchObject({
      uncommitted: count,
      changedAt: base + (MAX_CHANGED_STATS - 1) * 1000,
    });
  });
});

describe('scanWorkRepo (fixture)', () => {
  const NAME = 'work-scan';
  const LINKED = `${NAME}-linked`;
  const PLAIN = `${NAME}-plain`;
  let repoPath: string;
  let linkedPath: string;
  let facts: WorkRepoFacts;
  let indexMtimeBefore: number;
  let tips: Record<string, string>;

  function commit(dir: string, file: string): string {
    writeFixtureFile(dir, file, `${file}\n`);
    gitExec(dir, `add ${file}`);
    gitExec(dir, `commit -q -m "${file}"`);
    return gitExec(dir, 'rev-parse HEAD').trim();
  }

  beforeAll(async () => {
    clearDefaultBaseCache();
    removeRepoWithRemote(NAME);
    removeFixtureRepo(LINKED);
    ({ repoPath } = createRepoWithRemote(NAME));
    gitExec(repoPath, 'checkout -q -b main');
    commit(repoPath, 'root.txt');
    gitExec(repoPath, 'push -q origin main');

    tips = {};
    gitExec(repoPath, 'checkout -q -b pushed');
    tips.pushed = commit(repoPath, 'pushed.txt');
    gitExec(repoPath, 'push -q origin pushed');

    gitExec(repoPath, 'checkout -q -b ahead main');
    commit(repoPath, 'ahead-1.txt');
    gitExec(repoPath, 'push -q origin ahead');
    tips.ahead = commit(repoPath, 'ahead-2.txt');

    gitExec(repoPath, 'checkout -q -b local-only main');
    tips['local-only'] = commit(repoPath, 'local.txt');
    // git refuses to make a flag-shaped branch, but a ref can still exist.
    gitExec(repoPath, 'update-ref refs/heads/-x HEAD');
    gitExec(repoPath, 'checkout -q main');

    gitExec(repoPath, 'remote add gh https://github.com/Aerius/Calculator.git');
    gitExec(repoPath, 'remote add fork git@github.com:JornC/calculator.git');
    gitExec(repoPath, 'remote add lab git@gitlab.com:someone/thing.git');

    linkedPath = path.join(repoPath, '..', LINKED);
    gitExec(repoPath, `worktree add -q "${linkedPath}" ahead`);
    writeFixtureFile(linkedPath, 'root.txt', 'modified\n');
    writeFixtureFile(linkedPath, 'new.txt', 'untracked\n');

    const commonDir = path.join(repoPath, '.git');
    for (const [branch, name, text] of [
      ['ahead', 'top.md', 'Why this. {{link}}'],
      ['-x', 'top.md', 'refused name'],
      ['feature/gone', 'ai.md', 'agent text'],
    ]) {
      const dir = path.join(commonDir, 'diffstalker', 'pr', ...branch.split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }

    indexMtimeBefore = fs.statSync(path.join(commonDir, 'worktrees', LINKED, 'index')).mtimeMs;
    facts = (await scanWorkRepo(repoPath))!;
  });

  afterAll(() => {
    removeRepoWithRemote(NAME);
    removeFixtureRepo(LINKED);
    removeFixtureRepo(PLAIN);
    clearDefaultBaseCache();
  });

  it('names the repo by its main worktree', () => {
    expect(facts.path).toBe(repoPath);
    expect(facts.root).toBe(fs.realpathSync(repoPath));
    expect(facts.name).toBe(NAME);
  });

  it('tells pushed, ahead of its copy and never pushed apart', () => {
    const byName = new Map(facts.branches.map((b) => [b.name, b]));
    expect(byName.get('pushed')).toEqual({
      name: 'pushed',
      tip: tips.pushed,
      remoteCopy: true,
      unpushed: 0,
    });
    expect(byName.get('ahead')).toMatchObject({ tip: tips.ahead, remoteCopy: true, unpushed: 1 });
    expect(byName.get('local-only')).toMatchObject({
      tip: tips['local-only'],
      remoteCopy: false,
      unpushed: null,
    });
    expect(byName.get('-x')).toMatchObject({ remoteCopy: false, unpushed: null });
    expect(facts.branches.map((b) => b.name)).toEqual([
      '-x',
      'ahead',
      'local-only',
      'main',
      'pushed',
    ]);
    expect(facts.branchesCapped).toBe(false);
  });

  it('counts uncommitted paths per worktree, with the base', () => {
    const linked = facts.worktrees.find((wt) => wt.branch === 'ahead')!;
    expect(linked).toMatchObject({
      isMain: false,
      isBare: false,
      uncommitted: 2,
      aheadOfBase: 2,
      base: 'origin/main',
    });
    expect(linked.changedAt).toEqual(expect.any(Number));
    const main = facts.worktrees.find((wt) => wt.isMain)!;
    expect(main).toMatchObject({
      branch: 'main',
      uncommitted: 0,
      changedAt: null,
      aheadOfBase: 0,
      base: 'origin/main',
    });
  });

  it('leaves the index alone', () => {
    const after = fs.statSync(path.join(repoPath, '.git', 'worktrees', LINKED, 'index')).mtimeMs;
    expect(after).toBe(indexMtimeBefore);
  });

  it('reads the GitHub identities and drops other remotes', () => {
    expect([...facts.identities].sort()).toEqual(['aerius/calculator', 'jornc/calculator']);
  });

  it('lists the drafts and skips a refused branch name', () => {
    expect(facts.drafts.map((d) => d.branch)).toEqual(['ahead', 'feature/gone']);
    expect(facts.drafts[0]).toMatchObject({ hasTop: true, top: 'Why this. {{link}}' });
  });

  it('gives the same root from a linked worktree', async () => {
    const fromLinked = (await scanWorkRepo(linkedPath))!;
    expect(fromLinked.root).toBe(facts.root);
    expect(fromLinked.path).toBe(linkedPath);
    expect(fromLinked.drafts.map((d) => d.branch)).toEqual(['ahead', 'feature/gone']);
  });

  it('has no identities without remotes', async () => {
    const plain = createFixtureRepo(PLAIN);
    commit(plain, 'one.txt');
    expect(await readGithubIdentities(plain)).toEqual([]);
    const scanned = (await scanWorkRepo(plain))!;
    expect(scanned.identities).toEqual([]);
    expect(scanned.branches).toEqual([
      expect.objectContaining({ name: 'main', remoteCopy: false, unpushed: null }),
    ]);
  });

  it('is null for a path that is not a repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workscan-none-'));
    try {
      expect(await scanWorkRepo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
