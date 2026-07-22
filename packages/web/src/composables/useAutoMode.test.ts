/**
 * useAutoMode tests: the CLI auto-mode policy ported to the web —
 * the first snapshot seeds without jumping; a later mtime increase
 * (or a new file) selects the newest-changed file, flashes it, and
 * smooth-scrolls the registered Changes stack to it (auto on, Changes
 * view only — the AUTO-SCROLL-ONLY-IN-AUTO-MODE decision: with auto
 * OFF the stack is never scrolled); the jump defers while the user
 * scrolled the stack within the last USER_SCROLL_DEFER_MS and retries
 * while the view is still mounting; tracking continues while auto is
 * OFF so toggling on never acts on a stale change; the view switches
 * on file-count transitions (files dry up on Changes -> History with
 * the newest commit selected; files appear on History -> Changes); a
 * repo switch starts a fresh seeding cycle. Driven by assigning the
 * repo store's shared state directly (repoId stays null, so no
 * fetches), fake timers for the flash and deferral windows.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useAutoMode, registerStackAutoJump, USER_SCROLL_DEFER_MS } from './useAutoMode';
import { useRepoStore } from '../stores/repo';
import { useUiStore, FLASH_MS } from '../stores/ui';
import type { FileEntry, FileStatus, CommitInfo } from '@diffstalker/core/git/status';
import type { RepoSharedState } from '../stores/types';

const Harness = defineComponent({
  setup() {
    useAutoMode();
    return () => h('div');
  },
});

function fileEntry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, status: 'modified' as FileStatus, staged: false, ...overrides };
}

function sharedState(
  files: FileEntry[],
  mtimes: Record<string, number> | null
): RepoSharedState {
  return {
    status: { files, branch: { current: 'main', ahead: 0, behind: 0 }, isRepo: true },
    hunkCounts: { staged: {}, unstaged: {} },
    stashList: [],
    operationInProgress: null,
    mtimes,
    error: null,
    isLoading: false,
  };
}

function commit(hash: string): CommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: 'm',
    author: 'a',
    date: new Date('2026-07-20T00:00:00Z'),
    refs: '',
  };
}

let wrapper: VueWrapper;
let repo: ReturnType<typeof useRepoStore>;
let ui: ReturnType<typeof useUiStore>;
let unregister: (() => void) | null;

/** Apply a shared state and let the composable's watcher run. */
async function apply(files: FileEntry[], mtimes: Record<string, number> | null): Promise<void> {
  repo.shared = sharedState(files, mtimes);
  await nextTick();
}

/** Register a fake stack jump target (unregistered in afterEach). */
function registerTarget(lastUserScrollAt: () => number = () => 0): ReturnType<typeof vi.fn> {
  const jump = vi.fn();
  unregister = registerStackAutoJump({ jump, lastUserScrollAt });
  return jump;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setActivePinia(createPinia());
  repo = useRepoStore();
  ui = useUiStore();
  unregister = null;
  wrapper = mount(Harness);
});

afterEach(() => {
  unregister?.();
  wrapper.unmount();
  vi.useRealTimers();
});

describe('first snapshot', () => {
  test('seeds without jumping, even with auto on', async () => {
    ui.toggleAutoMode(); // on
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 200 });

    expect(repo.selection.file).toBeNull();
    expect(ui.flashedFile).toBeNull();
    expect(ui.activeView).toBe('changes');
  });
});

describe('auto-select the newest-changed file', () => {
  test('an mtime increase selects that file and flashes it; the flash clears', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 200 });

    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 300, 'b.ts': 200 });

    expect(repo.selection.file?.path).toBe('a.ts');
    expect(ui.flashedFile).toBe('a.ts');

    await vi.advanceTimersByTimeAsync(FLASH_MS);
    expect(ui.flashedFile).toBeNull();
  });

  test('a new file counts as changed and is selected', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    const fresh = fileEntry('new.txt', { status: 'untracked' });
    await apply([fileEntry('a.ts'), fresh], { 'a.ts': 100, 'new.txt': 500 });

    expect(repo.selection.file).toBe(fresh);
    expect(ui.flashedFile).toBe('new.txt');
  });

  test('several changes: the one with the highest mtime wins', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 100 });

    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 400, 'b.ts': 900 });

    expect(repo.selection.file?.path).toBe('b.ts');
  });

  test('a staged/unstaged pair collapses to one entry; the first row is handed over', async () => {
    ui.toggleAutoMode();
    const unstaged = fileEntry('a.ts');
    const staged = fileEntry('a.ts', { staged: true });
    await apply([unstaged, staged], { 'a.ts': 100 });

    const nextUnstaged = fileEntry('a.ts');
    const nextStaged = fileEntry('a.ts', { staged: true });
    await apply([nextUnstaged, nextStaged], { 'a.ts': 200 });

    expect(repo.selection.file).toBe(nextUnstaged);
  });

  test('an unchanged state (SSE churn without a content change) never jumps', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });
    repo.selectFile(null); // the user cleared the selection

    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    expect(repo.selection.file).toBeNull();
    expect(ui.flashedFile).toBeNull();
  });

  test('auto OFF: never selects, but keeps tracking so toggling on does not act on a stale change', async () => {
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });
    await apply([fileEntry('a.ts')], { 'a.ts': 900 }); // change lands while off

    expect(repo.selection.file).toBeNull();
    expect(ui.flashedFile).toBeNull();

    ui.toggleAutoMode(); // on — the 900 mtime is already tracked
    await apply([fileEntry('a.ts')], { 'a.ts': 900 });

    expect(repo.selection.file).toBeNull();
    expect(ui.flashedFile).toBeNull();
  });

  test('only acts on the Changes view', async () => {
    ui.toggleAutoMode();
    ui.setActiveView('explorer');
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([fileEntry('a.ts')], { 'a.ts': 500 });

    expect(repo.selection.file).toBeNull();
    expect(ui.flashedFile).toBeNull();
  });
});

