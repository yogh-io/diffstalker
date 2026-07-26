/**
 * JournalView tests: the derived outdated map (buildSupersededAt) and
 * the rendered log — hunk-group headers over DiffView bodies, boundary
 * dividers, seeded muting, the outdated one-line stub with click
 * re-expand, ×N chain expansion (the fold shown end to end; the fold's
 * own table tests live in utils/foldEntries.test.ts), keyed-by-seq
 * stability across a fold move, the "journal restarted" divider, the
 * newest-first display order, and the head-pin follow-vs-pill behavior
 * (with the anchor-compensated prepend and the enter-reveal policy).
 *
 * The repo store runs for real; the journal slice is set directly on
 * it (repoId stays null, so store actions never fetch) — appends
 * replace journalEntries wholesale, exactly like the SSE sink does.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import JournalView, { buildSupersededAt } from './JournalView.vue';
import { useRepoStore } from '../stores/repo';
import type {
  JournalBoundaryEntry,
  JournalEntry,
  JournalHunkEntry,
} from '@diffstalker/core/types/journal';
import type { DiffResult } from '@diffstalker/core/git/diff';

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function makeDiff(path: string, marker: string): DiffResult {
  return {
    raw: '',
    lines: [
      { type: 'header', content: `diff --git a/${path} b/${path}` },
      { type: 'hunk', content: '@@ -10,5 +10,6 @@' },
      { type: 'addition', content: `+${marker}`, newLineNum: 10 },
    ],
  };
}

function hunk(seq: number, over: Partial<JournalHunkEntry> = {}): JournalHunkEntry {
  return {
    type: 'hunk',
    seq,
    ts: T0 + seq * 1000,
    path: 'src/a.ts',
    status: 'modified',
    kind: 'edited',
    span: { start: 10, count: 5 },
    stats: { insertions: 2, deletions: 1 },
    diff: makeDiff(over.path ?? 'src/a.ts', `edit-${seq}`),
    supersedes: [],
    siblings: 1,
    seeded: false,
    ...over,
  };
}

function boundary(seq: number, over: Partial<JournalBoundaryEntry> = {}): JournalBoundaryEntry {
  return {
    type: 'boundary',
    seq,
    ts: T0 + seq * 1000,
    kind: 'commit',
    label: 'a1b2c3d fix things',
    resolves: [],
    ...over,
  };
}

describe('buildSupersededAt', () => {
  test('maps retired seqs to the FIRST retiring entry ts, from supersedes and resolves', () => {
    const at = buildSupersededAt([
      hunk(1),
      hunk(2, { supersedes: [1] }),
      boundary(3, { resolves: [2] }),
    ]);
    expect(at.get(1)).toBe(T0 + 2000);
    expect(at.get(2)).toBe(T0 + 3000);
    expect(at.has(3)).toBe(false);
  });
});

// --- Rendering ---

let pinia: Pinia;

function setEntries(repo: ReturnType<typeof useRepoStore>, entries: JournalEntry[]): void {
  repo.journalEntries = entries;
  repo.journalLoaded = true;
}

function mountView(entries: JournalEntry[]): {
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
  loadSpy: ReturnType<typeof vi.spyOn>;
} {
  const repo = useRepoStore();
  const loadSpy = vi.spyOn(repo, 'loadJournal').mockResolvedValue(undefined);
  setEntries(repo, entries);
  const wrapper = mount(JournalView, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  return { wrapper, repo, loadSpy };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('rendering', () => {
  test('loads the journal lazily on mount', () => {
    const { loadSpy } = mountView([]);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  test('empty state names the start time', () => {
    const { wrapper } = mountView([]);
    expect(wrapper.get('[data-testid="journal-empty"]').text()).toMatch(
      /^journal started \d{2}:\d{2} — your edits will show up here$/
    );
  });

  test('a failed lazy load renders a calm error line instead of rejecting', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'loadJournal').mockRejectedValue(new Error('journal exploded'));
    const wrapper = mount(JournalView, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="journal-error"]').text()).toBe('journal exploded');
  });

  test('shows a loading line until the first load lands', async () => {
    const repo = useRepoStore();
    vi.spyOn(repo, 'loadJournal').mockResolvedValue(undefined);
    const wrapper = mount(JournalView, { global: { plugins: [pinia] }, attachTo: document.body });
    expect(wrapper.get('[data-testid="journal-loading"]').text()).toBe('Loading journal…');

    setEntries(repo, []);
    await flushPromises();
    expect(wrapper.find('[data-testid="journal-loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="journal-empty"]').exists()).toBe(true);
  });

  test('a hunk group renders header (path, kind, stats) over a DiffView body', () => {
    const { wrapper } = mountView([hunk(1, { kind: 'created' })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.text()).toContain('src/a.ts');
    // Kind is a colour-coded word (the site's status idiom). The line range is
    // NOT duplicated in the header — it lives in the diff's own @@ hunk header.
    expect(entry.get('[data-testid="kind-badge"]').text()).toBe('created');
    expect(entry.text()).toContain('+2');
    expect(entry.text()).toContain('−1');
    // The reused DiffView renders the single-hunk snapshot.
    expect(entry.find('[data-testid="diff-view"]').exists()).toBe(true);
    expect(entry.text()).toContain('edit-1');
  });

  test('a long path keeps the file name; the directory ellipses, full path on the title', () => {
    const { wrapper } = mountView([hunk(1, { path: 'packages/web/src/views/JournalView.vue' })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    // The file name is its own non-shrinking span (never ellipsed)…
    expect(entry.get('.path-name').text()).toBe('JournalView.vue');
    // …the directory prefix (which ellipses) carries the rest…
    expect(entry.get('.path-dir').text()).toBe('packages/web/src/views/');
    // …and the whole path is available on hover.
    expect(entry.get('.path').attributes('title')).toBe('packages/web/src/views/JournalView.vue');
  });

  test('a bare filename renders no directory span', () => {
    const { wrapper } = mountView([hunk(1, { path: 'README.md' })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.get('.path-name').text()).toBe('README.md');
    expect(entry.find('.path-dir').exists()).toBe(false);
  });

  test('the copy button writes the full path and flips to a "copied" label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { wrapper } = mountView([hunk(1, { path: 'packages/web/src/views/JournalView.vue' })]);
    const btn = wrapper.get('[data-testid="copy-path"]');
    expect(btn.text()).toBe('copy');
    await btn.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('packages/web/src/views/JournalView.vue');
    expect(btn.text()).toBe('copied');
  });

  test('the kind badge explains itself on hover', () => {
    const { wrapper } = mountView([hunk(1, { kind: 'created' })]);
    expect(wrapper.get('[data-testid="kind-badge"]').attributes('title')).toContain(
      'First time this change was recorded'
    );
  });

  test('a null diff (reverted tombstone) falls into the DiffView no-hunk note', () => {
    const { wrapper } = mountView([hunk(1, { kind: 'reverted', diff: null })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.find('[data-testid="diff-empty"]').exists()).toBe(true);
  });

  test('the newest entry renders FIRST — above older ones', async () => {
    const { wrapper, repo } = mountView([hunk(1), hunk(2, { path: 'src/b.ts' })]);
    const seqOrder = () =>
      wrapper.findAll('[data-testid="journal-entry"]').map((e) => e.attributes('data-seq'));
    expect(seqOrder()).toEqual(['2', '1']);

    // A genuine append lands on top.
    setEntries(repo, [...repo.journalEntries, hunk(3, { path: 'src/c.ts' })]);
    await flushPromises();
    expect(seqOrder()).toEqual(['3', '2', '1']);
  });

  test('boundary entries render as dividers with label and resolve count', () => {
    const { wrapper } = mountView([hunk(1), hunk(2), boundary(3, { resolves: [1, 2] })]);
    expect(wrapper.get('[data-testid="journal-boundary"]').text()).toBe(
      'committed a1b2c3d fix things — 2 changes'
    );
  });

  test('a journal reset renders the restarted divider at the old end of the log', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    expect(wrapper.find('[data-testid="journal-restarted"]').exists()).toBe(false);

    repo.journalRestarted = true;
    await flushPromises();
    expect(wrapper.get('[data-testid="journal-restarted"]').text()).toBe(
      'journal restarted — earlier entries were lost'
    );
  });

  test('seeded entries render muted with the seeded note (explained on hover)', () => {
    const { wrapper } = mountView([hunk(1, { seeded: true })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.classes()).toContain('seeded');
    const note = entry.get('[data-testid="seeded-note"]');
    // Compressed to a muted tag; the full sentence survives on the hover title.
    expect(note.text()).toBe('seeded');
    expect(note.attributes('title')).toContain('already in your working tree');
  });

  test('a superseded entry collapses to an outdated stub; click re-expands the stale snapshot', async () => {
    // Split children (siblings 2) supersede without folding — the parent
    // stays its own visible row and flips to outdated. Newest-first, so
    // the stale parent (seq 1) renders LAST.
    const { wrapper } = mountView([
      hunk(1),
      hunk(2, { supersedes: [1], siblings: 2 }),
      hunk(3, { supersedes: [1], siblings: 2 }),
    ]);
    const entries = wrapper.findAll('[data-testid="journal-entry"]');
    expect(entries).toHaveLength(3);
    const stale = entries[2];
    expect(stale.classes()).toContain('outdated');
    expect(stale.get('[data-testid="outdated-badge"]').text()).toMatch(/^outdated \d{2}:\d{2}$/);
    expect(stale.find('.clamp').classes()).toContain('closed');
    // The live successors are not stubs.
    expect(entries[1].find('.clamp').classes()).not.toContain('closed');

    await stale.get('.entry-header').trigger('click');
    expect(stale.find('.clamp').classes()).not.toContain('closed');

    await stale.get('.entry-header').trigger('click');
    expect(stale.find('.clamp').classes()).toContain('closed');
  });

  test('a folded chain shows one blurb with the ×N affordance; clicking expands the chain', async () => {
    const { wrapper } = mountView([
      hunk(1, { kind: 'created' }),
      hunk(2, { supersedes: [1] }),
      hunk(3, { supersedes: [2] }),
    ]);
    const entries = wrapper.findAll('[data-testid="journal-entry"]');
    expect(entries).toHaveLength(1);
    const fold = entries[0].get('[data-testid="fold-count"]');
    expect(fold.text()).toBe('×3');
    // The blurb shows the TIP's snapshot.
    expect(entries[0].text()).toContain('edit-3');
    expect(wrapper.findAll('[data-testid="chain-member"]')).toHaveLength(0);

    await fold.trigger('click');
    const members = wrapper.findAll('[data-testid="chain-member"]');
    expect(members).toHaveLength(2); // the pre-tip revisions, oldest first
    expect(members[0].text()).toContain('edit-1');
  });

  test('keys are the first member seq and survive a fold move (append-only, never reorder)', async () => {
    const { wrapper, repo } = mountView([hunk(1), hunk(2, { path: 'src/b.ts' })]);
    let seqs = wrapper.findAll('[data-testid="journal-entry"]').map((e) => e.attributes('data-seq'));
    expect(seqs).toEqual(['2', '1']); // newest-first

    // Fold: seq 3 supersedes seq 1 — group 1 keeps its key but moves to
    // the newest slot, the display top (a group renders at its LATEST
    // entry's position).
    setEntries(repo, [...repo.journalEntries, hunk(3, { supersedes: [1] })]);
    await flushPromises();
    seqs = wrapper.findAll('[data-testid="journal-entry"]').map((e) => e.attributes('data-seq'));
    expect(seqs).toEqual(['1', '2']);
    const moved = wrapper.findAll('[data-testid="journal-entry"]')[0];
    expect(moved.text()).toContain('edit-3');
  });

  test('a renamed marker row is dismissable via its header (not an immortal row)', async () => {
    const { wrapper } = mountView([hunk(1, { kind: 'renamed' })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.find('.clamp').classes()).not.toContain('closed');
    expect(entry.get('.entry-header').classes()).toContain('clickable');

    await entry.get('.entry-header').trigger('click');
    expect(entry.find('.clamp').classes()).toContain('closed');

    await entry.get('.entry-header').trigger('click');
    expect(entry.find('.clamp').classes()).not.toContain('closed');
  });

  test('a huge blurb (>800 changed lines) collapses behind a show row', async () => {
    const { wrapper } = mountView([hunk(1, { stats: { insertions: 900, deletions: 0 } })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    const showRow = entry.get('[data-testid="huge-collapsed"]');
    expect(showRow.text()).toBe('900 lines changed — show');
    expect(entry.find('[data-testid="diff-view"]').exists()).toBe(false);

    await showRow.trigger('click');
    expect(entry.find('[data-testid="huge-collapsed"]').exists()).toBe(false);
    expect(entry.find('[data-testid="diff-view"]').exists()).toBe(true);
  });

  test('an 800-changed-line blurb (at the threshold) still renders inline', () => {
    const { wrapper } = mountView([hunk(1, { stats: { insertions: 400, deletions: 400 } })]);
    const entry = wrapper.get('[data-testid="journal-entry"]');
    expect(entry.find('[data-testid="huge-collapsed"]').exists()).toBe(false);
    expect(entry.find('[data-testid="diff-view"]').exists()).toBe(true);
  });
});

describe('epoch reset', () => {
  test('a journalEpoch change clears session-local expansion state', async () => {
    useRepoStore().journalEpoch = 'epoch-1';
    // Split children keep the parent visible as an outdated stub.
    const { wrapper, repo } = mountView([
      hunk(1),
      hunk(2, { supersedes: [1], siblings: 2 }),
      hunk(3, { supersedes: [1], siblings: 2 }),
    ]);
    // Newest-first: the stale parent (seq 1) renders last.
    const stale = wrapper.findAll('[data-testid="journal-entry"]')[2];
    await stale.get('.entry-header').trigger('click');
    expect(stale.find('.clamp').classes()).not.toContain('closed');

    // Daemon reset: same seqs reappear in a NEW log — the old
    // re-expansion must not leak onto them.
    repo.journalEpoch = 'epoch-2';
    await flushPromises();
    expect(
      wrapper.findAll('[data-testid="journal-entry"]')[2].find('.clamp').classes()
    ).toContain('closed');
  });

  test('an epoch reset clears a stale mount-time load error', async () => {
    const repo = useRepoStore();
    repo.journalEpoch = 'epoch-1';
    vi.spyOn(repo, 'loadJournal').mockRejectedValue(new Error('journal exploded'));
    const wrapper = mount(JournalView, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-testid="journal-error"]').exists()).toBe(true);

    // Daemon reset: the store refetched the log wholesale — the old
    // load error must not linger over the fresh (still empty) log.
    repo.journalEpoch = 'epoch-2';
    await flushPromises();
    expect(wrapper.find('[data-testid="journal-error"]').exists()).toBe(false);
  });

  test('the first load (null -> epoch) does not reset anything', async () => {
    const { wrapper, repo } = mountView([
      hunk(1),
      hunk(2, { supersedes: [1], siblings: 2 }),
      hunk(3, { supersedes: [1], siblings: 2 }),
    ]);
    const stale = wrapper.findAll('[data-testid="journal-entry"]')[2];
    await stale.get('.entry-header').trigger('click');

    repo.journalEpoch = 'epoch-1'; // the lazy load landing
    await flushPromises();
    expect(stale.find('.clamp').classes()).not.toContain('closed');
  });
});

describe('head-pin', () => {
  /** Give the happy-dom scroller real-looking scroll metrics. */
  function mockScroller(el: HTMLElement, over: { scrollTop: number }): void {
    Object.defineProperties(el, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
      scrollTop: { value: over.scrollTop, writable: true, configurable: true },
    });
  }

  test('pinned within 40px of the top: appends keep the view at the top, no pill', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 20 }); // 20 <= 40
    scroller.dispatchEvent(new Event('scroll'));

    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/b.ts' })]);
    await flushPromises();
    expect(wrapper.find('[data-testid="new-pill"]').exists()).toBe(false);
    expect(scroller.scrollTop).toBe(0); // followed back to the newest, on top
  });

  test('scrolled down: appends count into the pill; clicking jumps to the top', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    await flushPromises(); // let the mount-time scroll-to-top settle first
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 100 }); // reading older entries
    scroller.dispatchEvent(new Event('scroll'));

    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/b.ts' }), hunk(3)]);
    await flushPromises();
    const pill = wrapper.get('[data-testid="new-pill"]');
    expect(pill.text()).toBe('2 new ↑');
    expect(scroller.scrollTop).toBe(100); // nothing yanked the viewport

    await pill.trigger('click');
    expect(scroller.scrollTop).toBe(0);
    expect(wrapper.find('[data-testid="new-pill"]').exists()).toBe(false);
  });

  test('an append while scrolled down is compensated: the survivor keeps its viewport position', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    await flushPromises();
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 100 });
    scroller.dispatchEvent(new Event('scroll'));

    // Stub the survivor's geometry: 100px from the viewport top before
    // the append, 160px after — the entering row prepended 60px above
    // it. The stub keys off the DOM itself (entry count), so the
    // pre-flush prepare sees 100 and the post-flush restore sees 160.
    const survivor = wrapper.get('[data-testid="journal-entry"]').element as HTMLElement;
    survivor.getBoundingClientRect = () => {
      const top = document.querySelectorAll('[data-testid="journal-entry"]').length > 1 ? 160 : 100;
      return { top, bottom: top + 40 } as DOMRect;
    };

    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/b.ts' })]);
    await flushPromises();
    // The sandwich moved scrollTop by exactly the entering height, so
    // the survivor did not move on screen.
    expect(scroller.scrollTop).toBe(160);
  });

  test('a pinned append animates open: the entering row carries the enter class', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    await flushPromises(); // mounted at the top — pinned

    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/b.ts' })]);
    await flushPromises();
    const reveals = wrapper.findAll('.reveal');
    expect(reveals[0].classes()).toContain('enter'); // the newest, on top
    expect(reveals[1].classes()).not.toContain('enter'); // pre-existing rows never replay
  });

  test('an append while scrolled down snaps in — no enter animation to fight the anchor', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    await flushPromises();
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 100 }); // unpinned
    scroller.dispatchEvent(new Event('scroll'));

    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/b.ts' })]);
    await flushPromises();
    for (const reveal of wrapper.findAll('.reveal')) {
      expect(reveal.classes()).not.toContain('enter');
    }
  });

  test('the pill counts displayed rows, not folded revisions', async () => {
    const { wrapper, repo } = mountView([hunk(1)]);
    await flushPromises();
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 100 }); // unpinned
    scroller.dispatchEvent(new Event('scroll'));

    // An autosave burst: 4 revisions of one new hunk, each superseding
    // the last within the fold window — ONE displayed row.
    setEntries(repo, [
      ...repo.journalEntries,
      hunk(2, { path: 'src/b.ts' }),
      hunk(3, { path: 'src/b.ts', supersedes: [2] }),
      hunk(4, { path: 'src/b.ts', supersedes: [3] }),
      hunk(5, { path: 'src/b.ts', supersedes: [4] }),
    ]);
    await flushPromises();
    expect(wrapper.get('[data-testid="new-pill"]').text()).toBe('1 new ↑');

    // The group growing across a LATER batch still counts once — the
    // count is recomputed against the frozen marker, never accumulated.
    setEntries(repo, [...repo.journalEntries, hunk(6, { path: 'src/b.ts', supersedes: [5] })]);
    await flushPromises();
    expect(wrapper.get('[data-testid="new-pill"]').text()).toBe('1 new ↑');
  });

  test('a journal reset (seq regression) resyncs the seen marker instead of muting it', async () => {
    const { wrapper, repo } = mountView([hunk(5), hunk(6)]);
    await flushPromises(); // let the mount-time scroll-to-top settle first
    const scroller = wrapper.get('[data-testid="journal-scroll"]').element as HTMLElement;
    mockScroller(scroller, { scrollTop: 100 }); // unpinned
    scroller.dispatchEvent(new Event('scroll'));

    // Epoch reset: the log was replaced wholesale, seqs restart at 1 —
    // BELOW the stale marker (6). The refetched log is not "new".
    setEntries(repo, [hunk(1, { path: 'src/fresh.ts' })]);
    await flushPromises();
    expect(wrapper.find('[data-testid="new-pill"]').exists()).toBe(false);

    // A genuine append after the reset counts again (marker resynced —
    // a stale marker of 6 would have muted seq 2 forever).
    setEntries(repo, [...repo.journalEntries, hunk(2, { path: 'src/fresh.ts' })]);
    await flushPromises();
    expect(wrapper.get('[data-testid="new-pill"]').text()).toBe('1 new ↑');
  });
});
