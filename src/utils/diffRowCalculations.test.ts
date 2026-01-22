import { describe, it, expect } from 'vitest';
import {
  getLineContent,
  getLineNumWidth,
  getDiffLineWidth,
  getDiffLineRowCount,
  getDiffTotalRows,
} from './diffRowCalculations.js';
import { DiffLine, DiffResult } from '../git/diff.js';

describe('getLineContent', () => {
  it('removes leading + from additions', () => {
    const line: DiffLine = { type: 'addition', content: '+hello world', newLineNum: 1 };
    expect(getLineContent(line)).toBe('hello world');
  });

  it('removes leading - from deletions', () => {
    const line: DiffLine = { type: 'deletion', content: '-goodbye world', oldLineNum: 1 };
    expect(getLineContent(line)).toBe('goodbye world');
  });

  it('removes leading space from context lines', () => {
    const line: DiffLine = { type: 'context', content: ' unchanged', oldLineNum: 1, newLineNum: 1 };
    expect(getLineContent(line)).toBe('unchanged');
  });

  it('returns content unchanged for headers', () => {
    const line: DiffLine = { type: 'header', content: 'diff --git a/foo b/foo' };
    expect(getLineContent(line)).toBe('diff --git a/foo b/foo');
  });

  it('handles empty content after prefix', () => {
    const line: DiffLine = { type: 'addition', content: '+', newLineNum: 1 };
    expect(getLineContent(line)).toBe('');
  });
});

describe('getLineNumWidth', () => {
  it('returns minimum width of 3 for small line numbers', () => {
    const lines: DiffLine[] = [
      { type: 'addition', content: '+a', newLineNum: 1 },
      { type: 'addition', content: '+b', newLineNum: 5 },
    ];
    expect(getLineNumWidth(lines)).toBe(3);
  });

  it('expands for larger line numbers', () => {
    const lines: DiffLine[] = [{ type: 'addition', content: '+a', newLineNum: 1000 }];
    expect(getLineNumWidth(lines)).toBe(4);
  });

  it('considers both old and new line numbers', () => {
    const lines: DiffLine[] = [
      { type: 'deletion', content: '-a', oldLineNum: 99999 },
      { type: 'addition', content: '+b', newLineNum: 1 },
    ];
    expect(getLineNumWidth(lines)).toBe(5);
  });

  it('returns 3 for empty array', () => {
    expect(getLineNumWidth([])).toBe(3);
  });
});

describe('getDiffLineWidth', () => {
  const lineNumWidth = 3;

  describe('content lines (addition/deletion/context)', () => {
    it('calculates width for short addition', () => {
      const line: DiffLine = { type: 'addition', content: '+hi', newLineNum: 1 };
      // paddingX(2) + lineNum(3) + space(1) + symbol(1) + space(1) + content(2) = 10
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(10);
    });

    it('calculates width for longer content', () => {
      const line: DiffLine = { type: 'deletion', content: '-' + 'x'.repeat(50), oldLineNum: 1 };
      // paddingX(2) + lineNum(3) + space(1) + symbol(1) + space(1) + content(50) = 58
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(58);
    });

    it('handles empty content', () => {
      const line: DiffLine = { type: 'addition', content: '+', newLineNum: 1 };
      // paddingX(2) + lineNum(3) + space(1) + symbol(1) + space(1) + content(0) = 8
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(8);
    });
  });

  describe('header lines', () => {
    it('calculates width for diff --git header', () => {
      const line: DiffLine = { type: 'header', content: 'diff --git a/foo.txt b/foo.txt' };
      // paddingX(2) + "── " + "foo.txt" + " ──" = 2 + 3 + 7 + 3 = 15
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(15);
    });

    it('calculates width for other headers', () => {
      const line: DiffLine = { type: 'header', content: 'new file mode 100644' };
      // paddingX(2) + content(20) = 22
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(22);
    });
  });

  describe('hunk headers', () => {
    it('calculates width for simple hunk', () => {
      const line: DiffLine = { type: 'hunk', content: '@@ -1 +1 @@' };
      // "Lines 1 → 1" = 11 chars + paddingX(2) = 13
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(13);
    });

    it('calculates width for hunk with ranges', () => {
      const line: DiffLine = { type: 'hunk', content: '@@ -10,5 +20,8 @@' };
      // "Lines 10-14 → 20-27" = 19 chars + paddingX(2) = 21
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(21);
    });

    it('calculates width for hunk with context', () => {
      const line: DiffLine = { type: 'hunk', content: '@@ -1 +1 @@ function foo()' };
      // "Lines 1 → 1" = 11 + " function foo()" = 15 + paddingX(2) = 28
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(28);
    });

    it('handles malformed hunk headers gracefully', () => {
      const line: DiffLine = { type: 'hunk', content: 'not a real hunk' };
      // Falls back to content length + padding
      expect(getDiffLineWidth(line, lineNumWidth)).toBe(17);
    });
  });
});

