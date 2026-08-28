/**
 * format tests: the small pure shell formatters — path helpers, byte
 * sizes, the status letter (one per FileStatus member, so the union
 * growing shows up here), and the journal's frozen wall-clock stamp,
 * which carries its day whenever it is not today.
 *
 * Dates are built in LOCAL time on purpose: formatClock reads local
 * calendar fields, so a UTC fixture would flip day in half the world's
 * timezones.
 */

import { describe, test, expect } from 'vitest';
import {
  basename,
  parentDir,
  splitBasename,
  formatBytes,
  statusLetter,
  formatClock,
} from './format';
import type { FileStatus } from '@diffstalker/core/git/status';

describe('path helpers', () => {
  test('basename takes the last segment', () => {
    expect(basename('/home/u/repo')).toBe('repo');
    expect(basename('/home/u/repo/')).toBe('repo');
    expect(basename('repo')).toBe('repo');
  });

  test('parentDir drops the last segment; root stays root', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
    expect(parentDir('/a/b/c/')).toBe('/a/b');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });

  test('splitBasename keeps the filename whole so the head can ellipsise', () => {
    expect(splitBasename('a/b/c.ts')).toEqual({ head: 'a/b', tail: '/c.ts' });
    expect(splitBasename('c.ts')).toEqual({ head: '', tail: 'c.ts' });
    expect(splitBasename('a/b/')).toEqual({ head: 'a/b', tail: '/' });
  });
});

describe('formatBytes', () => {
  test('scales to B / KB / MB', () => {
    expect(formatBytes(482)).toBe('482 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });
});

describe('statusLetter', () => {
  test('every FileStatus has a letter — an unmerged path is git’s U', () => {
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
      expect(statusLetter(status as FileStatus)).toBe(letter);
    }
  });
});

describe('formatClock', () => {
  const now = new Date(2026, 6, 20, 15, 30).getTime(); // Mon 20 Jul 2026, local

  test('an entry from today is a bare HH:MM', () => {
    expect(formatClock(new Date(2026, 6, 20, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatClock(new Date(2026, 6, 20, 0, 0).getTime(), now)).toBe('00:00');
  });

  test('another day carries its day — the whole point of the fix', () => {
    // Yesterday, minutes before midnight: bare HH:MM would read as today.
    expect(formatClock(new Date(2026, 6, 19, 23, 50).getTime(), now)).toBe('Jul 19 23:50');
    expect(formatClock(new Date(2026, 6, 14, 8, 0).getTime(), now)).toBe('Jul 14 08:00');
  });

  test('another year says so', () => {
    expect(formatClock(new Date(2025, 11, 31, 18, 4).getTime(), now)).toBe('Dec 31, 2025 18:04');
  });

  test('a later entry on the same day stays bare (the comparison is calendar, not elapsed)', () => {
    // 20 hours apart, same date -> no day; 4 hours apart, across midnight -> day.
    expect(formatClock(new Date(2026, 6, 20, 23, 59).getTime(), now)).toBe('23:59');
    expect(
      formatClock(new Date(2026, 6, 19, 22, 0).getTime(), new Date(2026, 6, 20, 2, 0).getTime())
    ).toBe('Jul 19 22:00');
  });
});
