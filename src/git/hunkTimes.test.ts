import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HunkTimeTracker } from './hunkTimes.js';
import type { DiffResult, DiffLine } from './diff.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

const FIXTURE = 'hunk-times-test';

function makeDiff(
  file: string,
  hunks: { header: string; body: [DiffLine['type'], string][] }[]
): DiffResult {
  const lines: DiffLine[] = [{ type: 'header', content: `diff --git a/${file} b/${file}` }];
  for (const hunk of hunks) {
    lines.push({ type: 'hunk', content: hunk.header });
    for (const [type, content] of hunk.body) {
      lines.push({ type, content });
    }
  }
  return { raw: '', lines };
}

describe('HunkTimeTracker', () => {
  const repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'a.txt', 'hello\n');

  afterAll(() => {
    removeFixtureRepo(FIXTURE);
  });

  it('stamps a first-seen hunk with the file mtime', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const diff = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(diff);

    const mtime = fs.statSync(path.join(repoPath, 'a.txt')).mtimeMs;
    expect(diff.lines[1].editedAt).toBe(mtime);
  });

  it('keeps the stamp when the hunk content merely moves (header changes)', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const first = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(first);
    const original = first.lines[1].editedAt;

    const moved = makeDiff('a.txt', [{ header: '@@ -50,2 +51,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(moved);
    expect(moved.lines[1].editedAt).toBe(original);
  });

  it('gives a changed hunk a fresh stamp independent of the old one', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const first = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(first);

    // Touch the file so its mtime moves forward, then present changed content
    const target = path.join(repoPath, 'a.txt');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(target, future, future);

    const changed = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+y']] }]);
    tracker.stamp(changed);
    expect(changed.lines[1].editedAt).toBe(fs.statSync(target).mtimeMs);
    expect(changed.lines[1].editedAt).not.toBe(first.lines[1].editedAt);
  });

  it('distinguishes hunks by their content within a file', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const diff = makeDiff('a.txt', [
      { header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] },
      { header: '@@ -10,2 +11,3 @@', body: [['deletion', '-z']] },
    ]);
    tracker.stamp(diff);
    expect(diff.lines[1].editedAt).toBeDefined();
    expect(diff.lines[3].editedAt).toBeDefined();
  });

  it('ignores context lines for hunk identity', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const first = makeDiff('a.txt', [
      {
        header: '@@ -1,3 +1,4 @@',
        body: [
          ['context', ' before'],
          ['addition', '+x'],
        ],
      },
    ]);
    tracker.stamp(first);
    const original = first.lines[1].editedAt;

    // Same +/- content, different context window
    const shifted = makeDiff('a.txt', [
      {
        header: '@@ -1,3 +1,4 @@',
        body: [
          ['context', ' other-context'],
          ['addition', '+x'],
        ],
      },
    ]);
    tracker.stamp(shifted);
    expect(shifted.lines[1].editedAt).toBe(original);
  });

  it('prunes stamps for files that no longer have changes', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const first = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(first);
    const original = first.lines[1].editedAt;

    tracker.prune(new Set());

    // Re-observing after prune re-stamps from mtime (moved forward here to prove it)
    const target = path.join(repoPath, 'a.txt');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(target, future, future);

    const again = makeDiff('a.txt', [{ header: '@@ -1,2 +1,3 @@', body: [['addition', '+x']] }]);
    tracker.stamp(again);
    expect(again.lines[1].editedAt).not.toBe(original);
  });

  it('falls back to now for unreadable files', () => {
    const tracker = new HunkTimeTracker(repoPath);
    const before = Date.now();
    const diff = makeDiff('missing.txt', [{ header: '@@ -1 +1 @@', body: [['addition', '+x']] }]);
    tracker.stamp(diff);
    expect(diff.lines[1].editedAt).toBeGreaterThanOrEqual(before);
  });
});
