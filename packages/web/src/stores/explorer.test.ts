/**
 * useExplorerStore tests: lazy root/dir loading against the fake fetch,
 * the daemon's show-flag params (hidden/ignored — inverted from core's
 * hide options), expansion caching + collapse, the changed-only client
 * filter, filter-toggle races (a stale in-flight expand cannot stomp
 * the post-toggle cache; a failed reload reverts the flag and keeps the
 * old tree), repo-switch reset, file loads with the FileForDisplay
 * flags, connection-error collapse into the calm reconnect line, and
 * revealFile (ancestor expansion with lazy level loads + selection,
 * directory targets, ancestor-failure bail, hidden/ignored visibility).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useExplorerStore } from './explorer';
import { useRepoStore, CONNECTION_LOST_MESSAGE } from './repo';
import { makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';

const ROOT_ENTRIES: DirEntry[] = [
  { name: 'docs', path: 'docs', type: 'dir' },
  { name: 'src', path: 'src', type: 'dir', hasChanges: true },
  { name: 'README.md', path: 'README.md', type: 'file' },
  { name: 'changed.ts', path: 'changed.ts', type: 'file', gitStatus: 'modified', staged: true },
];

const SRC_ENTRIES: DirEntry[] = [
  { name: 'a.ts', path: 'src/a.ts', type: 'file', gitStatus: 'modified' },
  { name: 'b.ts', path: 'src/b.ts', type: 'file' },
];

const TEXT_FILE: FileForDisplay = {
  content: 'line 1\nline 2\n',
  binary: false,
  truncated: false,
  tooLarge: false,
  size: 14,
  totalLines: 3,
};

function params(call: FetchCall): URLSearchParams {
  return new URLSearchParams(call.url.split('?')[1] ?? '');
}

let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | undefined) | null;

function defaultRoutes(call: FetchCall): FakeResponse {
  if (call.url.startsWith('/repos/r1/tree?')) {
    const dir = params(call).get('dir');
    if (dir === '') return { body: ROOT_ENTRIES };
    if (dir === 'src') return { body: SRC_ENTRIES };
    if (dir === 'docs') return { body: [] };
    return { status: 404, body: { error: `no such dir: ${dir}` } };
  }
  if (call.url.startsWith('/repos/r1/file?')) {
    return { body: TEXT_FILE };
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

function treeCalls(): FetchCall[] {
  return fake.callsTo('/tree');
}

/** Build the two stores with an active repo already set. */
function setup(): { repo: ReturnType<typeof useRepoStore>; explorer: ReturnType<typeof useExplorerStore> } {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  const explorer = useExplorerStore();
  return { repo, explorer };
}

beforeEach(() => {
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? defaultRoutes(call));
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('root loading', () => {
  test('ensureRoot loads the root listing with the default show-flags (both false)', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();

    expect(treeCalls()).toHaveLength(1);
    const query = params(treeCalls()[0]);
    expect(query.get('dir')).toBe('');
    // Inverted wire semantics: hidden=false HIDES dotfiles,
    // ignored=false HIDES gitignored — the defaults.
    expect(query.get('hidden')).toBe('false');
    expect(query.get('ignored')).toBe('false');

    expect(explorer.rows.map((r) => r.entry.name)).toEqual([
      'docs',
      'src',
      'README.md',
      'changed.ts',
    ]);
    expect(explorer.rows.every((r) => r.depth === 0)).toBe(true);
    expect(explorer.rootLoaded).toBe(true);
  });

  test('ensureRoot is idempotent — a second call does not refetch', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.ensureRoot();
    expect(treeCalls()).toHaveLength(1);
  });

  test('without a repo, ensureRoot stays inert', async () => {
    const repo = useRepoStore();
    repo.repoId = null;
    const explorer = useExplorerStore();
    await explorer.ensureRoot();
    expect(fake.calls).toHaveLength(0);
    expect(explorer.rows).toEqual([]);
  });
});

