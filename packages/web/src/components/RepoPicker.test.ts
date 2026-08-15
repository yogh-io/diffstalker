/**
 * RepoPicker tests: the component contracts of the one control that both
 * filters repos and opens a typed path.
 *
 * Two groups of cases. The first are inherited from the old three-list
 * panel and must survive the merge unchanged — worktree folding, the
 * pending/absent/failed rules for recents, dedup across the three sources,
 * and clicking a row opening the RIGHT path (not the clicked literal).
 * They are asserted at COMPONENT level on purpose: the row builder has its
 * own unit tests, but only a mounted component can catch a wrong click
 * target. The second group is new behaviour: the probe behind the Open
 * button, the keyboard model, and the discovered reveal.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import RepoPicker from './RepoPicker.vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { useDismissable } from '../composables/useDismissable';
import { makeFakeFetch, worktree, Deferred } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/w/calculator';

/** Bare layout: the bare git dir is the family's main entry. */
const CALC_FAMILY = [
  worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
  worktree(`${CALC}/main`, 'main', { lastActivity: 1000 }),
  worktree(`${CALC}/fix-a`, 'fix-a', { lastActivity: 5000 }),
];

interface DiscoveredFixture {
  name: string;
  path: string;
  branch: string | null;
  lastActivity?: number | null;
}

interface Fixture {
  worktrees?: Map<string, WorktreeInfo[]>;
  discovered?: DiscoveredFixture[];
  capped?: boolean;
  /** Paths GET /resolve calls openable; everything else is not a repo. */
  openable?: string[];
  extra?: (call: FetchCall) => FakeResponse | undefined;
}

function queriedPath(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
}

function fakeDaemon(fixture: Fixture): FakeFetch {
  return makeFakeFetch((call) => {
    const extra = fixture.extra?.(call);
    if (extra) return extra;
    if (call.url.startsWith('/worktrees')) {
      return { body: fixture.worktrees?.get(queriedPath(call.url)) ?? [] };
    }
    if (call.url.startsWith('/discovered')) {
      const repos = (fixture.discovered ?? []).map((repo) => ({ lastActivity: null, ...repo }));
      return {
        body: { roots: [{ path: '/w', repos, error: null, capped: fixture.capped ?? false }] },
      };
    }
    if (call.url.startsWith('/resolve')) {
      const path = queriedPath(call.url);
      const openable = (fixture.openable ?? []).includes(path);
      return { body: { openable, root: openable ? path : null } };
    }
    if (call.method === 'POST' && call.url === '/repos') {
      return { status: 201, body: { id: 'new', path: (call.body as { path: string }).path } };
    }
    return { status: 404, body: {} };
  });
}

async function mountPicker(fixture: Fixture = {}): Promise<{ wrapper: VueWrapper; fake: FakeFetch }> {
  const fake = fakeDaemon(fixture);
  vi.stubGlobal('fetch', fake.fn);
  const wrapper = mount(RepoPicker, { attachTo: document.body });
  await flushPromises();
  return { wrapper, fake };
}

function rowNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-testid="picker-row"] .name').map((name) => name.text());
}

function sections(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.group-label').map((label) => label.text());
}

function posted(fake: FakeFetch): string[] {
  return fake.calls
    .filter((call) => call.method === 'POST' && call.url === '/repos')
    .map((call) => (call.body as { path: string }).path);
}

/** Type into the input and let the 250ms probe debounce elapse. */
async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('[data-testid="picker-input"]').setValue(text);
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// --- Inherited contracts -------------------------------------------------

