/**
 * The registry's linger window: a released repo keeps its live manager for
 * a while so a reopen inside the window is warm. Clients see the same
 * close/open as before (onClosed, then onOpened on reopen; not listed in
 * between). Real managers on real fixture repos, no daemon.
 */

import { describe, test, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { RepoRegistry, LINGER_MS, LINGER_CAP, type RepoHandle } from './repoRegistry.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-registry';

function makeRepo(name: string): string {
  const repoPath = createFixtureRepo(name);
  writeFixtureFile(repoPath, 'file.txt', 'content\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial commit"');
  return repoPath;
}

let registry: RepoRegistry;
let events: string[];
let repoA: string;
let repoB: string;
let repoC: string;

beforeEach(() => {
  events = [];
  registry = new RepoRegistry({
    onOpened: (handle) => events.push(`opened:${handle.path}`),
    onClosed: (id) => events.push(`closed:${id}`),
  });
  repoA = makeRepo(`${FIXTURE}-a`);
  repoB = makeRepo(`${FIXTURE}-b`);
  repoC = makeRepo(`${FIXTURE}-c`);
});

afterEach(() => {
  jest.useRealTimers();
  registry.disposeAll();
  for (const name of ['a', 'b', 'c']) removeFixtureRepo(`${FIXTURE}-${name}`);
});

async function openAndRelease(repoPath: string): Promise<RepoHandle> {
  const { handle } = await registry.openRepo(repoPath);
  registry.closeRepo(handle.id);
  return handle;
}

describe('RepoRegistry linger', () => {
  test('the constants are what the design says', () => {
    expect(LINGER_MS).toBe(10 * 60 * 1000);
    expect(LINGER_CAP).toBe(4);
  });

  test('a released repo is closed for clients but reopens on the same live manager', async () => {
    const first = await registry.openRepo(repoA);
    expect(first.created).toBe(true);
    const dispose = spyOn(first.handle.manager, 'dispose');

    expect(registry.closeRepo(first.handle.id)).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(registry.getRepo(first.handle.id)).toBeUndefined();
    expect(registry.listRepos()).toEqual([]);

    const again = await registry.openRepo(repoA);
    expect(again.created).toBe(false);
    expect(again.handle).toBe(first.handle);
    expect(again.handle.manager).toBe(first.handle.manager);
    expect(again.handle.refCount).toBe(1);
    expect(registry.getRepo(first.handle.id)).toBe(first.handle);
    expect(registry.listRepos()).toEqual([first.handle]);
    expect(events).toEqual([`opened:${repoA}`, `closed:${first.handle.id}`, `opened:${repoA}`]);
    expect(dispose).not.toHaveBeenCalled();
  });

  test('a revived repo is refreshed in the background, for what its watchers missed', async () => {
    const handle = await openAndRelease(repoA);
    const refresh = spyOn(handle.manager.workingTree, 'scheduleRefresh');
    await registry.openRepo(repoA);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('a revived repo is refcounted from one again', async () => {
    const handle = await openAndRelease(repoA);
    await registry.openRepo(repoA);
    await registry.openRepo(repoA);
    expect(handle.refCount).toBe(2);
    expect(registry.closeRepo(handle.id)).toBe(false);
    expect(registry.closeRepo(handle.id)).toBe(true);
  });

  test('the linger timer disposes the manager after LINGER_MS', async () => {
    const { handle } = await registry.openRepo(repoA);
    const dispose = spyOn(handle.manager, 'dispose');

    jest.useFakeTimers();
    registry.closeRepo(handle.id);
    jest.advanceTimersByTime(LINGER_MS - 1);
    expect(dispose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    jest.useRealTimers();

    // Gone for good: the next open starts fresh.
    const fresh = await registry.openRepo(repoA);
    expect(fresh.created).toBe(true);
    expect(fresh.handle.manager).not.toBe(handle.manager);
  });

  test('a reopen inside the window cancels the timer', async () => {
    const { handle } = await registry.openRepo(repoA);
    const dispose = spyOn(handle.manager, 'dispose');

    jest.useFakeTimers();
    registry.closeRepo(handle.id);
    jest.useRealTimers();
    await registry.openRepo(repoA);
    jest.useFakeTimers();
    jest.advanceTimersByTime(LINGER_MS * 2);
    expect(dispose).not.toHaveBeenCalled();
  });

  test('past the cap, the repo that has lingered longest is disposed', async () => {
    registry = new RepoRegistry({}, { lingerCap: 2 });
    const a = await openAndRelease(repoA);
    const b = await openAndRelease(repoB);
    const disposeA = spyOn(a.manager, 'dispose');
    const disposeB = spyOn(b.manager, 'dispose');

    const c = await openAndRelease(repoC);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    // B and C still linger: both come back live; A is a cold open.
    expect((await registry.openRepo(repoB)).handle).toBe(b);
    expect((await registry.openRepo(repoC)).handle).toBe(c);
    expect((await registry.openRepo(repoA)).created).toBe(true);
  });

  test('disposeAll disposes lingering managers too', async () => {
    const open = await registry.openRepo(repoA);
    const released = await openAndRelease(repoB);
    const disposeOpen = spyOn(open.handle.manager, 'dispose');
    const disposeReleased = spyOn(released.manager, 'dispose');

    registry.disposeAll();
    expect(disposeOpen).toHaveBeenCalledTimes(1);
    expect(disposeReleased).toHaveBeenCalledTimes(1);
    expect(registry.listRepos()).toEqual([]);
    expect((await registry.openRepo(repoB)).created).toBe(true);
  });

  test('a lingering repo whose directory was replaced is not revived', async () => {
    const { handle } = await registry.openRepo(repoA);
    fs.rmSync(repoA, { recursive: true, force: true });
    await handle.manager.workingTree.refresh();
    expect(handle.manager.workingTree.unavailable).not.toBeNull();
    const dispose = spyOn(handle.manager, 'dispose');
    registry.closeRepo(handle.id);

    makeRepo(`${FIXTURE}-a`);
    const fresh = await registry.openRepo(repoA);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fresh.created).toBe(true);
    expect(fresh.handle.manager).not.toBe(handle.manager);
  });
});
