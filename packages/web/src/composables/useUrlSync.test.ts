/**
 * useUrlSync tests: parse the clean path (repo path segments + view + an
 * optional `:`-encoded compare base), and write repo/view/base back to the
 * path — home-relative — as store state changes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseUrlPath, useUrlSync } from './useUrlSync';
import { useDaemonStore } from '../stores/daemon';
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
  setPath('/');
});

describe('parseUrlPath', () => {
  test('repo path + view', () => {
    expect(parseUrlPath('/w/calculator/fix-a/history')).toEqual({
      repoRel: 'w/calculator/fix-a',
      view: 'history',
      base: null,
    });
  });

  test('compare with a :-encoded base decodes to a slashed ref', () => {
    expect(parseUrlPath('/w/calculator/fix-a/compare/upstream:main')).toEqual({
      repoRel: 'w/calculator/fix-a',
      view: 'compare',
      base: 'upstream/main',
    });
  });

  test('compare with no base', () => {
    expect(parseUrlPath('/w/diffstalker/compare')).toEqual({
      repoRel: 'w/diffstalker',
      view: 'compare',
      base: null,
    });
  });

  test('a base equal to a view keyword is still read as the base (compare checked first)', () => {
    expect(parseUrlPath('/w/x/compare/history')).toEqual({
      repoRel: 'w/x',
      view: 'compare',
      base: 'history',
    });
  });

  test('a worktree segment named like a (non-compare) view is not mistaken for the view', () => {
    // repo ends in a dir called "history"; the appended view is "changes".
    expect(parseUrlPath('/w/x/history/changes')).toEqual({
      repoRel: 'w/x/history',
      view: 'changes',
      base: null,
    });
  });

  test('empty path -> nothing', () => {
    expect(parseUrlPath('/')).toEqual({ repoRel: null, view: null, base: null });
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
});
