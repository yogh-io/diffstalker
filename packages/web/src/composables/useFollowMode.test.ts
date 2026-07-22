/**
 * useFollowMode tests: a follow-change with followEnabled ON activates
 * the followed repo (through the one-POST useRepoOpen flow) and reveals
 * a followed FILE in the Explorer view; a bare repo path only switches
 * (trailing slash included); a subdirectory path expands, never opens
 * as a file; the active repo is not re-activated; rapid churn is
 * serialized so every superseded/previous ref is released and
 * repo.repoId stays in sync with daemon.activeRepoId; with
 * followEnabled OFF nothing moves, and flipping it ON acts on the
 * recorded latest event. A target seeded by loadFollow (cold load, no
 * live event yet) drives the same machinery, and a followed repo
 * missing from the open list is opened by path. Real stores against
 * the Slice-3 fakes — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useFollowMode } from './useFollowMode';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useExplorerStore } from '../stores/explorer';
import { useUiStore } from '../stores/ui';
import { makeFakeFetch, FakeEventSource, Deferred } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';

const REPO_ONE = { id: 'r1', path: '/repo', branch: 'main' };
const REPO_TWO = { id: 'r2', path: '/other', branch: null };
const REPO_THREE = { id: 'r3', path: '/third', branch: null };

const Harness = defineComponent({
  setup() {
    useFollowMode();
    return () => h('div');
  },
});

let fake: FakeFetch;
let serverRepos: { id: string; path: string; branch: string | null }[];
let onRequest: ((call: FetchCall) => FakeResponse | Promise<FakeResponse> | undefined) | null;

function routes(call: FetchCall): FakeResponse {
  if (call.method === 'POST' && call.url === '/repos') {
    const { path } = call.body as { path: string };
    const known = serverRepos.find((repo) => repo.path === path);
    if (known) return { body: { id: known.id, path: known.path } };
    return { status: 400, body: { error: 'Not a git repository' } };
  }
  if (call.method === 'GET' && call.url === '/repos') return { body: serverRepos };
  if (call.method === 'DELETE' && call.url.startsWith('/repos/')) return { body: null };
  if (/^\/repos\/[^/]+\/tree\?/.test(call.url)) {
    const dir = new URLSearchParams(call.url.split('?')[1]).get('dir');
    if (dir === '') return { body: [{ name: 'src', path: 'src', type: 'dir' }] };
    if (dir === 'src') {
      return { body: [{ name: 'main.ts', path: 'src/main.ts', type: 'file' }] };
    }
    return { body: [] };
  }
  if (/^\/repos\/[^/]+\/file\?/.test(call.url)) {
    return {
      body: { content: 'x', binary: false, truncated: false, tooLarge: false, size: 1, totalLines: 1 },
    };
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

function repoPosts(): string[] {
  return fake.calls
    .filter((call) => call.method === 'POST' && call.url === '/repos')
    .map((call) => (call.body as { path: string }).path);
}

function repoDeletes(): string[] {
  return fake.calls
    .filter((call) => call.method === 'DELETE' && call.url.startsWith('/repos/'))
    .map((call) => call.url);
}

interface Stores {
  daemon: ReturnType<typeof useDaemonStore>;
  repo: ReturnType<typeof useRepoStore>;
  explorer: ReturnType<typeof useExplorerStore>;
  ui: ReturnType<typeof useUiStore>;
}

let wrapper: VueWrapper;

/** Mount the harness with r1 active and r2/r3 known to the daemon. */
async function setup(): Promise<Stores> {
  serverRepos = [REPO_ONE, REPO_TWO, REPO_THREE];
  const daemon = useDaemonStore();
  const repo = useRepoStore();
  const explorer = useExplorerStore();
  const ui = useUiStore();
  daemon.repos = [REPO_ONE, REPO_TWO, REPO_THREE];
  daemon.activeRepoId = 'r1';
  repo.repoId = 'r1';
  repo.repoPath = '/repo';
  wrapper = mount(Harness);
  await flushPromises();
  fake.calls.length = 0; // only what the follow-change causes from here
  return { daemon, repo, explorer, ui };
}

async function emitFollowChange(daemon: Stores['daemon'], path: string, repoId = 'r2') {
  daemon.lastFollowChange = { repoId, path, rawContent: path };
  await nextTick();
  await flushPromises();
  await nextTick();
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? routes(call));
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
});

