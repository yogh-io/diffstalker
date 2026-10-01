/**
 * Compare with a named head (docs/stacked-compare.md §4): the range ends
 * at a ref instead of HEAD, so one layer of a stack can be read on its
 * own. Absent head must behave exactly as before — the same git calls,
 * the same answer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getCommitCountBetweenRefs,
  getCompareDiff,
  getDiffBetweenRefs,
  getFileDiffInRange,
  NoCommonHistoryError,
} from './diff.js';
import { ALL_UNCOMMITTED } from '../types/compare.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

function commit(repoPath: string, file: string, message: string): void {
  writeFixtureFile(repoPath, file, `${message}\n`);
  gitExec(repoPath, `add ${file}`);
  gitExec(repoPath, `commit -m "${message}"`);
}

describe('compare with a named head (fixture)', () => {
  const REPO_NAME = 'compare-head-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    commit(repoPath, 'base.txt', 'base');
    gitExec(repoPath, 'checkout -b bottom');
    commit(repoPath, 'bottom.txt', 'bottom');
    gitExec(repoPath, 'checkout -b middle');
    commit(repoPath, 'middle.txt', 'middle one');
    commit(repoPath, 'middle.txt', 'middle two');
    gitExec(repoPath, 'checkout -b top');
    commit(repoPath, 'top.txt', 'top');
    gitExec(repoPath, 'checkout --orphan orphan');
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "orphan root"');
    gitExec(repoPath, 'checkout top');
    // Uncommitted work at HEAD, which a named head must never fold in.
    writeFixtureFile(repoPath, 'base.txt', 'base\ndirty\n');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('getDiffBetweenRefs with a head reads base...head: one layer only', async () => {
    const diff = await getDiffBetweenRefs(repoPath, 'bottom', 'middle');
    expect(diff.baseBranch).toBe('bottom');
    expect(diff.files.map((f) => f.path)).toEqual(['middle.txt']);
    expect(diff.commits.map((c) => c.message)).toEqual(['middle two', 'middle one']);
    // The uncommitted count is still HEAD's working tree: it is the same
    // `git status` whichever head is named.
    expect(diff.uncommittedCount).toBe(1);
  });

  it('the merge-base is taken against the head, not HEAD', async () => {
    // From top, bottom...HEAD would carry middle's and top's commits;
    // bottom...middle carries middle's only. And main...bottom from top
    // is bottom's one commit, not the whole stack.
    expect(await getCommitCountBetweenRefs(repoPath, 'bottom', 'middle')).toBe(2);
    expect(await getCommitCountBetweenRefs(repoPath, 'main', 'bottom')).toBe(1);
    expect(await getCommitCountBetweenRefs(repoPath, 'main')).toBe(4);
  });

  it('an absent head is HEAD: the same answer as naming it', async () => {
    const implicit = await getDiffBetweenRefs(repoPath, 'main');
    const explicit = await getDiffBetweenRefs(repoPath, 'main', 'HEAD');
    expect(explicit).toEqual(implicit);
    expect(await getCommitCountBetweenRefs(repoPath, 'main', 'HEAD')).toBe(
      await getCommitCountBetweenRefs(repoPath, 'main')
    );
  });

  it('getCompareDiff passes the head through for the committed compare', async () => {
    const diff = await getCompareDiff(repoPath, 'bottom', undefined, 'middle');
    expect(diff.files.map((f) => f.path)).toEqual(['middle.txt']);
    expect(diff.files.some((f) => f.uncommitted)).toBe(false);
  });

  it('getCompareDiff refuses uncommitted parts together with a head', async () => {
    // Uncommitted work only exists against HEAD; a head with it is a
    // programming error, not a request to be guessed at.
    await expect(getCompareDiff(repoPath, 'bottom', ALL_UNCOMMITTED, 'middle')).rejects.toThrow(
      /HEAD/
    );
  });

  it('getFileDiffInRange reads the compare range up to the head', async () => {
    const diff = await getFileDiffInRange(repoPath, { kind: 'compare', base: 'bottom', head: 'middle' }, 'middle.txt');
    const text = diff.lines.map((l) => l.content).join('\n');
    expect(text).toContain('+middle two');
    expect(text).not.toContain('top');

    // top.txt is not in bottom...middle: an empty diff, as for any file
    // outside the range.
    const outside = await getFileDiffInRange(repoPath, { kind: 'compare', base: 'bottom', head: 'middle' }, 'top.txt');
    expect(outside.lines).toEqual([]);
  });

  it('a head with no common history is NoCommonHistoryError, as for HEAD', async () => {
    await expect(getDiffBetweenRefs(repoPath, 'main', 'orphan')).rejects.toThrow(
      NoCommonHistoryError
    );
    await expect(getCommitCountBetweenRefs(repoPath, 'main', 'orphan')).rejects.toThrow(
      NoCommonHistoryError
    );
  });
});
