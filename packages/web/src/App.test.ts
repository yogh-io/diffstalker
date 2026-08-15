/**
 * App shell integration tests: theme stamping, empty state, repo
 * selection (open-by-path + switcher), warm-daemon auto-activation,
 * view routing via the rail, the global keyboard layer + overlays
 * (finder on Ctrl+P, hotkeys help on ?), and the status bar readout.
 * Stores run for real against the Slice-3 fakes (fake fetch +
 * FakeEventSource) — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import App from './App.vue';
import { useDaemonStore } from './stores/daemon';
import { useRepoStore } from './stores/repo';
import { useUiStore } from './stores/ui';
import { PREFS_KEY } from './prefs';
import { makeFakeFetch, FakeEventSource, Deferred } from './testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from './testing/fakes';

const REPO_ONE = { id: 'r1', path: '/repo', branch: 'main' };
const REPO_TWO = { id: 'r2', path: '/other', branch: 'dev' };

const FOLLOW_STATE = {
  targetFile: '/home/u/.cache/diffstalker/target',
  enabled: false,
  followedRepoId: null,
  followedPath: null,
};

const SHARED_STATE = {
  status: {
    files: [
      { path: 'src/a.ts', status: 'modified', staged: false, insertions: 10, deletions: 2 },
      { path: 'src/b.ts', status: 'added', staged: true, insertions: 5 },
    ],
    branch: { current: 'main', tracking: 'origin/main', ahead: 2, behind: 1 },
    isRepo: true,
  },
  hunkCounts: { staged: {}, unstaged: {} },
  stashList: [],
  operationInProgress: null,
  mtimes: {},
  error: null,
};

let fake: FakeFetch;
let serverRepos: { id: string; path: string; branch: string | null }[];

function openRepoRoute(call: FetchCall): FakeResponse {
  const { path } = call.body as { path: string };
  const known = serverRepos.find((repo) => repo.path === path);
  if (known) return { body: { id: known.id, path: known.path } };
  const opened = { id: `id-${path.replaceAll('/', '_')}`, path, branch: null };
  serverRepos.push(opened);
  return { body: { id: opened.id, path: opened.path } };
}

/** Repo-scoped GET reads (/repos/:id/…), matched by path. */
function repoGetRoutes(url: string): FakeResponse | undefined {
  // The History / Compare views pull these on activation.
  if (/^\/repos\/[^/]+\/history/.test(url)) {
    return { body: [] };
  }
  // The fuzzy finder pulls the full file list on open.
  if (/^\/repos\/[^/]+\/files$/.test(url)) {
    return { body: ['README.md', 'src/a.ts', 'src/b.ts'] };
  }
  if (/^\/repos\/[^/]+\/base-branches$/.test(url)) {
    return { body: ['origin/main'] };
  }
  // The rail's Compare badge pulls this for every applied state, whether or
  // not the Compare view has ever been opened. Before the /compare? route,
  // which shares its prefix.
  if (/^\/repos\/[^/]+\/compare\/count/.test(url)) {
    return { body: { baseBranch: 'origin/main', commits: 0 } };
  }
  if (/^\/repos\/[^/]+\/compare\?/.test(url)) {
    return {
      body: {
        baseBranch: 'origin/main',
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        files: [],
        commits: [],
        uncommittedCount: 0,
      },
    };
  }
  return undefined;
}

/**
 * The calls the repo picker makes wherever it is mounted (the empty state
 * mounts it, so almost every test in here hits these).
 *
 * `/resolve` answers openable for any path the fake "server" would open —
 * i.e. any path at all. That mirrors the daemon: the probe and POST /repos
 * share one resolver, so a fake where they disagreed would let a test pass
 * against behaviour the real pair cannot produce.
 */
function pickerRoutes(url: string): FakeResponse | undefined {
  if (url === '/settings') return { body: { watchRoots: [], persisted: true } };
  if (url === '/discovered') return { body: { roots: [] } };
  if (url.startsWith('/worktrees?')) return { body: [] };
  if (url.startsWith('/resolve?')) {
    const path = new URLSearchParams(url.split('?')[1]).get('path') ?? '';
    return { body: { openable: path.startsWith('/'), root: path.startsWith('/') ? path : null } };
  }
  return undefined;
}

