/**
 * Unit tests for fileCategories
 */

import { describe, test, expect } from 'bun:test';
import { categorizeFiles, getFileListSectionCounts } from './fileCategories.js';
import { FileEntry, FileStatus } from '../git/status.js';

// Helper to create test FileEntry objects
function makeFile(path: string, status: FileStatus, staged: boolean): FileEntry {
  return { path, status, staged };
}

describe('categorizeFiles', () => {
  test('returns empty arrays for empty input', () => {
    const result = categorizeFiles([]);

    expect(result.modified).toEqual([]);
    expect(result.untracked).toEqual([]);
    expect(result.staged).toEqual([]);
    expect(result.ordered).toEqual([]);
  });

  test('categorizes modified files (unstaged, non-untracked)', () => {
    const files = [
      makeFile('a.txt', 'modified', false),
      makeFile('b.txt', 'added', false),
      makeFile('c.txt', 'deleted', false),
    ];

    const result = categorizeFiles(files);

    expect(result.modified.length).toBe(3);
    expect(result.modified.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result.untracked).toEqual([]);
    expect(result.staged).toEqual([]);
  });

  test('categorizes untracked files', () => {
    const files = [
      makeFile('new1.txt', 'untracked', false),
      makeFile('new2.txt', 'untracked', false),
    ];

    const result = categorizeFiles(files);

    expect(result.modified).toEqual([]);
    expect(result.untracked.length).toBe(2);
    expect(result.untracked.map((f) => f.path)).toEqual(['new1.txt', 'new2.txt']);
    expect(result.staged).toEqual([]);
  });

  test('categorizes staged files', () => {
    const files = [
      makeFile('staged1.txt', 'modified', true),
      makeFile('staged2.txt', 'added', true),
      makeFile('staged3.txt', 'untracked', true), // untracked can also be staged
    ];

    const result = categorizeFiles(files);

    expect(result.modified).toEqual([]);
    expect(result.untracked).toEqual([]);
    expect(result.staged.length).toBe(3);
    expect(result.staged.map((f) => f.path)).toEqual(['staged1.txt', 'staged2.txt', 'staged3.txt']);
  });

  test('orders files as modified → untracked → staged', () => {
    const files = [
      makeFile('staged.txt', 'modified', true),
      makeFile('untracked.txt', 'untracked', false),
      makeFile('modified.txt', 'modified', false),
    ];

    const result = categorizeFiles(files);

    expect(result.ordered.map((f) => f.path)).toEqual([
      'modified.txt', // Modified first
      'untracked.txt', // Untracked second
      'staged.txt', // Staged last
    ]);
  });

  test('preserves original order within each category', () => {
    const files = [
      makeFile('z-staged.txt', 'added', true),
      makeFile('a-staged.txt', 'added', true),
      makeFile('z-modified.txt', 'modified', false),
      makeFile('a-modified.txt', 'modified', false),
      makeFile('z-untracked.txt', 'untracked', false),
      makeFile('a-untracked.txt', 'untracked', false),
    ];

    const result = categorizeFiles(files);

    // Within each category, original order is preserved (not sorted)
    expect(result.modified.map((f) => f.path)).toEqual(['z-modified.txt', 'a-modified.txt']);
    expect(result.untracked.map((f) => f.path)).toEqual(['z-untracked.txt', 'a-untracked.txt']);
    expect(result.staged.map((f) => f.path)).toEqual(['z-staged.txt', 'a-staged.txt']);
  });

  test('handles mixed file statuses correctly', () => {
    const files = [
      makeFile('mod1.txt', 'modified', false),
      makeFile('new1.txt', 'untracked', false),
      makeFile('staged1.txt', 'modified', true),
      makeFile('mod2.txt', 'deleted', false),
      makeFile('new2.txt', 'untracked', false),
      makeFile('staged2.txt', 'renamed', true),
    ];

    const result = categorizeFiles(files);

    expect(result.modified.length).toBe(2);
    expect(result.untracked.length).toBe(2);
    expect(result.staged.length).toBe(2);
    expect(result.ordered.length).toBe(6);

    // Verify order
    expect(result.ordered.map((f) => f.path)).toEqual([
      'mod1.txt',
      'mod2.txt',
      'new1.txt',
      'new2.txt',
      'staged1.txt',
      'staged2.txt',
    ]);
  });
});

describe('getFileListSectionCounts', () => {
  test('returns zero counts for empty input', () => {
    const result = getFileListSectionCounts([]);

    expect(result.modifiedCount).toBe(0);
    expect(result.untrackedCount).toBe(0);
    expect(result.stagedCount).toBe(0);
  });

  test('counts files correctly', () => {
    const files = [
      makeFile('mod1.txt', 'modified', false),
      makeFile('mod2.txt', 'deleted', false),
      makeFile('new1.txt', 'untracked', false),
      makeFile('staged1.txt', 'added', true),
      makeFile('staged2.txt', 'modified', true),
      makeFile('staged3.txt', 'renamed', true),
    ];

    const result = getFileListSectionCounts(files);

    expect(result.modifiedCount).toBe(2);
    expect(result.untrackedCount).toBe(1);
    expect(result.stagedCount).toBe(3);
  });
});
