import { describe, test, expect } from 'bun:test';
import type { GitState } from '@diffstalker/core/managers/WorkingTreeManager';
import { mapToRecord, serializeHunkCounts, serializeSharedState, toWire } from './serialize.js';

describe('mapToRecord', () => {
  test('converts a string-keyed Map to a plain object', () => {
    const map = new Map([
      ['src/a.ts', 3],
      ['src/b.ts', 1],
    ]);
    expect(mapToRecord(map)).toEqual({ 'src/a.ts': 3, 'src/b.ts': 1 });
  });

  test('empty Map becomes an empty object', () => {
    expect(mapToRecord(new Map())).toEqual({});
  });
});

describe('serializeHunkCounts', () => {
  test('null stays null', () => {
    expect(serializeHunkCounts(null)).toBeNull();
  });

  test('both Maps become records', () => {
    const wire = serializeHunkCounts({
      staged: new Map([['a.ts', 2]]),
      unstaged: new Map([['b.ts', 5]]),
    });
    expect(wire).toEqual({ staged: { 'a.ts': 2 }, unstaged: { 'b.ts': 5 } });
  });
});

describe('serializeSharedState', () => {
  test('keeps status and hunkCounts, drops per-client fields', () => {
    const state: GitState = {
      status: {
        files: [{ path: 'a.ts', status: 'modified', staged: false }],
        branch: { current: 'main', ahead: 0, behind: 0 },
        isRepo: true,
      },
      diff: { raw: 'SECRET-PER-CLIENT', lines: [] },
      combinedFileDiffs: null,
      selectedFile: { path: 'a.ts', status: 'modified', staged: false },
      isLoading: false,
      error: null,
      hunkCounts: { staged: new Map(), unstaged: new Map([['a.ts', 1]]) },
      stashList: [{ index: 0, message: 'WIP on main' }],
      operationInProgress: null,
    };

    const wire = serializeSharedState(state);
    expect(wire).toEqual({
      status: state.status,
      hunkCounts: { staged: {}, unstaged: { 'a.ts': 1 } },
      error: null,
      stashList: [{ index: 0, message: 'WIP on main' }],
      operationInProgress: null,
    });
    expect(JSON.stringify(wire)).not.toContain('SECRET-PER-CLIENT');
    expect(wire).not.toHaveProperty('selectedFile');
    expect(wire).not.toHaveProperty('diff');
  });

  test('carries the manager error and in-progress operation onto the wire', () => {
    const state: GitState = {
      status: null,
      diff: null,
      combinedFileDiffs: null,
      selectedFile: null,
      isLoading: false,
      error: 'Git watcher error: boom',
      hunkCounts: null,
      stashList: [],
      operationInProgress: 'rebase',
    };
    const wire = serializeSharedState(state);
    expect(wire.error).toBe('Git watcher error: boom');
    expect(wire.operationInProgress).toBe('rebase');
  });
});

describe('toWire', () => {
  test('Date becomes an ISO string', () => {
    const date = new Date('2026-07-19T12:34:56.000Z');
    expect(toWire(date)).toBe('2026-07-19T12:34:56.000Z');
  });

  test('Map becomes a plain object, recursively', () => {
    const value = new Map<string, unknown>([
      ['when', new Date(0)],
      ['inner', new Map([['n', 1]])],
    ]);
    expect(toWire(value)).toEqual({
      when: '1970-01-01T00:00:00.000Z',
      inner: { n: 1 },
    });
  });

  test('arrays and nested objects are walked', () => {
    const value = { list: [new Date(0), { m: new Map([['k', 'v']]) }] };
    expect(toWire(value)).toEqual({
      list: ['1970-01-01T00:00:00.000Z', { m: { k: 'v' } }],
    });
  });

  test('primitives and null pass through', () => {
    expect(toWire(null)).toBeNull();
    expect(toWire(42)).toBe(42);
    expect(toWire('x')).toBe('x');
    expect(toWire(true)).toBe(true);
  });
});