describe('follow enabled', () => {
  test('a followed FILE in another repo: activates it and reveals the file', async () => {
    const { daemon, repo, explorer, ui } = await setup();

    await emitFollowChange(daemon, '/other/src/main.ts');

    // Switched through the one-POST flow.
    expect(repoPosts()).toEqual(['/other']);
    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');

    // Revealed in the Explorer view.
    expect(ui.activeView).toBe('explorer');
    expect(explorer.selectedPath).toBe('src/main.ts');
    expect(explorer.rows.map((row) => row.entry.path)).toEqual(['src', 'src/main.ts']);
  });

  test('a followed repo ROOT: switches the repo, keeps the current view', async () => {
    const { daemon, repo, explorer, ui } = await setup();
    ui.setActiveView('history');

    await emitFollowChange(daemon, '/other');

    expect(repo.repoId).toBe('r2');
    expect(ui.activeView).toBe('history');
    expect(explorer.selectedPath).toBeNull();
  });

  test('a trailing-slash ROOT path is root-only: switch, no reveal, no file fetch', async () => {
    const { daemon, repo, explorer, ui } = await setup();
    ui.setActiveView('history');

    await emitFollowChange(daemon, '/other/');

    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');
    expect(ui.activeView).toBe('history');
    expect(explorer.selectedPath).toBeNull();
    expect(fake.callsTo('/file')).toHaveLength(0);
  });

  test('a SUBDIRECTORY path expands the dir in the tree — never opened as a file', async () => {
    const { daemon, explorer, ui } = await setup();

    await emitFollowChange(daemon, '/other/src');

    expect(ui.activeView).toBe('explorer');
    // The dir is expanded (its children are rows), not selected as a file.
    expect(explorer.rows.map((row) => row.entry.path)).toEqual(['src', 'src/main.ts']);
    expect(explorer.rows[0].isExpanded).toBe(true);
    expect(explorer.selectedPath).toBeNull();
    expect(fake.callsTo('/file')).toHaveLength(0);
  });

  test('rapid r1→r2→r3 churn: serialized handling, every superseded ref released, ids in sync', async () => {
    const { daemon, repo } = await setup();

    // The r2 open's POST hangs (out-of-order resolution); r3's is fast.
    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        const { path } = call.body as { path: string };
        if (path === '/other') return slow.promise;
      }
      return undefined;
    };

    daemon.lastFollowChange = { repoId: 'r2', path: '/other', rawContent: '/other' };
    await nextTick();
    await flushPromises(); // r2 handling is parked on its hanging POST
    daemon.lastFollowChange = { repoId: 'r3', path: '/third', rawContent: '/third' };
    await nextTick();
    await flushPromises();

    // Serialized: r3 waits — its POST has not fired while r2 hangs.
    expect(repoPosts()).toEqual(['/other']);

    slow.resolve({ body: { id: 'r2', path: '/other' } });
    await flushPromises();

    // r2 completed (releasing r1's ref), then r3 ran (releasing r2's).
    expect(repoPosts()).toEqual(['/other', '/third']);
    expect(repoDeletes()).toEqual(['/repos/r1', '/repos/r2']);
    expect(repo.repoId).toBe('r3');
    expect(daemon.activeRepoId).toBe('r3');
  });

  test('a followed file in the ALREADY-active repo: reveals without re-opening', async () => {
    const { daemon, explorer, ui } = await setup();

    await emitFollowChange(daemon, '/repo/src/main.ts', 'r1');

    expect(repoPosts()).toEqual([]); // no re-activation
    expect(ui.activeView).toBe('explorer');
    expect(explorer.selectedPath).toBe('src/main.ts');
  });

  test('an unknown repo id re-pulls the repo list once, then acts on it', async () => {
    const { daemon, repo } = await setup();
    daemon.repos = [REPO_ONE]; // stream missed r2's repo-opened

    await emitFollowChange(daemon, '/other');

    expect(fake.callsTo('/repos').some((call) => call.method === 'GET')).toBe(true);
    expect(repo.repoId).toBe('r2');
  });

  test('a followed repo missing from the open list entirely is opened by path', async () => {
    const { daemon, repo } = await setup();
    // r2 is not open anywhere: not client-side, not in the daemon list.
    daemon.repos = [REPO_ONE];
    onRequest = (call) => {
      if (call.method === 'GET' && call.url === '/repos') return { body: [REPO_ONE] };
      return undefined;
    };

    await emitFollowChange(daemon, '/other');

    // One refresh missed it, then the open-by-path fallback POSTed it.
    expect(fake.callsTo('/repos').some((call) => call.method === 'GET')).toBe(true);
    expect(repoPosts()).toEqual(['/other']);
    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');
  });

  test('a target seeded by loadFollow (cold load) activates the followed repo', async () => {
    const { daemon, repo } = await setup();
    daemon.activeRepoId = null; // fresh page: nothing active yet
    repo.repoId = null;
    repo.repoPath = null;
    onRequest = (call) =>
      call.url === '/follow'
        ? {
            body: { targetFile: '/t', enabled: true, followedRepoId: 'r2', followedPath: '/other' },
          }
        : undefined;

    // The daemon's target predates the page: no live event, only GET /follow.
    await daemon.loadFollow();
    await nextTick();
    await flushPromises();

    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');
  });
});

describe('follow disabled', () => {
  test('a follow-change moves NOTHING while the toggle is off', async () => {
    const { daemon, repo, explorer, ui } = await setup();
    daemon.followEnabled = false;

    await emitFollowChange(daemon, '/other/src/main.ts');

    expect(fake.calls).toHaveLength(0);
    expect(repo.repoId).toBe('r1');
    expect(daemon.activeRepoId).toBe('r1');
    expect(ui.activeView).toBe('changes');
    expect(explorer.selectedPath).toBeNull();
  });

  test('flipping the toggle ON acts on the recorded latest event immediately', async () => {
    const { daemon, repo } = await setup();
    daemon.followEnabled = false;

    await emitFollowChange(daemon, '/other');
    expect(repo.repoId).toBe('r1'); // recorded, not acted on

    daemon.followEnabled = true;
    await nextTick();
    await flushPromises();

    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');
  });

  test('flipping the toggle ON acts on a target seeded by loadFollow', async () => {
    const { daemon, repo } = await setup();
    daemon.followEnabled = false;
    onRequest = (call) =>
      call.url === '/follow'
        ? {
            body: { targetFile: '/t', enabled: true, followedRepoId: 'r2', followedPath: '/other' },
          }
        : undefined;

    // Cold load with the toggle off: the target is seeded, not acted on.
    await daemon.loadFollow();
    await nextTick();
    await flushPromises();
    expect(repo.repoId).toBe('r1');

    daemon.followEnabled = true;
    await nextTick();
    await flushPromises();

    expect(repo.repoId).toBe('r2');
    expect(daemon.activeRepoId).toBe('r2');
  });
});
