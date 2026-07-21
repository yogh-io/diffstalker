/**
 * ChangesView tests: category grouping (Modified / Untracked / Staged),
 * per-row stats + hunk-count indicators, identity-preserving selection
 * (the exact FileEntry object reaches repo.selectFile), keyboard
 * navigation, the clean-tree and no-selection states, the diff column
 * reflecting the store selection, the persisted resizer, and the
 * viewer stance (no stage/discard/commit controls anywhere).
 *
 * The repo store runs for real; state is set directly on it (selectFile
 * with repoId === null never fetches), so no fakes are needed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import ChangesView from './ChangesView.vue';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { PREFS_KEY, loadPrefs } from '../prefs';
import { stubMatchMedia } from '../testing/portrait';
import type { RepoSharedState } from '../stores/types';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import type { DiffResult } from '@diffstalker/core/git/diff';

const FILES: FileEntry[] = [
  { path: 'src/app/main.ts', status: 'modified', staged: false, insertions: 10, deletions: 2 },
  { path: 'src/util.ts', status: 'deleted', staged: false, deletions: 30 },
  { path: 'notes.txt', status: 'untracked', staged: false, insertions: 4 },
  { path: 'src/app/main.ts', status: 'modified', staged: true, insertions: 3 },
];

function makeShared(files: FileEntry[]): RepoSharedState {
  const status: GitStatus = {
    files,
    branch: { current: 'main', ahead: 0, behind: 0 },
    isRepo: true,
  };
  return {
    status,
    hunkCounts: {
      staged: { 'src/app/main.ts': 1 },
      unstaged: { 'src/app/main.ts': 2, 'src/util.ts': 1 },
    },
    stashList: [],
    operationInProgress: null,
    mtimes: null,
    error: null,
    isLoading: false,
  };
}

const SAMPLE_DIFF: DiffResult = {
  raw: 'diff --git a/src/app/main.ts b/src/app/main.ts\n@@ -1 +1 @@\n-old\n+new\n',
  lines: [
    { type: 'header', content: 'diff --git a/src/app/main.ts b/src/app/main.ts' },
    { type: 'hunk', content: '@@ -1 +1 @@' },
    { type: 'deletion', content: '-old', oldLineNum: 1 },
    { type: 'addition', content: '+new', newLineNum: 1 },
  ],
};

let pinia: Pinia;

function mountView(files: FileEntry[] = FILES): {
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
} {
  const repo = useRepoStore();
  repo.shared = makeShared(files);
  const wrapper = mount(ChangesView, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  return { wrapper, repo };
}

beforeEach(() => {
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('files column', () => {
  test('groups files into Modified / Untracked / Staged sections with counts', () => {
    const { wrapper } = mountView();

    const modified = wrapper.find('[data-testid="section-modified"]');
    const untracked = wrapper.find('[data-testid="section-untracked"]');
    const staged = wrapper.find('[data-testid="section-staged"]');

    expect(modified.find('.section-header').text()).toBe('Modified 2');
    expect(untracked.find('.section-header').text()).toBe('Untracked 1');
    expect(staged.find('.section-header').text()).toBe('Staged 1');

    expect(modified.findAll('.file-row')).toHaveLength(2);
    expect(untracked.findAll('.file-row')).toHaveLength(1);
    expect(staged.findAll('.file-row')).toHaveLength(1);

    // Basename emphasized, dir dimmed.
    const firstRow = modified.findAll('.file-row')[0];
    expect(firstRow.find('.dir').text()).toBe('src/app/');
    expect(firstRow.find('.base').text()).toBe('main.ts');
  });

  test('an empty section is hidden', () => {
    const { wrapper } = mountView([FILES[0]]);
    expect(wrapper.find('[data-testid="section-modified"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="section-untracked"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="section-staged"]').exists()).toBe(false);
  });

  test('rows show +/− stats and hunk-count indicators', () => {
    const { wrapper } = mountView();
    const rows = wrapper.find('[data-testid="section-modified"]').findAll('.file-row');

    // main.ts unstaged: 2 of 3 hunks on this side.
    expect(rows[0].find('.stats .count-add').text()).toBe('+10');
    expect(rows[0].find('.stats .count-del').text()).toBe('−2');
    expect(rows[0].find('.hunks').text()).toBe('●2/3');

    // util.ts: all 1 hunk unstaged → bare total.
    expect(rows[1].find('.hunks').text()).toBe('●1');

    // main.ts staged: 1 of 3 hunks staged.
    const stagedRow = wrapper.find('[data-testid="section-staged"]').find('.file-row');
    expect(stagedRow.find('.hunks').text()).toBe('●1/3');

    // Untracked rows carry no hunk indicator.
    const untrackedRow = wrapper.find('[data-testid="section-untracked"]').find('.file-row');
    expect(untrackedRow.find('.hunks').exists()).toBe(false);
  });

  test('shows the clean-tree state when there are no changes', () => {
    const { wrapper } = mountView([]);
    expect(wrapper.find('[data-testid="clean-tree"]').text()).toContain(
      'No changes — working tree clean'
    );
    expect(wrapper.find('[data-testid="file-list"]').exists()).toBe(false);
  });
});

describe('selection', () => {
  test('clicking a row calls selectFile with the EXACT FileEntry object', async () => {
    const { wrapper, repo } = mountView();
    const spy = vi.spyOn(repo, 'selectFile');

    await wrapper.find('[data-testid="section-untracked"]').find('.file-row').trigger('click');

    expect(spy).toHaveBeenCalledTimes(1);
    // Identity, not equality: the store's stale-guard depends on it.
    expect(spy.mock.calls[0][0]).toBe(repo.shared.status!.files[2]);
    expect(repo.selection.file).toBe(repo.shared.status!.files[2]);
  });

  test('the selected row is highlighted', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    const rows = wrapper.findAll('.file-row');
    expect(rows[0].classes()).toContain('selected');
    expect(rows.filter((row) => row.classes().includes('selected'))).toHaveLength(1);
  });

  test('the auto-flashed file row carries the flash class until the window closes', async () => {
    vi.useFakeTimers();
    try {
      const { wrapper } = mountView();
      const ui = useUiStore();

      ui.flashFile('src/util.ts');
      await wrapper.vm.$nextTick();

      const flashed = wrapper.findAll('.file-row').filter((row) => row.classes().includes('flash'));
      expect(flashed).toHaveLength(1);
      expect(flashed[0].attributes('title')).toBe('src/util.ts');

      vi.advanceTimersByTime(900);
      await wrapper.vm.$nextTick();
      expect(
        wrapper.findAll('.file-row').filter((row) => row.classes().includes('flash'))
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('ArrowDown moves the selection to the next file in category order', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.selection.file).toBe(files[1]);

    // Ordered flat list: modified → untracked → staged.
    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'ArrowDown' });
    expect(repo.selection.file).toBe(files[2]);
  });

  test('roving tabindex: only the selected row is a tab stop', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[1], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    const stops = wrapper.findAll('.file-row').map((row) => row.attributes('tabindex'));
    expect(stops).toEqual(['-1', '0', '-1', '-1']);
  });

  test('ArrowUp moves the selection up and clamps at the top (no wrap)', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[1], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'ArrowUp' });
    expect(repo.selection.file).toBe(files[0]);

    // Already at the top: stays put, does not wrap to the last file.
    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowUp' });
    expect(repo.selection.file).toBe(files[0]);
  });

  test('the list is a listbox of options with aria-selected on the picked row', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="file-list"]').attributes('role')).toBe('listbox');
    const rows = wrapper.findAll('.file-row');
    expect(rows.every((row) => row.attributes('role') === 'option')).toBe(true);
    expect(rows.map((row) => row.attributes('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    // The old toggle-button semantics are gone.
    expect(rows.some((row) => row.attributes('aria-pressed') !== undefined)).toBe(false);
  });

  test('after moveSelection focus lands on the new row, and Space selects', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();
    expect(repo.selection.file).toBe(files[1]);
    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[1].element);

    const spy = vi.spyOn(repo, 'selectFile');
    await wrapper.findAll('.file-row')[2].trigger('keydown', { key: ' ' });
    expect(spy).toHaveBeenCalledWith(files[2]);
    expect(repo.selection.file).toBe(files[2]);
  });

  test('focus recovers to the selected row when the focused row vanishes', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[1], diff: null, combined: null };
    await wrapper.vm.$nextTick();
    (wrapper.findAll('.file-row')[1].element as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[1].element);

    // State-change drops util.ts; the store re-anchors selection.
    repo.shared = makeShared([files[0], files[2], files[3]]);
    repo.selection = { file: files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[0].element);
  });
});

describe('diff column', () => {
  test('shows the quiet prompt when nothing is selected', () => {
    const { wrapper } = mountView();
    expect(wrapper.find('[data-testid="diff-prompt"]').text()).toBe(
      'Select a file to view its diff'
    );
  });

  test('reflects the store selection: file header + rendered diff', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[0], diff: SAMPLE_DIFF, combined: null };
    await wrapper.vm.$nextTick();

    const col = wrapper.find('[data-testid="diff-col"]');
    expect(col.find('.diff-path').text()).toBe('src/app/main.ts');
    expect(col.find('.row.del .content').text()).toBe('old');
    expect(col.find('.row.add .content').text()).toBe('new');
    expect(wrapper.find('[data-testid="diff-prompt"]').exists()).toBe(false);
  });

  test('a selected file with no diff yet shows a loading line, not a promise', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="diff-col"]').text()).toContain('Loading diff…');
  });
});

describe('resizable split', () => {
  test('arrow keys on the separator adjust and persist the ratio', async () => {
    const { wrapper } = mountView();
    const resizer = wrapper.find('[role="separator"]');

    await resizer.trigger('keydown', { key: 'ArrowRight' });
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    expect(stored.changesSplit).toBeCloseTo(0.34);
    expect(wrapper.find('.changes').attributes('style')).toContain('--files-col: 34.00%');
  });

  test('a stored ratio is restored on mount', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.5 }));
    const { wrapper } = mountView();
    expect(wrapper.find('.changes').attributes('style')).toContain('--files-col: 50.00%');
  });

  test('the separator exposes its value and range to assistive tech', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.5 }));
    const { wrapper } = mountView();
    const resizer = wrapper.find('[role="separator"]');
    expect(resizer.attributes('aria-valuenow')).toBe('50');
    expect(resizer.attributes('aria-valuemin')).toBe('15');
    expect(resizer.attributes('aria-valuemax')).toBe('65');
  });

  test('keyboard resize clamps at the max band', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.64 }));
    const { wrapper } = mountView();
    const resizer = wrapper.find('[role="separator"]');

    await resizer.trigger('keydown', { key: 'ArrowRight' }); // 0.66 → clamped to 0.65
    await resizer.trigger('keydown', { key: 'ArrowRight' }); // stays clamped
    expect(wrapper.find('.changes').attributes('style')).toContain('--files-col: 65.00%');
    expect(resizer.attributes('aria-valuenow')).toBe('65');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).changesSplit).toBeCloseTo(0.65);
  });

  test('keyboard resize clamps at the min band', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.16 }));
    const { wrapper } = mountView();
    const resizer = wrapper.find('[role="separator"]');

    await resizer.trigger('keydown', { key: 'ArrowLeft' }); // 0.14 → clamped to 0.15
    await resizer.trigger('keydown', { key: 'ArrowLeft' }); // stays clamped
    expect(wrapper.find('.changes').attributes('style')).toContain('--files-col: 15.00%');
    expect(resizer.attributes('aria-valuenow')).toBe('15');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).changesSplit).toBeCloseTo(0.15);
  });
});

describe('viewer stance (read-only)', () => {
  test('rows and section headers carry NO stage/unstage/discard controls', () => {
    const { wrapper } = mountView();

    for (const id of ['stage-file', 'unstage-file', 'discard-file', 'stage-all', 'unstage-all']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    }
    // Rows contain no buttons at all — selection is the only affordance.
    expect(wrapper.find('[data-testid="file-list"]').findAll('button')).toHaveLength(0);
  });

  test('there is NO commit column or commit controls', () => {
    const { wrapper } = mountView();
    expect(wrapper.find('[data-testid="commit-col"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="commit-message"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="commit-button"]').exists()).toBe(false);
  });

  test('a selected working-tree file renders a diff with NO hunk buttons', async () => {
    const { wrapper, repo } = mountView();
    repo.selection = { file: repo.shared.status!.files[0], diff: SAMPLE_DIFF, combined: null };
    await wrapper.vm.$nextTick();

    // The diff renders (read path intact)…
    expect(wrapper.find('[data-testid="diff-col"] .row.add .content').text()).toBe('new');
    // …with no staging affordance on its hunks.
    expect(wrapper.find('[data-testid="hunk-action"]').exists()).toBe(false);
  });
});

describe('portrait layout', () => {
  beforeEach(() => {
    stubMatchMedia(true);
  });


  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('rotates: portrait class, row-split var, horizontal separator', () => {
    const { wrapper } = mountView();
    const root = wrapper.find('.changes');
    expect(root.classes()).toContain('portrait');
    expect(root.attributes('style')).toContain('--changes-top: 30.00%');

    const resizer = wrapper.find('[role="separator"]');
    expect(resizer.attributes('aria-orientation')).toBe('horizontal');
    expect(resizer.attributes('aria-valuemin')).toBe('10');
    expect(resizer.attributes('aria-valuemax')).toBe('60');
    expect(resizer.attributes('aria-valuenow')).toBe('30');
  });

  test('the separator drags the ROW split: ArrowDown persists changesTop', async () => {
    const { wrapper } = mountView();
    const resizer = wrapper.find('[role="separator"]');

    await resizer.trigger('keydown', { key: 'ArrowDown' });
    expect(loadPrefs().changesTop).toBeCloseTo(0.32);
    expect(loadPrefs().changesSplit).toBeNull(); // landscape fraction untouched
    expect(wrapper.find('.changes').attributes('style')).toContain('--changes-top: 32.00%');

    // Column keys are inert on the row axis.
    await resizer.trigger('keydown', { key: 'ArrowRight' });
    expect(loadPrefs().changesTop).toBeCloseTo(0.32);
  });

  test('a stored changesTop is restored on mount', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesTop: 0.5 }));
    const { wrapper } = mountView();
    expect(wrapper.find('.changes').attributes('style')).toContain('--changes-top: 50.00%');
  });

  test('j/k move the selection within the file band', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[0], diff: null, combined: null };
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'j' });
    expect(repo.selection.file).toBe(files[1]);
    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'k' });
    expect(repo.selection.file).toBe(files[0]);
  });

  test('the diff pane is a focusable region; Enter on a row focuses it', async () => {
    const { wrapper, repo } = mountView();
    const files = repo.shared.status!.files;
    repo.selection = { file: files[0], diff: SAMPLE_DIFF, combined: null };
    await wrapper.vm.$nextTick();

    const pane = wrapper.find('.diff-body');
    expect(pane.attributes('tabindex')).toBe('0');
    expect(pane.attributes('role')).toBe('region');

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'Enter' });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(pane.element);
  });
});
