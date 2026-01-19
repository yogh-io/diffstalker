import { describe, it, expect } from 'vitest';
import {
  calculatePaneHeights,
  getRowForFileIndex,
  calculateScrollOffset,
} from './layoutCalculations.js';
import { FileEntry } from '../git/status.js';

// Helper to create test file entries
function makeFile(path: string, staged: boolean): FileEntry {
  return { path, status: 'modified', staged };
}

describe('calculatePaneHeights', () => {
  it('returns minimum height of 3 for empty file list', () => {
    const result = calculatePaneHeights([], 30);
    expect(result.topPaneHeight).toBe(3);
    expect(result.bottomPaneHeight).toBe(27);
  });

  it('calculates height for only unstaged files', () => {
    const files = [
      makeFile('a.ts', false),
      makeFile('b.ts', false),
    ];
    const result = calculatePaneHeights(files, 30);
    // STAGING AREA (1) + unstaged header (1) + 2 files = 4
    expect(result.topPaneHeight).toBe(4);
    expect(result.bottomPaneHeight).toBe(26);
  });

  it('calculates height for only staged files', () => {
    const files = [
      makeFile('a.ts', true),
      makeFile('b.ts', true),
      makeFile('c.ts', true),
    ];
    const result = calculatePaneHeights(files, 30);
    // STAGING AREA (1) + staged header (1) + 3 files = 5
    expect(result.topPaneHeight).toBe(5);
    expect(result.bottomPaneHeight).toBe(25);
  });

  it('calculates height for mixed files with spacer', () => {
    const files = [
      makeFile('a.ts', false),
      makeFile('b.ts', false),
      makeFile('c.ts', true),
    ];
    const result = calculatePaneHeights(files, 30);
    // STAGING AREA (1) + unstaged header (1) + 2 unstaged + spacer (1) + staged header (1) + 1 staged = 7
    expect(result.topPaneHeight).toBe(7);
    expect(result.bottomPaneHeight).toBe(23);
  });

  it('respects maxTopRatio', () => {
    const files = Array.from({ length: 20 }, (_, i) => makeFile(`file${i}.ts`, false));
    const result = calculatePaneHeights(files, 30, 0.4);
    expect(result.topPaneHeight).toBe(12); // 30 * 0.4 = 12
    expect(result.bottomPaneHeight).toBe(18);
  });

  it('uses custom maxTopRatio', () => {
    const files = Array.from({ length: 20 }, (_, i) => makeFile(`file${i}.ts`, false));
    const result = calculatePaneHeights(files, 30, 0.6);
    expect(result.topPaneHeight).toBe(18); // 30 * 0.6 = 18
    expect(result.bottomPaneHeight).toBe(12);
  });
});

describe('getRowForFileIndex', () => {
  it('returns correct row for first unstaged file', () => {
    expect(getRowForFileIndex(0, 3, 2)).toBe(1);
  });

  it('returns correct row for middle unstaged file', () => {
    expect(getRowForFileIndex(1, 3, 2)).toBe(2);
  });

  it('returns correct row for last unstaged file', () => {
    expect(getRowForFileIndex(2, 3, 2)).toBe(3);
  });

  it('returns correct row for first staged file', () => {
    // unstaged section (header + 3 files = 4) + spacer (1) + staged header (1) = row 6
    expect(getRowForFileIndex(3, 3, 2)).toBe(6);
  });

  it('returns correct row for last staged file', () => {
    expect(getRowForFileIndex(4, 3, 2)).toBe(7);
  });

  it('handles no unstaged files', () => {
    // Only staged: staged header at row 1, first file at row 1
    expect(getRowForFileIndex(0, 0, 3)).toBe(1);
    expect(getRowForFileIndex(2, 0, 3)).toBe(3);
  });

  it('handles no staged files', () => {
    expect(getRowForFileIndex(0, 3, 0)).toBe(1);
    expect(getRowForFileIndex(2, 3, 0)).toBe(3);
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