describe('getDiffLineRowCount', () => {
  const lineNumWidth = 3;

  it('returns 1 for lines that fit', () => {
    const line: DiffLine = { type: 'addition', content: '+short', newLineNum: 1 };
    expect(getDiffLineRowCount(line, lineNumWidth, 80)).toBe(1);
  });

  it('returns 2 for lines that wrap once', () => {
    const line: DiffLine = { type: 'addition', content: '+' + 'x'.repeat(100), newLineNum: 1 };
    // Width = 2 + 3 + 1 + 1 + 1 + 100 = 108
    // 108 / 80 = 1.35 → ceil = 2
    expect(getDiffLineRowCount(line, lineNumWidth, 80)).toBe(2);
  });

  it('returns 3 for lines that wrap twice', () => {
    const line: DiffLine = { type: 'addition', content: '+' + 'x'.repeat(200), newLineNum: 1 };
    // Width = 2 + 3 + 1 + 1 + 1 + 200 = 208
    // 208 / 80 = 2.6 → ceil = 3
    expect(getDiffLineRowCount(line, lineNumWidth, 80)).toBe(3);
  });

  it('handles narrow terminal', () => {
    const line: DiffLine = { type: 'addition', content: '+' + 'x'.repeat(20), newLineNum: 1 };
    // contentWidth = 10 - 3 (lineNumWidth) - 5 (prefix) = 2 chars per row
    // 20 chars / 2 = 10 rows
    expect(getDiffLineRowCount(line, lineNumWidth, 10)).toBe(10);
  });

  it('returns 1 for invalid terminal width', () => {
    const line: DiffLine = { type: 'addition', content: '+test', newLineNum: 1 };
    expect(getDiffLineRowCount(line, lineNumWidth, 0)).toBe(1);
    expect(getDiffLineRowCount(line, lineNumWidth, -1)).toBe(1);
  });
});

describe('getDiffTotalRows', () => {
  it('returns 0 for null diff', () => {
    expect(getDiffTotalRows(null, 80)).toBe(0);
  });

  it('returns 0 for invalid terminal width', () => {
    const diff: DiffResult = {
      raw: '',
      lines: [{ type: 'addition', content: '+a', newLineNum: 1 }],
    };
    expect(getDiffTotalRows(diff, 0)).toBe(0);
  });

  it('calculates total for simple diff', () => {
    const diff: DiffResult = {
      raw: '',
      lines: [
        { type: 'addition', content: '+line1', newLineNum: 1 },
        { type: 'addition', content: '+line2', newLineNum: 2 },
        { type: 'addition', content: '+line3', newLineNum: 3 },
      ],
    };
    // All lines fit in 80 cols → 3 rows
    expect(getDiffTotalRows(diff, 80)).toBe(3);
  });

  it('accounts for wrapped lines', () => {
    const diff: DiffResult = {
      raw: '',
      lines: [
        { type: 'addition', content: '+short', newLineNum: 1 },
        { type: 'addition', content: '+' + 'x'.repeat(100), newLineNum: 2 }, // wraps to 2 rows
        { type: 'addition', content: '+short', newLineNum: 3 },
      ],
    };
    // 1 + 2 + 1 = 4 rows
    expect(getDiffTotalRows(diff, 80)).toBe(4);
  });

  it('filters out non-displayable lines', () => {
    const diff: DiffResult = {
      raw: '',
      lines: [
        { type: 'header', content: '--- a/foo' }, // filtered out
        { type: 'header', content: '+++ b/foo' }, // filtered out
        { type: 'addition', content: '+line1', newLineNum: 1 },
      ],
    };
    // Only 1 displayable line
    expect(getDiffTotalRows(diff, 80)).toBe(1);
  });

  it('includes displayable headers', () => {
    const diff: DiffResult = {
      raw: '',
      lines: [
        { type: 'header', content: 'diff --git a/foo.txt b/foo.txt' },
        { type: 'hunk', content: '@@ -1 +1 @@' },
        { type: 'addition', content: '+line1', newLineNum: 1 },
      ],
    };
    // All 3 are displayable
    expect(getDiffTotalRows(diff, 80)).toBe(3);
  });
});
