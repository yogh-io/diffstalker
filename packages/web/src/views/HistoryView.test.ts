/**
 * HistoryView tests: load-on-activation (only when the list is empty),
 * commit rows (hash, message, author, relative date, ref tags),
 * identity-preserving selection (the exact CommitInfo object reaches
 * repo.selectHistoryCommit), keyboard navigation with roving tabindex,
 * the detail pane (metadata, the changed-file tree, and one diff-stack
 * section per file), the load-more paging affordance, the empty-log
 * and no-selection states, and the viewer stance (no cherry-pick /
 * revert controls — the web UI is read-only).
 *
 * The repo store runs for real; state is set directly on it (repoId
 * stays null, so store actions never fetch), matching ChangesView.test.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import HistoryView from './HistoryView.vue';
import { useRepoStore } from '../stores/repo';
import { formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareFileDiff } from '@diffstalker/core/git/diff';
import { loadPrefs } from '../prefs';
import { stubMatchMedia } from '../testing/portrait';

function commit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  const hash = overrides.hash ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: 'Fix the thing',
    author: 'yogh-io',
    date: new Date(Date.now() - 2 * 86_400_000),
    refs: '',
    ...overrides,
  };
}

/** A commit touching two files — the per-file rows the daemon returns. */
const TWO_FILES: CompareFileDiff[] = [
  {
    path: 'src/bar.ts',
    status: 'added',
    additions: 1,
    deletions: 0,
    diff: {
      lines: [
        { type: 'header', content: 'diff --git a/src/bar.ts b/src/bar.ts' },
        { type: 'header', content: 'new file mode 100644' },
        { type: 'hunk', content: '@@ -0,0 +1 @@' },
        { type: 'addition', content: '+new bar', newLineNum: 1 },
      ],
    },
  },
  {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    diff: {
      lines: [
        { type: 'header', content: 'diff --git a/src/foo.ts b/src/foo.ts' },
        { type: 'hunk', content: '@@ -1 +1 @@' },
        { type: 'deletion', content: '-old foo', oldLineNum: 1 },
        { type: 'addition', content: '+new foo', newLineNum: 1 },
      ],
    },
  },
];

let pinia: Pinia;

function mountView(commits: CommitInfo[]): {
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
} {
  const repo = useRepoStore();
  repo.history = { commits, selectedCommit: null, commitFiles: null, isLoading: false };
  const wrapper = mount(HistoryView, {
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

describe('load on activation', () => {
  test('an empty list loads the default page on mount', () => {
    const repo = useRepoStore();
    const spy = vi.spyOn(repo, 'loadHistory').mockResolvedValue(undefined);
    mount(HistoryView, { global: { plugins: [pinia] } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(100);
  });

  test('an already-loaded list does NOT reload on mount', () => {
    const repo = useRepoStore();
    repo.history = { commits: [commit()], selectedCommit: null, commitFiles: null, isLoading: false };
    const spy = vi.spyOn(repo, 'loadHistory').mockResolvedValue(undefined);
    mount(HistoryView, { global: { plugins: [pinia] } });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a rejected load lands as an error line, not an unhandled throw', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'loadHistory').mockRejectedValue(new Error('git log failed'));
    const wrapper = mount(HistoryView, { global: { plugins: [pinia] } });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('git log failed');
    });
  });
});

describe('commit list', () => {
  test('rows show hash, message, author, relative date, and ref tags', () => {
    const withRefs = commit({
      hash: 'b'.repeat(40),
      message: 'Add compare view',
      author: 'Ada',
      refs: 'HEAD -> main, origin/main',
    });
    const { wrapper } = mountView([withRefs, commit()]);

    const rows = wrapper.findAll('.commit-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.hash').text()).toBe('bbbbbbb');
    expect(rows[0].find('.message').text()).toBe('Add compare view');
    expect(rows[0].find('.author').text()).toBe('Ada');
    expect(rows[0].find('.date').text()).toBe('2 days ago');
    expect(rows[0].findAll('.ref-tag').map((tag) => tag.text())).toEqual([
      'HEAD -> main',
      'origin/main',
    ]);
    // No refs → no tags.
    expect(rows[1].findAll('.ref-tag')).toHaveLength(0);
  });

  test('clicking a row calls selectHistoryCommit with the EXACT commit object', async () => {
    const commits = [commit(), commit({ hash: 'c'.repeat(40), message: 'Second' })];
    const { wrapper, repo } = mountView(commits);
    const spy = vi.spyOn(repo, 'selectHistoryCommit');

    await wrapper.findAll('.commit-row')[1].trigger('click');

    expect(spy).toHaveBeenCalledTimes(1);
    // Identity, not equality: the store's stale-guard depends on it.
    expect(spy.mock.calls[0][0]).toBe(repo.history.commits[1]);
  });

  test('the list is a listbox; the selected row is highlighted and aria-selected', async () => {
    const commits = [commit(), commit({ hash: 'c'.repeat(40) })];
    const { wrapper, repo } = mountView(commits);
    repo.history = { ...repo.history, selectedCommit: repo.history.commits[1] };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="commit-list"]').attributes('role')).toBe('listbox');
    const rows = wrapper.findAll('.commit-row');
    expect(rows.every((row) => row.attributes('role') === 'option')).toBe(true);
    expect(rows.map((row) => row.attributes('aria-selected'))).toEqual(['false', 'true']);
    expect(rows[1].classes()).toContain('selected');
  });

  test('ArrowDown/ArrowUp move the selection and clamp at the ends', async () => {
    const commits = [commit(), commit({ hash: 'c'.repeat(40) })];
    const { wrapper, repo } = mountView(commits);
    repo.history = { ...repo.history, selectedCommit: repo.history.commits[0] };
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.commit-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.history.selectedCommit).toBe(repo.history.commits[1]);

    // Clamp at the bottom: stays put.
    await wrapper.findAll('.commit-row')[1].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.history.selectedCommit).toBe(repo.history.commits[1]);

    await wrapper.findAll('.commit-row')[1].trigger('keydown', { key: 'ArrowUp' });
    expect(repo.history.selectedCommit).toBe(repo.history.commits[0]);
  });

  test('roving tabindex: the selected row is the only tab stop', async () => {
    const commits = [commit(), commit({ hash: 'c'.repeat(40) })];
    const { wrapper, repo } = mountView(commits);
    repo.history = { ...repo.history, selectedCommit: repo.history.commits[1] };
    await wrapper.vm.$nextTick();

    const stops = wrapper.findAll('.commit-row').map((row) => row.attributes('tabindex'));
    expect(stops).toEqual(['-1', '0']);
  });

  test('shows "No commits yet." for an empty log', () => {
    const { wrapper } = mountView([]);
    expect(wrapper.find('[data-testid="history-empty"]').text()).toBe('No commits yet.');
  });
});