describe('open repos', () => {
  test('worktrees of one project fold to a single row, counting ALL of them', async () => {
    const daemon = useDaemonStore();
    daemon.repos = [
      { id: 'calc-a', path: `${CALC}/fix-a`, branch: 'fix-a' },
      { id: 'calc-b', path: `${CALC}/main`, branch: 'main' },
      { id: 'diff', path: '/w/diffstalker', branch: 'main' },
    ];
    const family = [...CALC_FAMILY, worktree(`${CALC}/fix-b`, 'fix-b')];

    const { wrapper } = await mountPicker({
      worktrees: new Map([
        [`${CALC}/fix-a`, family],
        [`${CALC}/main`, family],
        ['/w/diffstalker', [worktree('/w/diffstalker', 'main', { main: true })]],
      ]),
    });

    expect(rowNames(wrapper)).toEqual(['calculator', 'diffstalker']);
    expect(sections(wrapper)).toEqual(['Open']);

    // The count is every worktree the project has (3 non-bare — the bare
    // entry is not one), not the 2 that happen to be open. A
    // single-worktree repo gets no badge at all.
    const rows = wrapper.findAll('[data-testid="picker-row"]');
    expect(rows[0].find('.branch').text()).toBe('3 worktrees');
    expect(rows[1].find('.branch').exists()).toBe(false);
  });

  test('the active project is marked, and clicking a row activates it', async () => {
    const daemon = useDaemonStore();
    daemon.repos = [
      { id: 'r1', path: '/w/one', branch: 'main' },
      { id: 'r2', path: '/w/two', branch: 'main' },
    ];
    daemon.activeRepoId = 'r1';

    const { wrapper, fake } = await mountPicker({
      worktrees: new Map([
        ['/w/one', [worktree('/w/one', 'main', { main: true })]],
        ['/w/two', [worktree('/w/two', 'main', { main: true })]],
      ]),
    });

    const rows = wrapper.findAll('[data-testid="picker-row"]');
    expect(rows[0].classes()).toContain('active');
    expect(rows[1].classes()).not.toContain('active');

    await rows[1].trigger('click');
    await flushPromises();
    expect(posted(fake)).toEqual(['/w/two']);
  });
});

describe('recent repos', () => {
  test('paths still resolving are held back, not drawn as stray rows', async () => {
    // Two worktrees of ONE project. Until they resolve neither knows it is
    // "calculator", so drawing them optimistically shows two rows that then
    // collapse into one — the "why is my worktree listed as a repo" bug.
    useUiStore().recentRepos = [`${CALC}/fix-a`, `${CALC}/main`];

    const gate = new Deferred<void>();
    const { wrapper } = await mountPicker({
      extra: (call) => {
        if (!call.url.startsWith('/worktrees')) return undefined;
        return gate.promise.then(() => ({ body: CALC_FAMILY })) as unknown as FakeResponse;
      },
    });

    expect(rowNames(wrapper)).toEqual([]);

    gate.resolve();
    await flushPromises();
    expect(rowNames(wrapper)).toEqual(['calculator']);
    expect(sections(wrapper)).toEqual(['Recent']);
  });

  test('siblings fold to one row, and clicking it opens the FRESHEST worktree', async () => {
    useUiStore().recentRepos = [`${CALC}/fix-a`, `${CALC}/main`, '/w/diffstalker'];

    const { wrapper, fake } = await mountPicker({
      worktrees: new Map([
        [`${CALC}/fix-a`, CALC_FAMILY],
        [`${CALC}/main`, CALC_FAMILY],
        ['/w/diffstalker', [worktree('/w/diffstalker', 'main', { main: true })]],
      ]),
    });

    expect(rowNames(wrapper)).toEqual(['calculator', 'diffstalker']);
    const calcRow = wrapper.findAll('[data-testid="picker-row"]')[0];
    expect(calcRow.find('.branch').text()).toBe('2 worktrees');

    await calcRow.trigger('click');
    await flushPromises();
    // fix-a has the higher lastActivity, so it — not the clicked row's own
    // project root — is what gets opened.
    expect(posted(fake)).toEqual([`${CALC}/fix-a`]);
  });

  test('a recent covered by an open project does not appear twice', async () => {
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'calc-a', path: `${CALC}/fix-a`, branch: 'fix-a' }];
    daemon.activeRepoId = 'calc-a';
    useUiStore().recentRepos = [`${CALC}/main`];

    const { wrapper } = await mountPicker({
      worktrees: new Map([
        [`${CALC}/fix-a`, CALC_FAMILY],
        [`${CALC}/main`, CALC_FAMILY],
      ]),
    });

    expect(rowNames(wrapper)).toEqual(['calculator']);
    expect(sections(wrapper)).toEqual(['Open']);
  });

  test('a path that is no longer a worktree is dropped', async () => {
    useUiStore().recentRepos = [`${CALC}/gone`, '/w/diffstalker'];

    const { wrapper } = await mountPicker({
      worktrees: new Map([
        ['/w/diffstalker', [worktree('/w/diffstalker', 'main', { main: true })]],
        // `${CALC}/gone` answers [] — the daemon looked and found nothing.
      ]),
    });

    expect(rowNames(wrapper)).toEqual(['diffstalker']);
  });

  test('a failed lookup is shown by its own path and retried, not cached dead', async () => {
    useUiStore().recentRepos = [`${CALC}/fix-a`];

    let calls = 0;
    const { wrapper } = await mountPicker({
      extra: (call) => {
        if (!call.url.startsWith('/worktrees')) return undefined;
        calls++;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return { body: [worktree(`${CALC}/fix-a`, 'fix-a', { main: true })] };
      },
    });

    // We could not ask, so this is not evidence the path is bad.
    expect(rowNames(wrapper)).toEqual(['fix-a']);

    // The needed-paths watcher fires again on any change to the set.
    useUiStore().recentRepos = [`${CALC}/fix-a`, '/w/other'];
    await flushPromises();
    expect(calls).toBeGreaterThan(1);
  });
});

