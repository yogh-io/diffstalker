/**
 * useUrlSync tests: the view-first grammar (parse + write, both ways for
 * the awkward characters), the settled-repo gate, and the entry policy —
 * a gesture pushes once, ambient movement replaces, one hijack entry, and
 * a restore writes nothing of its own.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  beginUserNav,
  parseUrl,
  resetUserNav,
  useUrlSync,
  type UrlState,
  type UrlSyncOptions,
} from './useUrlSync';
import type { CommitInfo } from '@diffstalker/core/git/status';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { makeFakeFetch } from '../testing/fakes';

const HOME = '/home/u';

function setUrl(url: string): void {
  window.history.replaceState(null, '', url);
}

function here(): string {
  return window.location.pathname + window.location.search;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  resetUserNav();
  syncOptions = {};
  setUrl('/');
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
  // The history spies live on the shared window.history — without this,
  // spying again in the next test returns the SAME mock, calls and all.
  vi.restoreAllMocks();
  setUrl('/');
});

/** ONE harness for every mount: options ride in through this slot. */
let syncOptions: UrlSyncOptions = {};

const Harness = defineComponent({
  setup() {
    useUrlSync(syncOptions);
    return () => null;
  },
});

/** A CommitInfo carrying only what the URL reads off it. */
function commit(hash: string): CommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: 'a commit',
    author: 'u',
    date: new Date(0),
    refs: '',
  };
}

/** An open repo the URL can name, without a daemon behind it. */
function activeRepo(path = `${HOME}/w/diffstalker`): void {
  const daemon = useDaemonStore();
  const repo = useRepoStore();
  daemon.repos = [{ id: 'r1', path, branch: 'main' }];
  daemon.activeRepoId = 'r1';
  repo.repoId = 'r1';
  repo.repoPath = path;
}

/** Every UrlState field, so a test only spells out what it is about. */
function state(part: Partial<UrlState>): UrlState {
  return { repo: null, view: null, at: null, base: null, whole: null, ...part };
}

describe('parseUrl', () => {
  test('view first, then a home-relative repo', () => {
    expect(parseUrl('/history/~/w/calculator/fix-a')).toEqual(
      state({ repo: { homeRelative: true, path: 'w/calculator/fix-a' }, view: 'history' })
    );
  });

  test('a repo outside $HOME keeps its absolute path', () => {
    expect(parseUrl('/changes/srv/git/thing')).toEqual(
      state({ repo: { homeRelative: false, path: 'srv/git/thing' }, view: 'changes' })
    );
  });

  test('a directory literally named ~ is not the home sentinel', () => {
    // The sentinel test runs on the RAW segment, so %7E stays a directory.
    expect(parseUrl('/changes/%7E/odd')).toEqual(
      state({ repo: { homeRelative: false, path: '~/odd' }, view: 'changes' })
    );
  });

  test('anchors ride in the query', () => {
    expect(parseUrl('/explorer/~/w/x', '?at=packages/web/src/App.vue')).toEqual(
      state({
        repo: { homeRelative: true, path: 'w/x' },
        view: 'explorer',
        at: 'packages/web/src/App.vue',
      })
    );
  });

  test('compare carries base and file together', () => {
    expect(parseUrl('/compare/~/w/x', '?base=upstream/main&at=src/a.ts')).toEqual(
      state({
        repo: { homeRelative: true, path: 'w/x' },
        view: 'compare',
        base: 'upstream/main',
        at: 'src/a.ts',
      })
    );
  });

  test('a + in a file name survives (URLSearchParams would eat it)', () => {
    expect(parseUrl('/explorer/~/w/x', '?at=src/a+b.ts').at).toBe('src/a+b.ts');
  });

  test('a repo directory named like a view is just a directory', () => {
    expect(parseUrl('/changes/~/w/history')).toEqual(
      state({ repo: { homeRelative: true, path: 'w/history' }, view: 'changes' })
    );
  });

  test('nothing, junk, and a link from the old grammar all name no place', () => {
    expect(parseUrl('/')).toEqual(state({}));
    expect(parseUrl('/foo/bar')).toEqual(state({}));
    expect(parseUrl('/w/diffstalker/explorer/packages:web')).toEqual(state({}));
  });

  test('a malformed escape does not throw — the address bar is untrusted', () => {
    expect(parseUrl('/changes/~/w/%zz')).toEqual(
      state({ repo: { homeRelative: true, path: 'w/%zz' }, view: 'changes' })
    );
  });
});