describe('load more', () => {
  function fullPage(): CommitInfo[] {
    return Array.from({ length: 100 }, (_, i) =>
      commit({ hash: `${i}`.padStart(40, '0'), message: `commit ${i}` })
    );
  }

  test('a full page shows the affordance; clicking raises the count by a page', async () => {
    const { wrapper, repo } = mountView(fullPage());
    const spy = vi.spyOn(repo, 'loadHistory').mockResolvedValue(undefined);

    const button = wrapper.find('[data-testid="load-more"]');
    expect(button.exists()).toBe(true);
    await button.trigger('click');
    expect(spy).toHaveBeenCalledWith(200);
  });

  test('a short page hides the affordance — nothing more to load', () => {
    const { wrapper } = mountView([commit()]);
    expect(wrapper.find('[data-testid="load-more"]').exists()).toBe(false);
  });

  test('the button stays visible as disabled "Loading…" while the pull is in flight', async () => {
    const { wrapper, repo } = mountView(fullPage());
    vi.spyOn(repo, 'loadHistory').mockImplementation(() => {
      repo.history = { ...repo.history, isLoading: true };
      return new Promise<void>(() => {}); // never settles: held in flight
    });

    await wrapper.find('[data-testid="load-more"]').trigger('click');
    const button = wrapper.find('[data-testid="load-more"]');
    expect(button.exists()).toBe(true); // did NOT vanish on click
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toBe('Loading…');
  });

  test('a load-more failure keeps the list and offers a retry', async () => {
    const { wrapper, repo } = mountView(fullPage());
    const spy = vi.spyOn(repo, 'loadHistory').mockRejectedValue(new Error('git log failed'));

    await wrapper.find('[data-testid="load-more"]').trigger('click');
    await flushPromises();

    // The list survives; the failure is a small inline line, not a
    // full-pane replacement.
    expect(wrapper.findAll('.commit-row')).toHaveLength(100);
    expect(wrapper.find('[data-testid="load-error"]').text()).toContain('git log failed');
    expect(wrapper.find('[data-testid="load-more"]').exists()).toBe(true);

    // Retry re-runs the SAME failed count; success clears the line.
    spy.mockResolvedValue(undefined);
    await wrapper.find('[data-testid="load-retry"]').trigger('click');
    expect(spy).toHaveBeenLastCalledWith(200);
    await flushPromises();
    expect(wrapper.find('[data-testid="load-error"]').exists()).toBe(false);
  });
});

