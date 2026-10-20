/**
 * The hook-file read throttle. start() is never called, so no chokidar
 * watcher exists: file events are driven through onFileEvent(), the seam
 * the watcher's change/add handlers call, against a real temp file.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilePathWatcher, FILE_EVENT_COOLDOWN_MS, type WatcherState } from './FilePathWatcher.js';

let dir: string;
let hookFile: string;
let watcher: FilePathWatcher;
let seen: string[];

beforeEach(() => {
  jest.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-hook-'));
  hookFile = path.join(dir, 'hook');
  fs.writeFileSync(hookFile, '');
  watcher = new FilePathWatcher(hookFile);
  seen = [];
  watcher.on('path-change', (state: WatcherState) => {
    seen.push(state.rawContent ?? '');
  });
});

afterEach(() => {
  watcher.stop();
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(target: string): void {
  fs.appendFileSync(hookFile, `${target}\n`);
}

describe('FilePathWatcher read throttle', () => {
  test('an isolated event reads at once, with no timer in between', () => {
    write('/repo/a');
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a']);
    expect(watcher.state.path).toBe('/repo/a');
  });

  test('a burst inside the cooldown yields one trailing read of the newest target', () => {
    write('/repo/a');
    watcher.onFileEvent();
    write('/repo/b');
    watcher.onFileEvent();
    write('/repo/c');
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a']);

    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS - 1);
    expect(seen).toEqual(['/repo/a']);
    jest.advanceTimersByTime(1);
    expect(seen).toEqual(['/repo/a', '/repo/c']);
  });

  test('a quiet cooldown ends without emitting; the next event reads at once again', () => {
    write('/repo/a');
    watcher.onFileEvent();
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS);
    expect(seen).toEqual(['/repo/a']);

    write('/repo/b');
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a', '/repo/b']);
  });

  test('a write inside the cooldown whose event chokidar dropped is still read at its end', () => {
    write('/repo/a');
    watcher.onFileEvent();
    write('/repo/b');
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS - 1);
    expect(seen).toEqual(['/repo/a']);
    jest.advanceTimersByTime(1);
    expect(seen).toEqual(['/repo/a', '/repo/b']);

    // No event arrived during the window, so no further window chains.
    write('/repo/c');
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS * 3);
    expect(seen).toEqual(['/repo/a', '/repo/b']);
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a', '/repo/b', '/repo/c']);
  });

  test('a trailing read starts a new cooldown, so a steady stream reads once per window', () => {
    write('/repo/a');
    watcher.onFileEvent();
    write('/repo/b');
    watcher.onFileEvent();
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS);
    expect(seen).toEqual(['/repo/a', '/repo/b']);

    write('/repo/c');
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a', '/repo/b']);
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS);
    expect(seen).toEqual(['/repo/a', '/repo/b', '/repo/c']);
  });

  test('a rewrite of the same target does not emit again', () => {
    write('/repo/a');
    watcher.onFileEvent();
    write('/repo/a');
    watcher.onFileEvent();
    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS);
    expect(seen).toEqual(['/repo/a']);
  });

  test('a file briefly missing is skipped; the next event reads it', () => {
    fs.rmSync(hookFile);
    watcher.onFileEvent();
    expect(seen).toEqual([]);

    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS);
    write('/repo/a');
    watcher.onFileEvent();
    expect(seen).toEqual(['/repo/a']);
  });

  test('stop() cancels the trailing read', () => {
    write('/repo/a');
    watcher.onFileEvent();
    write('/repo/b');
    watcher.onFileEvent();
    watcher.stop();

    jest.advanceTimersByTime(FILE_EVENT_COOLDOWN_MS * 2);
    expect(seen).toEqual(['/repo/a']);
  });

  test('the cooldown length is the constructor argument', () => {
    const quick = new FilePathWatcher(hookFile, 10);
    const quickSeen: string[] = [];
    quick.on('path-change', (state) => quickSeen.push(state.rawContent ?? ''));
    try {
      write('/repo/a');
      quick.onFileEvent();
      write('/repo/b');
      quick.onFileEvent();
      jest.advanceTimersByTime(10);
      expect(quickSeen).toEqual(['/repo/a', '/repo/b']);
    } finally {
      quick.stop();
    }
  });
});
