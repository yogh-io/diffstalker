import { describe, it, expect } from 'vitest';
import { isDisplayableDiffHeader, isDisplayableDiffLine } from './diffFilters.js';
import type { DiffLine } from '../git/diff.js';

describe('isDisplayableDiffHeader', () => {
  it('filters index headers', () => {
    expect(isDisplayableDiffHeader('index abc123..def456 100644')).toBe(false);
  });

  it('filters --- headers', () => {
    expect(isDisplayableDiffHeader('--- a/file.ts')).toBe(false);
  });

  it('filters +++ headers', () => {
    expect(isDisplayableDiffHeader('+++ b/file.ts')).toBe(false);
  });

  it('filters similarity index', () => {
    expect(isDisplayableDiffHeader('similarity index 95%')).toBe(false);
  });

  it('allows diff --git headers', () => {
    expect(isDisplayableDiffHeader('diff --git a/file.ts b/file.ts')).toBe(true);
  });

  it('allows new file mode headers', () => {
    expect(isDisplayableDiffHeader('new file mode 100644')).toBe(true);
  });

  it('allows deleted file mode headers', () => {
    expect(isDisplayableDiffHeader('deleted file mode 100644')).toBe(true);
  });

  it('allows rename from/to headers', () => {
    expect(isDisplayableDiffHeader('rename from old.ts')).toBe(true);
    expect(isDisplayableDiffHeader('rename to new.ts')).toBe(true);
  });
});

describe('isDisplayableDiffLine', () => {
  it('always displays non-header lines', () => {
    const lines: DiffLine[] = [
      { type: 'addition', content: '+added' },
      { type: 'deletion', content: '-deleted' },
      { type: 'context', content: ' context' },
      { type: 'hunk', content: '@@ -1,3 +1,4 @@' },
    ];
    for (const line of lines) {
      expect(isDisplayableDiffLine(line)).toBe(true);
    }
  });

  it('filters non-displayable header lines', () => {
    const line: DiffLine = { type: 'header', content: 'index abc..def 100644' };
    expect(isDisplayableDiffLine(line)).toBe(false);
  });

  it('displays displayable header lines', () => {
    const line: DiffLine = { type: 'header', content: 'diff --git a/f.ts b/f.ts' };
    expect(isDisplayableDiffLine(line)).toBe(true);
  });
});