describe('writing the path', () => {
  test('no repo open is the root, not a view keyword standing alone', async () => {
    mount(Harness);
    await flushPromises();
    expect(here()).toBe('/');
  });

  test('view first, repo home-relative', async () => {
    activeRepo();
    mount(Harness);
    await flushPromises();
    expect(here()).toBe('/changes/~/w/diffstalker');
  });

  test('a repo outside $HOME writes an absolute path', async () => {
    activeRepo('/srv/git/thing');
    mount(Harness);
    await flushPromises();
    expect(here()).toBe('/changes/srv/git/thing');
  });

  test('explorer carries its open file', async () => {
    activeRepo();
    const explorer = useExplorerStore();
    mount(Harness);
    await flushPromises();
    useUiStore().setActiveView('explorer');
    explorer.selectedPath = 'packages/web/src/App.vue';
    await flushPromises();
    expect(here()).toBe('/explorer/~/w/diffstalker?at=packages/web/src/App.vue');
  });

  test('a file name with : and # and a space round-trips', async () => {
    activeRepo();
    const explorer = useExplorerStore();
    mount(Harness);
    await flushPromises();
    useUiStore().setActiveView('explorer');
    explorer.selectedPath = 'src/a:b #1.ts';
    await flushPromises();
    expect(here()).toBe('/explorer/~/w/diffstalker?at=src/a:b%20%231.ts');
    expect(parseUrl(window.location.pathname, window.location.search).at).toBe('src/a:b #1.ts');
  });

  test('changes carries the stack key, side included', async () => {
    activeRepo();
    const ui = useUiStore();
    mount(Harness);
    await flushPromises();
    // A row click is a gesture; an ambient anchor move would be deferred
    // by the throttle (see the entry tests below).
    beginUserNav({ view: 'changes' });
    ui.setActiveStackKey('u:packages/web/src/App.vue');
    await flushPromises();
    expect(here()).toBe('/changes/~/w/diffstalker?at=u:packages/web/src/App.vue');
  });

  test('history carries the selected commit as its short hash', async () => {
    activeRepo();
    const repo = useRepoStore();
    mount(Harness);
    await flushPromises();
    useUiStore().setActiveView('history');
    repo.history = { ...repo.history, selectedCommit: commit('4d1c44a8014eae3032520f702a49') };
    await flushPromises();
    expect(here()).toBe('/history/~/w/diffstalker?at=4d1c44a');
  });

  test('journal carries nothing — its seqs are not stable identities', async () => {
    activeRepo();
    const ui = useUiStore();
    mount(Harness);
    await flushPromises();
    ui.setActiveStackKey('u:a.ts');
    ui.setActiveView('journal');
    await flushPromises();
    expect(here()).toBe('/journal/~/w/diffstalker');
  });
});

describe('the settled-repo gate', () => {
  test('nothing is written while repo and daemon disagree about the repo', async () => {
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/one`, branch: 'main' }];
    daemon.activeRepoId = 'r1';
    repo.repoId = 'r1';
    repo.repoPath = `${HOME}/w/one`;
    mount(Harness);
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');

    // Mid-switch: the store has let go of the old repo, the daemon has not
    // yet been told about the new one. Every reset in between is unwritable.
    repo.repoId = null;
    repo.repoPath = `${HOME}/w/two`;
    useUiStore().setActiveView('history');
    await flushPromises();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(here()).toBe('/changes/~/w/one');

    // The gate reopens: ONE write for the whole switch.
    daemon.repos = [{ id: 'r2', path: `${HOME}/w/two`, branch: 'main' }];
    daemon.activeRepoId = 'r2';
    repo.repoId = 'r2';
    await flushPromises();
    expect(here()).toBe('/history/~/w/two');
  });
});

describe('history entries', () => {
  function mountActive(): void {
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    daemon.repos = [
      { id: 'r1', path: `${HOME}/w/one`, branch: 'main' },
      { id: 'r2', path: `${HOME}/w/two`, branch: 'main' },
    ];
    daemon.activeRepoId = 'r1';
    repo.repoId = 'r1';
    repo.repoPath = `${HOME}/w/one`;
    mount(Harness);
  }

  test('a declared gesture pushes exactly one entry, however many writes it takes', async () => {
    mountActive();
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');
    const explorer = useExplorerStore();

    // "Open this file in the explorer": a view change AND a reveal.
    beginUserNav({ view: 'explorer' });
    useUiStore().setActiveView('explorer');
    await flushPromises();
    explorer.selectedPath = 'src/a.ts';
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(here()).toBe('/explorer/~/w/one?at=src/a.ts');
  });

  test('an undeclared move replaces — ambient actors never mint entries', async () => {
    mountActive();
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    // Follow mode's shape of change, with no gesture behind it.
    useUiStore().setActiveView('explorer');
    await flushPromises();

    expect(push).not.toHaveBeenCalled();
    expect(here()).toBe('/explorer/~/w/one');
  });

  test('an ambient yank away from a chosen place is undoable exactly once', async () => {
    mountActive();
    await flushPromises();
    const ui = useUiStore();

    beginUserNav({ view: 'history' });
    ui.setActiveView('history');
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    // Follow mode drags the user into the explorer: one entry, so Back
    // returns to the view they picked...
    ui.setActiveView('explorer');
    await flushPromises();
    expect(push).toHaveBeenCalledTimes(1);

    // ...and every ambient move after it is free.
    const explorer = useExplorerStore();
    explorer.selectedPath = 'src/a.ts';
    await flushPromises();
    explorer.selectedPath = 'src/b.ts';
    await flushPromises();
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('a repo switch is one entry, minted when the gate reopens', async () => {
    mountActive();
    await flushPromises();
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    const push = vi.spyOn(window.history, 'pushState');

    beginUserNav({ repo: `${HOME}/w/two` });
    repo.repoId = null;
    repo.repoPath = `${HOME}/w/two`;
    await flushPromises();
    repo.repoId = 'r2';
    daemon.activeRepoId = 'r2';
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(here()).toBe('/changes/~/w/two');
  });
});

describe('back and forward', () => {
  test('a pop hands the parsed place to onRestore, and applying it pushes nothing', async () => {
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/one`, branch: 'main' }];
    daemon.activeRepoId = 'r1';
    repo.repoId = 'r1';
    repo.repoPath = `${HOME}/w/one`;

    const seen: UrlState[] = [];
    syncOptions = {
      onRestore: (popped) => {
        seen.push(popped);
        if (popped.view) ui.setActiveView(popped.view);
      },
    };
    mount(Harness);
    await flushPromises();

    beginUserNav({ view: 'history' });
    ui.setActiveView('history');
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    // The browser is already at the older entry when popstate fires.
    setUrl('/changes/~/w/one');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();

    expect(seen).toEqual([
      state({ repo: { homeRelative: true, path: 'w/one' }, view: 'changes' }),
    ]);
    expect(ui.activeView).toBe('changes');
    expect(push).not.toHaveBeenCalled();
    expect(here()).toBe('/changes/~/w/one');
  });

  test('a superseded restore stops applying and writes nothing', async () => {
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    const ui = useUiStore();
    daemon.repos = [{ id: 'r1', path: `${HOME}/w/one`, branch: 'main' }];
    daemon.activeRepoId = 'r1';
    repo.repoId = 'r1';
    repo.repoPath = `${HOME}/w/one`;

    let release: null | (() => void) = null;
    const releaseSlow = (): void => release?.();
    const applied: string[] = [];
    syncOptions = {
      onRestore: async (popped, ctx) => {
        if (popped.view === 'history') {
          // The slow one: still awaiting when the next Back arrives.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (ctx.isStale()) return;
        }
        applied.push(popped.view ?? '?');
        if (popped.view) ui.setActiveView(popped.view);
      },
    };
    mount(Harness);
    await flushPromises();

    setUrl('/history/~/w/one');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    setUrl('/explorer/~/w/one');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    releaseSlow();
    await flushPromises();

    // The stale restore neither applied nor wrote.
    expect(applied).toEqual(['explorer']);
    expect(ui.activeView).toBe('explorer');
  });
});

