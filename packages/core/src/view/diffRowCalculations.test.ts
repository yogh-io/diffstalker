import { describe, it, expect } from 'vitest';
import { getLineContent } from './diffRowCalculations.js';
import type { DiffLine } from '../git/diff.js';

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
