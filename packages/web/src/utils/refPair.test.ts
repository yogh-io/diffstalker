/**
 * The ref-pair vocabulary. One place decides the wording, so the four
 * surfaces that print it cannot drift apart on what "index → working
 * tree" means.
 */

import { describe, test, expect } from 'vitest';
import { refPairLabel, refPairTitle, type RefPair } from './refPair';
import type { FileStatus } from '@diffstalker/core/git/status';

function working(staged: boolean, status: FileStatus = 'modified'): RefPair {
  return { kind: 'working', staged, status };
}

describe('refPairLabel', () => {
  test('the two sides of the index, named as the reader thinks of them', () => {
    expect(refPairLabel(working(false))).toBe('index → working tree');
    expect(refPairLabel(working(true))).toBe('HEAD → index');
  });

  test('an untracked file has no old side, and does not pretend to', () => {
    // "index → working tree" would name a side that does not exist: the
    // file is not in the index at all.
    expect(refPairLabel(working(false, 'untracked' as FileStatus))).toBe(
      'new file → working tree'
    );
  });

  test('a deleted file has no new side', () => {
    expect(refPairLabel(working(false, 'deleted' as FileStatus))).toBe('index → deleted');
    expect(refPairLabel(working(true, 'deleted' as FileStatus))).toBe('HEAD → deleted');
  });

  test('compare uses git’s own three-dot notation, not an arrow', () => {
    expect(refPairLabel({ kind: 'compare', base: 'origin/main', head: null })).toBe(
      'origin/main…HEAD'
    );
  });

  test('compare with no resolved base still names the shape', () => {
    expect(refPairLabel({ kind: 'compare', base: null, head: null })).toBe('base…HEAD');
  });

  test('a picked stack layer names both ends: the layer below, then the layer', () => {
    // The pair a layer's diff actually sits between — NOT trunk…HEAD,
    // which is what the same row would read without the layer.
    expect(
      refPairLabel({ kind: 'compare', base: 'feature/jsp-to-html', head: 'feature/nginx' })
    ).toBe('feature/jsp-to-html…feature/nginx');
    expect(refPairTitle({ kind: 'compare', base: 'feature/jsp-to-html', head: 'feature/nginx' })).toContain(
      'feature/nginx'
    );
  });

  test('compare’s uncommitted rows start at the same base, and say where they end', () => {
    // One row per file, from the merge-base: only the end differs.
    const row = (side: 'staged' | 'unstaged' | 'both' | 'untracked') =>
      refPairLabel({ kind: 'compare-uncommitted', base: 'origin/main', side });
    expect(row('staged')).toBe('origin/main…index');
    expect(row('unstaged')).toBe('origin/main…working tree');
    expect(row('both')).toBe('origin/main…working tree');
    expect(row('untracked')).toBe('origin/main…working tree');
    expect(refPairLabel({ kind: 'compare-uncommitted', base: null, side: 'staged' })).toBe(
      'base…index'
    );
  });

  test('a commit is named against its parent', () => {
    expect(refPairLabel({ kind: 'commit', shortHash: 'a1b2c3d' })).toBe('a1b2c3d^ → a1b2c3d');
  });

  test('the journal is always worktree-vs-HEAD', () => {
    expect(refPairLabel({ kind: 'journal' })).toBe('HEAD → working tree');
  });
});

describe('refPairTitle', () => {
  test('every pair has a longer explanation, and none is empty', () => {
    const all: RefPair[] = [
      working(false),
      working(true),
      working(false, 'untracked' as FileStatus),
      working(false, 'deleted' as FileStatus),
      { kind: 'compare', base: 'origin/main', head: null },
      { kind: 'compare', base: 'feature/a', head: 'feature/b' },
      { kind: 'compare-uncommitted', base: 'origin/main', side: 'both' },
      { kind: 'compare-uncommitted', base: 'origin/main', side: 'staged' },
      { kind: 'commit', shortHash: 'a1b2c3d' },
      { kind: 'journal' },
    ];
    for (const pair of all) {
      expect(refPairTitle(pair).length).toBeGreaterThan(10);
      expect(refPairLabel(pair).length).toBeGreaterThan(0);
    }
  });
});
