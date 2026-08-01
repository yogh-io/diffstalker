/**
 * DiffStack geometry: the arithmetic section-offset model, over a stack
 * that mixes every body shape — a rendered diff, BOTH withheld-diff notes
 * (the large-file notice and the binary note), and a media card.
 *
 * This file exists for one bug. The stack derives every section's
 * scroller-relative top by arithmetic (zero DOM reads per scroll frame),
 * and the fixed strips in that sum are measured ONCE and reused for every
 * section of the same kind. Give two differently-sized bodies the same
 * memoized slot and every section below the first mismatch is placed
 * wrong, by a compounding (N-1) x delta. Nothing throws, jumps still land
 * (they read live offsetTop), and the only symptom is the scroll spy
 * naming a file the reader is not looking at. So that is what these tests
 * assert, with the LARGE NOTE FIRST — whichever shape renders first is
 * what fills a shared slot, which is exactly how the bug hides.
 *
 * happy-dom has no layout engine, so the tests install one: a
 * getBoundingClientRect that answers from a table keyed by class, plus
 * offsetTops accumulated from those same heights. The model must agree
 * with that independently-computed truth.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import DiffStack from './DiffStack.vue';
import type { StackFile } from './DiffStack.vue';
import type { DiffResult } from '@diffstalker/core/git/diff';

// --- The fake layout ---

const ROW_H = 20;
const HUNK_HEADER_H = 24;
/** The border a non-last hunk carries; the probe's first hunk has it. */
const HUNK_BORDER_H = 2;
/** Rows in the probe's first hunk — measureProbe derives the border from it. */
const PROBE_FIRST_HUNK_ROWS = 2;
const PROBE_FILE_HEADER_H = 22;
const PROBE_NOTE_H = 18;
const PROBE_SECTION_H = 100;
const PROBE_SECTION_GAP = 6;

const TOOLBAR_H = 16;
const SECTION_HEADER_H = 30;
/** "Binary file — no text diff to show." — one line. */
const NOT_SHOWN_BINARY_H = 40;
/** The large-file notice: longer prose, but still clamped to one line. */
const NOT_SHOWN_LARGE_H = 62;
/**
 * The large notice's height for THIS test, by its text. The notice embeds
 * a per-file size and line count, so left to wrap two of them would be
 * different heights on a narrow card — the CSS clamps it to one line, and
 * one test breaks that to prove the DEV guard notices.
 */
let largeNoticeHeight: (text: string) => number = (_text) => NOT_SHOWN_LARGE_H;
/** Deliberately nothing like a note: a shared slot must show up loudly. */
const NOT_SHOWN_MEDIA_H = 400;
/**
 * The media card's height for THIS test: the card promises to be the same
 * height in every state, and one test breaks that promise to prove the DEV
 * guard notices.
 */
let mediaHeightOverride: number | null = null;
/** border-top + border-bottom on .file-diff. */
const BORDER_Y = 2;
/** The .file-diff + .file-diff margin. */
const SECTION_GAP = 12;

function heightOf(el: Element): number {
  const has = (name: string): boolean => el.classList.contains(name);
  if (has('hunk-header')) return HUNK_HEADER_H;
  if (has('hunk')) return HUNK_HEADER_H + PROBE_FIRST_HUNK_ROWS * ROW_H + HUNK_BORDER_H;
  if (has('row')) return ROW_H;
  if (has('file-header')) return PROBE_FILE_HEADER_H;
  if (has('file-note')) return PROBE_NOTE_H;
  if (has('file-section')) return PROBE_SECTION_H;
  if (has('stack-toolbar')) return TOOLBAR_H;
  if (has('file-diff-header')) return SECTION_HEADER_H;
  if (has('not-shown-binary')) return NOT_SHOWN_BINARY_H;
  if (has('not-shown-large')) return largeNoticeHeight(el.textContent ?? '');
  if (has('not-shown-media')) return mediaHeightOverride ?? NOT_SHOWN_MEDIA_H;
  return 0;
}

/**
 * Only the probe's file sections need a real top: measureProbe derives the
 * inter-section gap from the distance between them.
 */
function topOf(el: Element): number {
  if (!el.classList.contains('file-section')) return 0;
  const siblings = [...(el.parentElement?.children ?? [])].filter((child) =>
    child.classList.contains('file-section')
  );
  return siblings.indexOf(el) * (PROBE_SECTION_H + PROBE_SECTION_GAP);
}