// --- Discovered ----------------------------------------------------------

describe('discovered repos', () => {
  const TWO = [
    { name: 'archive', path: '/w/archive', branch: 'main' },
    { name: 'register', path: '/w/register', branch: 'feat/x' },
  ];

  test('hidden by default, behind a control that counts them', async () => {
    const { wrapper } = await mountPicker({ discovered: TWO });

    expect(rowNames(wrapper)).toEqual([]);
    expect(wrapper.find('[data-testid="picker-more"]').text()).toBe('Show 2 discovered repos');
  });

  test('the control reveals them, with branch and path, and hides again', async () => {
    const { wrapper } = await mountPicker({ discovered: TWO });

    await wrapper.find('[data-testid="picker-more"]').trigger('click');
    expect(rowNames(wrapper)).toEqual(['archive', 'register']);
    expect(sections(wrapper)).toEqual(['Discovered']);
    expect(wrapper.findAll('[data-testid="picker-row"]')[1].find('.branch').text()).toBe('feat/x');
    expect(wrapper.find('[data-testid="picker-more"]').text()).toBe('Hide discovered repos');

    await wrapper.find('[data-testid="picker-more"]').trigger('click');
    expect(rowNames(wrapper)).toEqual([]);
  });

  test('clicking the control leaves focus in the input', async () => {
    // Found in the browser, not in a test: the control is the one row a
    // mouse can press without the picker closing right after, so a click
    // that parked focus on it left the next arrow key and the next Escape
    // going to the popover instead of the query.
    const { wrapper } = await mountPicker({ discovered: TWO });

    // Asserted on the EVENT, not on document.activeElement: the focus move
    // this prevents is the browser's own default action for mousedown, and
    // the test DOM does not perform it — so an activeElement check would
    // pass with the handler removed.
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    wrapper.find('[data-testid="picker-more"]').element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a capped scan says so instead of passing a truncated list off as complete', async () => {
    const { wrapper } = await mountPicker({ discovered: TWO, capped: true });
    expect(wrapper.find('[data-testid="picker-more"]').text()).toBe(
      'Show 2+ discovered repos (list incomplete)'
    );
  });

  test('mounting rescans, so a branch label is not stale', async () => {
    const { fake } = await mountPicker({ discovered: TWO });
    expect(fake.callsTo('/discovered/rescan')).toHaveLength(1);
  });

  test('a repo open on the daemon is not repeated — bare siblings included', async () => {
    // The bare layout is the case one merged list cannot get away with:
    // discovery finds every sibling worktree as a repo of its own, so
    // without the FAMILY the project shows once under Open and once per
    // sibling under Discovered.
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'calc', path: `${CALC}/main`, branch: 'main' }];

    const { wrapper } = await mountPicker({
      worktrees: new Map([[`${CALC}/main`, CALC_FAMILY]]),
      discovered: [
        { name: 'main', path: `${CALC}/main`, branch: 'main' },
        { name: 'fix-a', path: `${CALC}/fix-a`, branch: 'fix-a' },
        { name: 'register', path: '/w/register', branch: 'main' },
      ],
    });

    await wrapper.find('[data-testid="picker-more"]').trigger('click');
    expect(rowNames(wrapper)).toEqual(['calculator', 'register']);
  });
});

// --- Filtering -----------------------------------------------------------

