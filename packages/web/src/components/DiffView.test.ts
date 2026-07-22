/**
 * DiffView tests: line-type rendering (markers, dual line-number
 * gutters, diff bg classes), file-section headers (auto for multi-file
 * diffs, prop-forced/suppressed), hunk headers with relative edit times
 * and the fresh-hunk flash, word-level highlighting for similar del/add
 * pairs (positional pairing within a run, none for dissimilar lines),
 * empty/binary states, a large diff rendering without error, and the
 * viewer stance: the diff is READ-ONLY — no hunk-staging buttons exist.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DiffView from './DiffView.vue';
import type { DiffResult, DiffLine } from '@diffstalker/core/git/diff';

function header(path: string): DiffLine {
  return { type: 'header', content: `diff --git a/${path} b/${path}` };
}

function hunk(content: string, editedAt?: number): DiffLine {
  return { type: 'hunk', content, ...(editedAt !== undefined && { editedAt }) };
}

function ctx(text: string, oldNum: number, newNum: number): DiffLine {
  return { type: 'context', content: ` ${text}`, oldLineNum: oldNum, newLineNum: newNum };
}

function add(text: string, newNum: number): DiffLine {
  return { type: 'addition', content: `+${text}`, newLineNum: newNum };
}

function del(text: string, oldNum: number): DiffLine {
  return { type: 'deletion', content: `-${text}`, oldLineNum: oldNum };
}

function makeDiff(lines: DiffLine[]): DiffResult {
  return { raw: lines.map((l) => l.content).join('\n') + '\n', lines };
}

function mountDiff(
  diff: DiffResult | null,
  props: {
    showFileHeaders?: boolean;
    filePath?: string;
    syntax?: boolean;
    mode?: 'unified' | 'split';
  } = {}
) {
  return mount(DiffView, { props: { diff, ...props } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('line rendering', () => {
  const diff = makeDiff([
    header('src/foo.ts'),
    hunk('@@ -10,3 +10,3 @@ function foo()'),
    ctx('unchanged', 10, 10),
    del('old line', 11),
    add('new line', 11),
  ]);

  test('each line type renders with the right marker and line numbers', () => {
    const wrapper = mountDiff(diff);

    const context = wrapper.find('.row.context');
    expect(context.find('.ln.old').text()).toBe('10');
    expect(context.find('.ln.new').text()).toBe('10');
    expect(context.find('.marker').text()).toBe('');
    expect(context.find('.content').text()).toBe('unchanged');

    const deletion = wrapper.find('.row.del');
    expect(deletion.find('.ln.old').text()).toBe('11');
    expect(deletion.find('.ln.new').text()).toBe('');
    expect(deletion.find('.marker').text()).toBe('-');
    expect(deletion.find('.content').text()).toBe('old line');

    const addition = wrapper.find('.row.add');
    expect(addition.find('.ln.old').text()).toBe('');
    expect(addition.find('.ln.new').text()).toBe('11');
    expect(addition.find('.marker').text()).toBe('+');
    expect(addition.find('.content').text()).toBe('new line');
  });

  test('addition and deletion rows carry the diff bg classes', () => {
    const wrapper = mountDiff(diff);
    expect(wrapper.find('.row.add').exists()).toBe(true);
    expect(wrapper.find('.row.del').exists()).toBe(true);
    // Context rows carry neither.
    expect(wrapper.find('.row.context').classes()).not.toContain('add');
    expect(wrapper.find('.row.context').classes()).not.toContain('del');
  });

  test('a single-file diff renders no file-section header by default', () => {
    // The pane chrome above the diff already names the file.
    const wrapper = mountDiff(diff);
    expect(wrapper.findAll('[data-testid="file-section-header"]')).toHaveLength(0);
  });

  test('the line-number gutter width follows the largest line number', () => {
    const wide = makeDiff([
      header('a.ts'),
      hunk('@@ -99998,2 +99998,2 @@'),
      ctx('x', 99998, 99998),
      ctx('y', 99999, 99999),
    ]);
    const wrapper = mountDiff(wide);
    expect(wrapper.find('[data-testid="diff-view"]').attributes('style')).toContain(
      '--ln-w: 5ch'
    );
  });
});

describe('file section headers (multi-file diffs)', () => {
  const twoFileDiff = makeDiff([
    header('src/foo.ts'),
    hunk('@@ -1 +1 @@'),
    del('old foo', 1),
    add('new foo', 1),
    header('src/bar.ts'),
    hunk('@@ -5 +5 @@'),
    add('new bar', 5),
  ]);

  test('a multi-file diff renders one header per file section, in order', () => {
    const wrapper = mountDiff(twoFileDiff);
    const headers = wrapper.findAll('[data-testid="file-section-header"]');
    expect(headers.map((h) => h.text())).toEqual(['src/foo.ts', 'src/bar.ts']);
    // The hunk-header sticky offset class rides along.
    expect(wrapper.find('[data-testid="diff-view"]').classes()).toContain('with-file-headers');
  });

  test('every file section keeps its own rows under its header', () => {
    const wrapper = mountDiff(twoFileDiff);
    const sections = wrapper.findAll('.file-section');
    expect(sections).toHaveLength(2);
    expect(sections[0].find('.row.del .content').text()).toBe('old foo');
    expect(sections[1].find('.row.add .content').text()).toBe('new bar');
  });

  test('showFileHeaders forces the header on a single-file diff', () => {
    const single = makeDiff([header('a.ts'), hunk('@@ -1 +1 @@'), ctx('x', 1, 1)]);
    const wrapper = mountDiff(single, { showFileHeaders: true });
    const headers = wrapper.findAll('[data-testid="file-section-header"]');
    expect(headers).toHaveLength(1);
    expect(headers[0].text()).toBe('a.ts');
  });

  test('a single-file diff without the prop has no sticky-offset class either', () => {
    const single = makeDiff([header('a.ts'), hunk('@@ -1 +1 @@'), ctx('x', 1, 1)]);
    const wrapper = mountDiff(single);
    expect(wrapper.find('[data-testid="diff-view"]').classes()).not.toContain(
      'with-file-headers'
    );
  });
});

describe('hunk headers', () => {
  test('shows readable ranges and the relative edit time from editedAt', () => {
    const editedAt = Date.now() - 5 * 60_000;
    const wrapper = mountDiff(
      makeDiff([
        header('src/foo.ts'),
        hunk('@@ -10,3 +12,4 @@ function foo()', editedAt),
        ctx('x', 10, 12),
      ])
    );
    const headerEl = wrapper.find('[data-testid="hunk-header"]');
    expect(headerEl.text()).toContain('Lines 10-12 → 12-15');
    expect(headerEl.text()).toContain('function foo()');
    expect(wrapper.find('[data-testid="hunk-time"]').text()).toBe('5 minutes ago');
  });

  test('a hunk without editedAt shows no time', () => {
    const wrapper = mountDiff(makeDiff([header('a.ts'), hunk('@@ -1 +1 @@'), ctx('x', 1, 1)]));
    expect(wrapper.find('[data-testid="hunk-time"]').exists()).toBe(false);
  });

  test('a freshly-edited hunk flashes the WHOLE hunk group; an old one does not', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1 +1 @@', Date.now() - 100),
        ctx('x', 1, 1),
        hunk('@@ -5 +5 @@', Date.now() - 60_000),
        ctx('y', 5, 5),
      ])
    );
    // The flash rides the hunk GROUP (header + rows), not the header.
    const hunks = wrapper.findAll('.hunk');
    expect(hunks[0].classes()).toContain('flash');
    expect(hunks[1].classes()).not.toContain('flash');
    // The flashed group wraps both the header and its rows.
    expect(hunks[0].find('[data-testid="hunk-header"]').exists()).toBe(true);
    expect(hunks[0].findAll('.row')).toHaveLength(1);
    // No header-only flash remains.
    expect(wrapper.findAll('[data-testid="hunk-header"].flash')).toHaveLength(0);
  });

  test('sub-minute times tick: the 1s interval re-renders the relative time', async () => {
    vi.useFakeTimers();
    const wrapper = mountDiff(
      makeDiff([header('a.ts'), hunk('@@ -1 +1 @@', Date.now() - 55_000), ctx('x', 1, 1)])
    );
    expect(wrapper.find('[data-testid="hunk-time"]').text()).toBe('55 seconds ago');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wrapper.find('[data-testid="hunk-time"]').text()).toBe('1 minute ago');
    // The stamp aged past the sub-minute window — the ticker stopped itself.
    expect(vi.getTimerCount()).toBe(0);
    wrapper.unmount(); // advancing further must not throw
    await vi.advanceTimersByTimeAsync(5_000);
  });

  test('unmount clears the ticker: zero pending timers remain', () => {
    vi.useFakeTimers();
    const wrapper = mountDiff(
      makeDiff([header('a.ts'), hunk('@@ -1 +1 @@', Date.now() - 5_000), ctx('x', 1, 1)])
    );
    expect(vi.getTimerCount()).toBe(1); // fresh stamp → ticker running
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0); // the real leak proof
  });

  test('no ticker runs when the newest editedAt is older than a minute', () => {
    vi.useFakeTimers();
    const wrapper = mountDiff(
      makeDiff([header('a.ts'), hunk('@@ -1 +1 @@', Date.now() - 5 * 60_000), ctx('x', 1, 1)])
    );
    expect(wrapper.find('[data-testid="hunk-time"]').text()).toBe('5 minutes ago');
    expect(vi.getTimerCount()).toBe(0);
    wrapper.unmount();
  });
});

describe('word-level highlighting', () => {
  test('a similar del/add pair gets changed segments wrapped in .word-hl', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1 +1 @@'),
        del('const value = 1;', 1),
        add('const value = 2;', 1),
      ])
    );
    const delHl = wrapper.find('.row.del').findAll('.word-hl');
    const addHl = wrapper.find('.row.add').findAll('.word-hl');
    expect(delHl.map((s) => s.text()).join('')).toBe('1');
    expect(addHl.map((s) => s.text()).join('')).toBe('2');
    // Unchanged segments are NOT highlighted.
    expect(wrapper.find('.row.del .content').text()).toBe('const value = 1;');
  });

  test('a dissimilar del/add pair gets NO word highlighting', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1 +1 @@'),
        del('aaaa', 1),
        add('a completely different line entirely', 1),
      ])
    );
    expect(wrapper.findAll('.word-hl')).toHaveLength(0);
  });

  test('pairs by position within a consecutive del/add run (CLI semantics)', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1,2 +1,2 @@'),
        del('alpha = 111;', 1),
        del('beta = 333;', 2),
        add('alpha = 222;', 1),
        add('beta = 444;', 2),
      ])
    );
    const delRows = wrapper.findAll('.row.del');
    const addRows = wrapper.findAll('.row.add');
    // del[0] pairs with add[0], del[1] with add[1] — every row highlights
    // exactly its own changed token.
    expect(delRows[0].findAll('.word-hl').map((s) => s.text()).join('')).toBe('111');
    expect(delRows[1].findAll('.word-hl').map((s) => s.text()).join('')).toBe('333');
    expect(addRows[0].findAll('.word-hl').map((s) => s.text()).join('')).toBe('222');
    expect(addRows[1].findAll('.word-hl').map((s) => s.text()).join('')).toBe('444');
  });

  test('an unequal run pairs by position; the surplus addition gets NO highlight', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1,2 +1,3 @@'),
        del('const alpha = 1;', 1),
        del('const beta = 2;', 2),
        add('const alpha = 9;', 1),
        add('const beta = 8;', 2),
        add('const gamma = 7;', 3),
      ])
    );
    const delRows = wrapper.findAll('.row.del');
    const addRows = wrapper.findAll('.row.add');
    // The first two del/add pairs highlight their changed token…
    expect(delRows[0].findAll('.word-hl').map((s) => s.text()).join('')).toBe('1');
    expect(delRows[1].findAll('.word-hl').map((s) => s.text()).join('')).toBe('2');
    expect(addRows[0].findAll('.word-hl').map((s) => s.text()).join('')).toBe('9');
    expect(addRows[1].findAll('.word-hl').map((s) => s.text()).join('')).toBe('8');
    // …the unpaired third addition carries no word highlighting at all.
    expect(addRows[2].findAll('.word-hl')).toHaveLength(0);
    expect(addRows[2].find('.content').text()).toBe('const gamma = 7;');
  });

  test('does NOT pair across context lines (separate runs)', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('a.ts'),
        hunk('@@ -1,3 +1,3 @@'),
        del('const value = 1;', 1),
        ctx('between', 2, 2),
        add('const value = 2;', 2),
      ])
    );
    expect(wrapper.findAll('.word-hl')).toHaveLength(0);
  });
});

describe('empty and edge states', () => {
  test('a null diff shows the quiet empty state', () => {
    const wrapper = mountDiff(null);
    expect(wrapper.find('[data-testid="diff-empty"]').text()).toContain('No changes to show');
  });

  test('an empty diff shows the quiet empty state', () => {
    const wrapper = mountDiff({ raw: '', lines: [] });
    expect(wrapper.find('[data-testid="diff-empty"]').text()).toContain('No changes to show');
  });

  test('a binary diff shows a clear note', () => {
    const wrapper = mountDiff(
      makeDiff([
        header('img.png'),
        { type: 'header', content: 'Binary files a/img.png and b/img.png differ' },
      ])
    );
    expect(wrapper.find('[data-testid="diff-empty"]').text()).toContain('Binary file');
  });

  test('a header-only diff (new file mode, no content) renders the notes branch', () => {
    const wrapper = mountDiff(
      makeDiff([header('new.ts'), { type: 'header', content: 'new file mode 100644' }])
    );
    const empty = wrapper.find('[data-testid="diff-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.find('.empty-note').text()).toBe('new file mode 100644');
    expect(empty.text()).toContain('No text changes to show');
    // No diff rows and no crash on a body-less diff.
    expect(wrapper.findAll('.row')).toHaveLength(0);
  });

  test('a large diff renders every row without error', () => {
    const lines: DiffLine[] = [header('big.ts'), hunk('@@ -1,3000 +1,3000 @@')];
    for (let i = 1; i <= 3000; i++) {
      lines.push(ctx(`line ${i}`, i, i));
    }
    const wrapper = mountDiff(makeDiff(lines));
    expect(wrapper.findAll('.row')).toHaveLength(3000);
  });
});

describe('viewer stance (read-only)', () => {
  const twoHunkDiff = makeDiff([
    header('src/foo.ts'),
    hunk('@@ -1,2 +1,2 @@'),
    del('first old', 1),
    add('first new', 1),
    ctx('keep', 2, 2),
    hunk('@@ -10,2 +10,2 @@'),
    del('second old', 10),
    add('second new', 10),
  ]);

  test('a working-tree diff renders NO hunk buttons — and no buttons at all', () => {
    const wrapper = mountDiff(twoHunkDiff, { filePath: 'src/foo.ts' });
    // The read rendering is intact…
    expect(wrapper.findAll('[data-testid="hunk-header"]')).toHaveLength(2);
    expect(wrapper.find('.row.del .content').text()).toBe('first old');
    // …and there is no staging affordance anywhere in the diff.
    expect(wrapper.findAll('[data-testid="hunk-action"]')).toHaveLength(0);
    expect(wrapper.findAll('button')).toHaveLength(0);
  });
});

describe('syntax highlighting (the `syntax` prop)', () => {
  // A .ts diff whose added line contains a keyword hljs will tokenize.
  const tsDiff = makeDiff([
    header('src/foo.ts'),
    hunk('@@ -1,1 +1,1 @@'),
    del('const x = 1;', 1),
    add('const y = 2;', 1),
  ]);

  test('off by default: content is plain text, no hljs token spans', () => {
    const wrapper = mountDiff(tsDiff, { filePath: 'src/foo.ts' });
    expect(wrapper.find('[class*="hljs-"]').exists()).toBe(false);
    expect(wrapper.find('.row.add .content').text()).toBe('const y = 2;');
  });

  test('on with a known language: hljs token spans render, text preserved', () => {
    const wrapper = mountDiff(tsDiff, { filePath: 'src/foo.ts', syntax: true });
    expect(wrapper.find('[class*="hljs-"]').exists()).toBe(true);
    // The rendered text still reconstructs the exact source line.
    expect(wrapper.find('.row.add .content').text()).toBe('const y = 2;');
  });

  test('on but unknown language: falls back to plain (no hljs spans)', () => {
    const unknown = makeDiff([
      header('notes.unknownext'),
      hunk('@@ -1,1 +1,1 @@'),
      add('const y = 2;', 1),
    ]);
    const wrapper = mountDiff(unknown, { filePath: 'notes.unknownext', syntax: true });
    expect(wrapper.find('[class*="hljs-"]').exists()).toBe(false);
    expect(wrapper.find('.row.add .content').text()).toBe('const y = 2;');
  });

  test('word-diff background survives with syntax on (both layers compose)', () => {
    const wrapper = mountDiff(tsDiff, { filePath: 'src/foo.ts', syntax: true });
    // The del/add pair is similar, so a changed word ("1"/"2") carries a
    // word-hl span even while syntax tokenization is active.
    expect(wrapper.find('.row.add .content .word-hl').exists()).toBe(true);
  });
});

describe('split mode (the `mode` prop)', () => {
  // A hunk with an unbalanced run: 2 deletions, 1 addition, plus context.
  const diff = makeDiff([
    header('src/foo.ts'),
    hunk('@@ -1,3 +1,2 @@'),
    ctx('keep', 1, 1),
    del('old a', 2),
    del('old b', 3),
    add('new a', 2),
  ]);

  test('unified by default: a stacked row stream, no split body', () => {
    const wrapper = mountDiff(diff, { filePath: 'src/foo.ts' });
    expect(wrapper.find('.split-body').exists()).toBe(false);
    expect(wrapper.findAll('.row').length).toBeGreaterThan(0);
  });

  test('split renders two aligned sides with equal row counts', () => {
    const wrapper = mountDiff(diff, { filePath: 'src/foo.ts', mode: 'split' });
    expect(wrapper.find('.split-body').exists()).toBe(true);
    // No unified rows in split mode.
    expect(wrapper.findAll('.row')).toHaveLength(0);
    const left = wrapper.findAll('.split-side.left .split-line');
    const right = wrapper.findAll('.split-side.right .split-line');
    // context (1) + max(2 dels, 1 add) = 3 visual rows on each side.
    expect(left).toHaveLength(3);
    expect(right).toHaveLength(3);
  });

  test('the short side pads with an empty cell', () => {
    const wrapper = mountDiff(diff, { filePath: 'src/foo.ts', mode: 'split' });
    const right = wrapper.findAll('.split-side.right .split-line');
    // Rows: [context, add "new a", empty] — the 2nd deletion has no pair.
    expect(right[1].classes()).toContain('add');
    expect(right[1].find('.content').text()).toBe('new a');
    expect(right[2].classes()).toContain('empty');
    expect(right[2].find('.content').text()).toBe('');
  });

  test('left side carries the deletions with old line numbers', () => {
    const wrapper = mountDiff(diff, { filePath: 'src/foo.ts', mode: 'split' });
    const left = wrapper.findAll('.split-side.left .split-line');
    expect(left[1].classes()).toContain('del');
    expect(left[1].find('.content').text()).toBe('old a');
    expect(left[1].find('.ln').text()).toBe('2');
    expect(left[2].find('.content').text()).toBe('old b');
  });

  test('syntax highlighting composes with split mode', () => {
    const wrapper = mountDiff(diff, { filePath: 'src/foo.ts', mode: 'split', syntax: true });
    expect(wrapper.find('.split-body [class*="hljs-"]').exists()).toBe(true);
  });
});