function routes(call: FetchCall): FakeResponse {
  if (call.method === 'POST' && call.url === '/discovered/rescan') {
    return { body: { roots: [] } };
  }
  if (call.method === 'GET') {
    const pickerRoute = pickerRoutes(call.url);
    if (pickerRoute) return pickerRoute;
  }
  if (call.method === 'GET' && call.url === '/repos') {
    return { body: serverRepos };
  }
  if (call.method === 'POST' && call.url === '/repos') {
    return openRepoRoute(call);
  }
  if (call.method === 'DELETE' && call.url.startsWith('/repos/')) {
    return { body: null };
  }
  if (call.url === '/follow') {
    return { body: FOLLOW_STATE };
  }
  if (call.method === 'GET') {
    const repoRoute = repoGetRoutes(call.url);
    if (repoRoute) return repoRoute;
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

function repoPosts(): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.url === '/repos')
    .map((c) => (c.body as { path: string }).path);
}

function repoDeletes(): string[] {
  return fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
}

function daemonSource(): FakeEventSource {
  const source = FakeEventSource.instances.find((s) => s.url === '/events');
  if (!source) throw new Error('daemon stream not subscribed');
  return source;
}

function repoSource(id: string): FakeEventSource | undefined {
  return FakeEventSource.instances.find((s) => s.url === `/repos/${id}/events` && !s.closed);
}

function mountApp(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(App, { global: { plugins: [pinia] }, attachTo: document.body });
}

/** Mount, connect, and deliver a daemon snapshot of open repos. */
async function mountWithRepos(
  repos: { id: string; path: string; branch: string | null }[]
): Promise<VueWrapper> {
  serverRepos = [...repos];
  const wrapper = mountApp();
  await flushPromises();
  daemonSource().emit(
    'snapshot',
    repos.map(({ id, path }) => ({ id, path }))
  );
  await flushPromises();
  return wrapper;
}

/**
 * The picker's repo rows. Every test in here starts with no recents and no
 * watch directories, so each row is a repo open on the daemon.
 */
function openRows(wrapper: VueWrapper): ReturnType<VueWrapper['findAll']> {
  return wrapper.findAll('[data-testid="picker-row"]');
}

/**
 * Open a repo the way the picker does it: type the path, let the probe
 * answer, then press the button it grows.
 *
 * The wait is real, not a fake timer: these tests drive the whole app, and
 * swapping the clock mid-test would also freeze the stores' own timers. The
 * button is deliberately not reachable before the daemon has confirmed the
 * path — that is the behaviour under test, not an obstacle to route around.
 */
async function typePathAndOpen(wrapper: VueWrapper, path: string): Promise<void> {
  await wrapper.find('[data-testid="picker-input"]').setValue(path);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await flushPromises();
  await wrapper.find('[data-testid="picker-open-btn"]').trigger('click');
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  // Reset the URL — useUrlSync reads the query on mount, and happy-dom's
  // window persists across tests, so a prior test's ?repo=… would leak in.
  window.history.replaceState(null, '', '/');
  delete document.documentElement.dataset.theme;
  // Deterministic system theme: prefer dark (happy-dom reports light).
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: false, media: query }))
  );
  serverRepos = [];
  fake = makeFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shell', () => {
  test('mounting stamps the theme on <html> and connects to the daemon', async () => {
    const wrapper = mountApp();
    expect(document.documentElement.dataset.theme).toBe('dark');
    await flushPromises();
    expect(daemonSource().url).toBe('/events');
    wrapper.unmount();
  });

  test('renders header, rail, workspace, and status bar', async () => {
    const wrapper = await mountWithRepos([]);
    expect(wrapper.find('header').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="Views"]').exists()).toBe(true);
    expect(wrapper.find('main').exists()).toBe(true);
    expect(wrapper.find('footer').exists()).toBe(true);
    expect(wrapper.text()).toContain('diffstalker');
    wrapper.unmount();
  });
});

