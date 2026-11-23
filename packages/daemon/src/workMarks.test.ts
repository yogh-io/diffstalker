import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpError } from './router.js';
import { MAX_MARKS, WorkMarksStore, parseMarkRequest } from './workMarks.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workmarks-'));
  file = path.join(dir, 'state', 'work.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const KEY = '/repos/calculator\nfeature';

describe('WorkMarksStore.apply', () => {
  test('track, then drop', () => {
    const store = new WorkMarksStore(file);
    expect(store.apply({ key: KEY, action: 'track' }, 100).tracked).toEqual({ [KEY]: { at: 100 } });
    expect(store.apply({ key: KEY, action: 'drop' }, 200).tracked).toEqual({});
  });

  test('dismiss, then undismiss', () => {
    const store = new WorkMarksStore(file);
    const marks = store.apply({ key: KEY, action: 'dismiss', fingerprint: 'abc|0|0' }, 100);
    expect(marks.dismissed).toEqual({ [KEY]: { fingerprint: 'abc|0|0', at: 100 } });
    expect(store.apply({ key: KEY, action: 'undismiss' }, 200).dismissed).toEqual({});
  });

  test('prune drops keys from both kinds before the action', () => {
    const store = new WorkMarksStore(file);
    store.apply({ key: 'a', action: 'track' }, 1);
    store.apply({ key: 'b', action: 'dismiss', fingerprint: 'x' }, 2);
    store.apply({ key: 'c', action: 'track' }, 3);
    const marks = store.apply({ key: 'a', action: 'track', prune: ['a', 'b'] }, 4);
    expect(marks).toEqual({ tracked: { a: { at: 4 }, c: { at: 3 } }, dismissed: {} });
  });

  test('persists across two stores on one file', () => {
    const first = new WorkMarksStore(file);
    first.apply({ key: KEY, action: 'track' }, 100);
    first.apply(
      { key: 'pr:aerius/calculator#9087', action: 'dismiss', fingerprint: '2026-11-20T10:00:00Z' },
      200
    );
    const second = new WorkMarksStore(file);
    expect(second.load()).toEqual(first.marks);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['work.json']);
  });

  test('a key named __proto__ stays a key', () => {
    const store = new WorkMarksStore(file);
    const marks = store.apply({ key: '__proto__', action: 'track' }, 1);
    expect(Object.keys(marks.tracked)).toEqual(['__proto__']);
    expect(new WorkMarksStore(file).load()).toEqual(marks);
  });

  test('more marks than the cap is a 400 and nothing changes', () => {
    const store = new WorkMarksStore(null);
    for (let i = 0; i < MAX_MARKS; i++) store.apply({ key: `k${i}`, action: 'track' }, i);
    expect(() => store.apply({ key: 'one more', action: 'track' }, 0)).toThrow(HttpError);
    expect(Object.keys(store.marks.tracked)).toHaveLength(MAX_MARKS);
  });

  test('a failed write throws and leaves the marks as they were', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state'), 'a file where the directory should be');
    const store = new WorkMarksStore(file);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => store.apply({ key: KEY, action: 'track' }, 1)).toThrow();
    } finally {
      stderr.mockRestore();
    }
    expect(store.marks).toEqual({ tracked: {}, dismissed: {} });
  });

  test("two daemons on one file keep each other's marks", () => {
    const released = new WorkMarksStore(file);
    const dev = new WorkMarksStore(file);
    released.load();
    dev.load();
    released.apply({ key: 'tracked', action: 'track' }, 1);
    const marks = dev.apply({ key: 'hidden', action: 'dismiss', fingerprint: 'f' }, 2);
    expect(marks).toEqual({
      tracked: { tracked: { at: 1 } },
      dismissed: { hidden: { fingerprint: 'f', at: 2 } },
    });
    expect(released.load()).toEqual(marks);
  });
});

describe('WorkMarksStore.load', () => {
  let stderr: ReturnType<typeof spyOn>;
  beforeEach(() => {
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  test('a missing file is no marks, quietly', () => {
    expect(new WorkMarksStore(file).load()).toEqual({ tracked: {}, dismissed: {} });
    expect(stderr).not.toHaveBeenCalled();
  });

  test('a file that is not JSON starts empty and logs', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(new WorkMarksStore(file).load()).toEqual({ tracked: {}, dismissed: {} });
    expect(stderr).toHaveBeenCalled();
  });

  test('only well-shaped entries are believed', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        tracked: { good: { at: 1 }, noTime: {}, badTime: { at: 'x' }, '': { at: 1 } },
        dismissed: {
          good: { fingerprint: 'f', at: 2 },
          noPrint: { at: 2 },
          long: { fingerprint: 'x'.repeat(513), at: 2 },
        },
        extra: true,
      })
    );
    expect(new WorkMarksStore(file).load()).toEqual({
      tracked: { good: { at: 1 } },
      dismissed: { good: { fingerprint: 'f', at: 2 } },
    });
  });
});

describe('parseMarkRequest', () => {
  test('accepts each action', () => {
    expect(parseMarkRequest({ key: KEY, action: 'track' })).toEqual({ key: KEY, action: 'track' });
    expect(
      parseMarkRequest({ key: KEY, action: 'dismiss', fingerprint: 'f', prune: ['x'] })
    ).toEqual({
      key: KEY,
      action: 'dismiss',
      fingerprint: 'f',
      prune: ['x'],
    });
  });

  const refused: Array<[string, unknown]> = [
    ['no body', undefined],
    ['an array', [KEY]],
    ['no key', { action: 'track' }],
    ['an empty key', { key: '', action: 'track' }],
    ['a key with a NUL', { key: 'a\0b', action: 'track' }],
    ['a key too long', { key: 'x'.repeat(4097), action: 'track' }],
    ['an unknown action', { key: KEY, action: 'done' }],
    ['dismiss without a fingerprint', { key: KEY, action: 'dismiss' }],
    ['a fingerprint too long', { key: KEY, action: 'dismiss', fingerprint: 'x'.repeat(513) }],
    ['a fingerprint that is not text', { key: KEY, action: 'dismiss', fingerprint: 5 }],
    ['prune that is not a list', { key: KEY, action: 'track', prune: 'x' }],
    ['prune with a bad key', { key: KEY, action: 'track', prune: [''] }],
    [
      'prune too long',
      {
        key: KEY,
        action: 'track',
        prune: Array.from({ length: MAX_MARKS + 1 }, (_, i) => `k${i}`),
      },
    ],
  ];
  for (const [name, body] of refused) {
    test(`refuses ${name}`, () => {
      let thrown: unknown;
      try {
        parseMarkRequest(body);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(400);
    });
  }
});
