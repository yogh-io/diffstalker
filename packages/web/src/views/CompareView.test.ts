/**
 * CompareView tests: refresh-on-activation, the base-branch selector
 * (candidates listed, change → the read-only setSelectedCompareBase —
 * no daemon-side persistence), the include-uncommitted toggle
 * (re-queries with the flag), the stats line, the
 * file tree (grouping, status letters, per-file stats, uncommitted
 * flags, per-folder collapse), the stacked per-file diffs (DiffStack:
 * collapsible sticky headers, scrollToFile jumps on the stack's OWN
 * scroller — never scrollIntoView),
 * the collapsible commits section, selection (click + keyboard), and
 * the noBaseBranch / clean / loading / error states.
 *
 * The repo store runs for real; state is set directly on it (repoId
 * stays null, so store actions never fetch), matching ChangesView.test.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import CompareView from './CompareView.vue';
import DiffStack from '../components/DiffStack.vue';
import { useRepoStore } from '../stores/repo';
import { makeFakeFetch } from '../testing/fakes';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareDiff, CompareFileDiff, DiffResult } from '@diffstalker/core/git/diff';
import { loadPrefs } from '../prefs';
import { stubMatchMedia, addToolbarSlot } from '../testing/portrait';

function fileDiff(
  path: string,
  status: CompareFileDiff['status'],
  additions: number,
  deletions: number,
  isUncommitted = false
): CompareFileDiff {
  const diff: DiffResult = {
    raw: '',
    lines: [
      { type: 'header', content: `diff --git a/${path} b/${path}` },
      { type: 'hunk', content: '@@ -1 +1 @@' },
      { type: 'addition', content: `+changed ${path}`, newLineNum: 1 },
    ],
  };
  return { path, status, additions, deletions, diff, ...(isUncommitted && { isUncommitted }) };
}

function commit(hash: string, message: string): CommitInfo {
  return {
    hash: hash.repeat(40).slice(0, 40),
    shortHash: hash.repeat(7).slice(0, 7),
    message,
    author: 'Ada',
    date: new Date(Date.now() - 3 * 86_400_000),
    refs: '',
  };
}

const FILES: CompareFileDiff[] = [
  fileDiff('src/app/main.ts', 'modified', 30, 10),
  fileDiff('src/util.ts', 'added', 10, 0),
  fileDiff('notes.txt', 'deleted', 0, 2, true),
];

function makeCompareDiff(
  files: CompareFileDiff[] = FILES,
  commits: CommitInfo[] = [commit('a', 'First'), commit('b', 'Second')]
): CompareDiff {
  return {
    baseBranch: 'origin/main',
    stats: {
      filesChanged: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    },
    files,
    commits,
    uncommittedCount: files.filter((f) => f.isUncommitted).length,
  };
}

let pinia: Pinia;

function mountView(compareDiff: CompareDiff | null = makeCompareDiff()): {
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
} {
  const repo = useRepoStore();
  if (compareDiff) {
    repo.compare = {
      compareDiff,
      baseBranch: compareDiff.baseBranch,
      loading: false,
      error: null,
      noBaseBranch: false,
      selection: { type: null, index: 0, diff: null },
    };
  }
  const wrapper = mount(CompareView, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  return { wrapper, repo };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('activation', () => {
  test('refreshes the compare diff on mount (uncommitted off by default)', () => {
    const repo = useRepoStore();
    const spy = vi.spyOn(repo, 'refreshCompare').mockResolvedValue(undefined);
    mount(CompareView, { global: { plugins: [pinia] } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

describe('top bar', () => {
  test('the base selector lists candidates and shows the current base', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/main', 'origin/dev']);
    const { wrapper } = mountView();
    await flushPromises();

    const select = wrapper.find('[data-testid="base-select"]');
    expect(select.findAll('option').map((o) => o.text())).toEqual(['origin/main', 'origin/dev']);
    expect((select.element as HTMLSelectElement).value).toBe('origin/main');
  });

  test('picking a base calls the read-only setSelectedCompareBase with branch + toggle state', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/main', 'origin/dev']);
    const setBase = vi.spyOn(repo, 'setSelectedCompareBase').mockResolvedValue(undefined);
    const { wrapper } = mountView();
    await flushPromises();

    await wrapper.find('[data-testid="base-select"]').setValue('origin/dev');
    expect(setBase).toHaveBeenCalledTimes(1);
    expect(setBase).toHaveBeenCalledWith('origin/dev', false);
  });

  test('the base pick stays client-side: a GET with ?base=…, never a PUT', async () => {
    // Real store, real setSelectedCompareBase: with a repo attached the
    // pick must produce a GET /compare?base=… and nothing else.
    const fake = makeFakeFetch(() => ({
      body: {
        baseBranch: 'origin/dev',
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        files: [],
        commits: [],
        uncommittedCount: 0,
      },
    }));
    vi.stubGlobal('fetch', fake.fn);
    try {
      const repo = useRepoStore();
      vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/main', 'origin/dev']);
      const { wrapper } = mountView();
      repo.repoId = 'r1';
      await flushPromises();
      fake.calls.length = 0; // drop the activation refresh

      await wrapper.find('[data-testid="base-select"]').setValue('origin/dev');
      await flushPromises();

      expect(fake.calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', '/repos/r1/compare?base=origin%2Fdev&uncommitted=false'],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('re-picking the current base is a no-op', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/main', 'origin/dev']);
    const setBase = vi.spyOn(repo, 'setSelectedCompareBase').mockResolvedValue(undefined);
    const { wrapper } = mountView();
    await flushPromises();

    await wrapper.find('[data-testid="base-select"]').setValue('origin/main');
    expect(setBase).not.toHaveBeenCalled();
  });

  test('a base not among the candidates still appears as an option', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/dev']);
    const { wrapper } = mountView();
    await flushPromises();

    const options = wrapper.find('[data-testid="base-select"]').findAll('option');
    expect(options.map((o) => o.text())).toEqual(['origin/main', 'origin/dev']);
  });

  test('the include-uncommitted toggle re-queries with the flag', async () => {
    const { wrapper, repo } = mountView();
    const spy = vi.spyOn(repo, 'refreshCompare').mockResolvedValue(undefined);

    await wrapper.find('[data-testid="uncommitted-toggle"]').setValue(true);
    expect(spy).toHaveBeenLastCalledWith(true);

    await wrapper.find('[data-testid="uncommitted-toggle"]').setValue(false);
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  test('uncommitted ON, then a base change: setSelectedCompareBase gets the flag', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'getCandidateBaseBranches').mockResolvedValue(['origin/main', 'origin/dev']);
    const setBase = vi.spyOn(repo, 'setSelectedCompareBase').mockResolvedValue(undefined);
    const { wrapper } = mountView();
    await flushPromises();

    await wrapper.find('[data-testid="uncommitted-toggle"]').setValue(true);
    await wrapper.find('[data-testid="base-select"]').setValue('origin/dev');
    expect(setBase).toHaveBeenCalledWith('origin/dev', true);
  });

  test('the include-uncommitted choice survives a tab re-entry (remount)', async () => {
    const { wrapper, repo } = mountView();
    // The REAL refreshCompare runs (repoId null → no fetch) and records
    // the flag; the remounted component must seed its ref from it.
    await wrapper.find('[data-testid="uncommitted-toggle"]').setValue(true);
    wrapper.unmount();

    const spy = vi.spyOn(repo, 'refreshCompare').mockResolvedValue(undefined);
    const second = mount(CompareView, { global: { plugins: [pinia] } });
    const box = second.find('[data-testid="uncommitted-toggle"]');
    expect((box.element as HTMLInputElement).checked).toBe(true);
    // And the activation refresh re-queries WITH uncommitted.
    expect(spy).toHaveBeenCalledWith(true);
  });

  test('shows the diff-colored stats line', () => {
    const { wrapper } = mountView();
    const stats = wrapper.find('[data-testid="compare-stats"]');
    expect(stats.text()).toContain('3 files changed');
    expect(stats.find('.count-add').text()).toBe('+40');
    expect(stats.find('.count-del').text()).toBe('−12');
  });
});

describe('commits section', () => {
  test('is collapsed by default and expands on toggle', async () => {
    const { wrapper } = mountView();
    expect(wrapper.find('[data-testid="compare-commits"]').exists()).toBe(false);

    const toggle = wrapper.find('[data-testid="commits-toggle"]');
    expect(toggle.text()).toContain('Commits');
    expect(toggle.text()).toContain('2');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const rows = wrapper.find('[data-testid="compare-commits"]').findAll('.commit-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.hash').text()).toBe('aaaaaaa');
    expect(rows[0].find('.message').text()).toBe('First');
    expect(rows[0].find('.author').text()).toBe('Ada');
    expect(rows[0].find('.date').text()).toBe('3 days ago');
  });
});

describe('file tree', () => {
  test('groups files under directories with status letters, stats, and uncommitted flags', () => {
    const { wrapper } = mountView();
    const list = wrapper.find('[data-testid="compare-files"]');

    // Tree shape: src/ then app/ (dir→file chains don't collapse), the
    // files inside, then the root-level file (directories sort first).
    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual([
      'src/',
      'app/',
    ]);
    const rows = list.findAll('.file-row');
    expect(rows.map((row) => row.find('.name').text())).toEqual([
      'main.ts',
      'util.ts',
      'notes.txt',
    ]);
    expect(rows.map((row) => row.find('.letter').text())).toEqual(['M', 'A', 'D']);

    expect(rows[0].find('.count-add').text()).toBe('+30');
    expect(rows[0].find('.count-del').text()).toBe('−10');

    // The uncommitted file is flagged.
    expect(rows[2].classes()).toContain('uncommitted');
    expect(rows[2].find('[data-testid="uncommitted-tag"]').text()).toBe('[uncommitted]');
    expect(rows[0].find('[data-testid="uncommitted-tag"]').exists()).toBe(false);
  });

  test('a single-child directory chain renders as ONE combined dir row', () => {
    // core's buildFileTree+collapseTree merge deep→one→two; the view
    // renders the merged name on a single row.
    const files = [
      fileDiff('deep/one/two/leaf.ts', 'modified', 1, 0),
      fileDiff('root.ts', 'modified', 1, 0),
    ];
    const { wrapper } = mountView(makeCompareDiff(files, []));
    const list = wrapper.find('[data-testid="compare-files"]');

    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual([
      'deep/one/two/',
    ]);
    expect(list.findAll('.file-row').map((row) => row.find('.name').text())).toEqual([
      'leaf.ts',
      'root.ts',
    ]);
  });

  test('clicking a file selects it in the store', async () => {
    const { wrapper, repo } = mountView();
    const spy = vi.spyOn(repo, 'selectCompareFile');

    // Tree rows map back to indexes in compareDiff.files.
    await wrapper.findAll('.file-row')[2].trigger('click');
    expect(spy).toHaveBeenCalledWith(2);
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 2 });
  });

  test('keyboard: arrows move the file selection in tree order, clamped', async () => {
    const { wrapper, repo } = mountView();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 0 });

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 1 });

    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'ArrowUp' });
    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowUp' });
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 0 });
  });

  test('directory rows are presentational — only file rows are options', () => {
    const { wrapper } = mountView();
    const list = wrapper.find('[data-testid="compare-files"]');
    expect(list.attributes('role')).toBe('listbox');
    expect(list.findAll('.dir-row').every((row) => row.attributes('role') === 'presentation')).toBe(
      true
    );
    expect(list.findAll('.file-row').every((row) => row.attributes('role') === 'option')).toBe(
      true
    );
  });

  test('a tree row selects by files-array index (tree order ≠ files order) and scrolls to it', async () => {
    // files order: notes.txt (0), src/a.ts (1) — but the TREE lists the
    // src/ directory first, so the FIRST file row is a.ts (index 1).
    const files = [fileDiff('notes.txt', 'modified', 1, 0), fileDiff('src/a.ts', 'modified', 2, 0)];
    const { wrapper, repo } = mountView(makeCompareDiff(files, []));
    const spy = vi.spyOn(repo, 'selectCompareFile');

    const scroller = wrapper.find('[data-testid="compare-diffs"]').element as HTMLElement;
    const scrollSpy = vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {});

    const rows = wrapper.findAll('.file-row');
    expect(rows.map((row) => row.find('.name').text())).toEqual(['a.ts', 'notes.txt']);

    await rows[0].trigger('click');
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(1); // a.ts's files-array index
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 1 });
    // The stack jumps to a.ts's DIFF SECTION by scrolling its OWN
    // scroller (scrollTo — never scrollIntoView, which would drag every
    // ancestor and ignore the sticky header).
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(DiffStack).emitted('active-file')).toEqual([['src/a.ts']]);
  });

  test('the selected file row is aria-selected and highlighted', async () => {
    const { wrapper, repo } = mountView();
    repo.selectCompareFile(1);
    await wrapper.vm.$nextTick();

    const rows = wrapper.findAll('.file-row');
    expect(rows.map((row) => row.attributes('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(rows[1].classes()).toContain('selected');
  });
});

describe('folder collapse', () => {
  test('collapsing a directory hides its files AND subdirectories; expanding restores them', async () => {
    const { wrapper } = mountView();
    const list = wrapper.find('[data-testid="compare-files"]');

    // src/ collapses: app/ and both files under it vanish; the
    // root-level file stays. The stacked diffs on the right are a
    // tree-unrelated concern and keep all sections.
    await list.findAll('.dir-row')[0].find('.dir-collapse-btn').trigger('click');
    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual(['src/']);
    expect(list.findAll('.file-row').map((row) => row.find('.name').text())).toEqual([
      'notes.txt',
    ]);
    expect(wrapper.findAll('[data-testid="file-diff"]')).toHaveLength(3);

    await list.findAll('.dir-row')[0].find('.dir-collapse-btn').trigger('click');
    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual([
      'src/',
      'app/',
    ]);
    expect(list.findAll('.file-row')).toHaveLength(3);
  });

  test('clicking the dir ROW (not just the button) toggles too', async () => {
    const { wrapper } = mountView();
    const list = wrapper.find('[data-testid="compare-files"]');

    await list.findAll('.dir-row')[0].trigger('click');
    expect(list.findAll('.file-row')).toHaveLength(1);
    await list.findAll('.dir-row')[0].trigger('click');
    expect(list.findAll('.file-row')).toHaveLength(3);
  });

  test('a collapsed single-child chain hides its whole subtree', async () => {
    // deep→one→two merges into ONE dir row; collapsing it hides the
    // nested subdir and every file under the chain.
    const files = [
      fileDiff('deep/one/two/leaf.ts', 'modified', 1, 0),
      fileDiff('deep/one/two/sub/nested.ts', 'modified', 1, 0),
      fileDiff('root.ts', 'modified', 1, 0),
    ];
    const { wrapper } = mountView(makeCompareDiff(files, []));
    const list = wrapper.find('[data-testid="compare-files"]');
    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual([
      'deep/one/two/',
      'sub/',
    ]);

    await list.findAll('.dir-row')[0].find('.dir-collapse-btn').trigger('click');
    expect(list.findAll('.dir-row').map((row) => row.find('.dir-name').text())).toEqual([
      'deep/one/two/',
    ]);
    expect(list.findAll('.file-row').map((row) => row.find('.name').text())).toEqual(['root.ts']);
  });

  test('the toggle button carries aria-expanded/aria-label and toggles on click, Enter, and Space', async () => {
    const { wrapper } = mountView();
    const btn = () =>
      wrapper.find('[data-testid="compare-files"]').findAll('.dir-row')[0].find('.dir-collapse-btn');

    expect(btn().attributes('aria-expanded')).toBe('true');
    expect(btn().attributes('aria-label')).toBe('Collapse src');
    expect(btn().text()).toBe('▾');

    await btn().trigger('click');
    expect(btn().attributes('aria-expanded')).toBe('false');
    expect(btn().attributes('aria-label')).toBe('Expand src');
    expect(btn().text()).toBe('▸');

    await btn().trigger('keydown', { key: 'Enter' });
    expect(btn().attributes('aria-expanded')).toBe('true');
    await btn().trigger('keydown', { key: ' ' });
    expect(btn().attributes('aria-expanded')).toBe('false');

    // Left/Right mirror the Explorer: collapse/expand, idempotent.
    await btn().trigger('keydown', { key: 'ArrowLeft' });
    expect(btn().attributes('aria-expanded')).toBe('false');
    await btn().trigger('keydown', { key: 'ArrowRight' });
    expect(btn().attributes('aria-expanded')).toBe('true');
    await btn().trigger('keydown', { key: 'ArrowRight' });
    expect(btn().attributes('aria-expanded')).toBe('true');
  });

  test('keyboard nav and the tab stop skip files hidden under a collapsed dir', async () => {
    // Tree order: src/ (x.ts, y.ts), then a.ts, z.ts — dirs sort first.
    const files = [
      fileDiff('a.ts', 'modified', 1, 0), // files index 0
      fileDiff('src/x.ts', 'modified', 1, 0), // 1
      fileDiff('src/y.ts', 'modified', 1, 0), // 2
      fileDiff('z.ts', 'modified', 1, 0), // 3
    ];
    const { wrapper, repo } = mountView(makeCompareDiff(files, []));

    await wrapper.find('.dir-collapse-btn').trigger('click'); // collapse src/
    const rows = wrapper.findAll('.file-row');
    expect(rows.map((row) => row.find('.name').text())).toEqual(['a.ts', 'z.ts']);

    // ArrowDown from a.ts lands on z.ts (index 3), NOT hidden x.ts (1).
    await rows[0].trigger('click');
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 0 });
    await rows[0].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 3 });

    // Hide the SELECTED file: the tab stop falls back to the first
    // visible file row instead of pointing at a hidden one.
    await wrapper.find('.dir-collapse-btn').trigger('click'); // expand src/
    await wrapper.findAll('.file-row')[0].trigger('click'); // x.ts (index 1)
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 1 });
    await wrapper.find('.dir-collapse-btn').trigger('click'); // collapse again
    const visible = wrapper.findAll('.file-row');
    expect(visible.map((row) => row.attributes('tabindex'))).toEqual(['0', '-1']);
  });
});

describe('per-file diffs', () => {
  test('renders one DiffView per compare file, under a header with path + stats', () => {
    const { wrapper } = mountView();
    const sections = wrapper.findAll('[data-testid="file-diff"]');
    expect(sections).toHaveLength(3);

    expect(sections[0].find('.path').text()).toBe('src/app/main.ts');
    expect(sections[0].find('.count-add').text()).toBe('+30');
    expect(sections[0].find('[data-testid="diff-view"]').exists()).toBe(true);
    expect(sections[0].find('.row.add .content').text()).toBe('changed src/app/main.ts');

    // Single-file diffs: OUR sticky header names the file; DiffView adds
    // no redundant section header of its own.
    expect(sections[0].findAll('[data-testid="file-section-header"]')).toHaveLength(0);

    // The uncommitted file's header carries the marker.
    expect(sections[2].find('.uncommitted-tag').text()).toBe('[uncommitted]');
  });

  test('a file section collapses and re-expands', async () => {
    const { wrapper } = mountView();
    const first = wrapper.findAll('[data-testid="file-diff"]')[0];
    const button = first.find('.collapse-btn');
    expect(button.attributes('aria-expanded')).toBe('true');

    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(first.find('.file-diff-body').isVisible()).toBe(false);

    await button.trigger('click');
    expect(first.find('.file-diff-body').isVisible()).toBe(true);
  });

  test('the selected file gets the highlight on its diff section', async () => {
    const { wrapper, repo } = mountView();
    repo.selectCompareFile(1);
    await wrapper.vm.$nextTick();

    const sections = wrapper.findAll('[data-testid="file-diff"]');
    expect(sections.map((s) => s.classes().includes('selected'))).toEqual([false, true, false]);
  });
});

describe('empty and edge states', () => {
  test('noBaseBranch prompts for a base pick and explains remote-ref detection', () => {
    const repo = useRepoStore();
    repo.compare = {
      compareDiff: null,
      baseBranch: null,
      loading: false,
      error: null,
      noBaseBranch: true,
      selection: { type: null, index: 0, diff: null },
    };
    const wrapper = mount(CompareView, { global: { plugins: [pinia] } });

    const state = wrapper.find('[data-testid="no-base-branch"]');
    expect(state.text()).toContain('No base branch detected');
    expect(state.text()).toContain('origin/main');
    // The selector stays available to fix it.
    expect(wrapper.find('[data-testid="base-select"]').exists()).toBe(true);
  });

  test('an empty compare shows "No changes compared to <base>"', () => {
    const { wrapper } = mountView(makeCompareDiff([], []));
    expect(wrapper.find('[data-testid="compare-clean"]').text()).toBe(
      'No changes compared to origin/main.'
    );
  });

  test('shows a loading line while the first pull is in flight', () => {
    const repo = useRepoStore();
    repo.compare = {
      compareDiff: null,
      baseBranch: null,
      loading: true,
      error: null,
      noBaseBranch: false,
      selection: { type: null, index: 0, diff: null },
    };
    const wrapper = mount(CompareView, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compare-loading"]').text()).toBe('Loading compare…');
  });

  test('surfaces a compare error', () => {
    const repo = useRepoStore();
    repo.compare = {
      compareDiff: null,
      baseBranch: null,
      loading: false,
      error: 'Failed to load compare diff: boom',
      noBaseBranch: false,
      selection: { type: null, index: 0, diff: null },
    };
    const wrapper = mount(CompareView, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compare-error"]').text()).toContain('boom');
  });

  test('a transient refresh error keeps the loaded diff visible under a banner', async () => {
    const { wrapper, repo } = mountView();
    // The store deliberately KEEPS compareDiff on a failed re-pull; the
    // view must keep rendering it, with the error as a banner on top.
    repo.compare = { ...repo.compare, error: 'Failed to load compare diff: boom' };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="compare-error-banner"]').text()).toContain('boom');
    expect(wrapper.find('[data-testid="compare-error"]').exists()).toBe(false); // no full-pane takeover
    expect(wrapper.findAll('[data-testid="file-diff"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="compare-files"]').exists()).toBe(true);
  });
});

describe('portrait layout', () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia(true);
    addToolbarSlot();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('lifts the base picker and commits toggle into the tab-band slot', () => {
    const { wrapper } = mountView();
    const slot = document.querySelector('#view-toolbar-slot')!;

    expect(slot.querySelector('[data-testid="base-select"]')).not.toBeNull();
    expect(slot.querySelector('[data-testid="commits-toggle"]')).not.toBeNull();
    // ...and out of the view's own topbar/commits section.
    expect(
      wrapper.find('[data-testid="compare-topbar"] [data-testid="base-select"]').exists()
    ).toBe(false);
    expect(wrapper.find('.commits-section [data-testid="commits-toggle"]').exists()).toBe(false);
    // The uncommitted toggle stays in the topbar.
    expect(
      wrapper.find('[data-testid="compare-topbar"] [data-testid="uncommitted-toggle"]').exists()
    ).toBe(true);
  });

  test('the lifted commits toggle still opens the in-view commit list', async () => {
    const { wrapper } = mountView();
    const toggle = document.querySelector<HTMLButtonElement>(
      '#view-toolbar-slot [data-testid="commits-toggle"]'
    )!;
    expect(wrapper.find('[data-testid="compare-commits"]').exists()).toBe(false);

    toggle.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="compare-commits"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="compare-commits"] .commit-row')).toHaveLength(2);
  });

  test('jump-index: clicking a file in the band scrolls its diff section into view', async () => {
    const files = [fileDiff('notes.txt', 'modified', 1, 0), fileDiff('src/a.ts', 'modified', 2, 0)];
    const { wrapper, repo } = mountView(makeCompareDiff(files, []));

    const scroller = wrapper.find('[data-testid="compare-diffs"]').element as HTMLElement;
    const scrollSpy = vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {});

    await wrapper.findAll('.file-row')[0].trigger('click'); // a.ts (files index 1)
    await flushPromises();
    // The stacked diffs scroll to a.ts's sticky header — nothing filters.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(DiffStack).emitted('active-file')).toEqual([['src/a.ts']]);
    expect(repo.compare.selection).toMatchObject({ type: 'file', index: 1 });
    expect(wrapper.findAll('[data-testid="file-diff"]')).toHaveLength(2);
  });

  test('the PR body gets a horizontal row resizer that persists compareTop', async () => {
    const { wrapper } = mountView();
    expect(wrapper.find('.compare').classes()).toContain('portrait');
    expect(wrapper.find('.compare').attributes('style')).toContain('--compare-top: 22.00%');

    const resizer = wrapper.find('.row-resizer');
    expect(resizer.attributes('aria-orientation')).toBe('horizontal');
    await resizer.trigger('keydown', { key: 'ArrowDown' });
    expect(loadPrefs().compareTop).toBeCloseTo(0.24);
    expect(wrapper.find('.compare').attributes('style')).toContain('--compare-top: 24.00%');
  });

  test('the diffs column is a focusable region in portrait', () => {
    const { wrapper } = mountView();
    const diffs = wrapper.find('[data-testid="compare-diffs"]');
    expect(diffs.attributes('tabindex')).toBe('0');
    expect(diffs.attributes('role')).toBe('region');
  });
});