describe('commit detail', () => {
  test('shows the quiet prompt when nothing is selected', () => {
    const { wrapper } = mountView([commit()]);
    expect(wrapper.find('[data-testid="history-prompt"]').text()).toBe(
      'Select a commit to view its changes'
    );
  });

  test('shows metadata, the changed-file tree, and one diff section per file', async () => {
    const selected = commit({ message: 'Split the daemon', author: 'Ada' });
    const { wrapper, repo } = mountView([selected]);
    repo.history = {
      ...repo.history,
      selectedCommit: repo.history.commits[0],
      commitFiles: TWO_FILES,
    };
    await wrapper.vm.$nextTick();

    const detail = wrapper.find('[data-testid="commit-detail"]');
    expect(detail.find('.full-hash').text()).toBe(selected.hash);
    expect(detail.find('.detail-message').text()).toBe('Split the daemon');
    expect(detail.find('.detail-meta .author').text()).toBe('Ada');
    expect(detail.find('.abs-date').text()).toBe(formatDateAbsolute(selected.date));

    // The tree lists the commit's files with git's status and counts.
    const rows = wrapper.find('[data-testid="commit-files"]').findAll('.file-row');
    expect(rows.map((r) => r.find('.name').text())).toEqual(['bar.ts', 'foo.ts']);
    expect(rows.map((r) => r.find('.letter').attributes('data-status'))).toEqual([
      'added',
      'modified',
    ]);
    expect(rows[1].find('.count-del').text()).toBe('−1');

    // The stack holds one section per file, in tree order.
    const sections = wrapper.findAll('[data-testid="file-diff"]');
    expect(sections.map((sec) => sec.find('.path').text())).toEqual(['src/bar.ts', 'src/foo.ts']);
    expect(sections[1].find('.row.del .content').text()).toBe('old foo');
  });

  test('the first file starts selected; clicking a row selects it', async () => {
    const { wrapper, repo } = mountView([commit()]);
    repo.history = {
      ...repo.history,
      selectedCommit: repo.history.commits[0],
      commitFiles: TWO_FILES,
    };
    await wrapper.vm.$nextTick();

    const rows = () => wrapper.find('[data-testid="commit-files"]').findAll('.file-row');
    expect(rows()[0].attributes('aria-selected')).toBe('true');

    await rows()[1].trigger('click');
    expect(rows()[1].attributes('aria-selected')).toBe('true');
    expect(rows()[0].attributes('aria-selected')).toBe('false');
    expect(wrapper.findAll('[data-testid="file-diff"]')[1].classes()).toContain('selected');
  });

  test('the top of the TREE starts selected, not the flat-sorted first file', async () => {
    const { wrapper, repo } = mountView([commit()]);
    // Flat path sort puts README.md first; the tree puts the src/ folder first.
    const [bar] = TWO_FILES;
    const readme = { ...bar, path: 'README.md' };
    repo.history = {
      ...repo.history,
      selectedCommit: repo.history.commits[0],
      commitFiles: [readme, bar],
    };
    await wrapper.vm.$nextTick();

    const selected = wrapper.find('[data-testid="commit-files"] .file-row[aria-selected="true"]');
    expect(selected.find('.name').text()).toBe('bar.ts');
  });

  test('a commit with no file rows (a merge) says so instead of an empty pane', async () => {
    const { wrapper, repo } = mountView([commit()]);
    repo.history = { ...repo.history, selectedCommit: repo.history.commits[0], commitFiles: [] };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="history-no-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="commit-diffs"]').exists()).toBe(false);
  });

  test('the wrap toggle switches the commit diff into wrap mode', async () => {
    const selected = commit({ message: 'Split the daemon', author: 'Ada' });
    const { wrapper, repo } = mountView([selected]);
    repo.history = {
      ...repo.history,
      selectedCommit: repo.history.commits[0],
      commitFiles: TWO_FILES,
    };
    await wrapper.vm.$nextTick();

    // The first real section — the stack's hidden size probe is a DiffView too.
    const first = wrapper.findAll('[data-testid="file-diff"]')[0];
    expect(first.find('.diff-scroll').classes()).not.toContain('wrap');

    await wrapper.find('[data-testid="wrap-toggle"]').trigger('click');

    expect(first.find('.diff-scroll').classes()).toContain('wrap');
  });

  test('a selected commit with no diff yet shows a loading line', async () => {
    const { wrapper, repo } = mountView([commit()]);
    repo.history = { ...repo.history, selectedCommit: repo.history.commits[0], commitFiles: null };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Loading diff…');
  });

  test('a rejected diff load shows the calm error, not a stuck "Loading diff…"', async () => {
    const { wrapper, repo } = mountView([commit()]);
    // The real store sets the selection synchronously, THEN rejects the
    // DaemonError from the diff pull — mirror that shape.
    vi.spyOn(repo, 'selectHistoryCommit').mockImplementation(async (c) => {
      repo.history = { ...repo.history, selectedCommit: c, commitFiles: null };
      throw new Error('git show failed');
    });

    await wrapper.findAll('.commit-row')[0].trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="detail-error"]').text()).toBe(
      'Failed to load commit diff: git show failed'
    );
    expect(wrapper.text()).not.toContain('Loading diff…');
  });
});