describe('repo selection', () => {
  test('shows the empty state when the daemon has no open repos', async () => {
    const wrapper = await mountWithRepos([]);
    const empty = wrapper.find('[data-testid="empty-state"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('Open a repository');
    wrapper.unmount();
  });

  test('entering a path opens it with exactly ONE POST and starts the repo session', async () => {
    const wrapper = await mountWithRepos([]);

    await typePathAndOpen(wrapper, '/other');

    // repoStore.open is the sole opener: one POST /repos per open.
    expect(repoPosts()).toEqual(['/other']);
    expect(repoDeletes()).toEqual([]); // nothing was open before

    // The repo session subscribed to the per-repo stream.
    const repo = useRepoStore();
    expect(repo.repoPath).toBe('/other');
    expect(repoSource(repo.repoId!)).toBeDefined();

    // Empty state gone; recent repos persisted.
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(false);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).recentRepos).toEqual(['/other']);
    wrapper.unmount();
  });

  test('a refused path surfaces the refusal and keeps the empty state', async () => {
    const wrapper = await mountWithRepos([]);

    // Re-stub: the daemon refuses every POST /repos from here on.
    fake = makeFakeFetch((call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        return { status: 400, body: { error: 'Not a git repository' } };
      }
      return routes(call);
    });
    vi.stubGlobal('fetch', fake.fn);

    await typePathAndOpen(wrapper, '/not-a-repo');

    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Not a git repository');
    wrapper.unmount();
  });

  test('a warm daemon auto-activates the first open repo with ONE POST', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);
    const repo = useRepoStore();
    expect(repo.repoPath).toBe('/repo');
    expect(repoSource('r1')).toBeDefined();
    expect(repoPosts()).toEqual(['/repo']);
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('cold load with a follow target activates the FOLLOWED repo, not the first', async () => {
    serverRepos = [REPO_ONE, REPO_TWO];
    // The follow state resolves AFTER the repo list — the losing order
    // for the old race, where repos[0] got activated instead.
    const followLoad = new Deferred<FakeResponse>();
    fake = makeFakeFetch((call) => {
      if (call.url === '/follow') return followLoad.promise;
      return routes(call);
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mountApp();
    await flushPromises();
    daemonSource().emit('snapshot', [
      { id: 'r1', path: '/repo' },
      { id: 'r2', path: '/other' },
    ]);
    await flushPromises();

    // The repo list is in but follow is still in flight: no fallback yet.
    expect(repoPosts()).toEqual([]);

    followLoad.resolve({
      body: { targetFile: '/t', enabled: true, followedRepoId: 'r2', followedPath: '/other' },
    });
    await flushPromises();
    await flushPromises();

    // Exactly ONE activation, and it is the followed repo — no
    // double-open, no flicker through repos[0].
    expect(repoPosts()).toEqual(['/other']);
    expect(useRepoStore().repoPath).toBe('/other');
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('a stuck /follow does not deadlock the empty state — the fallback opens repos[0]', async () => {
    vi.useFakeTimers();
    serverRepos = [REPO_ONE];
    // The SSE stream stays alive, but every GET /follow fails. The store
    // exhausts its bounded retries and follow.value stays null; without
    // the App fallback the one-shot would wait on daemon.follow forever.
    fake = makeFakeFetch((call) => {
      if (call.url === '/follow') return { status: 503, body: { error: 'follow down' } };
      return routes(call);
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mountApp();
    await flushPromises();
    daemonSource().emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    await flushPromises();

    // Follow never loads: nothing activated yet, still on the empty state.
    expect(useDaemonStore().follow).toBeNull();
    expect(repoPosts()).toEqual([]);
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);

    // Past the store's bounded retries AND the App fallback window.
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();

    // Escaped the deadlock: repos[0] activated exactly once.
    expect(repoPosts()).toEqual(['/repo']);
    expect(useRepoStore().repoPath).toBe('/repo');
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(false);
    wrapper.unmount();
    vi.useRealTimers();
  });

  test('a later repo-opened does NOT hijack the empty state once latched', async () => {
    const wrapper = await mountWithRepos([]); // first repo list arrived: latch set

    // The CLI opens a repo later; the daemon broadcasts repo-opened.
    daemonSource().emit('repo-opened', { id: 'r9', path: '/late' });
    await flushPromises();

    // Listed, but never auto-activated: the user stays at the empty state.
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(useRepoStore().repoPath).toBeNull();
    expect(repoPosts()).toEqual([]);
    wrapper.unmount();
  });

  test('the switcher lists open repos and switches the session', async () => {
    const wrapper = await mountWithRepos([REPO_ONE, REPO_TWO]);

    await wrapper.find('.switch-btn').trigger('click');
    const rows = openRows(wrapper);
    expect(rows.map((row) => row.text())).toEqual([
      expect.stringContaining('repo'),
      expect.stringContaining('other'),
    ]);

    await rows[1].trigger('click');
    await flushPromises();
    expect(useRepoStore().repoPath).toBe('/other');
    wrapper.unmount();
  });

  test('switching A -> B holds ONE ref on B and releases A', async () => {
    const wrapper = await mountWithRepos([REPO_ONE, REPO_TWO]);
    expect(repoPosts()).toEqual(['/repo']); // auto-activation of A

    await wrapper.find('.switch-btn').trigger('click');
    const rows = openRows(wrapper);
    await rows[1].trigger('click');
    await flushPromises();

    // One POST for B, and A's ref released (DELETE), never re-POSTed.
    expect(repoPosts()).toEqual(['/repo', '/other']);
    expect(repoDeletes()).toEqual(['/repos/r1']);
    wrapper.unmount();
  });
});

describe('repo switch discards stale view state', () => {
  /** Switch to the second repo through the header switcher. */
  async function switchToSecond(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.switch-btn').trigger('click');
    const rows = openRows(wrapper);
    await rows[1].trigger('click');
    await flushPromises();
  }

  test('switching repos on History remounts it and pulls the NEW repo log', async () => {
    const wrapper = await mountWithRepos([REPO_ONE, REPO_TWO]);
    useUiStore().setActiveView('history');
    await flushPromises();
    expect(fake.calls.some((c) => c.url.startsWith('/repos/r1/history'))).toBe(true);

    await switchToSecond(wrapper);

    // Without the remount, onMounted never refires and History sticks
    // on the old repo's (empty) state.
    expect(fake.calls.some((c) => c.url.startsWith('/repos/r2/history'))).toBe(true);
    wrapper.unmount();
  });
});

describe('view routing', () => {
  async function railButton(wrapper: VueWrapper, label: string) {
    const buttons = wrapper.find('nav[aria-label="Views"]').findAll('button');
    const target = buttons.find((b) => b.attributes('title') === label);
    if (!target) throw new Error(`no rail entry: ${label}`);
    return target;
  }

  test('the rail switches the view, renders it, and persists', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);
    // Changes view: no repo snapshot yet, so the files column is loading.
    expect(wrapper.text()).toContain('Loading status');

    await (await railButton(wrapper, 'History')).trigger('click');
    await flushPromises(); // history loads on activation (empty log here)
    expect(wrapper.text()).toContain('No commits yet.');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).activeView).toBe('history');

    await (await railButton(wrapper, 'Compare')).trigger('click');
    await flushPromises(); // compare refreshes on activation (clean here)
    expect(wrapper.text()).toContain('No changes compared to origin/main.');

    await (await railButton(wrapper, 'Explorer')).trigger('click');
    await flushPromises(); // the tree root loads on activation
    expect(wrapper.text()).toContain('Select a file');
    expect(wrapper.find('[data-testid="toggle-changed"]').exists()).toBe(true);
    wrapper.unmount();
  });

  test('the stored view is restored on mount', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ activeView: 'compare' }));
    const wrapper = await mountWithRepos([REPO_ONE]);
    await flushPromises();
    expect(wrapper.text()).toContain('include uncommitted');
    // The active tab is Compare, and its title carries the commit count the
    // rail badges it with (0 against this fake's empty compare).
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe(
      'Compare — 0 commits vs the base branch'
    );
    wrapper.unmount();
  });
});

