/**
 * fileRowFormatters tests: the status letter and colour every file row in
 * the CLI is built from. Both tables are typed Record<FileStatus, …> so a
 * new FileStatus member fails to compile here instead of rendering as a
 * blank glyph — which is exactly what 'conflicted' did.
 */

import { describe, it, expect } from 'bun:test';
import { getStatusChar, getStatusColor } from './fileRowFormatters.js';
import type { FileStatus } from '@diffstalker/core/git/status';

describe('getStatusChar', () => {
  it('gives every FileStatus a letter — an unmerged path is git’s U', () => {
    const letters: Record<FileStatus, string> = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      untracked: '?',
      renamed: 'R',
      copied: 'C',
      conflicted: 'U',
    };
    for (const [status, letter] of Object.entries(letters)) {
      expect(getStatusChar(status as FileStatus)).toBe(letter);
    }
  });
});

describe('getStatusColor', () => {
  it('gives every FileStatus a colour, and a conflict is not the deleted red', () => {
    const colors: Record<FileStatus, string> = {
      modified: 'yellow',
      added: 'green',
      deleted: 'red',
      untracked: 'gray',
      renamed: 'blue',
      copied: 'cyan',
      conflicted: 'brightred',
    };
    for (const [status, color] of Object.entries(colors)) {
      expect(getStatusColor(status as FileStatus)).toBe(color);
    }
    expect(getStatusColor('conflicted')).not.toBe(getStatusColor('deleted'));
  });
});
