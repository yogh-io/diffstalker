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
import { makeFakeFetch, FakeEventSource } from './testing/fakes';
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

function routes(call: FetchCall): FakeResponse {
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
  // The History / Compare views pull these on activation.
  if (call.method === 'GET' && /^\/repos\/[^/]+\/history/.test(call.url)) {
    return { body: [] };
  }
  // The fuzzy finder pulls the full file list on open.
  if (call.method === 'GET' && /^\/repos\/[^/]+\/files$/.test(call.url)) {
    return { body: ['README.md', 'src/a.ts', 'src/b.ts'] };
  }
  if (call.method === 'GET' && /^\/repos\/[^/]+\/base-branches$/.test(call.url)) {
    return { body: ['origin/main'] };
  }
  if (call.method === 'GET' && /^\/repos\/[^/]+\/compare\?/.test(call.url)) {
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

beforeEach(() => {
  localStorage.clear();
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

    const form = wrapper.find('[data-testid="empty-state"] form');
    await form.find('input').setValue('/other');
    await form.trigger('submit');
    await flushPromises();

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

    const form = wrapper.find('[data-testid="empty-state"] form');
    await form.find('input').setValue('/not-a-repo');
    await form.trigger('submit');
    await flushPromises();

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
    const rows = wrapper.find('[data-testid="open-repos"]').findAll('.repo-row');
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
    const rows = wrapper.find('[data-testid="open-repos"]').findAll('.repo-row');
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
    const rows = wrapper.find('[data-testid="open-repos"]').findAll('.repo-row');
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
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Compare');
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

  test('view keys 1-4 switch views from anywhere outside a text field', async () => {
    const wrapper = await mountWithRepos([REPO_ONE]);

    press('4');
    await flushPromises();
    expect(wrapper.find('button[aria-current="page"]').attributes('title')).toBe('Explorer');

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
    expect(wrapper.find('[data-testid="connection"]').text()).toContain('daemon disconnected');
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
    expect(branch.text()).toContain('origin/main');
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

describe('portrait toolbar slot', () => {
  test('the rail hosts the Teleport target for lifted view toolbars', async () => {
    const wrapper = await mountWithRepos([]);
    expect(wrapper.find('nav[aria-label="Views"] #view-toolbar-slot').exists()).toBe(true);
    wrapper.unmount();
  });
});
