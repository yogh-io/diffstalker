/**
 * DiffStack geometry: the arithmetic section-offset model, over a stack
 * that mixes the three body shapes — a rendered diff, a withheld-diff
 * NOTE, and a media card.
 *
 * This file exists for one bug. The stack derives every section's
 * scroller-relative top by arithmetic (zero DOM reads per scroll frame),
 * and the fixed strips in that sum are measured ONCE and reused for every
 * section of the same kind. Give two differently-sized bodies the same
 * memoized slot and every section below the first mismatch is placed
 * wrong, by a compounding (N-1) x delta. Nothing throws, jumps still land
 * (they read live offsetTop), and the only symptom is the scroll spy
 * naming a file the reader is not looking at. So that is what these tests
 * assert, with a LARGE NOTE ABOVE A MEDIA CARD — the note is what
 * populates the shared slot first, which is exactly how the bug hides.
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
const NOT_SHOWN_NOTE_H = 40;
/** Deliberately nothing like the note: a shared slot must show up loudly. */
const NOT_SHOWN_MEDIA_H = 400;
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
  if (has('not-shown-note')) return NOT_SHOWN_NOTE_H;
  if (has('not-shown-media')) return NOT_SHOWN_MEDIA_H;
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

/** text, LARGE NOTE, media card, text — the order that hides the bug. */
function mixedFiles(): StackFile[] {
  return [
    stackFile('a.ts', TEXT_DIFF),
    stackFile('big.gml', LARGE_DIFF),
    stackFile('img.png', BINARY_DIFF),
    stackFile('b.ts', TEXT_DIFF),
  ];
}

const TEXT_BODY_H = HUNK_HEADER_H + 2 * ROW_H;
const OUTER = {
  text: BORDER_Y + SECTION_HEADER_H + TEXT_BODY_H,
  note: BORDER_Y + SECTION_HEADER_H + NOT_SHOWN_NOTE_H,
  media: BORDER_Y + SECTION_HEADER_H + NOT_SHOWN_MEDIA_H,
};

/** The true tops of the four sections, accumulated from the layout above. */
const EXPECTED_TOPS = (() => {
  const heights = [OUTER.text, OUTER.note, OUTER.media, OUTER.text];
  const tops: number[] = [];
  let top = TOOLBAR_H;
  for (const height of heights) {
    tops.push(top);
    top += height + SECTION_GAP;
  }
  return tops;
})();

// --- Harness ---

let realRect: () => DOMRect;
let realComputedStyle: typeof window.getComputedStyle;

async function mountStack(mediaKeys = new Set(['img.png'])): Promise<VueWrapper> {
  const wrapper = mount(DiffStack, {
    props: { files: mixedFiles(), mediaKeys },
    slots: { media: '<div class="media-card">image card</div>' },
    attachTo: document.body,
  });
  // The scroll-spy binds its listener in a pre-flush watcher on the
  // scroller ref, which runs after mount() returns.
  await nextTick();
  // The DOM's own answer for "where does this section start", accumulated
  // from the same per-section heights the model must arrive at.
  wrapper.findAll('[data-testid="file-diff"]').forEach((section, i) => {
    Object.defineProperty(section.element, 'offsetTop', {
      value: EXPECTED_TOPS[i],
      configurable: true,
    });
  });
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

describe('the media slot', () => {
  test('a binary section with a media key renders the slot instead of the note', async () => {
    const wrapper = await mountStack();
    const sections = wrapper.findAll('[data-testid="file-diff"]');
    const media = sections[2];

    expect(media.find('[data-testid="not-shown-media"]').exists()).toBe(true);
    expect(media.find('.media-card').text()).toBe('image card');
    expect(media.find('[data-testid="not-shown-note"]').exists()).toBe(false);
    // Still no diff body and no "Load diff": a picture is not a diff.
    expect(media.find('.file-diff-body').exists()).toBe(false);
    expect(media.find('[data-testid="load-diff"]').exists()).toBe(false);
  });

  test('a binary section with no media key keeps the plain note', async () => {
    const wrapper = await mountStack(new Set());
    const media = wrapper.findAll('[data-testid="file-diff"]')[2];

    expect(wrapper.find('[data-testid="not-shown-media"]').exists()).toBe(false);
    expect(media.find('[data-testid="not-shown-note"]').text()).toContain('Binary file');
  });

  test('an over-cap TEXT section never becomes a media card, key or not', async () => {
    const wrapper = await mountStack(new Set(['big.gml', 'img.png']));
    const note = wrapper.findAll('[data-testid="file-diff"]')[1];

    expect(note.find('[data-testid="not-shown-media"]').exists()).toBe(false);
    expect(note.find('[data-testid="not-shown-note"]').text()).toContain('Large file');
    expect(wrapper.findAll('[data-testid="not-shown-media"]')).toHaveLength(1);
  });
});

describe('section offsets across the three body shapes', () => {
  test('the scroll-spy names the section the reader is actually inside', async () => {
    const wrapper = await mountStack();
    // Well inside the media card, whose top is EXPECTED_TOPS[2]. A model
    // that sized this section with the NOTE's memoized height would put
    // the next file's top at 292 and name b.ts from here.
    await scrollTo(wrapper, EXPECTED_TOPS[2] + 200);
    expect(activeKey(wrapper)).toBe('img.png');
  });

  test('every section owns its own span, top to bottom', async () => {
    const wrapper = await mountStack();
    const keys = ['a.ts', 'big.gml', 'img.png', 'b.ts'];

    for (const [i, key] of keys.entries()) {
      await scrollTo(wrapper, EXPECTED_TOPS[i] + 20);
      expect(activeKey(wrapper)).toBe(key);
    }

    // And the last section's true top is far below where a shared strip
    // slot would have placed it — the compounding error, made explicit.
    expect(EXPECTED_TOPS[3] - (EXPECTED_TOPS[2] + OUTER.note + SECTION_GAP)).toBe(
      NOT_SHOWN_MEDIA_H - NOT_SHOWN_NOTE_H
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

  test('flipping a section to a media card re-places everything below it', async () => {
    const wrapper = await mountStack(new Set());
    // With the note, b.ts starts a note-height card earlier.
    const noteTop = EXPECTED_TOPS[2] + OUTER.note + SECTION_GAP;
    await scrollTo(wrapper, noteTop + 20);
    expect(activeKey(wrapper)).toBe('b.ts');

    // The metadata lands: the parent REPLACES the Set, the card grows,
    // and the same scroll position is now inside the picture.
    await wrapper.setProps({ mediaKeys: new Set(['img.png']) });
    await nextTick();
    await scrollTo(wrapper, noteTop + 20);
    expect(activeKey(wrapper)).toBe('img.png');
  });
});
