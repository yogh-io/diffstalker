/**
 * ChangesView tests: category grouping (Modified / Untracked / Staged),
 * per-row stats + hunk-count indicators, the file list as a JUMP
 * NAVIGATOR over the stacked diffs (clicks/arrows hand the EXACT
 * FileEntry to repo.selectFile, optimistically set ui.activeStackKey,
 * and scroll the DiffStack — whose scroll-spy feeds the active row
 * back), the stack itself (one section per file in category order,
 * workingDiffs-fed diffs, placeholders, huge-file "Load diff" gate +
 * its latch, binary placeholder-only sections, manual collapse), the
 * image-diff wiring (which sections get a picture card, which keep the
 * note, and which sections the view asks the daemon about at all), the
 * auto-mode jump registration (deferred mount, huge/binary section-top
 * rule, the list-click manual guard), the per-repo state reset, the
 * clean-tree state, the persisted resizer, and the viewer stance (no
 * stage/discard/commit controls anywhere).
 *
 * The repo store runs for real; state is set directly on it (selectFile
 * fetches nothing now), so no fakes are needed. useAutoMode is mocked
 * to capture the registered jump target.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import type { MockInstance } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import ChangesView from './ChangesView.vue';
import DiffStack from '../components/DiffStack.vue';
import ImageDiffView from '../components/ImageDiffView.vue';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { useFilterStore } from '../stores/filter';
import type { StackAutoJumpTarget } from '../composables/useAutoMode';
import { PREFS_KEY, loadPrefs } from '../prefs';
import { stubMatchMedia } from '../testing/portrait';
import type { RepoSharedState } from '../stores/types';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import type { DiffResult } from '@diffstalker/core/git/diff';
import type { MediaPair, MediaSide } from '@diffstalker/client';

// Capture the auto-jump target ChangesView registers on mount.
const autoJump = vi.hoisted(() => ({ target: null as StackAutoJumpTarget | null }));
vi.mock('../composables/useAutoMode', () => ({
  registerStackAutoJump: (target: StackAutoJumpTarget) => {
    autoJump.target = target;
    return () => {
      if (autoJump.target === target) autoJump.target = null;
    };
  },
}));

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

const BINARY_DIFF: DiffResult = {
  lines: [
    { type: 'header', content: 'diff --git a/img.png b/img.png' },
    { type: 'header', content: 'Binary files a/img.png and b/img.png differ' },
  ],
};

const SAMPLE_DIFF: DiffResult = {
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
  ui: ReturnType<typeof useUiStore>;
} {
  const repo = useRepoStore();
  const ui = useUiStore();
  repo.shared = makeShared(files);
  const wrapper = mount(ChangesView, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  return { wrapper, repo, ui };
}

/** Seed the store's working-diff cache for a row key. */
function seedDiff(repo: ReturnType<typeof useRepoStore>, key: string, diff: DiffResult): void {
  const byKey = new Map(repo.workingDiffs.byKey);
  byKey.set(key, { diff, fetchedAt: Date.now() });
  repo.workingDiffs = { byKey, seq: repo.workingDiffs.seq + 1 };
}

/** Spy on the stack scroller's scrollTo (jump assertions). */
function spyOnStackScroll(wrapper: VueWrapper): ReturnType<typeof vi.spyOn> {
  const scroller = wrapper.find('[data-testid="changes-diffs"]').element as HTMLElement;
  return vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {});
}

beforeEach(() => {
  localStorage.clear();
  autoJump.target = null;
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
      'No changes'
    );
    // The message replaces the whole two-column layout.
    expect(wrapper.find('[data-testid="file-list"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-diffs"]').exists()).toBe(false);
  });
});