describe('global keyboard + overlays', () => {
  function press(key: string, init: KeyboardEventInit = {}): void {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init })
    );
  }

  test('Ctrl+P opens the finder over the shell; Esc closes it', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('p', { ctrlKey: true });
    await flushPromises();

    const overlay = wrapper.find('[data-testid="finder-overlay"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.find('[role="dialog"]').exists()).toBe(true);
    // The repo's file list arrived and focus sits in the input.
    expect(overlay.text()).toContain('src/a.ts');
    expect(document.activeElement).toBe(overlay.find('input').element);

    press('Escape');
    await flushPromises();
    expect(wrapper.find('[data-testid="finder-overlay"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('the finder names the other two search gestures and their keys', async () => {
    // The one surface with a visible way in is where the other two keys
    // get learned; without this they are reachable only by knowing them.
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('p', { ctrlKey: true });
    await flushPromises();

    const strip = wrapper.find('[data-testid="search-modes"]');
    const text = strip.text().replace(/\s+/g, ' ');
    expect(text).toContain('Files Ctrl P');
    expect(text).toContain('Contents ⇧ F');
    expect(text).toContain('Outline o');
    wrapper.unmount();
  });

  test('the strip switches corpus and carries the query across', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('p', { ctrlKey: true });
    await flushPromises();
    await wrapper.find('[data-testid="finder-input"]').setValue('needle');

    await wrapper.find('[data-testid="mode-contents"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="finder-overlay"]').exists()).toBe(false);
    const search = wrapper.find('[data-testid="search-overlay"]');
    expect(search.exists()).toBe(true);
    expect(search.find('[data-testid="search-input"]').attributes('value')).toBe('needle');
    wrapper.unmount();
  });

  test('the outline mode reaches the popover from another view', async () => {
    // The regression this pins: the Explorer is what listens for the
    // outline request, so firing it before the view mounts loses it and
    // you land in the Explorer with no popover.
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('p', { ctrlKey: true });
    await flushPromises();
    await wrapper.find('[data-testid="mode-outline"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="finder-overlay"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Explorer');
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(true);
    wrapper.unmount();
  });

  test('? toggles the hotkeys help', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('?');
    await flushPromises();
    const overlay = wrapper.find('[data-testid="hotkeys-overlay"]');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain('Keyboard shortcuts');
    expect(overlay.text()).toContain('Find file');

    press('?');
    await flushPromises();
    expect(wrapper.find('[data-testid="hotkeys-overlay"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('view keys 1-5 switch views (rail order) from anywhere outside a text field', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('5');
    await flushPromises();
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Explorer');

    press('2');
    await flushPromises();
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Journal');

    press('1');
    await flushPromises();
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Changes');
    wrapper.unmount();
  });
});

