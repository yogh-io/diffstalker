import { describe, it, expect } from 'bun:test';
import { formatCompareListView } from './CompareListView.js';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareFileDiff, DiffResult } from '@diffstalker/core/git/diff';

const emptyDiff: DiffResult = {
  lines: [],
} as unknown as DiffResult;

function commit(over: Partial<CommitInfo> = {}): CommitInfo {
  return {
    hash: 'abcdef0123',
    shortHash: 'abcdef0',
    message: 'do a thing',
    author: 'a',
    date: new Date('2026-01-01T00:00:00Z'),
    refs: '',
    ...over,
  };
}

function file(over: Partial<CompareFileDiff> = {}): CompareFileDiff {
  return {
    path: 'src/thing.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    diff: emptyDiff,
    ...over,
  };
}

const WIDTH = 80;

describe('formatCompareListView rendering', () => {
  it('emits blessed tags, never raw ANSI or {escape}', () => {
    const out = formatCompareListView(
      [commit()],
      [file(), file({ path: 'a/b.ts', status: 'added' })],
      null,
      true,
      WIDTH
    );
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('{escape}');
    // recognisable blessed tags are present
    expect(out).toContain('{yellow-fg}');
    expect(out).toContain('{cyan-fg}{bold}');
  });

  it('every line is balanced blessed markup with no control chars', () => {
    const out = formatCompareListView([commit()], [file()], null, false, WIDTH);
    for (const line of out.split('\n')) {
      expect(/[\x00-\x08\x0e-\x1f]/.test(line)).toBe(false);
      const open = (line.match(/\{(?!\/)[a-z-]+\}/g) ?? []).length;
      const close = (line.match(/\{\/[a-z-]*\}/g) ?? []).length;
      expect(open).toBe(close);
    }
  });

  it('distinguishes "no base branch" from "no changes vs base"', () => {
    const noChanges = formatCompareListView([], [], null, false, WIDTH, 0, undefined, false, false);
    expect(noChanges).toContain('No changes compared to base branch');

    const noBase = formatCompareListView([], [], null, false, WIDTH, 0, undefined, false, true);
    expect(noBase).toContain('No base branch to compare against');
    expect(noBase).not.toContain('No changes compared to base branch');
  });

  it('escapes braces in commit messages and file names', () => {
    const out = formatCompareListView(
      [commit({ message: 'fix {weird} bug' })],
      [file({ path: 'we{ir}d.ts' })],
      null,
      false,
      WIDTH
    );
    expect(out).toContain('fix {{weird}} bug');
    expect(out).toContain('we{{ir}}d.ts');
  });
});
