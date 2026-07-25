/**
 * useUrlSync tests: parse the reproducible bits from the query (unknown
 * view -> null), and write repo/view/base back to the query as the store
 * state changes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseUrlState, useUrlSync } from './useUrlSync';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';

function setUrl(query: string): void {
  window.history.replaceState(null, '', query ? `/?${query}` : '/');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  setUrl('');
});

afterEach(() => {
  setUrl('');
});

describe('parseUrlState', () => {
  test('reads repo, a known view, and base', () => {
    setUrl('repo=%2Fhome%2Fu%2Fcalculator%2Ffix-a&view=compare&base=upstream%2Fmain');
    expect(parseUrlState()).toEqual({
      repo: '/home/u/calculator/fix-a',
      view: 'compare',
      base: 'upstream/main',
    });
  });

  test('drops an unknown view; missing bits are null', () => {
    setUrl('view=bogus');
    expect(parseUrlState()).toEqual({ repo: null, view: null, base: null });
  });
});

describe('writes state to the query', () => {
  const Harness = defineComponent({
    setup() {
      useUrlSync();
      return () => null;
    },
  });

  test('active repo path, view, and selected base ride the query', async () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    const repo = useRepoStore();
    daemon.repos = [{ id: 'r1', path: '/home/u/calculator/fix-a', branch: 'fix-a' }];
    daemon.activeRepoId = 'r1';

    mount(Harness);
    ui.setActiveView('compare');
    repo.selectedCompareBase = 'upstream/main';
    await flushPromises();

    const params = new URLSearchParams(window.location.search);
    expect(params.get('repo')).toBe('/home/u/calculator/fix-a');
    expect(params.get('view')).toBe('compare');
    expect(params.get('base')).toBe('upstream/main');
  });

  test('no base param when none is selected', async () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: '/repo', branch: null }];
    daemon.activeRepoId = 'r1';

    mount(Harness);
    ui.setActiveView('history');
    await flushPromises();

    const params = new URLSearchParams(window.location.search);
    expect(params.get('repo')).toBe('/repo');
    expect(params.get('view')).toBe('history');
    expect(params.has('base')).toBe(false);
  });
});