describe('whole-file mode in the URL (F5 must land in the same view)', () => {
  /** Whole-file mode on for one key, without a daemon behind it. */
  function wholeOn(repo: ReturnType<typeof useRepoStore>, key: string): void {
    repo.wholeFile = { key, path: key.slice(key.indexOf(':') + 1), diff: { lines: [] } };
  }

  test('writes the path of the file drawn whole', async () => {
    activeRepo();
    const repo = useRepoStore();
    const ui = useUiStore();
    ui.setActiveView('changes');
    ui.setActiveStackKey('u:src/a.ts');
    wholeOn(repo, 'u:src/a.ts');
    mount(Harness);
    await flushPromises();
    expect(here()).toBe('/changes/~/w/diffstalker?whole=src/a.ts&at=u:src/a.ts');
  });

  test('writes nothing when the mode is on for a DIFFERENT file', async () => {
    // The flag describes the anchor. Claiming it for a file the view is
    // not aimed at would be unreadable on restore.
    activeRepo();
    const repo = useRepoStore();
    const ui = useUiStore();
    ui.setActiveView('changes');
    ui.setActiveStackKey('u:src/a.ts');
    wholeOn(repo, 'u:src/other.ts');
    mount(Harness);
    await flushPromises();
    expect(here()).toBe('/changes/~/w/diffstalker?at=u:src/a.ts');
  });

  test('turning the mode on is undoable — it does not vanish into the anchor throttle', async () => {
    // The regression this guards: anchorOnly() decides "only the anchor
    // moved", and a change it cannot see is deferred into the 400ms
    // throttle and flushed as replace — so the toggle could never mint a
    // Back entry. `whole` has to be part of that comparison.
    activeRepo();
    const repo = useRepoStore();
    const ui = useUiStore();
    ui.setActiveView('changes');
    ui.setActiveStackKey('u:src/a.ts');
    mount(Harness);
    await flushPromises();
    const push = vi.spyOn(window.history, 'pushState');

    beginUserNav({ view: 'changes' });
    wholeOn(repo, 'u:src/a.ts');
    await flushPromises();

    expect(push).toHaveBeenCalledTimes(1);
    expect(here()).toBe('/changes/~/w/diffstalker?whole=src/a.ts&at=u:src/a.ts');
  });

  test('the mode is part of the document title, so two Back entries differ', async () => {
    activeRepo();
    const repo = useRepoStore();
    const ui = useUiStore();
    ui.setActiveView('changes');
    ui.setActiveStackKey('u:src/a.ts');
    mount(Harness);
    await flushPromises();
    const hunksTitle = document.title;

    wholeOn(repo, 'u:src/a.ts');
    await flushPromises();
    expect(document.title).not.toBe(hunksTitle);
    expect(document.title).toContain('whole');
  });
});
