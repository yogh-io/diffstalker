import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandPath, getLastNonEmptyLine } from './pathUtils.js';

describe('expandPath', () => {
  it('expands ~/... to home directory', () => {
    expect(expandPath('~/documents')).toBe(path.join(os.homedir(), 'documents'));
  });

  it('expands bare ~ to home directory', () => {
    expect(expandPath('~')).toBe(os.homedir());
  });

  it('does not expand paths without tilde', () => {
    expect(expandPath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('does not expand tilde in the middle of a path', () => {
    expect(expandPath('/home/user/~config')).toBe('/home/user/~config');
  });

  it('expands nested tilde paths', () => {
    expect(expandPath('~/a/b/c')).toBe(path.join(os.homedir(), 'a/b/c'));
  });
});

describe('getLastNonEmptyLine', () => {
  it('returns last non-empty line', () => {
    expect(getLastNonEmptyLine('first\nsecond\nthird')).toBe('third');
  });

  it('skips trailing empty lines', () => {
    expect(getLastNonEmptyLine('first\nsecond\n\n\n')).toBe('second');
  });

  it('skips trailing whitespace-only lines', () => {
    expect(getLastNonEmptyLine('first\nsecond\n   \n  ')).toBe('second');
  });

  it('returns empty string for empty content', () => {
    expect(getLastNonEmptyLine('')).toBe('');
  });

  it('returns empty string for only whitespace', () => {
    expect(getLastNonEmptyLine('   \n  \n   ')).toBe('');
  });

  it('handles single line', () => {
    expect(getLastNonEmptyLine('only')).toBe('only');
  });

  it('trims the returned line', () => {
    expect(getLastNonEmptyLine('  padded  ')).toBe('padded');
  });
});