describe('expansion', () => {
  test('expanding a dir fetches its children into depth+1 rows', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');

    expect(params(treeCalls()[1]).get('dir')).toBe('src');
    const names = explorer.rows.map((r) => `${r.depth}:${r.entry.name}`);
    expect(names).toEqual(['0:docs', '0:src', '1:a.ts', '1:b.ts', '0:README.md', '0:changed.ts']);
    expect(explorer.rows[1].isExpanded).toBe(true);
  });

  test('collapse removes the children rows; re-expand serves the cache (no refetch)', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    await explorer.toggleDir('src'); // collapse
    expect(explorer.rows.map((r) => r.entry.name)).toEqual([
      'docs',
      'src',
      'README.md',
      'changed.ts',
    ]);

    await explorer.toggleDir('src'); // re-expand
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');
    expect(treeCalls()).toHaveLength(2); // root + first src fetch only
  });

  test('a failed expand collapses back and surfaces the daemon error', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    onRequest = (call) =>
      call.url.includes('dir=src') ? { status: 404, body: { error: 'gone' } } : undefined;

    await explorer.toggleDir('src');
    expect(explorer.rows.find((r) => r.entry.path === 'src')?.isExpanded).toBe(false);
    expect(explorer.error).toBe('gone');
  });

  test('a later successful expand clears the tree error', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    onRequest = (call) =>
      call.url.includes('dir=src') ? { status: 404, body: { error: 'gone' } } : undefined;
    await explorer.toggleDir('src');
    expect(explorer.error).toBe('gone');

    onRequest = null; // src recovers
    await explorer.toggleDir('src');
    expect(explorer.error).toBe(null);
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');
  });
});

