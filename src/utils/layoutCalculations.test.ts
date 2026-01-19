import { describe, it, expect } from 'vitest';
import {
  calculatePaneHeights,
  getRowForFileIndex,
  calculateScrollOffset,
  getFileListSectionCounts,
  getFileListTotalRows,
} from './layoutCalculations.js';
import { FileEntry, FileStatus } from '../git/status.js';

// Helper to create test file entries
function makeFile(path: string, staged: boolean, status: FileStatus = 'modified'): FileEntry {
  return { path, status, staged };
}

describe('getFileListSectionCounts', () => {
  it('counts empty file list', () => {
    const result = getFileListSectionCounts([]);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 0, stagedCount: 0 });
  });

  it('counts only modified files', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'added'),
    ];
    const result = getFileListSectionCounts(files);
    expect(result).toEqual({ modifiedCount: 2, untrackedCount: 0, stagedCount: 0 });
  });

  it('counts only untracked files', () => {
    const files = [
      makeFile('a.ts', false, 'untracked'),
      makeFile('b.ts', false, 'untracked'),
    ];
    const result = getFileListSectionCounts(files);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 2, stagedCount: 0 });
  });

  it('counts only staged files', () => {
    const files = [
      makeFile('a.ts', true, 'modified'),
      makeFile('b.ts', true, 'added'),
    ];
    const result = getFileListSectionCounts(files);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 0, stagedCount: 2 });
  });

  it('counts mixed files correctly', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'untracked'),
      makeFile('c.ts', false, 'untracked'),
      makeFile('d.ts', true, 'modified'),
    ];
    const result = getFileListSectionCounts(files);
    expect(result).toEqual({ modifiedCount: 1, untrackedCount: 2, stagedCount: 1 });
  });
});

describe('getFileListTotalRows', () => {
  it('returns 0 for empty file list', () => {
    expect(getFileListTotalRows([])).toBe(0);
  });

  it('counts rows for only modified files', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
    ];
    // header (1) + 2 files = 3
    expect(getFileListTotalRows(files)).toBe(3);
  });

  it('counts rows for only untracked files', () => {
    const files = [
      makeFile('a.ts', false, 'untracked'),
      makeFile('b.ts', false, 'untracked'),
    ];
    // header (1) + 2 files = 3
    expect(getFileListTotalRows(files)).toBe(3);
  });

  it('counts rows for only staged files', () => {
    const files = [
      makeFile('a.ts', true, 'modified'),
      makeFile('b.ts', true, 'modified'),
      makeFile('c.ts', true, 'modified'),
    ];
    // header (1) + 3 files = 4
    expect(getFileListTotalRows(files)).toBe(4);
  });

  it('counts rows for modified + staged with spacer', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
      makeFile('c.ts', true, 'modified'),
    ];
    // modified header (1) + 2 files + spacer (1) + staged header (1) + 1 file = 6
    expect(getFileListTotalRows(files)).toBe(6);
  });

  it('counts rows for all three sections', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'untracked'),
      makeFile('c.ts', true, 'modified'),
    ];
    // modified header (1) + 1 file + spacer (1) + untracked header (1) + 1 file + spacer (1) + staged header (1) + 1 file = 8
    expect(getFileListTotalRows(files)).toBe(8);
  });
});

describe('calculatePaneHeights', () => {
  it('returns minimum height of 3 for empty file list', () => {
    const result = calculatePaneHeights([], 30);
    expect(result.topPaneHeight).toBe(3);
    expect(result.bottomPaneHeight).toBe(27);
  });

  it('calculates height for only modified files', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
    ];
    const result = calculatePaneHeights(files, 30);
    // header (1) + 2 files = 3
    expect(result.topPaneHeight).toBe(3);
    expect(result.bottomPaneHeight).toBe(27);
  });

  it('calculates height for only staged files', () => {
    const files = [
      makeFile('a.ts', true, 'modified'),
      makeFile('b.ts', true, 'modified'),
      makeFile('c.ts', true, 'modified'),
    ];
    const result = calculatePaneHeights(files, 30);
    // header (1) + 3 files = 4
    expect(result.topPaneHeight).toBe(4);
    expect(result.bottomPaneHeight).toBe(26);
  });

  it('calculates height for mixed files with spacer', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
      makeFile('c.ts', true, 'modified'),
    ];
    const result = calculatePaneHeights(files, 30);
    // modified header (1) + 2 files + spacer (1) + staged header (1) + 1 file = 6
    expect(result.topPaneHeight).toBe(6);
    expect(result.bottomPaneHeight).toBe(24);
  });

  it('respects maxTopRatio', () => {
    const files = Array.from({ length: 20 }, (_, i) => makeFile(`file${i}.ts`, false, 'modified'));
    const result = calculatePaneHeights(files, 30, 0.4);
    expect(result.topPaneHeight).toBe(12); // 30 * 0.4 = 12
    expect(result.bottomPaneHeight).toBe(18);
  });

  it('uses custom maxTopRatio', () => {
    const files = Array.from({ length: 20 }, (_, i) => makeFile(`file${i}.ts`, false, 'modified'));
    const result = calculatePaneHeights(files, 30, 0.6);
    expect(result.topPaneHeight).toBe(18); // 30 * 0.6 = 18
    expect(result.bottomPaneHeight).toBe(12);
  });
});