describe('view switching on file-count transitions', () => {
  test('files dry up on Changes: switch to History and select the newest commit', async () => {
    ui.toggleAutoMode();
    repo.history = {
      commits: [commit('newest'), commit('older')],
      selectedCommit: null,
      commitDiff: null,
      isLoading: false,
    };
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([], {});

    expect(ui.activeView).toBe('history');
    expect(repo.history.selectedCommit?.hash).toBe('newest');
  });

  test('files appear on History: switch to Changes', async () => {
    ui.toggleAutoMode();
    ui.setActiveView('history');
    await apply([], {});

    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    expect(ui.activeView).toBe('changes');
    // The appearing file is also the newest change: selected + flashed.
    expect(repo.selection.file?.path).toBe('a.ts');
    expect(ui.flashedFile).toBe('a.ts');
  });

  test('no switch away from Compare/Explorer (CLI guard parity)', async () => {
    ui.toggleAutoMode();
    ui.setActiveView('compare');
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([], {});

    expect(ui.activeView).toBe('compare');
  });

  test('auto OFF: no switch, but the count is still tracked for a later toggle', async () => {
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });
    await apply([], {}); // dries up while off — no switch
    expect(ui.activeView).toBe('changes');

    ui.toggleAutoMode();
    ui.setActiveView('history');
    await apply([fileEntry('a.ts')], { 'a.ts': 100 }); // 0 -> 1 while on

    expect(ui.activeView).toBe('changes');
  });
});

describe('repo switch', () => {
  test('a new repo id starts a fresh seeding cycle: its first snapshot never jumps', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    repo.repoId = 'other-repo';
    await nextTick();
    // First snapshot of the new repo: same path, much newer mtime —
    // must seed, not jump.
    await apply([fileEntry('a.ts')], { 'a.ts': 999 });

    expect(ui.flashedFile).toBeNull();
  });
});

describe('stack auto-jump (auto-scroll ONLY in auto mode)', () => {
  test('auto ON: a fresh change jumps the registered stack to that path', async () => {
    const jump = registerTarget();
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 100 });

    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 500 });

    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledWith('b.ts');
  });

  test('auto OFF: a live edit NEVER scrolls — the stack updates in place', async () => {
    const jump = registerTarget();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });
    await apply([fileEntry('a.ts')], { 'a.ts': 900 });

    expect(jump).not.toHaveBeenCalled();
    // No selection churn either — only the editedAt flash marks it.
    expect(repo.selection.file).toBeNull();
  });

  test('a recent manual scroll defers the jump until the window closes', async () => {
    const scrolledAt = Date.now();
    const jump = registerTarget(() => scrolledAt);
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    vi.advanceTimersByTime(500); // user scrolled 500ms ago
    await apply([fileEntry('a.ts')], { 'a.ts': 200 });
    expect(jump).not.toHaveBeenCalled(); // deferred, not dropped

    await vi.advanceTimersByTimeAsync(USER_SCROLL_DEFER_MS - 500);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledWith('a.ts');
  });

  test('a newer change replaces a deferred jump: one jump, freshest path', async () => {
    const scrolledAt = Date.now();
    const jump = registerTarget(() => scrolledAt);
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 100, 'b.ts': 100 });

    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 200, 'b.ts': 100 });
    await apply([fileEntry('a.ts'), fileEntry('b.ts')], { 'a.ts': 200, 'b.ts': 300 });
    expect(jump).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(USER_SCROLL_DEFER_MS);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledWith('b.ts');
  });

  test('no target yet (view still mounting): the jump retries and lands after registration', async () => {
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([fileEntry('a.ts')], { 'a.ts': 200 }); // no target registered

    const jump = registerTarget();
    await vi.advanceTimersByTimeAsync(200); // past the retry cadence
    expect(jump).toHaveBeenCalledWith('a.ts');
  });

  test('leaving the Changes view drops a deferred jump', async () => {
    const scrolledAt = Date.now();
    const jump = registerTarget(() => scrolledAt);
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([fileEntry('a.ts')], { 'a.ts': 200 }); // deferred (recent scroll)
    ui.setActiveView('explorer');
    await vi.advanceTimersByTimeAsync(USER_SCROLL_DEFER_MS + 100);

    expect(jump).not.toHaveBeenCalled();
  });

  test('toggling auto mode off drops a deferred jump', async () => {
    const scrolledAt = Date.now();
    const jump = registerTarget(() => scrolledAt);
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([fileEntry('a.ts')], { 'a.ts': 200 }); // deferred (recent scroll)
    ui.toggleAutoMode(); // off
    await vi.advanceTimersByTimeAsync(USER_SCROLL_DEFER_MS + 100);

    expect(jump).not.toHaveBeenCalled();
  });

  test('unregistering drops the target (no jump into an unmounted view)', async () => {
    const jump = registerTarget();
    unregister?.();
    unregister = null;
    ui.toggleAutoMode();
    await apply([fileEntry('a.ts')], { 'a.ts': 100 });

    await apply([fileEntry('a.ts')], { 'a.ts': 200 });
    expect(jump).not.toHaveBeenCalled();
  });
});
