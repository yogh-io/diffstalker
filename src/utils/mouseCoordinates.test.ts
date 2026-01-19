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
function makeFile(path: string, staged: boolean, status: FileEntry['status'] = 'modified'): FileEntry {
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
    const files = [
      makeFile('a.ts', false, 'modified'),
      makeFile('b.ts', false, 'modified'),
    ];
    // Row 4 = start of file list, row 0 = header "Modified:", row 1 = first file
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('returns correct index for untracked files section', () => {
    const files = [
      makeFile('a.ts', false, 'untracked'),
      makeFile('b.ts', false, 'untracked'),
    ];
    // No modified section, so untracked header at row 0, files at row 1, 2
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('returns correct index for staged files section', () => {
    const files = [
      makeFile('a.ts', true, 'modified'),
      makeFile('b.ts', true, 'added'),
    ];
    // No unstaged section, staged header at row 0, files at row 1, 2
    expect(getClickedFileIndex(5, 0, files, 3, 10)).toBe(0);
    expect(getClickedFileIndex(6, 0, files, 3, 10)).toBe(1);
  });

  it('handles mixed modified and untracked files', () => {
    const files = [
      makeFile('mod.ts', false, 'modified'),
      makeFile('new.ts', false, 'untracked'),
    ];
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
    const files = [
      makeFile('a.ts', false, 'modified'),
    ];
    // Row 4 with scroll 0 = list row 0 = "Modified:" header
    expect(getClickedFileIndex(4, 0, files, 3, 10)).toBe(-1);
  });
});

describe('getTabBoundaries', () => {
  it('calculates tab boundaries for standard width', () => {
    const result = getTabBoundaries(100);
    // tabsStart = 100 - 34 = 66
    expect(result.diffStart).toBe(66);
    expect(result.diffEnd).toBe(73);
    expect(result.commitStart).toBe(74);
    expect(result.commitEnd).toBe(83);
    expect(result.historyStart).toBe(84);
    expect(result.historyEnd).toBe(94);
    expect(result.prStart).toBe(95);
    expect(result.prEnd).toBe(100);
  });

  it('handles narrow terminal', () => {
    const result = getTabBoundaries(50);
    // tabsStart = 50 - 34 = 16
    expect(result.diffStart).toBe(16);
  });
});

describe('getClickedTab', () => {
  const terminalWidth = 100;

  it('returns diff for click in diff tab area', () => {
    expect(getClickedTab(66, terminalWidth)).toBe('diff');
    expect(getClickedTab(70, terminalWidth)).toBe('diff');
    expect(getClickedTab(73, terminalWidth)).toBe('diff');
  });

  it('returns commit for click in commit tab area', () => {
    expect(getClickedTab(74, terminalWidth)).toBe('commit');
    expect(getClickedTab(80, terminalWidth)).toBe('commit');
    expect(getClickedTab(83, terminalWidth)).toBe('commit');
  });

  it('returns history for click in history tab area', () => {
    expect(getClickedTab(84, terminalWidth)).toBe('history');
    expect(getClickedTab(90, terminalWidth)).toBe('history');
    expect(getClickedTab(94, terminalWidth)).toBe('history');
  });

  it('returns pr for click in PR tab area', () => {
    expect(getClickedTab(95, terminalWidth)).toBe('pr');
    expect(getClickedTab(98, terminalWidth)).toBe('pr');
    expect(getClickedTab(100, terminalWidth)).toBe('pr');
  });

  it('returns null for click outside tab area', () => {
    expect(getClickedTab(10, terminalWidth)).toBeNull();
    expect(getClickedTab(50, terminalWidth)).toBeNull();
    expect(getClickedTab(65, terminalWidth)).toBeNull();
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