describe('re-anchoring across a state-change re-pull', () => {
  test('the selected commit is re-selected by hash when the list is rebuilt', async () => {
    const { wrapper, repo } = mountView([commit()]);
    const spy = vi.spyOn(repo, 'selectHistoryCommit');
    await wrapper.findAll('.commit-row')[0].trigger('click');
    await flushPromises();
    expect(repo.history.selectedCommit).toBe(repo.history.commits[0]);

    // The store's reload mints NEW commit objects and drops the selection.
    const reloaded = commit(); // same hash, different object
    repo.history = { commits: [reloaded], selectedCommit: null, commitFiles: null, isLoading: false };
    await flushPromises();

    expect(spy).toHaveBeenLastCalledWith(reloaded);
    expect(repo.history.selectedCommit).toBe(reloaded);
    // The detail persists — no collapse to the prompt.
    expect(wrapper.find('[data-testid="history-prompt"]').exists()).toBe(false);
    expect(wrapper.find('.full-hash').text()).toBe(reloaded.hash);
  });

  test('a hash that vanished (rebased away) falls back to the prompt', async () => {
    const { wrapper, repo } = mountView([commit()]);
    const spy = vi.spyOn(repo, 'selectHistoryCommit');
    await wrapper.findAll('.commit-row')[0].trigger('click');
    await flushPromises();
    spy.mockClear();

    repo.history = {
      commits: [commit({ hash: 'f'.repeat(40) })],
      selectedCommit: null,
      commitFiles: null,
      isLoading: false,
    };
    await flushPromises();

    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="history-prompt"]').exists()).toBe(true);
  });
});

describe('viewer stance (read-only)', () => {
  test('the detail header offers NO cherry-pick/revert controls — no buttons at all', async () => {
    const repo = useRepoStore();
    const selected = commit({ message: 'Fix the thing' });
    repo.history = {
      commits: [selected],
      selectedCommit: selected,
      commitFiles: TWO_FILES,
      isLoading: false,
    };
    const wrapper = mount(HistoryView, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    // The detail renders (read path intact)…
    const detail = wrapper.find('[data-testid="commit-detail"]');
    expect(detail.find('.detail-message').text()).toBe('Fix the thing');
    expect(wrapper.find('[data-testid="commit-diffs"]').exists()).toBe(true);
    // …with no commit actions and no confirm flow.
    expect(wrapper.find('[data-testid="cherry-pick"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="revert"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="commit-action-confirm"]').exists()).toBe(false);
    expect(detail.findAll('button')).toHaveLength(0);
  });
});

describe('portrait layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('landscape renders NO row resizer', () => {
    stubMatchMedia(false);
    const { wrapper } = mountView([commit()]);
    expect(wrapper.find('.row-resizer').exists()).toBe(false);
  });

  test('portrait adds a horizontal row resizer that persists historyTop', async () => {
    stubMatchMedia(true);
    const { wrapper } = mountView([commit()]);
    expect(wrapper.find('.history').classes()).toContain('portrait');
    expect(wrapper.find('.history').attributes('style')).toContain('--history-top: 28.00%');

    const resizer = wrapper.find('.row-resizer');
    expect(resizer.attributes('role')).toBe('separator');
    expect(resizer.attributes('aria-orientation')).toBe('horizontal');

    await resizer.trigger('keydown', { key: 'ArrowDown' });
    expect(loadPrefs().historyTop).toBeCloseTo(0.3);
    expect(wrapper.find('.history').attributes('style')).toContain('--history-top: 30.00%');
  });

  test('j/k move the commit selection within the band', async () => {
    stubMatchMedia(true);
    const commits = [commit({ hash: 'a'.repeat(40) }), commit({ hash: 'b'.repeat(40) })];
    const { wrapper, repo } = mountView(commits);
    const spy = vi.spyOn(repo, 'selectHistoryCommit').mockResolvedValue(undefined);

    await wrapper.findAll('.commit-row')[0].trigger('keydown', { key: 'j' });
    expect(spy).toHaveBeenCalledWith(commits[0]); // nothing selected: j picks the first
  });

  test('the diff stack is a focusable region in portrait', async () => {
    stubMatchMedia(true);
    const commits = [commit()];
    const { wrapper, repo } = mountView(commits);
    repo.history = {
      commits,
      selectedCommit: commits[0],
      commitFiles: TWO_FILES,
      isLoading: false,
    };
    await wrapper.vm.$nextTick();

    const pane = wrapper.find('[data-testid="commit-diffs"]');
    expect(pane.attributes('tabindex')).toBe('0');
    expect(pane.attributes('role')).toBe('region');
  });
});