describe('single-child chain collapse', () => {
  /** packages → cli → src is a single-child dir run; src holds files. */
  function chainRoutes(call: FetchCall): FakeResponse | undefined {
    if (!call.url.startsWith('/repos/r1/tree?')) return undefined;
    const dir = params(call).get('dir');
    if (dir === '') {
      return {
        body: [
          { name: 'packages', path: 'packages', type: 'dir', hasChanges: true },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ] satisfies DirEntry[],
      };
    }
    if (dir === 'packages') {
      return {
        body: [
          { name: 'cli', path: 'packages/cli', type: 'dir', hasChanges: true },
        ] satisfies DirEntry[],
      };
    }
    if (dir === 'packages/cli') {
      return {
        body: [
          { name: 'src', path: 'packages/cli/src', type: 'dir', hasChanges: true },
        ] satisfies DirEntry[],
      };
    }
    if (dir === 'packages/cli/src') {
      return {
        body: [
          { name: 'a.ts', path: 'packages/cli/src/a.ts', type: 'file', gitStatus: 'modified' },
          { name: 'b.ts', path: 'packages/cli/src/b.ts', type: 'file' },
        ] satisfies DirEntry[],
      };
    }
    return { status: 404, body: { error: `no such dir: ${dir}` } };
  }

  test('expanding the chain head auto-fetches the run and yields ONE combined row', async () => {
    onRequest = chainRoutes;
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');

    // The whole run was fetched, one level at a time.
    expect(treeCalls().map((c) => params(c).get('dir'))).toEqual([
      '',
      'packages',
      'packages/cli',
      'packages/cli/src',
    ]);
    // One combined row — not three nested dir rows.
    expect(explorer.rows.map((r) => `${r.depth}:${r.displayName}`)).toEqual([
      '0:packages/cli/src',
      '1:a.ts',
      '1:b.ts',
      '0:README.md',
    ]);
    const combined = explorer.rows[0];
    expect(combined.entry.path).toBe('packages/cli/src'); // deepest dir
    expect(combined.isExpanded).toBe(true);
    expect(combined.entry.hasChanges).toBe(true); // decoration intact
  });

  test('collapsing the combined row hides the whole chain; re-expand serves the cache', async () => {
    onRequest = chainRoutes;
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');
    const fetches = treeCalls().length;

    await explorer.toggleDir('packages/cli/src'); // collapse the combined row
    expect(explorer.rows.map((r) => r.displayName)).toEqual(['packages/cli/src', 'README.md']);
    expect(explorer.rows[0].isExpanded).toBe(false);

    await explorer.toggleDir('packages/cli/src'); // re-expand — cached
    expect(explorer.rows.map((r) => r.displayName)).toContain('a.ts');
    expect(treeCalls()).toHaveLength(fetches);
  });

  test('a dir with multiple children or files does NOT collapse', async () => {
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/tree?')) return undefined;
      const dir = params(call).get('dir');
      if (dir === '') return { body: [{ name: 'packages', path: 'packages', type: 'dir' }] };
      if (dir === 'packages') {
        // One subdir PLUS a file: not a pure chain link.
        return {
          body: [
            { name: 'cli', path: 'packages/cli', type: 'dir' },
            { name: 'README.md', path: 'packages/README.md', type: 'file' },
          ] satisfies DirEntry[],
        };
      }
      return { status: 404, body: { error: `no such dir: ${dir}` } };
    };
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');

    expect(explorer.rows.map((r) => `${r.depth}:${r.displayName}`)).toEqual([
      '0:packages',
      '1:cli',
      '1:README.md',
    ]);
    // The lone subdir was NOT probed — no speculative fetch.
    expect(treeCalls().map((c) => params(c).get('dir'))).toEqual(['', 'packages']);
  });

  test('a filter toggle reloads the whole chain and the merge survives', async () => {
    onRequest = chainRoutes;
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');
    const before = treeCalls().length;

    await explorer.setShowHidden(true);

    // Every chain link is in the expansion set, so the reload re-pulls
    // the full run with the new params.
    const reloads = treeCalls().slice(before);
    expect(reloads.map((c) => params(c).get('dir'))).toEqual([
      '',
      'packages',
      'packages/cli',
      'packages/cli/src',
    ]);
    expect(reloads.every((c) => params(c).get('hidden') === 'true')).toBe(true);
    expect(explorer.rows.map((r) => r.displayName)).toEqual([
      'packages/cli/src',
      'a.ts',
      'b.ts',
      'README.md',
    ]);
  });

  test('changedOnly filters on the combined row like any dir row', async () => {
    onRequest = chainRoutes;
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');

    explorer.setChangedOnly(true);
    expect(explorer.rows.map((r) => r.displayName)).toEqual(['packages/cli/src', 'a.ts']);

    explorer.setChangedOnly(false);
    expect(explorer.rows).toHaveLength(4);
  });

  test('a failed fetch mid-chain stops the run and surfaces the error', async () => {
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/tree?')) return undefined;
      const dir = params(call).get('dir');
      if (dir === 'packages/cli') return { status: 500, body: { error: 'boom' } };
      return chainRoutes(call);
    };
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('packages');

    // The merge reaches the broken link and stops; the error shows.
    expect(explorer.error).toBe('boom');
    expect(explorer.rows.map((r) => r.displayName)).toEqual(['packages/cli', 'README.md']);
    expect(explorer.rows[0].isExpanded).toBe(false); // chevron stays truthful
  });
});