describe('getRowForFileIndex', () => {
  it('returns correct row for first modified file', () => {
    // modified: 3, untracked: 0, staged: 2
    // Row 0: Modified header, Row 1: first file
    expect(getRowForFileIndex(0, 3, 0, 2)).toBe(1);
  });

  it('returns correct row for middle modified file', () => {
    expect(getRowForFileIndex(1, 3, 0, 2)).toBe(2);
  });

  it('returns correct row for last modified file', () => {
    expect(getRowForFileIndex(2, 3, 0, 2)).toBe(3);
  });

  it('returns correct row for first staged file (no untracked)', () => {
    // modified: 3, untracked: 0, staged: 2
    // modified section (header + 3 files = 4) + spacer (1) + staged header (1) = row 6
    expect(getRowForFileIndex(3, 3, 0, 2)).toBe(6);
  });

  it('returns correct row for last staged file', () => {
    expect(getRowForFileIndex(4, 3, 0, 2)).toBe(7);
  });

  it('handles only staged files', () => {
    // modified: 0, untracked: 0, staged: 3
    // staged header at row 1, first file at row 1
    expect(getRowForFileIndex(0, 0, 0, 3)).toBe(1);
    expect(getRowForFileIndex(2, 0, 0, 3)).toBe(3);
  });

  it('handles only modified files', () => {
    expect(getRowForFileIndex(0, 3, 0, 0)).toBe(1);
    expect(getRowForFileIndex(2, 3, 0, 0)).toBe(3);
  });

  it('handles only untracked files', () => {
    // modified: 0, untracked: 3, staged: 0
    expect(getRowForFileIndex(0, 0, 3, 0)).toBe(1);
    expect(getRowForFileIndex(2, 0, 3, 0)).toBe(3);
  });

  it('handles modified + untracked', () => {
    // modified: 2, untracked: 2, staged: 0
    // modified section: header (1) + 2 files
    // spacer (1)
    // untracked section: header (1) + 2 files
    expect(getRowForFileIndex(0, 2, 2, 0)).toBe(1); // first modified
    expect(getRowForFileIndex(1, 2, 2, 0)).toBe(2); // second modified
    expect(getRowForFileIndex(2, 2, 2, 0)).toBe(5); // first untracked (row 3=spacer, row 4=header, row 5=file)
    expect(getRowForFileIndex(3, 2, 2, 0)).toBe(6); // second untracked
  });

  it('handles all three sections', () => {
    // modified: 1, untracked: 1, staged: 1
    // modified section: header (row 1) + 1 file (row 1) = 2 rows
    // spacer (1)
    // untracked section: header + 1 file = 2 rows
    // spacer (1)
    // staged section: header + 1 file = 2 rows
    expect(getRowForFileIndex(0, 1, 1, 1)).toBe(1); // modified file (after header)
    expect(getRowForFileIndex(1, 1, 1, 1)).toBe(4); // untracked file (2 + 1 spacer + 1 header)
    expect(getRowForFileIndex(2, 1, 1, 1)).toBe(7); // staged file (4 + 1 file + 1 spacer + 1 header)
  });
});

describe('calculateScrollOffset', () => {
  it('returns current offset when row is visible', () => {
    expect(calculateScrollOffset(5, 2, 10)).toBe(2);
  });

  it('scrolls up when row is above visible area', () => {
    expect(calculateScrollOffset(1, 5, 10)).toBe(0);
  });

  it('scrolls down when row is below visible area', () => {
    expect(calculateScrollOffset(15, 2, 10)).toBe(6);
  });

  it('handles edge case at top of visible area', () => {
    expect(calculateScrollOffset(2, 2, 10)).toBe(2);
  });

  it('handles edge case at bottom of visible area', () => {
    expect(calculateScrollOffset(11, 2, 10)).toBe(2);
  });

  it('handles edge case just past bottom of visible area', () => {
    expect(calculateScrollOffset(12, 2, 10)).toBe(3);
  });

  it('prevents negative scroll offset', () => {
    expect(calculateScrollOffset(0, 5, 10)).toBe(0);
  });
});