describe('jump navigation', () => {
  test('clicking a row selects the EXACT FileEntry, sets the stack key, and jumps the stack', async () => {
    const { wrapper, repo, ui } = mountView();
    const spy = vi.spyOn(repo, 'selectFile');
    const scrollSpy = spyOnStackScroll(wrapper);

    await wrapper.find('[data-testid="section-untracked"]').find('.file-row').trigger('click');

    // Identity, not equality: re-anchoring depends on it.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(repo.shared.status!.files[2]);
    expect(repo.selection.file).toBe(repo.shared.status!.files[2]);
    // Optimistic active key + a jump on the stack's OWN scroller
    // (scrollTo — never scrollIntoView).
    expect(ui.activeStackKey).toBe('u:notes.txt');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  test('the active row (ui.activeStackKey) is highlighted and aria-selected', async () => {
    const { wrapper, ui } = mountView();
    ui.setActiveStackKey('u:src/util.ts');
    await wrapper.vm.$nextTick();

    const rows = wrapper.findAll('.file-row');
    expect(rows[1].classes()).toContain('selected');
    expect(rows.filter((row) => row.classes().includes('selected'))).toHaveLength(1);
    expect(rows.map((row) => row.attributes('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  test("the stack's active-file event (scroll-spy) feeds ui.activeStackKey", async () => {
    const { wrapper, ui } = mountView();
    wrapper.findComponent(DiffStack).vm.$emit('active-file', 's:src/app/main.ts');
    await wrapper.vm.$nextTick();
    expect(ui.activeStackKey).toBe('s:src/app/main.ts');
    expect(wrapper.findAll('.file-row')[3].classes()).toContain('selected');
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

  test('ArrowDown moves the active file to the next row in category order and jumps', async () => {
    const { wrapper, repo, ui } = mountView();
    const files = repo.shared.status!.files;
    const scrollSpy = spyOnStackScroll(wrapper);
    ui.setActiveStackKey('u:src/app/main.ts');
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(ui.activeStackKey).toBe('u:src/util.ts');
    expect(repo.selection.file).toBe(files[1]);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Ordered flat list: modified → untracked → staged.
    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'ArrowDown' });
    expect(ui.activeStackKey).toBe('u:notes.txt');
    expect(repo.selection.file).toBe(files[2]);
  });

  test('roving tabindex: only the active row is a tab stop', async () => {
    const { wrapper, ui } = mountView();
    ui.setActiveStackKey('u:src/util.ts');
    await wrapper.vm.$nextTick();

    const stops = wrapper.findAll('.file-row').map((row) => row.attributes('tabindex'));
    expect(stops).toEqual(['-1', '0', '-1', '-1']);
  });

  test('ArrowUp moves the active file up and clamps at the top (no wrap)', async () => {
    const { wrapper, ui } = mountView();
    spyOnStackScroll(wrapper);
    ui.setActiveStackKey('u:src/util.ts');
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'ArrowUp' });
    expect(ui.activeStackKey).toBe('u:src/app/main.ts');

    // Already at the top: stays put, does not wrap to the last file.
    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowUp' });
    expect(ui.activeStackKey).toBe('u:src/app/main.ts');
  });

  test('the list is a listbox of options; the old toggle-button semantics are gone', async () => {
    const { wrapper, ui } = mountView();
    ui.setActiveStackKey('u:src/app/main.ts');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="file-list"]').attributes('role')).toBe('listbox');
    const rows = wrapper.findAll('.file-row');
    expect(rows.every((row) => row.attributes('role') === 'option')).toBe(true);
    expect(rows.some((row) => row.attributes('aria-pressed') !== undefined)).toBe(false);
  });

  test('after moveSelection focus lands on the new row, and Space jumps', async () => {
    const { wrapper, repo, ui } = mountView();
    const files = repo.shared.status!.files;
    spyOnStackScroll(wrapper);
    ui.setActiveStackKey('u:src/app/main.ts');
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();
    expect(ui.activeStackKey).toBe('u:src/util.ts');
    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[1].element);

    const spy = vi.spyOn(repo, 'selectFile');
    await wrapper.findAll('.file-row')[2].trigger('keydown', { key: ' ' });
    expect(spy).toHaveBeenCalledWith(files[2]);
    expect(ui.activeStackKey).toBe('u:notes.txt');
  });

  test('Enter focuses the target diff section (tabindex=-1)', async () => {
    const { wrapper } = mountView();
    spyOnStackScroll(wrapper);

    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'Enter' });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const section = wrapper.findAll('[data-testid="file-diff"]')[1];
    expect(section.attributes('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(section.element);
  });

  test('focus recovers to the active row when the focused row vanishes', async () => {
    const { wrapper, repo, ui } = mountView();
    const files = repo.shared.status!.files;
    ui.setActiveStackKey('u:src/util.ts');
    await wrapper.vm.$nextTick();
    (wrapper.findAll('.file-row')[1].element as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[1].element);

    // State-change drops util.ts; the active key re-anchors to main.ts.
    repo.shared = makeShared([files[0], files[2], files[3]]);
    ui.setActiveStackKey('u:src/app/main.ts');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(wrapper.findAll('.file-row')[0].element);
  });
});

describe('stacked diffs', () => {
  test('renders one section per file in category order, keyed s:/u: + path', () => {
    const { wrapper } = mountView();
    const sections = wrapper.findAll('[data-testid="file-diff"]');
    expect(sections.map((s) => s.attributes('data-key'))).toEqual([
      'u:src/app/main.ts',
      'u:src/util.ts',
      'u:notes.txt',
      's:src/app/main.ts',
    ]);
  });

  test('a cached working diff renders; files without one show a placeholder', async () => {
    const { wrapper, repo } = mountView();
    seedDiff(repo, 'u:src/app/main.ts', SAMPLE_DIFF);
    await wrapper.vm.$nextTick();

    const sections = wrapper.findAll('[data-testid="file-diff"]');
    expect(sections[0].find('.row.del .content').text()).toBe('old');
    expect(sections[0].find('.row.add .content').text()).toBe('new');
    expect(sections[0].find('[data-testid="diff-placeholder"]').exists()).toBe(false);
    // The other rows' diffs haven't landed: stats-sized placeholders.
    expect(sections[1].find('[data-testid="diff-placeholder"]').exists()).toBe(true);
    expect(sections[2].find('[data-testid="diff-placeholder"]').exists()).toBe(true);
  });

  test('the wrap toggle switches the stack (and its DiffViews) into wrap mode', async () => {
    const { wrapper, repo } = mountView();
    seedDiff(repo, 'u:src/app/main.ts', SAMPLE_DIFF);
    await wrapper.vm.$nextTick();

    const section = wrapper.findAll('[data-testid="file-diff"]')[0];
    expect(section.find('.file-diff-body').classes()).not.toContain('wrap-mode');
    expect(section.find('.diff-scroll').classes()).not.toContain('wrap');

    await wrapper.find('[data-testid="wrap-toggle"]').trigger('click');

    expect(section.find('.file-diff-body').classes()).toContain('wrap-mode');
    expect(section.find('.diff-scroll').classes()).toContain('wrap');
  });

  test('manual per-file collapse hides the body and toggles back', async () => {
    const { wrapper, repo } = mountView();
    seedDiff(repo, 'u:src/app/main.ts', SAMPLE_DIFF);
    await wrapper.vm.$nextTick();

    const section = wrapper.findAll('[data-testid="file-diff"]')[0];
    await section.find('.collapse-btn').trigger('click');
    expect(section.find('.file-diff-body').isVisible()).toBe(false);
    expect(section.find('.collapse-btn').attributes('aria-expanded')).toBe('false');

    await section.find('.collapse-btn').trigger('click');
    expect(section.find('.file-diff-body').isVisible()).toBe(true);
  });

  test('a huge file starts collapsed behind "Load diff"; the click mounts its body', async () => {
    const huge: FileEntry = {
      path: 'big.txt',
      status: 'modified',
      staged: false,
      insertions: 1400,
      deletions: 200,
    };
    const { wrapper } = mountView([huge]);

    const section = wrapper.find('[data-testid="file-diff"]');
    // Gated: no body in the DOM at all — the worst-case DOM cap.
    expect(section.find('.file-diff-body').exists()).toBe(false);
    expect(section.find('.collapse-btn').attributes('aria-expanded')).toBe('false');
    const gate = section.find('[data-testid="load-diff"]');
    expect(gate.text()).toContain('Load diff');
    expect(gate.text()).toContain('1600 changed lines');

    await gate.trigger('click');
    expect(section.find('[data-testid="load-diff"]').exists()).toBe(false);
    expect(section.find('.file-diff-body').exists()).toBe(true);
    expect(section.find('.collapse-btn').attributes('aria-expanded')).toBe('true');
  });

  test('a file at exactly the cap stays expanded (only PAST ~1500 collapses)', () => {
    const atCap: FileEntry = {
      path: 'cap.txt',
      status: 'modified',
      staged: false,
      insertions: 1500,
    };
    const { wrapper } = mountView([atCap]);
    const section = wrapper.find('[data-testid="file-diff"]');
    expect(section.find('[data-testid="load-diff"]').exists()).toBe(false);
    expect(section.find('.file-diff-body').exists()).toBe(true);
  });

  test('a file already rendered keeps its body when its stats grow past the cap (latch)', async () => {
    const small: FileEntry = { path: 'grow.ts', status: 'modified', staged: false, insertions: 10 };
    const { wrapper, repo } = mountView([small]);
    expect(wrapper.find('.file-diff-body').exists()).toBe(true);

    repo.shared = makeShared([{ ...small, insertions: 5000 }]);
    await wrapper.vm.$nextTick();

    // Latched: the body stays mounted — unmounting mid-view would yank
    // content from under the reader. Only files that FIRST APPEAR past
    // the threshold are gated.
    expect(wrapper.find('.file-diff-body').exists()).toBe(true);
    expect(wrapper.find('[data-testid="load-diff"]').exists()).toBe(false);
  });

  test('a binary file renders as a placeholder note only — no diff body, no "Load diff"', async () => {
    // Big stats on purpose: binary wins over the huge gate too.
    const bin: FileEntry = { path: 'img.png', status: 'modified', staged: false, insertions: 2000 };
    const { wrapper, repo } = mountView([bin]);
    seedDiff(repo, 'u:img.png', BINARY_DIFF);
    await wrapper.vm.$nextTick();

    const section = wrapper.find('[data-testid="file-diff"]');
    expect(section.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
    expect(section.find('[data-testid="load-diff"]').exists()).toBe(false);
    expect(section.find('.file-diff-body').exists()).toBe(false);
    expect(section.find('[data-testid="diff-view"]').exists()).toBe(false);
  });

  test('an over-cap file renders the daemon\'s size notice — no diff body, no "Load diff"', async () => {
    // Big stats on purpose: the withheld note wins over the huge gate too.
    const big: FileEntry = { path: 'big.gml', status: 'modified', staged: false, insertions: 2000 };
    const { wrapper, repo } = mountView([big]);
    seedDiff(repo, 'u:big.gml', {
      lines: [
        { type: 'header', content: 'diff --git a/big.gml b/big.gml' },
        { type: 'header', content: 'Large file — diff not shown (18.3 MB, 121,285 lines)' },
      ],
    });
    await wrapper.vm.$nextTick();

    const section = wrapper.find('[data-testid="file-diff"]');
    expect(section.find('[data-testid="not-shown-note"]').text()).toContain(
      'Large file — diff not shown (18.3 MB, 121,285 lines)'
    );
    expect(section.find('[data-testid="load-diff"]').exists()).toBe(false);
    expect(section.find('.file-diff-body').exists()).toBe(false);
    expect(section.find('[data-testid="diff-view"]').exists()).toBe(false);
  });
});

describe('image diffs in the stack', () => {
  const IMG: FileEntry = { path: 'img.png', status: 'modified', staged: false };
  const TAR: FileEntry = { path: 'dist.tar', status: 'modified', staged: false };
  const TEXT: FileEntry = { path: 'a.ts', status: 'modified', staged: false, insertions: 1 };

  type MockedEnsureMedia = MockInstance<(file: FileEntry, staged: boolean) => Promise<void>>;

  function imageSide(overrides: Partial<MediaSide> = {}): MediaSide {
    return {
      path: 'img.png',
      side: 'index',
      bytes: 2048,
      oid: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      version: 'v1',
      image: { format: 'png', mime: 'image/png', width: 64, height: 64, bytes: 2048 },
      refusal: null,
      ...overrides,
    };
  }

  /** A picture on both sides. */
  function imagePair(): MediaPair {
    return { old: imageSide(), new: imageSide({ side: 'worktree', oid: null, version: 'v2' }) };
  }

  /** A tarball: real bytes, no picture on either side. */
  function refusedPair(): MediaPair {
    const refused = { image: null, refusal: 'not-an-image' as const, path: 'dist.tar' };
    return {
      old: imageSide(refused),
      new: imageSide({ ...refused, side: 'worktree', oid: null }),
    };
  }

  function setup(
    files: FileEntry[],
    diffs: [string, DiffResult][],
    media: [string, MediaPair][] = []
  ) {
    const repo = useRepoStore();
    const ui = useUiStore();
    repo.repoId = 'r1';
    repo.shared = makeShared(files);
    for (const [key, diff] of diffs) seedDiff(repo, key, diff);
    repo.mediaMeta = new Map(media);
    // The store's own fetching is tested in stores/repo.test.ts; here the
    // question is only WHICH sections this view asks about.
    const ensureMedia = vi.spyOn(repo, 'ensureMedia').mockResolvedValue();
    const wrapper = mount(ChangesView, { global: { plugins: [pinia] }, attachTo: document.body });
    return { wrapper, repo, ui, ensureMedia };
  }

  /** Paths the view asked for metadata about. */
  function askedFor(ensureMedia: MockedEnsureMedia): string[] {
    return ensureMedia.mock.calls.map((call) => call[0].path);
  }

  test('a binary section with image metadata renders the card instead of the note', () => {
    const { wrapper } = setup([IMG], [['u:img.png', BINARY_DIFF]], [['u:img.png', imagePair()]]);
    const section = wrapper.find('[data-testid="file-diff"]');

    expect(section.find('[data-testid="image-diff"]').exists()).toBe(true);
    expect(section.find('[data-testid="not-shown-media"]').exists()).toBe(true);
    expect(section.find('[data-testid="not-shown-note"]').exists()).toBe(false);
    // Both sides, at their own blob URLs — and still no diff body.
    expect(section.findAll('img')).toHaveLength(2);
    expect(section.find('.file-diff-body').exists()).toBe(false);
  });

  test('a binary section whose metadata has not landed keeps the note', () => {
    const { wrapper } = setup([IMG], [['u:img.png', BINARY_DIFF]]);
    const section = wrapper.find('[data-testid="file-diff"]');

    expect(section.find('[data-testid="image-diff"]').exists()).toBe(false);
    expect(section.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('a tarball keeps the note once its metadata lands — no picture on either side', () => {
    const { wrapper } = setup(
      [TAR],
      [['u:dist.tar', BINARY_DIFF]],
      [['u:dist.tar', refusedPair()]]
    );
    const section = wrapper.find('[data-testid="file-diff"]');

    expect(section.find('[data-testid="image-diff"]').exists()).toBe(false);
    expect(section.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('metadata is asked for binary sections only — never for a text diff', () => {
    const { ensureMedia } = setup(
      [TEXT, IMG, TAR],
      [
        ['u:a.ts', SAMPLE_DIFF],
        ['u:img.png', BINARY_DIFF],
        ['u:dist.tar', BINARY_DIFF],
      ]
    );

    expect(askedFor(ensureMedia).sort()).toEqual(['dist.tar', 'img.png']);
    // The side pair follows the section's own s:/u: key.
    expect(ensureMedia.mock.calls[0][1]).toBe(false);
  });

  test('a collapsed section is not asked about again', async () => {
    const { wrapper, repo, ensureMedia } = setup([IMG], [['u:img.png', BINARY_DIFF]]);
    expect(askedFor(ensureMedia)).toEqual(['img.png']);

    await wrapper.find('.collapse-btn').trigger('click');
    ensureMedia.mockClear();

    // A state-change re-runs the candidates; the collapsed one is out.
    repo.shared = makeShared([IMG]);
    await wrapper.vm.$nextTick();
    expect(askedFor(ensureMedia)).toEqual([]);
  });

  test('only sections near the active one are asked about', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      path: `img${i}.png`,
      status: 'modified' as const,
      staged: false,
    }));
    const { ensureMedia } = setup(
      many,
      many.map((file): [string, DiffResult] => [`u:${file.path}`, BINARY_DIFF])
    );

    // No active key yet means the stack is at the top: the window starts
    // at the first section. Every pull costs the daemon two blob reads,
    // so the far end of a long stack is left alone until it is scrolled to.
    const asked = askedFor(ensureMedia);
    expect(asked).toEqual(many.slice(0, 6).map((file) => file.path));
    expect(asked).not.toContain('img13.png');
  });

  test('both sides failing to decode drops the card back to the note', async () => {
    const { wrapper } = setup([IMG], [['u:img.png', BINARY_DIFF]], [['u:img.png', imagePair()]]);
    const section = wrapper.find('[data-testid="file-diff"]');

    for (const img of section.findAll('img')) await img.trigger('error');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('a fresh blob version after a decode failure gets another attempt', async () => {
    const { wrapper, repo } = setup(
      [IMG],
      [['u:img.png', BINARY_DIFF]],
      [['u:img.png', imagePair()]]
    );

    for (const img of wrapper.findAll('img')) await img.trigger('error');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(false);

    // The image is fixed on disk: the state-change refetch lands a pair
    // carrying new versions. A failure keyed by section alone would keep
    // the note for the life of the view.
    repo.mediaMeta = new Map([
      [
        'u:img.png',
        {
          old: imageSide({ version: 'v3' }),
          new: imageSide({ side: 'worktree', oid: null, version: 'v4' }),
        },
      ],
    ]);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(true);
  });

  test('a failure reported after a refetch blacklists the bytes that failed, not the new ones', async () => {
    const { wrapper, repo } = setup(
      [IMG],
      [['u:img.png', BINARY_DIFF]],
      [['u:img.png', imagePair()]]
    );
    const card = wrapper.findComponent(ImageDiffView);

    // The refetch lands while the browser is still working on the old
    // bytes, and only then does the load fail. The card reporting it is
    // the one rendered from v1/v2 — the versions the <img> tags carried.
    repo.mediaMeta = new Map([
      [
        'u:img.png',
        {
          old: imageSide({ version: 'v3' }),
          new: imageSide({ side: 'worktree', oid: null, version: 'v4' }),
        },
      ],
    ]);
    card.vm.$emit('fail');
    await wrapper.vm.$nextTick();

    // Reading the store at error time would have blacklisted v3/v4 here.
    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(true);

    // ...and the failure really was recorded, against v1/v2.
    repo.mediaMeta = new Map([['u:img.png', imagePair()]]);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(false);
  });

  test('the SAME bytes failing again stay a note — no retry loop', async () => {
    const { wrapper, repo } = setup(
      [IMG],
      [['u:img.png', BINARY_DIFF]],
      [['u:img.png', imagePair()]]
    );

    for (const img of wrapper.findAll('img')) await img.trigger('error');
    await wrapper.vm.$nextTick();

    // A state-change re-asks and the daemon answers with the same
    // versions: a fresh object, but the same bytes, so still no card.
    repo.mediaMeta = new Map([['u:img.png', imagePair()]]);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('an auto jump to an image section lands on the section top and expands nothing', async () => {
    const { wrapper } = setup([IMG], [['u:img.png', BINARY_DIFF]], [['u:img.png', imagePair()]]);
    const scrollSpy = spyOnStackScroll(wrapper);

    autoJump.target!.jump('img.png');
    await wrapper.vm.$nextTick();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // Unchanged rule: a binary section has no hunks to aim at, and the
    // card is not a body that could be expanded.
    expect(wrapper.find('[data-testid="image-diff"]').exists()).toBe(true);
    expect(wrapper.find('.file-diff-body').exists()).toBe(false);
  });
});

describe('auto-mode jump target', () => {
  test('mount registers a target; its jump sets the key and scrolls; unmount unregisters', async () => {
    const { wrapper, ui } = mountView();
    const scrollSpy = spyOnStackScroll(wrapper);
    expect(autoJump.target).not.toBeNull();
    expect(typeof autoJump.target!.lastUserScrollAt()).toBe('number');

    autoJump.target!.jump('src/util.ts');
    await wrapper.vm.$nextTick();
    expect(ui.activeStackKey).toBe('u:src/util.ts');
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(autoJump.target).toBeNull();
  });

  test('a jump to a file that JUST entered the status set lands once its section mounts', async () => {
    const { wrapper, repo, ui } = mountView();
    const scrollSpy = spyOnStackScroll(wrapper);
    const fresh: FileEntry = { path: 'fresh.ts', status: 'untracked', staged: false, insertions: 1 };
    repo.shared = makeShared([...FILES, fresh]);

    // Fired before the render flush: the new section is not in the DOM
    // yet — the scroll must defer, not drop.
    autoJump.target!.jump('fresh.ts');
    expect(ui.activeStackKey).toBe('u:fresh.ts'); // optimistic key stays sync
    expect(scrollSpy).not.toHaveBeenCalled();

    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  test('a jump to a gated huge file scrolls to the section top and never loads it', async () => {
    const huge: FileEntry = { path: 'big.txt', status: 'modified', staged: false, insertions: 2000 };
    const { wrapper } = mountView([huge]);
    const scrollSpy = spyOnStackScroll(wrapper);

    autoJump.target!.jump('big.txt');
    await wrapper.vm.$nextTick();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // Still gated: an auto jump must never open or render a huge file.
    const section = wrapper.find('[data-testid="file-diff"]');
    expect(section.find('[data-testid="load-diff"]').exists()).toBe(true);
    expect(section.find('.file-diff-body').exists()).toBe(false);
  });

  test('a list-click jump stamps the manual-input guard the auto defer reads', async () => {
    const { wrapper } = mountView();
    spyOnStackScroll(wrapper);
    expect(autoJump.target!.lastUserScrollAt()).toBe(0);

    await wrapper.find('[data-testid="section-untracked"]').find('.file-row').trigger('click');
    expect(autoJump.target!.lastUserScrollAt()).toBeGreaterThan(0);
  });
});

describe('per-repo state reset', () => {
  test('a repo switch clears the active key, manual collapse, and loaded huge state', async () => {
    const small: FileEntry = { path: 'a.ts', status: 'modified', staged: false, insertions: 1 };
    const huge: FileEntry = { path: 'big.txt', status: 'modified', staged: false, insertions: 2000 };
    const { wrapper, repo, ui } = mountView([small, huge]);

    ui.setActiveStackKey('u:a.ts');
    const sections = wrapper.findAll('[data-testid="file-diff"]');
    await sections[0].find('.collapse-btn').trigger('click'); // manual collapse a.ts
    await sections[1].find('[data-testid="load-diff"]').trigger('click'); // load big.txt
    expect(wrapper.find('[data-testid="load-diff"]').exists()).toBe(false);

    repo.repoId = 'other-repo';
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    // A same-path file in the new repo inherits nothing.
    expect(ui.activeStackKey).toBeNull();
    const fresh = wrapper.findAll('[data-testid="file-diff"]');
    expect(fresh[0].find('.file-diff-body').isVisible()).toBe(true); // collapse cleared
    expect(fresh[1].find('[data-testid="load-diff"]').exists()).toBe(true); // gate back
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

describe('write stance (file-level stage/unstage only)', () => {
  test('each row carries a stage/unstage button; still no discard / bulk / commit controls', () => {
    const { wrapper } = mountView();

    // Unstaged rows offer stage (+), the staged row offers unstage (−).
    expect(wrapper.findAll('[data-testid="stage-file"]').length).toBeGreaterThan(0);
    expect(wrapper.find('[data-testid="unstage-file"]').exists()).toBe(true);
    // But nothing beyond file-level stage/unstage lives here.
    for (const id of ['discard-file', 'stage-all', 'unstage-all']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    }
  });

  test('clicking a stage button calls stageFile; the staged row calls unstageFile', async () => {
    const { wrapper, repo } = mountView();
    const stageSpy = vi.spyOn(repo, 'stageFile').mockResolvedValue();
    const unstageSpy = vi.spyOn(repo, 'unstageFile').mockResolvedValue();

    // First unstaged row is main.ts (Modified section, first file).
    await wrapper.find('[data-testid="stage-file"]').trigger('click');
    expect(stageSpy).toHaveBeenCalledWith('src/app/main.ts');

    // The Staged section's row unstages the same path (partially staged).
    await wrapper.find('[data-testid="unstage-file"]').trigger('click');
    expect(unstageSpy).toHaveBeenCalledWith('src/app/main.ts');
  });

  // `git add` on an unmerged path is how you tell git the conflict is
  // resolved. Offering it as a plain + would let one click claim a
  // resolution that never happened.
  test('a conflicted row cannot be staged, and says why', async () => {
    const { wrapper, repo } = mountView([
      { path: 'src/merge.ts', status: 'conflicted', staged: false },
      { path: 'src/merge.ts', status: 'conflicted', staged: true },
    ]);
    const stageSpy = vi.spyOn(repo, 'stageFile').mockResolvedValue();
    const unstageSpy = vi.spyOn(repo, 'unstageFile').mockResolvedValue();

    const stageBtn = wrapper.get('[data-testid="stage-file"]');
    expect(stageBtn.attributes('disabled')).toBeDefined();
    expect(stageBtn.attributes('title')).toBe('Conflicted — resolve the conflict first');
    expect(stageBtn.attributes('aria-label')).toBe(
      'Cannot stage src/merge.ts: resolve the conflict first'
    );

    // The staged side is refused just as plainly (unstaging would drop
    // the conflict stages).
    const unstageBtn = wrapper.get('[data-testid="unstage-file"]');
    expect(unstageBtn.attributes('disabled')).toBeDefined();
    expect(unstageBtn.attributes('aria-label')).toBe(
      'Cannot unstage src/merge.ts: resolve the conflict first'
    );

    await stageBtn.trigger('click');
    await unstageBtn.trigger('click');
    expect(stageSpy).not.toHaveBeenCalled();
    expect(unstageSpy).not.toHaveBeenCalled();
  });

  test('an ordinary row keeps its live button and plain label', () => {
    const { wrapper } = mountView();
    const stageBtn = wrapper.get('[data-testid="stage-file"]');
    expect(stageBtn.attributes('disabled')).toBeUndefined();
    expect(stageBtn.attributes('title')).toBe('Stage this file');
    expect(stageBtn.attributes('aria-label')).toBe('Stage src/app/main.ts');
  });

  test('a conflicted row shows git’s U letter', () => {
    const { wrapper } = mountView([{ path: 'src/merge.ts', status: 'conflicted', staged: false }]);
    const letter = wrapper.get('[data-testid="section-modified"] .file-row .letter');
    expect(letter.text()).toBe('U');
    expect(letter.attributes('data-status')).toBe('conflicted');
  });

  test('there is NO commit column or commit controls', () => {
    const { wrapper } = mountView();
    expect(wrapper.find('[data-testid="commit-col"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="commit-message"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="commit-button"]').exists()).toBe(false);
  });

  test('stacked diffs render with NO hunk buttons', async () => {
    const { wrapper, repo } = mountView();
    seedDiff(repo, 'u:src/app/main.ts', SAMPLE_DIFF);
    await wrapper.vm.$nextTick();

    // The diff renders (read path intact)… (scoped past the size probe)
    expect(
      wrapper.find('[data-testid="file-diff"] .row.add .content').text()
    ).toBe('new');
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

  test('j/k move the active file within the band', async () => {
    const { wrapper, repo, ui } = mountView();
    const files = repo.shared.status!.files;
    spyOnStackScroll(wrapper);
    ui.setActiveStackKey('u:src/app/main.ts');
    await wrapper.vm.$nextTick();

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'j' });
    expect(ui.activeStackKey).toBe('u:src/util.ts');
    expect(repo.selection.file).toBe(files[1]);
    await wrapper.findAll('.file-row')[1].trigger('keydown', { key: 'k' });
    expect(ui.activeStackKey).toBe('u:src/app/main.ts');
  });

  test('the stack is a focusable region; Enter on a row focuses its section', async () => {
    const { wrapper } = mountView();
    spyOnStackScroll(wrapper);

    const stack = wrapper.find('[data-testid="changes-diffs"]');
    expect(stack.attributes('tabindex')).toBe('0');
    expect(stack.attributes('role')).toBe('region');

    await wrapper.findAll('.file-row')[0].trigger('keydown', { key: 'Enter' });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(
      wrapper.findAll('[data-testid="file-diff"]')[0].element
    );
  });
});

/**
 * The list filter. It narrows the file set BEFORE categorization, so the
 * sections, the keyboard order and the diff stack all narrow together.
 * The two things that must not break: the clean-tree state reads the RAW
 * status (a filter hiding everything is not a clean tree), and a filter
 * that matches nothing says so in its own words.
 */
describe('list filter', () => {
  test('narrows the file list and keeps the count honest', async () => {
    const { wrapper } = mountView();
    const filter = useFilterStore();

    filter.openAndFocus();
    filter.setQuery('notes');
    await nextTick();

    const rows = wrapper.findAll('.file-row');
    expect(rows.length).toBe(1);
    expect(rows[0].text()).toContain('notes.txt');
    expect(wrapper.find('[data-testid="filter-count"]').text()).toBe('1 of 4 changed files');
    wrapper.unmount();
  });

  test('a corpus of one is not "1 changed files"', async () => {
    const { wrapper } = mountView([FILES[0]]);
    const filter = useFilterStore();

    filter.openAndFocus();
    await nextTick();

    expect(wrapper.find('[data-testid="filter-count"]').text()).toBe('1 changed file');
    wrapper.unmount();
  });

  test('a filter matching nothing says so, and does NOT claim a clean tree', async () => {
    const { wrapper } = mountView();
    const filter = useFilterStore();

    filter.openAndFocus();
    filter.setQuery('zzzzzzzz');
    await nextTick();

    expect(wrapper.find('[data-testid="filter-no-matches"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="clean-tree"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('clearing brings the whole list back', async () => {
    const { wrapper } = mountView();
    const filter = useFilterStore();

    filter.openAndFocus();
    filter.setQuery('notes');
    await nextTick();
    expect(wrapper.findAll('.file-row').length).toBe(1);

    filter.close();
    await nextTick();
    expect(wrapper.findAll('.file-row').length).toBe(FILES.length);
    expect(wrapper.find('[data-testid="filter-chip"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('the diff stack narrows with the list', async () => {
    const { wrapper } = mountView();
    const filter = useFilterStore();

    const before = wrapper.findAll('[data-testid="file-diff"]').length;
    filter.openAndFocus();
    filter.setQuery('notes');
    await nextTick();

    const after = wrapper.findAll('[data-testid="file-diff"]').length;
    expect(after).toBeLessThan(before);
    wrapper.unmount();
  });
});