function fakeRect(el: Element): DOMRect {
  const height = heightOf(el);
  const top = topOf(el);
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

// --- Fixtures ---

/** One file, one hunk, two rows: body = hunk header + 2 rows. */
const TEXT_DIFF: DiffResult = {
  lines: [
    { type: 'header', content: 'diff --git a/a.ts b/a.ts' },
    { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
    { type: 'deletion', content: '-old', oldLineNum: 1 },
    { type: 'addition', content: '+new', newLineNum: 1 },
  ],
};

const BINARY_DIFF: DiffResult = {
  lines: [
    { type: 'header', content: 'diff --git a/img.png b/img.png' },
    { type: 'header', content: 'Binary files a/img.png and b/img.png differ' },
  ],
};

const LARGE_DIFF: DiffResult = {
  lines: [
    { type: 'header', content: 'diff --git a/big.gml b/big.gml' },
    { type: 'header', content: 'Large file — diff not shown (18.3 MB, 121,285 lines)' },
  ],
};

function stackFile(path: string, diff: DiffResult): StackFile {
  return {
    key: path,
    path,
    status: 'modified',
    stats: { insertions: 1, deletions: 1 },
    diff,
  };
}

/**
 * text, LARGE NOTE, BINARY NOTE, media card, text — the order that hides
 * the bug: the large notice renders first, so it is what fills any slot
 * the shapes below it would have shared.
 */
function mixedFiles(): StackFile[] {
  return [
    stackFile('a.ts', TEXT_DIFF),
    stackFile('big.gml', LARGE_DIFF),
    stackFile('blob.bin', BINARY_DIFF),
    stackFile('img.png', BINARY_DIFF),
    stackFile('b.ts', TEXT_DIFF),
  ];
}

/** The section keys of mixedFiles, in order. */
const KEYS = ['a.ts', 'big.gml', 'blob.bin', 'img.png', 'b.ts'];

const TEXT_BODY_H = HUNK_HEADER_H + 2 * ROW_H;
const OUTER = {
  text: BORDER_Y + SECTION_HEADER_H + TEXT_BODY_H,
  binaryNote: BORDER_Y + SECTION_HEADER_H + NOT_SHOWN_BINARY_H,
  largeNote: BORDER_Y + SECTION_HEADER_H + NOT_SHOWN_LARGE_H,
  media: BORDER_Y + SECTION_HEADER_H + NOT_SHOWN_MEDIA_H,
};

/** What each section is worth, given the keys the parent has media for. */
function outerHeights(mediaKeys: Set<string>): number[] {
  return mixedFiles().map((file) => {
    if (file.diff === LARGE_DIFF) return OUTER.largeNote;
    if (file.diff !== BINARY_DIFF) return OUTER.text;
    return mediaKeys.has(file.key) ? OUTER.media : OUTER.binaryNote;
  });
}

/** The true tops of the sections, accumulated from the layout above. */
function expectedTops(mediaKeys: Set<string>): number[] {
  const tops: number[] = [];
  let top = TOOLBAR_H;
  for (const height of outerHeights(mediaKeys)) {
    tops.push(top);
    top += height + SECTION_GAP;
  }
  return tops;
}

const EXPECTED_TOPS = expectedTops(new Set(['img.png']));

// --- Harness ---

let realRect: () => DOMRect;
let realComputedStyle: typeof window.getComputedStyle;

/**
 * The DOM's own answer for "where does this section start", accumulated
 * from the same per-section heights the model must arrive at.
 */
function applyTops(wrapper: VueWrapper, mediaKeys: Set<string>): void {
  const tops = expectedTops(mediaKeys);
  wrapper.findAll('[data-testid="file-diff"]').forEach((section, i) => {
    Object.defineProperty(section.element, 'offsetTop', {
      value: tops[i],
      configurable: true,
    });
  });
}

async function mountStack(mediaKeys = new Set(['img.png'])): Promise<VueWrapper> {
  const wrapper = mount(DiffStack, {
    props: { files: mixedFiles(), mediaKeys },
    slots: { media: '<div class="media-card">image card</div>' },
    attachTo: document.body,
  });
  // The scroll-spy binds its listener in a pre-flush watcher on the
  // scroller ref, which runs after mount() returns.
  await nextTick();
  applyTops(wrapper, mediaKeys);
  return wrapper;
}

function scroller(wrapper: VueWrapper): HTMLElement {
  return wrapper.find('.stack-scroller').element as HTMLElement;
}

/** Scroll the stack and let the rAF-throttled spy run. */
async function scrollTo(wrapper: VueWrapper, top: number): Promise<void> {
  const el = scroller(wrapper);
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await nextTick();
}

/** The key the scroll-spy last reported. */
function activeKey(wrapper: VueWrapper): string | undefined {
  const events = wrapper.emitted('active-file') as string[][] | undefined;
  return events?.at(-1)?.[0];
}

beforeEach(() => {
  localStorage.clear();
  mediaHeightOverride = null;
  largeNoticeHeight = () => NOT_SHOWN_LARGE_H;
  setActivePinia(createPinia());
  realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return fakeRect(this);
  };
  realComputedStyle = window.getComputedStyle;
  vi.stubGlobal('getComputedStyle', (el: Element, pseudo?: string | null) => {
    if (el.classList?.contains('file-diff')) {
      return {
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
        paddingTop: '0px',
        paddingBottom: '0px',
        marginTop: `${SECTION_GAP}px`,
      } as CSSStyleDeclaration;
    }
    return realComputedStyle.call(window, el, pseudo);
  });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The section element for a key. */
function sectionFor(wrapper: VueWrapper, key: string) {
  return wrapper.findAll('[data-testid="file-diff"]')[KEYS.indexOf(key)];
}

describe('the media slot', () => {
  test('a binary section with a media key renders the slot instead of the note', async () => {
    const wrapper = await mountStack();
    const media = sectionFor(wrapper, 'img.png');

    expect(media.find('[data-testid="not-shown-media"]').exists()).toBe(true);
    expect(media.find('.media-card').text()).toBe('image card');
    expect(media.find('[data-testid="not-shown-note"]').exists()).toBe(false);
    // Still no diff body and no "Load diff": a picture is not a diff.
    expect(media.find('.file-diff-body').exists()).toBe(false);
    expect(media.find('[data-testid="load-diff"]').exists()).toBe(false);
  });

  test('a binary section with no media key keeps the plain note', async () => {
    const wrapper = await mountStack(new Set());
    const media = sectionFor(wrapper, 'img.png');

    expect(wrapper.find('[data-testid="not-shown-media"]').exists()).toBe(false);
    expect(media.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('an over-cap TEXT section never becomes a media card, key or not', async () => {
    const wrapper = await mountStack(new Set(['big.gml', 'img.png']));
    const note = sectionFor(wrapper, 'big.gml');

    expect(note.find('[data-testid="not-shown-media"]').exists()).toBe(false);
    expect(note.find('[data-testid="not-shown-note"]').text()).toContain('Large file');
    expect(wrapper.findAll('[data-testid="not-shown-media"]')).toHaveLength(1);
  });

  test('the notice keeps its full text in the title — the one-line clamp costs nothing', async () => {
    const wrapper = await mountStack();

    // The strip is a single line at any card width, so a narrow card can
    // ellipsize the size and line count away. The title is where they stay.
    expect(
      sectionFor(wrapper, 'big.gml').find('[data-testid="not-shown-note"]').attributes('title')
    ).toBe('Large file — diff not shown (18.3 MB, 121,285 lines)');
  });

  test('the two withheld-diff notes are measured as two different shapes', async () => {
    const wrapper = await mountStack();

    // Same styling class (one copy of the look), different measurement
    // hooks — which is what gives them separate memoized heights.
    expect(sectionFor(wrapper, 'big.gml').find('.not-shown-note').classes()).toContain(
      'not-shown-large'
    );
    expect(sectionFor(wrapper, 'blob.bin').find('.not-shown-note').classes()).toContain(
      'not-shown-binary'
    );
  });
});

describe('section offsets across every body shape', () => {
  test('the scroll-spy names the section the reader is actually inside', async () => {
    const wrapper = await mountStack();
    // Well inside the media card. A model that sized this section with a
    // NOTE's memoized height would put the next file's top far above here
    // and name b.ts instead.
    await scrollTo(wrapper, EXPECTED_TOPS[3] + 200);
    expect(activeKey(wrapper)).toBe('img.png');
  });

  test('every section owns its own span, top to bottom', async () => {
    const wrapper = await mountStack();

    for (const [i, key] of KEYS.entries()) {
      await scrollTo(wrapper, EXPECTED_TOPS[i] + 20);
      expect(activeKey(wrapper)).toBe(key);
    }
  });

  test('the binary note does not inherit the large notice height above it', async () => {
    const wrapper = await mountStack();
    // The large note renders first, so a shared "not shown" slot would be
    // measured from it and place this section (and every one below it)
    // that much too low.
    expect(EXPECTED_TOPS[2] - EXPECTED_TOPS[1]).toBe(OUTER.largeNote + SECTION_GAP);

    await scrollTo(wrapper, EXPECTED_TOPS[2] + 20);
    expect(activeKey(wrapper)).toBe('blob.bin');
    // One notice-vs-note delta is already enough to name the wrong file
    // at the very next section.
    await scrollTo(wrapper, EXPECTED_TOPS[3] - 10);
    expect(activeKey(wrapper)).toBe('blob.bin');
  });

  test('a shared strip slot would misplace the last section by the compounded delta', () => {
    // The error a single memoized slot buys, made explicit: each note-kind
    // and media section below the first mismatch adds its own difference.
    const shared =
      TOOLBAR_H +
      [OUTER.text, OUTER.largeNote, OUTER.largeNote, OUTER.largeNote]
        .map((h) => h + SECTION_GAP)
        .reduce((a, b) => a + b, 0);
    expect(EXPECTED_TOPS[4] - shared).toBe(
      NOT_SHOWN_BINARY_H - NOT_SHOWN_LARGE_H + (NOT_SHOWN_MEDIA_H - NOT_SHOWN_LARGE_H)
    );
  });

  test('the DEV geometry assert stays silent on a files commit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = await mountStack();

    // A commit re-runs the model against the real offsetTops.
    await wrapper.setProps({ files: mixedFiles() });
    await nextTick();

    expect(warn.mock.calls.map(String).join('\n')).not.toContain('[DiffStack]');
    warn.mockRestore();
  });

  test('the DEV strip assert warns when a slot stops matching its strip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = await mountStack();
    // Scroll once so the offset cache measures (and memoizes) the card.
    await scrollTo(wrapper, EXPECTED_TOPS[3] + 20);

    // The card then grew — exactly what the memoized slot promises never
    // happens, and what nothing else in the stack would notice.
    mediaHeightOverride = NOT_SHOWN_MEDIA_H + 40;
    await wrapper.setProps({ files: mixedFiles() });
    await nextTick();

    expect(warn.mock.calls.map(String).join('\n')).toContain('notShownMediaH drift');
    warn.mockRestore();
  });

  test('two large notices of different heights are reported, never silently shared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const otherLarge: DiffResult = {
      lines: [
        { type: 'header', content: 'diff --git a/other.gml b/other.gml' },
        { type: 'header', content: 'Large file — diff not shown (2.1 MB, 9,004 lines)' },
      ],
    };
    const files = (): StackFile[] => [
      stackFile('big.gml', LARGE_DIFF),
      stackFile('other.gml', otherLarge),
      stackFile('b.ts', TEXT_DIFF),
    ];
    const wrapper = mount(DiffStack, { props: { files: files() }, attachTo: document.body });
    await nextTick();

    // A commit measures notShownLargeH from the FIRST notice and then
    // sizes the second one with it, sight-unseen. The two notices carry
    // different numbers, and the clamp is what makes that safe.
    await wrapper.setProps({ files: files() });
    await nextTick();
    expect(warn.mock.calls.map(String).join('\n')).not.toContain('notShownLargeH drift');

    // The clamp gives way and the second notice wraps onto a second line:
    // every section below it is now placed wrong, and this is the only
    // thing in the stack that would say so.
    largeNoticeHeight = (text) =>
      text.includes('2.1 MB') ? NOT_SHOWN_LARGE_H + 18 : NOT_SHOWN_LARGE_H;
    await wrapper.setProps({ files: files() });
    await nextTick();
    expect(warn.mock.calls.map(String).join('\n')).toContain('notShownLargeH drift');
    warn.mockRestore();
  });

  test('flipping a section to a media card re-places everything below it', async () => {
    const wrapper = await mountStack(new Set());
    const noteTops = expectedTops(new Set());
    // With the note, b.ts starts a note-height card earlier.
    await scrollTo(wrapper, noteTops[4] + 20);
    expect(activeKey(wrapper)).toBe('b.ts');

    // The metadata lands: the parent REPLACES the Set, the card grows,
    // and the same scroll position is now inside the picture.
    await wrapper.setProps({ mediaKeys: new Set(['img.png']) });
    await nextTick();
    applyTops(wrapper, new Set(['img.png']));
    await scrollTo(wrapper, noteTops[4] + 20);
    expect(activeKey(wrapper)).toBe('img.png');
  });
});