describe('the filter', () => {
  test('one query reaches every source, and the control steps aside', async () => {
    useUiStore().recentRepos = ['/w/diffstalker'];
    const { wrapper } = await mountPicker({
      worktrees: new Map([['/w/diffstalker', [worktree('/w/diffstalker', 'main', { main: true })]]]),
      discovered: [
        { name: 'archive', path: '/w/archive', branch: 'main' },
        { name: 'register', path: '/w/register', branch: 'main' },
      ],
    });

    await type(wrapper, 'arch');

    // A recent AND a discovered repo, without expanding anything.
    expect(rowNames(wrapper)).toEqual(['archive']);
    expect(wrapper.find('[data-testid="picker-more"]').exists()).toBe(false);

    await type(wrapper, 'zzzz');
    expect(wrapper.find('[data-testid="picker-no-matches"]').text()).toContain('zzzz');
  });
});

// --- The Open button -----------------------------------------------------

describe('the Open button', () => {
  test('appears only once the daemon confirms the exact path', async () => {
    const { wrapper } = await mountPicker({ openable: ['/w/archive'] });

    // A name is never probed: no button, no request.
    await type(wrapper, 'archive');
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(false);

    await type(wrapper, '/w/nope');
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="picker-note"]').text()).toBe('not a git repository');

    await type(wrapper, '/w/archive');
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(true);
  });

  test('is debounced, and a stale answer never lands', async () => {
    const { wrapper, fake } = await mountPicker({ openable: ['/w/archive'] });
    const input = wrapper.find('[data-testid="picker-input"]');

    await input.setValue('/w/a');
    await input.setValue('/w/ar');
    await input.setValue('/w/archive');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();

    // One probe for the settled text, not one per keystroke.
    expect(fake.callsTo('/resolve')).toHaveLength(1);
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(true);
  });

  test('one more keystroke disarms it, before any new answer', async () => {
    const { wrapper } = await mountPicker({ openable: ['/w/archive'] });
    await type(wrapper, '/w/archive');
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(true);

    // No timers advanced: the answer we hold is for the OLD text, and a
    // button that stayed would open a path the daemon never confirmed.
    await wrapper.find('[data-testid="picker-input"]').setValue('/w/archives');
    expect(wrapper.find('[data-testid="picker-open-btn"]').exists()).toBe(false);
  });

  test('clicking it opens the ROOT the daemon named, not the typed text', async () => {
    // A bare container resolves to a worktree inside it.
    const { wrapper, fake } = await mountPicker({
      extra: (call) =>
        call.url.startsWith('/resolve')
          ? { body: { openable: true, root: `${CALC}/fix-a` } }
          : undefined,
    });

    await type(wrapper, CALC);
    await wrapper.find('[data-testid="picker-open-btn"]').trigger('click');
    await flushPromises();

    expect(posted(fake)).toEqual([`${CALC}/fix-a`]);
  });

  test('a refusal from the daemon is shown under the input', async () => {
    const { wrapper } = await mountPicker({
      openable: ['/w/archive'],
      extra: (call) =>
        call.method === 'POST' && call.url === '/repos'
          ? { status: 400, body: { error: 'Not a git repository' } }
          : undefined,
    });

    await type(wrapper, '/w/archive');
    await wrapper.find('[data-testid="picker-open-btn"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="picker-note"]').text()).toContain('Not a git repository');
  });

  test('a 400 for a path the daemon could not expand reads as not-a-repo, not as a dead daemon', async () => {
    // `~jorn/x` never expands, so it arrives still relative and comes back
    // 400. Calling that a transport failure would claim the daemon is
    // unreachable while it is answering.
    const { wrapper } = await mountPicker({
      extra: (call) =>
        call.url.startsWith('/resolve')
          ? { status: 400, body: { error: 'Repo path must be absolute: ~jorn/x' } }
          : undefined,
    });

    await type(wrapper, '~jorn/x');
    expect(wrapper.find('[data-testid="picker-note"]').text()).toBe('not a git repository');
  });
});

// --- Keyboard ------------------------------------------------------------