describe('live readouts', () => {
  test('status bar tracks the connection state', async () => {
    const wrapper = mountApp();
    expect(wrapper.find('[data-testid="connection"]').text()).toContain('connecting…');
    await flushPromises();

    daemonSource().emit('snapshot', []);
    await flushPromises();
    expect(wrapper.find('[data-testid="connection"]').text()).toContain('daemon connected');

    daemonSource().fail();
    await flushPromises();
    // One sentence for one dropped connection: the status bar reuses the
    // header's CONNECTION_LOST_MESSAGE rather than phrasing it a second way.
    expect(wrapper.find('[data-testid="connection"]').text()).toContain(
      'daemon connection lost'
    );
    wrapper.unmount();
  });

  test('with a repo active, the repo error wins — a stale daemon error cannot mask it', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    const daemon = useDaemonStore();
    daemon.error = 'stale daemon refusal';
    repoSource('r1')!.emit('state-change', { ...SHARED_STATE, error: 'watcher hiccup' });
    await flushPromises();

    expect(wrapper.find('[data-testid="header-error"]').text()).toBe('watcher hiccup');
    wrapper.unmount();
  });

  test('a repo snapshot fills the file list, branch info, and change count', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    repoSource('r1')!.emit('snapshot', SHARED_STATE);
    await flushPromises();

    // Changes view: grouped rows (Modified / Staged) with paths.
    const fileList = wrapper.find('[data-testid="file-list"]');
    expect(fileList.text()).toContain('src/a.ts');
    expect(fileList.text()).toContain('src/b.ts');
    expect(fileList.text()).toContain('Staged');

    // Header: branch → tracking, ahead/behind in diff colors.
    const branch = wrapper.find('[data-testid="branch-info"]');
    expect(branch.text()).toContain('main');
    // A same-named upstream shortens to its remote; the full ref is the title.
    expect(branch.find('.tracking').text()).toBe('origin');
    expect(branch.find('.tracking').attributes('title')).toBe('origin/main');
    expect(branch.find('.count-add').text()).toBe('↑2');
    expect(branch.find('.count-del').text()).toBe('↓1');

    // Status bar: change count with aggregated +/−.
    const count = wrapper.find('[data-testid="change-count"]');
    expect(count.text()).toContain('2 changed');
    expect(count.find('.count-add').text()).toBe('+15');
    expect(count.find('.count-del').text()).toBe('−2');
    wrapper.unmount();
  });
});

describe('view toolbar slot', () => {
  test('the toolbar strip (its own row, not the rail) hosts the Teleport target', async () => {
    const wrapper = await mountWithRepos([]);
    // The lifted per-view toolbars land in ViewToolbarStrip, a dedicated
    // row under the rail — NOT in the rail beside the global toggles.
    expect(wrapper.find('.view-toolbar-strip #view-toolbar-slot').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="Views"] #view-toolbar-slot').exists()).toBe(false);
    wrapper.unmount();
  });
});
