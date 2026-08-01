/**
 * useUrlSync tests: parse the clean path (repo path segments + view + an
 * optional `:`-encoded compare base), and write repo/view/base back to the
 * path — home-relative — as store state changes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseUrlPath, useUrlSync, type UrlState } from './useUrlSync';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { makeFakeFetch } from '../testing/fakes';

const HOME = '/home/u';

function setPath(pathname: string): void {
  window.history.replaceState(null, '', pathname);
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  setPath('/');
  // /health carries the daemon home; everything else 404s.
  vi.stubGlobal(
    'fetch',
    makeFakeFetch((call) =>
      call.url === '/health'
        ? { body: { ok: true, ready: true, home: HOME } }
        : { status: 404, body: {} }
    ).fn
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The history spies below live on the shared window.history — without
  // this, spying again in the next test returns the SAME mock with the
  // previous test's calls still on it.
  vi.restoreAllMocks();
  setPath('/');
});

describe('parseUrlPath', () => {
  test('repo path + view', () => {
    expect(parseUrlPath('/w/calculator/fix-a/history')).toEqual({
      repoRel: 'w/calculator/fix-a',
      view: 'history',
      base: null,
      file: null,
    });
  });

  test('compare with a :-encoded base decodes to a slashed ref', () => {
    expect(parseUrlPath('/w/calculator/fix-a/compare/upstream:main')).toEqual({
      repoRel: 'w/calculator/fix-a',
      view: 'compare',
      base: 'upstream/main',
      file: null,
    });
  });

  test('compare with no base', () => {
    expect(parseUrlPath('/w/diffstalker/compare')).toEqual({
      repoRel: 'w/diffstalker',
      view: 'compare',
      base: null,
      file: null,
    });
  });

  test('a base equal to a view keyword is still read as the base (compare checked first)', () => {
    expect(parseUrlPath('/w/x/compare/history')).toEqual({
      repoRel: 'w/x',
      view: 'compare',
      base: 'history',
      file: null,
    });
  });

  test('a worktree segment named like a (non-compare) view is not mistaken for the view', () => {
    // repo ends in a dir called "history"; the appended view is "changes".
    expect(parseUrlPath('/w/x/history/changes')).toEqual({
      repoRel: 'w/x/history',
      view: 'changes',
      base: null,
      file: null,
    });
  });

  test('empty path -> nothing', () => {
    expect(parseUrlPath('/')).toEqual({ repoRel: null, view: null, base: null, file: null });
  });

  test('explorer carries the open file as a :-encoded rider', () => {
    expect(parseUrlPath('/w/x/explorer/packages:web:src:App.vue')).toEqual({
      repoRel: 'w/x',
      view: 'explorer',
      base: null,
      file: 'packages/web/src/App.vue',
    });
  });

  test('explorer with no file open', () => {
    expect(parseUrlPath('/w/x/explorer')).toEqual({
      repoRel: 'w/x',
      view: 'explorer',
      base: null,
      file: null,
    });
  });

  test('a file named like a view keyword is still read as the file', () => {
    expect(parseUrlPath('/w/x/explorer/changes')).toEqual({
      repoRel: 'w/x',
      view: 'explorer',
      base: null,
      file: 'changes',
    });
  });
});

describe('writes a clean, home-relative path', () => {
  const Harness = defineComponent({
    setup() {
      useUrlSync();
      return () => null;
    },
  });

  test('home-relative repo path + view + :-encoded base', async () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    const repo = useRepoStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/calculator/fix-a`, branch: 'fix-a' }];
    daemon.activeRepoId = 'r1';

    mount(Harness);
    await flushPromises(); // home loads from /health
    ui.setActiveView('compare');
    repo.selectedCompareBase = 'upstream/main';
    await flushPromises();

    expect(window.location.pathname).toBe(
      '/w/calculator/fix-a/compare/upstream:main'
    );
  });

  test('no base segment for a non-compare view', async () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/diffstalker`, branch: 'main' }];
    daemon.activeRepoId = 'r1';

    mount(Harness);
    await flushPromises();
    ui.setActiveView('history');
    await flushPromises();

    expect(window.location.pathname).toBe('/w/diffstalker/history');
  });

  test('the explorer view carries its open file', async () => {
    const daemon = useDaemonStore();
    const explorer = useExplorerStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/diffstalker`, branch: 'main' }];
    daemon.activeRepoId = 'r1';

    mount(Harness);
    await flushPromises();
    ui.setActiveView('explorer');
    explorer.selectedPath = 'packages/web/src/App.vue';
    await flushPromises();

    expect(window.location.pathname).toBe(
      '/w/diffstalker/explorer/packages:web:src:App.vue'
    );
  });
});

describe('browser history', () => {
  const Harness = defineComponent({
    setup() {
      useUrlSync();
      return () => null;
    },
  });

  /** Mount with a repo already active and the first (replacing) write done. */
  async function mountWithRepo(): Promise<ReturnType<typeof useDaemonStore>> {
    const daemon = useDaemonStore();
    daemon.repos = [
      { id: 'r1', path: `${HOME}/w/one`, branch: 'main' },
      { id: 'r2', path: `${HOME}/w/two`, branch: 'main' },
    ];
    daemon.activeRepoId = 'r1';
    mount(Harness);
    await flushPromises();
    return daemon;
  }

  test('switching view pushes an entry', async () => {
    await mountWithRepo();
    const push = vi.spyOn(window.history, 'pushState');

    useUiStore().setActiveView('history');
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/w/one/history');
  });

  test('switching repo pushes an entry', async () => {
    const daemon = await mountWithRepo();
    const push = vi.spyOn(window.history, 'pushState');

    daemon.activeRepoId = 'r2';
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/w/two/changes');
  });

  test('the write that first names a repo replaces — it completes the entry URL', async () => {
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/one`, branch: 'main' }];
    mount(Harness);
    await flushPromises(); // first write: no repo yet -> /changes
    const push = vi.spyOn(window.history, 'pushState');

    daemon.activeRepoId = 'r1'; // auto-activation landing
    await flushPromises();

    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/w/one/changes');
  });

  test('opening another explorer file replaces — file steps never bury the entries', async () => {
    await mountWithRepo();
    const explorer = useExplorerStore();
    useUiStore().setActiveView('explorer');
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    explorer.selectedPath = 'src/a.ts';
    await flushPromises();
    explorer.selectedPath = 'src/b.ts';
    await flushPromises();

    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/w/one/explorer/src:b.ts');
  });
});

describe('back/forward', () => {
  test('popstate hands the parsed entry to onPopState, and applying it pushes nothing', async () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/one`, branch: 'main' }];
    daemon.activeRepoId = 'r1';

    const seen: UrlState[] = [];
    const Harness = defineComponent({
      setup() {
        useUrlSync({
          onPopState: (state) => {
            seen.push(state);
            if (state.view) ui.setActiveView(state.view);
          },
        });
        return () => null;
      },
    });
    mount(Harness);
    await flushPromises();

    ui.setActiveView('history');
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    // The browser walks back: the URL is already the older entry when
    // popstate fires.
    setPath('/w/one/changes');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();

    expect(seen).toEqual([{ repoRel: 'w/one', view: 'changes', base: null, file: null }]);
    expect(ui.activeView).toBe('changes');
    // Applying a popped entry must never stack a new one on top of it.
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/w/one/changes');
  });
});