describe('keyboard', () => {
  async function twoOpenRepos(): Promise<{ wrapper: VueWrapper; fake: FakeFetch }> {
    const daemon = useDaemonStore();
    // '/w/one-extra' exists so a typed '/w/one' matches a ROW as well as
    // the probe — the collision the selection rule below is about.
    daemon.repos = [
      { id: 'r1', path: '/w/one', branch: 'main' },
      { id: 'r2', path: '/w/two', branch: 'main' },
      { id: 'r3', path: '/w/one-extra', branch: 'main' },
    ];
    return mountPicker({
      worktrees: new Map([
        ['/w/one', [worktree('/w/one', 'main', { main: true })]],
        ['/w/two', [worktree('/w/two', 'main', { main: true })]],
        ['/w/one-extra', [worktree('/w/one-extra', 'main', { main: true })]],
      ]),
      openable: ['/w/one'],
    });
  }

  test('arrows move the rail and Enter opens the selected row', async () => {
    const { wrapper, fake } = await twoOpenRepos();
    const input = wrapper.find('[data-testid="picker-input"]');

    // The first row is selected without touching anything.
    expect(wrapper.findAll('[data-testid="picker-row"]')[0].classes()).toContain('selected');

    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.findAll('[data-testid="picker-row"]')[1].classes()).toContain('selected');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(posted(fake)).toEqual(['/w/two']);
  });

  test('Enter opens the probed path, unless the selection has been moved', async () => {
    const { wrapper, fake } = await twoOpenRepos();
    const input = wrapper.find('[data-testid="picker-input"]');

    await type(wrapper, '/w/one');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(posted(fake)).toEqual(['/w/one']);

    // Same text, but the user has arrowed onto the row it also matches:
    // the rail wins, or the rail and Enter disagree about what opens.
    await type(wrapper, '/w/one');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(posted(fake).at(-1)).toBe('/w/one-extra');
  });

  test('Enter does nothing while the probe is still out', async () => {
    const { wrapper, fake } = await twoOpenRepos();
    const input = wrapper.find('[data-testid="picker-input"]');

    await input.setValue('/w/one');
    // Mid-debounce: firing the raw path at POST /repos would reintroduce
    // the parent fallback the probe exists to close.
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(posted(fake)).toEqual([]);
  });

  test('the selection survives a late worktree resolution, by key not index', async () => {
    // The recents fold from two rows into one AFTER the user has selected;
    // an index-based selection would silently come to mean another repo.
    useUiStore().recentRepos = ['/w/aaa', `${CALC}/fix-a`, `${CALC}/main`];
    const gate = new Deferred<void>();

    const { wrapper, fake } = await mountPicker({
      extra: (call) => {
        if (!call.url.startsWith('/worktrees')) return undefined;
        const path = queriedPath(call.url);
        if (path === '/w/aaa') {
          return { body: [worktree('/w/aaa', 'main', { main: true })] };
        }
        return gate.promise.then(() => ({ body: CALC_FAMILY })) as unknown as FakeResponse;
      },
    });

    expect(rowNames(wrapper)).toEqual(['aaa']);
    const input = wrapper.find('[data-testid="picker-input"]');
    await input.trigger('keydown', { key: 'ArrowDown' }); // stays on 'aaa'

    gate.resolve();
    await flushPromises();
    expect(rowNames(wrapper)).toEqual(['aaa', 'calculator']);

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(posted(fake)).toEqual(['/w/aaa']);
  });

  test('Escape clears the query first and closes the popover only when empty', async () => {
    // Mounted inside a useDismissable shell, because the thing under test
    // is precisely the interaction between the two: the composable's
    // document listener closes on ANY Escape and never checks
    // defaultPrevented, so only stopPropagation can hold it off.
    const Shell = defineComponent({
      setup() {
        const { open, rootEl } = useDismissable();
        open.value = true;
        // Destructured under these exact names: Vue binds ref="rootEl" by
        // matching the setup variable's name.
        return { open, rootEl };
      },
      render() {
        return h('div', { ref: 'rootEl' }, this.open ? [h(RepoPicker)] : []);
      },
    });

    vi.stubGlobal('fetch', fakeDaemon({ discovered: [] }).fn);
    const wrapper = mount(Shell, { attachTo: document.body });
    await flushPromises();

    const input = wrapper.find('[data-testid="picker-input"]');
    await input.setValue('arch');

    // The real Escape path: the input's handler runs in the target phase,
    // the document listener would run after it.
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(wrapper.find('[data-testid="repo-picker"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="picker-input"]').element as HTMLInputElement).value).toBe(
      ''
    );

    // Empty now: the next Escape belongs to the popover.
    wrapper
      .find('[data-testid="picker-input"]')
      .element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[data-testid="repo-picker"]').exists()).toBe(false);
  });
});