describe('filters', () => {
  test('setShowHidden(true) refetches root AND expanded dirs with hidden=true', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    const before = treeCalls().length;

    await explorer.setShowHidden(true);

    const reloads = treeCalls().slice(before);
    expect(reloads.map((c) => params(c).get('dir'))).toEqual(['', 'src']);
    expect(reloads.every((c) => params(c).get('hidden') === 'true')).toBe(true);
    expect(reloads.every((c) => params(c).get('ignored') === 'false')).toBe(true);
    // Expansion survived the reload.
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');
  });

  test('setShowIgnored(true) refetches with ignored=true', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.setShowIgnored(true);

    const last = treeCalls().at(-1)!;
    expect(params(last).get('ignored')).toBe('true');
    expect(params(last).get('hidden')).toBe('false');
  });

  test('setting a toggle to its current value does not refetch', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.setShowHidden(false);
    expect(treeCalls()).toHaveLength(1);
  });

  test('a stale in-flight expand from before a toggle cannot stomp the reloaded cache', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();

    // The expand's fetch (hidden=false) hangs; the toggle reload
    // (hidden=true) answers immediately from the default routes.
    let releaseStale!: () => void;
    onRequest = (call) => {
      if (call.url.includes('/tree') && params(call).get('dir') === 'src' &&
          params(call).get('hidden') === 'false') {
        return new Promise((resolve) => {
          releaseStale = () =>
            resolve({ body: [{ name: 'stale.ts', path: 'src/stale.ts', type: 'file' }] });
        }) as unknown as FakeResponse;
      }
      return undefined;
    };

    const pendingExpand = explorer.toggleDir('src'); // fetch in flight, pre-toggle params
    await explorer.setShowHidden(true); // reload replaces the cache with hidden=true data
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');

    releaseStale(); // the old-params fetch resolves late
    await pendingExpand;

    // The post-toggle cache stands; the stale children were dropped.
    expect(explorer.rows.map((r) => r.entry.name)).not.toContain('stale.ts');
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');
    // And the dropped fetch still cleared its per-dir spinner.
    expect(explorer.rows.find((r) => r.entry.path === 'src')?.isLoading).toBe(false);
  });

  test('a failed toggle reload reverts the flag and keeps the old tree', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    const before = explorer.rows.map((r) => r.entry.name);

    onRequest = (call) =>
      call.url.includes('/tree') ? { status: 500, body: { error: 'boom' } } : undefined;
    await explorer.setShowHidden(true);

    // Flag matches the (unchanged) displayed data; the error line stays.
    expect(explorer.showHidden).toBe(false);
    expect(explorer.rows.map((r) => r.entry.name)).toEqual(before);
    expect(explorer.error).toBe('boom');

    onRequest = null;
    await explorer.setShowIgnored(true);
    expect(explorer.showIgnored).toBe(true); // a successful toggle commits
  });

  test('setShowIgnored also reverts on a failed reload', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    onRequest = (call) =>
      call.url.includes('/tree') ? { status: 500, body: { error: 'boom' } } : undefined;
    await explorer.setShowIgnored(true);
    expect(explorer.showIgnored).toBe(false);
    expect(explorer.error).toBe('boom');
  });

  test('changedOnly filters rows client-side — no fetch', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    const calls = treeCalls().length;

    explorer.setChangedOnly(true);
    // Only entries with git changes remain: the src dir (hasChanges),
    // its modified child, and the staged root file.
    expect(explorer.rows.map((r) => r.entry.name)).toEqual(['src', 'a.ts', 'changed.ts']);
    expect(treeCalls()).toHaveLength(calls);

    explorer.setChangedOnly(false);
    expect(explorer.rows).toHaveLength(6);
  });
});

describe('repo switch', () => {
  test('a repoId change resets tree, selection, and errors', async () => {
    const { repo, explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    await explorer.openFile('src/a.ts');
    expect(explorer.rows.length).toBeGreaterThan(0);
    expect(explorer.file).not.toBeNull();

    repo.repoId = 'r2';
    await nextTick(); // the store's reset watcher fires

    expect(explorer.rows).toEqual([]);
    expect(explorer.rootLoaded).toBe(false);
    expect(explorer.selectedPath).toBe(null);
    expect(explorer.file).toBe(null);
    expect(explorer.error).toBe(null);
  });

  test('a stale root load from before the switch is dropped', async () => {
    const { repo, explorer } = setup();
    let release!: () => void;
    onRequest = (call) => {
      if (call.url.startsWith('/repos/r1/tree')) {
        return new Promise((resolve) => {
          release = () => resolve({ body: ROOT_ENTRIES });
        }) as unknown as FakeResponse;
      }
      return undefined;
    };

    const pending = explorer.ensureRoot();
    repo.repoId = 'r2';
    await nextTick();
    release();
    await pending;

    expect(explorer.rows).toEqual([]);
    expect(explorer.rootLoaded).toBe(false);
  });
});

describe('file loading', () => {
  test('openFile pulls /file with the path and holds the result', async () => {
    const { explorer } = setup();
    await explorer.openFile('src/a.ts');

    const call = fake.callsTo('/file')[0];
    expect(params(call).get('path')).toBe('src/a.ts');
    expect(explorer.selectedPath).toBe('src/a.ts');
    expect(explorer.file).toEqual(TEXT_FILE);
    expect(explorer.fileLoading).toBe(false);
    expect(explorer.fileError).toBe(null);
  });

  test.each([
    ['binary', { ...TEXT_FILE, content: '', binary: true, totalLines: 0 }],
    ['tooLarge', { ...TEXT_FILE, content: '', tooLarge: true, size: 5_000_000, totalLines: 0 }],
    ['truncated', { ...TEXT_FILE, truncated: true, totalLines: 9000 }],
  ] as const)('the %s flag surfaces untouched', async (_label, wire) => {
    const { explorer } = setup();
    onRequest = (call) => (call.url.includes('/file') ? { body: wire } : undefined);
    await explorer.openFile('big.bin');
    expect(explorer.file).toEqual(wire);
  });

  test('a daemon error lands in fileError; the pane is not stuck loading', async () => {
    const { explorer } = setup();
    onRequest = (call) =>
      call.url.includes('/file') ? { status: 404, body: { error: 'ENOENT: no such file' } } : undefined;

    await explorer.openFile('gone.ts');
    expect(explorer.fileError).toBe('ENOENT: no such file');
    expect(explorer.file).toBe(null);
    expect(explorer.fileLoading).toBe(false);
  });

  test('a slower previous load cannot clobber the newer selection', async () => {
    const { explorer } = setup();
    let releaseFirst!: () => void;
    let first = true;
    onRequest = (call) => {
      if (!call.url.includes('/file')) return undefined;
      if (first) {
        first = false;
        return new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ body: { ...TEXT_FILE, content: 'STALE' } });
        }) as unknown as FakeResponse;
      }
      return { body: TEXT_FILE };
    };

    const stale = explorer.openFile('old.ts');
    await explorer.openFile('new.ts');
    releaseFirst();
    await stale;

    expect(explorer.selectedPath).toBe('new.ts');
    expect(explorer.file).toEqual(TEXT_FILE);
  });
});

