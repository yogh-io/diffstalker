import { describe, it, expect } from 'vitest';
import {
  calculatePaneBoundaries,
  getClickedFileIndex,
  getTabBoundaries,
  getClickedTab,
  isButtonAreaClick,
  isInPane,
} from './mouseCoordinates.js';
import { FileEntry } from '../git/status.js';

// Helper to create test file entries
function makeFile(
  path: string,
  staged: boolean,
  status: FileEntry['status'] = 'modified'
): FileEntry {
  return { path, status, staged };
}

describe('calculatePaneBoundaries', () => {
  it('calculates correct boundaries', () => {
    const result = calculatePaneBoundaries(10, 15, 30);
    expect(result.stagingPaneStart).toBe(3);
    expect(result.fileListEnd).toBe(12); // 2 + 10
    expect(result.separatorRow).toBe(13);
    expect(result.diffPaneStart).toBe(14);
    expect(result.diffPaneEnd).toBe(28); // 14 + 15 - 1
    expect(result.footerRow).toBe(30);
  });

  it('handles different pane sizes', () => {
    const result = calculatePaneBoundaries(5, 20, 40);
    expect(result.stagingPaneStart).toBe(3);
    expect(result.fileListEnd).toBe(7);
    expect(result.separatorRow).toBe(8);
    expect(result.diffPaneStart).toBe(9);
    expect(result.diffPaneEnd).toBe(28);
    expect(result.footerRow).toBe(40);
  });
});

describe('getClickedFileIndex', () => {
  it('returns -1 for click above file list', () => {
    const files = [makeFile('a.ts', false)];
    expect(getClickedFileIndex(2, 0, files, 3, 10)).toBe(-1);
  });

  it('returns -1 for click below file list', () => {
    const files = [makeFile('a.ts', false)];
    expect(getClickedFileIndex(15, 0, files, 3, 10)).toBe(-1);
  });

  it('returns correct index for modified files section', () => {
    const files = [makeFile('a.ts', false, 'modified'), makeFile('b.ts', false, 'modified')];
    // Row 4 = start of file list, row 0 = header "Modified:", row 1 = first file
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('returns correct index for untracked files section', () => {
    const files = [makeFile('a.ts', false, 'untracked'), makeFile('b.ts', false, 'untracked')];
    // No modified section, so untracked header at row 0, files at row 1, 2
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('returns correct index for staged files section', () => {
    const files = [makeFile('a.ts', true, 'modified'), makeFile('b.ts', true, 'added')];
    // No unstaged section, staged header at row 0, files at row 1, 2
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('handles mixed modified and untracked files', () => {
    const files = [makeFile('mod.ts', false, 'modified'), makeFile('new.ts', false, 'untracked')];
    // Modified header (0), mod.ts (1), spacer (2), Untracked header (3), new.ts (4)
    expect(getClickedFileIndex(5, 0, files, 3, 15)).toBe(0); // mod.ts
    expect(getClickedFileIndex(8, 0, files, 3, 15)).toBe(1); // new.ts
  });

  it('handles scroll offset', () => {
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
      makeFile('c.ts', false, 'modified'),
    ];
    // With scroll offset 1, clicking row 5 should map to file at list row 2
    expect(getClickedFileIndex(5, 1, files, 3, 10)).toBe(1);
  });

  it('returns -1 for click on header row', () => {
    const files = [makeFile('a.ts', false, 'modified')];
    // Row 4 with scroll 0 = list row 0 = "Modified:" header
    expect(getClickedFileIndex(4, 0, files, 3, 10)).toBe(-1);
  });
});

describe('getTabBoundaries', () => {
  it('calculates tab boundaries for standard width', () => {
    const result = getTabBoundaries(100);
    // tabsStart = 100 - 39 = 61
    expect(result.diffStart).toBe(61);
    expect(result.diffEnd).toBe(67);
    expect(result.commitStart).toBe(69);
    expect(result.commitEnd).toBe(77);
    expect(result.historyStart).toBe(79);
    expect(result.historyEnd).toBe(88);
    expect(result.compareStart).toBe(90);
    expect(result.compareEnd).toBe(99);
  });

  it('handles narrow terminal', () => {
    const result = getTabBoundaries(50);
    // tabsStart = 50 - 39 = 11
    expect(result.diffStart).toBe(11);
  });
});

describe('getClickedTab', () => {
  const terminalWidth = 100;
  // tabsStart = 100 - 39 = 61

  it('returns diff for click in diff tab area', () => {
    // diff: positions 0-6 relative to tabsStart = 61-67
    expect(getClickedTab(61, terminalWidth)).toBe('diff');
    expect(getClickedTab(64, terminalWidth)).toBe('diff');
    expect(getClickedTab(67, terminalWidth)).toBe('diff');
  });

  it('returns commit for click in commit tab area', () => {
    // commit: positions 8-16 relative to tabsStart = 69-77
    expect(getClickedTab(69, terminalWidth)).toBe('commit');
    expect(getClickedTab(73, terminalWidth)).toBe('commit');
    expect(getClickedTab(77, terminalWidth)).toBe('commit');
  });

  it('returns history for click in history tab area', () => {
    // history: positions 18-27 relative to tabsStart = 79-88
    expect(getClickedTab(79, terminalWidth)).toBe('history');
    expect(getClickedTab(83, terminalWidth)).toBe('history');
    expect(getClickedTab(88, terminalWidth)).toBe('history');
  });

  it('returns compare for click in compare tab area', () => {
    // compare: positions 29-38 relative to tabsStart = 90-99
    expect(getClickedTab(90, terminalWidth)).toBe('compare');
    expect(getClickedTab(95, terminalWidth)).toBe('compare');
    expect(getClickedTab(99, terminalWidth)).toBe('compare');
  });

  it('returns null for click outside tab area', () => {
    expect(getClickedTab(10, terminalWidth)).toBeNull();
    expect(getClickedTab(50, terminalWidth)).toBeNull();
    expect(getClickedTab(60, terminalWidth)).toBeNull();
  });
});

describe('isButtonAreaClick', () => {
  it('returns true for x <= 6', () => {
    expect(isButtonAreaClick(1)).toBe(true);
    expect(isButtonAreaClick(3)).toBe(true);
    expect(isButtonAreaClick(6)).toBe(true);
  });

  it('returns false for x > 6', () => {
    expect(isButtonAreaClick(7)).toBe(false);
    expect(isButtonAreaClick(10)).toBe(false);
    expect(isButtonAreaClick(50)).toBe(false);
  });
});

describe('isInPane', () => {
  it('returns true when y is within pane', () => {
    expect(isInPane(5, 3, 10)).toBe(true);
    expect(isInPane(3, 3, 10)).toBe(true);
    expect(isInPane(10, 3, 10)).toBe(true);
  });

  it('returns false when y is outside pane', () => {
    expect(isInPane(2, 3, 10)).toBe(false);
    expect(isInPane(11, 3, 10)).toBe(false);
    expect(isInPane(1, 3, 10)).toBe(false);
  });
});