describe('connection loss', () => {
  test('a tree fetch rejection collapses into the calm reconnect line', async () => {
    const { explorer } = setup();
    onRequest = () => {
      throw new TypeError('fetch failed');
    };
    await explorer.ensureRoot();
    expect(explorer.error).toBe(CONNECTION_LOST_MESSAGE);
    expect(explorer.rows).toEqual([]);
  });

  test('a file fetch rejection collapses into the calm reconnect line', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    onRequest = (call) => {
      if (call.url.includes('/file')) throw new TypeError('fetch failed');
      return undefined;
    };
    await explorer.openFile('src/a.ts');
    expect(explorer.fileError).toBe(CONNECTION_LOST_MESSAGE);
    expect(explorer.fileLoading).toBe(false);
  });
});

describe('revealFile', () => {
  test('a top-level file needs no expansion: root load + file load only', async () => {
    const { explorer } = setup();
    await explorer.revealFile('README.md');

    expect(treeCalls()).toHaveLength(1); // just the root
    expect(params(treeCalls()[0]).get('dir')).toBe('');
    expect(explorer.selectedPath).toBe('README.md');
    expect(explorer.file).toEqual(TEXT_FILE);
    expect(explorer.rows.some((r) => r.isExpanded)).toBe(false);
  });

  test('a deep path expands each ancestor, lazy-loading every level', async () => {
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/tree?')) return undefined;
      const dir = params(call).get('dir');
      if (dir === '') return { body: [{ name: 'src', path: 'src', type: 'dir' }] };
      if (dir === 'src') return { body: [{ name: 'utils', path: 'src/utils', type: 'dir' }] };
      if (dir === 'src/utils') {
        return { body: [{ name: 'deep.ts', path: 'src/utils/deep.ts', type: 'file' }] };
      }
      return { status: 404, body: { error: `no such dir: ${dir}` } };
    };
    const { explorer } = setup();
    await explorer.revealFile('src/utils/deep.ts');

    // Root, then each ancestor level, in order.
    expect(treeCalls().map((c) => params(c).get('dir'))).toEqual(['', 'src', 'src/utils']);
    // src → utils is a single-child chain: it collapses onto ONE row.
    expect(explorer.rows.map((r) => `${r.depth}:${r.displayName}`)).toEqual([
      '0:src/utils',
      '1:deep.ts',
    ]);
    expect(explorer.rows[0].isExpanded).toBe(true);
    expect(explorer.selectedPath).toBe('src/utils/deep.ts');
    expect(explorer.file).toEqual(TEXT_FILE);
  });

  test('already-expanded ancestors are served from the cache (no refetch)', async () => {
    const { explorer } = setup();
    await explorer.ensureRoot();
    await explorer.toggleDir('src');
    const callsBefore = treeCalls().length;

    await explorer.revealFile('src/a.ts');

    expect(treeCalls()).toHaveLength(callsBefore);
    expect(explorer.selectedPath).toBe('src/a.ts');
  });

  test('without a repo, revealFile stays inert', async () => {
    const repo = useRepoStore();
    repo.repoId = null;
    const explorer = useExplorerStore();
    await explorer.revealFile('src/a.ts');
    expect(fake.calls).toHaveLength(0);
    expect(explorer.selectedPath).toBeNull();
  });

  test('a DIRECTORY target is expanded, never opened as a file', async () => {
    const { explorer } = setup();
    await explorer.revealFile('src');

    expect(explorer.rows.find((r) => r.entry.path === 'src')?.isExpanded).toBe(true);
    expect(explorer.rows.map((r) => r.entry.name)).toContain('a.ts');
    expect(explorer.selectedPath).toBeNull();
    expect(fake.callsTo('/file')).toHaveLength(0);
  });

  test('a failed ancestor listing stops the reveal: error stays, file NOT opened', async () => {
    const { explorer } = setup();
    onRequest = (call) =>
      call.url.includes('/tree') && params(call).get('dir') === 'src'
        ? { status: 500, body: { error: 'boom' } }
        : undefined;

    await explorer.revealFile('src/a.ts');

    expect(explorer.error).toBe('boom');
    expect(explorer.selectedPath).toBeNull();
    expect(fake.callsTo('/file')).toHaveLength(0);
    // Coherent state: the broken dir collapsed back.
    expect(explorer.rows.find((r) => r.entry.path === 'src')?.isExpanded).toBe(false);
  });

  test('a dotfile path flips showHidden so the tree can actually show it', async () => {
    onRequest = (call) => {
      if (!call.url.includes('/tree')) return undefined;
      const dir = params(call).get('dir');
      const hidden = params(call).get('hidden') === 'true';
      if (dir === '') {
        return hidden
          ? { body: [{ name: '.github', path: '.github', type: 'dir' }, ...ROOT_ENTRIES] }
          : { body: ROOT_ENTRIES };
      }
      if (dir === '.github' && hidden) {
        return { body: [{ name: 'ci.yml', path: '.github/ci.yml', type: 'file' }] };
      }
      return undefined;
    };
    const { explorer } = setup();

    await explorer.revealFile('.github/ci.yml');

    expect(explorer.showHidden).toBe(true);
    expect(explorer.rows.map((r) => r.entry.path)).toContain('.github');
    expect(explorer.rows.map((r) => r.entry.path)).toContain('.github/ci.yml');
    expect(explorer.selectedPath).toBe('.github/ci.yml');
    expect(explorer.file).toEqual(TEXT_FILE);
  });

  test('a gitignored path missing from the listing flips showIgnored and retries', async () => {
    onRequest = (call) => {
      if (!call.url.includes('/tree')) return undefined;
      const dir = params(call).get('dir');
      const ignored = params(call).get('ignored') === 'true';
      if (dir === '') {
        return ignored
          ? { body: [...ROOT_ENTRIES, { name: 'gen.ts', path: 'gen.ts', type: 'file' }] }
          : { body: ROOT_ENTRIES };
      }
      return undefined;
    };
    const { explorer } = setup();

    await explorer.revealFile('gen.ts');

    expect(explorer.showIgnored).toBe(true);
    expect(explorer.selectedPath).toBe('gen.ts');
    expect(explorer.file).toEqual(TEXT_FILE);
  });

  test('a path that exists nowhere reveals nothing (no phantom selection)', async () => {
    const { explorer } = setup();
    await explorer.revealFile('nope/missing.ts');

    expect(explorer.selectedPath).toBeNull();
    expect(fake.callsTo('/file')).toHaveLength(0);
    // The one showIgnored retry ran, then gave up.
    expect(explorer.showIgnored).toBe(true);
  });
});
