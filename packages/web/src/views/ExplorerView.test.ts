/**
 * ExplorerView tests: the tree renders entries with git-status
 * decoration, dirs expand/collapse on click (lazy fetch), files select
 * and load into the content pane (highlighted lines, line numbers), the
 * pane's flag-driven states (binary / too-large / truncated / empty /
 * no selection), keyboard tree navigation with roving tabindex, and the
 * toolbar toggles (inverted wire params, changed-only client filter).
 *
 * The explorer + repo stores run for real against the fake fetch —
 * no real daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import ExplorerView from './ExplorerView.vue';
import { useRepoStore } from '../stores/repo';
import { useExplorerStore } from '../stores/explorer';
import { makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';
import type { FileMedia } from '@diffstalker/client';
import { blobUrl } from '../api/client';
import { loadPrefs } from '../prefs';
import { stubMatchMedia, addToolbarSlot } from '../testing/portrait';

const ROOT_ENTRIES: DirEntry[] = [
  { name: 'src', path: 'src', type: 'dir', hasChanges: true },
  { name: 'logo.png', path: 'logo.png', type: 'file' },
  { name: 'main.ts', path: 'main.ts', type: 'file', gitStatus: 'modified', staged: true },
];

const SRC_ENTRIES: DirEntry[] = [
  { name: 'util.ts', path: 'src/util.ts', type: 'file', gitStatus: 'added' },
];

const TS_FILE: FileForDisplay = {
  content: 'const x = 1;\nlet y = 2;\n',
  binary: false,
  truncated: false,
  tooLarge: false,
  size: 25,
  totalLines: 3,
};

const PNG_MEDIA: FileMedia = {
  image: { format: 'png', mime: 'image/png', width: 320, height: 200, bytes: 4096 },
  refusal: null,
  version: '4096-1712345678000',
};

function params(call: FetchCall): URLSearchParams {
  return new URLSearchParams(call.url.split('?')[1] ?? '');
}

let pinia: Pinia;
let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | undefined) | null;

function defaultRoutes(call: FetchCall): FakeResponse {
  if (call.url.startsWith('/repos/r1/tree?')) {
    const dir = params(call).get('dir');
    if (dir === '') return { body: ROOT_ENTRIES };
    if (dir === 'src') return { body: SRC_ENTRIES };
    return { status: 404, body: { error: `no such dir: ${dir}` } };
  }
  if (call.url.startsWith('/repos/r1/file?')) {
    return { body: TS_FILE };
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

async function mountView(): Promise<{
  wrapper: VueWrapper;
  explorer: ReturnType<typeof useExplorerStore>;
}> {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  const explorer = useExplorerStore();
  const wrapper = mount(ExplorerView, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, explorer };
}

function rowNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.tree-row .name').map((el) => el.text());
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? defaultRoutes(call));
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('tree rendering', () => {
  test('the root listing renders as a tree with git-status decoration', async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find('[role="tree"]').exists()).toBe(true);
    expect(rowNames(wrapper)).toEqual(['src', 'logo.png', 'main.ts']);

    const rows = wrapper.findAll('.tree-row');
    // Dir: collapsed chevron, changes dot, aria-expanded=false, level 1.
    expect(rows[0].find('.chevron').text()).toBe('▸');
    expect(rows[0].find('.changes-dot').exists()).toBe(true);
    expect(rows[0].attributes('aria-expanded')).toBe('false');
    expect(rows[0].attributes('aria-level')).toBe('1');
    // Plain file: no letter, no dots.
    expect(rows[1].find('.status-letter').exists()).toBe(false);
    // Modified + staged file: the M letter, the staged dot, status class.
    expect(rows[2].find('[data-testid="status-letter"]').text()).toBe('M');
    expect(rows[2].find('.staged-dot').exists()).toBe(true);
    expect(rows[2].classes()).toContain('st-modified');
  });

  test('an empty repo shows the quiet empty state', async () => {
    onRequest = (call) => (call.url.includes('/tree') ? { body: [] } : undefined);
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="tree-empty"]').text()).toBe('Empty repository.');
  });

  test('a failed root load surfaces the error in the tree column', async () => {
    onRequest = (call) =>
      call.url.includes('/tree') ? { status: 500, body: { error: 'boom' } } : undefined;
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="tree-error"]').text()).toBe('boom');
  });
});

describe('expansion by mouse', () => {
  test('clicking a dir fetches its children and renders them one level deeper', async () => {
    const { wrapper } = await mountView();

    await wrapper.findAll('.tree-row')[0].trigger('click');
    await flushPromises();

    const dirCalls = fake.callsTo('/tree');
    expect(params(dirCalls.at(-1)!).get('dir')).toBe('src');
    expect(rowNames(wrapper)).toEqual(['src', 'util.ts', 'logo.png', 'main.ts']);

    const child = wrapper.findAll('.tree-row')[1];
    expect(child.attributes('aria-level')).toBe('2');
    expect(child.findAll('.guide')).toHaveLength(1);
    expect(wrapper.findAll('.tree-row')[0].attributes('aria-expanded')).toBe('true');
  });

  test('clicking an expanded dir collapses it', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('click');
    await flushPromises();
    await wrapper.findAll('.tree-row')[0].trigger('click');
    expect(rowNames(wrapper)).toEqual(['src', 'logo.png', 'main.ts']);
  });
});

describe('single-child chain collapse', () => {
  beforeEach(() => {
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/tree?')) return undefined;
      const dir = params(call).get('dir');
      if (dir === '') {
        return {
          body: [
            { name: 'a', path: 'a', type: 'dir' },
            { name: 'main.ts', path: 'main.ts', type: 'file' },
          ] satisfies DirEntry[],
        };
      }
      if (dir === 'a') return { body: [{ name: 'b', path: 'a/b', type: 'dir' }] };
      if (dir === 'a/b') {
        return { body: [{ name: 'leaf.ts', path: 'a/b/leaf.ts', type: 'file' }] };
      }
      return { status: 404, body: { error: `no such dir: ${dir}` } };
    };
  });

  test('expanding the chain renders ONE combined row with working chevron and levels', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('click');
    await flushPromises();

    // One combined row (a/b), not two nested dir rows.
    expect(rowNames(wrapper)).toEqual(['a/b', 'leaf.ts', 'main.ts']);
    const combined = wrapper.findAll('.tree-row')[0];
    expect(combined.find('.chevron').text()).toBe('▾');
    expect(combined.attributes('aria-expanded')).toBe('true');
    expect(combined.attributes('aria-level')).toBe('1');
    // The child sits ONE level under the combined row.
    expect(wrapper.findAll('.tree-row')[1].attributes('aria-level')).toBe('2');
  });

  test('clicking the combined row collapses the whole chain', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('click');
    await flushPromises();
    await wrapper.findAll('.tree-row')[0].trigger('click');

    expect(rowNames(wrapper)).toEqual(['a/b', 'main.ts']);
    expect(wrapper.findAll('.tree-row')[0].attributes('aria-expanded')).toBe('false');
  });

  test('ArrowLeft on a chain child jumps to the combined row', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('click');
    await flushPromises();

    // leaf.ts's direct parent (a/b) has no row of its own — the walk-up
    // lands on the combined row.
    await wrapper.findAll('.tree-row')[1].trigger('keydown', { key: 'ArrowLeft' });
    const stops = wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));
    expect(stops[0]).toBe('0');
  });
});

describe('file selection and the content pane', () => {
  test('nothing selected shows the prompt', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="file-prompt"]').text()).toBe('Select a file');
  });

  test('clicking a file loads it and renders highlighted, numbered lines', async () => {
    const { wrapper } = await mountView();

    await wrapper.findAll('.tree-row')[2].trigger('click'); // main.ts
    await flushPromises();

    expect(params(fake.callsTo('/file')[0]).get('path')).toBe('main.ts');
    expect(wrapper.find('[data-testid="file-header"]').text()).toContain('main.ts');
    expect(wrapper.findAll('.tree-row')[2].attributes('aria-selected')).toBe('true');

    const content = wrapper.find('[data-testid="file-content"]');
    const rows = content.findAll('.code-row');
    expect(rows).toHaveLength(2); // trailing newline adds no phantom line
    expect(rows.map((r) => r.find('.ln').text())).toEqual(['1', '2']);
    // Syntax highlighting produced hljs token spans in the DOM.
    expect(content.find('.hljs-keyword').exists()).toBe(true);
    expect(content.text()).toContain('const x = 1;');
  });

  test('the wrap toggle switches the file content pane into wrap mode', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('click'); // main.ts
    await flushPromises();

    expect(wrapper.find('[data-testid="file-content"]').classes()).not.toContain('wrap');

    await wrapper.find('[data-testid="wrap-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="file-content"]').classes()).toContain('wrap');
  });

  // REGRESSION GUARD. The image feature widened this branch and hung a
  // refusal suffix off it; with no media verdict the text must stay exactly
  // what it has always been, to the byte.
  test('a binary file shows the flag-driven note', async () => {
    onRequest = (call) =>
      call.url.includes('/file')
        ? { body: { ...TS_FILE, content: '', binary: true, size: 2048, totalLines: 0 } }
        : undefined;
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="file-binary"]').text()).toBe('Binary file — 2.0 KB');
    expect(wrapper.find('[data-testid="image-refused"]').exists()).toBe(false);
  });

  test('a too-large file shows the flag-driven note', async () => {
    onRequest = (call) =>
      call.url.includes('/file')
        ? { body: { ...TS_FILE, content: '', tooLarge: true, size: 5 * 1024 * 1024, totalLines: 0 } }
        : undefined;
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="file-too-large"]').text()).toBe(
      'File too large to display (5.0 MB)'
    );
  });

  test('a truncated file shows content plus the truncation note', async () => {
    onRequest = (call) =>
      call.url.includes('/file')
        ? { body: { ...TS_FILE, truncated: true, totalLines: 9000 } }
        : undefined;
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="file-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-truncated"]').text()).toContain('of 9,000 lines');
  });

  test('an empty file shows the quiet note', async () => {
    onRequest = (call) =>
      call.url.includes('/file')
        ? { body: { ...TS_FILE, content: '', size: 0, totalLines: 1 } }
        : undefined;
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="file-empty"]').text()).toBe('Empty file');
  });

  test('a failed file load shows the error in the pane', async () => {
    onRequest = (call) =>
      call.url.includes('/file') ? { status: 404, body: { error: 'ENOENT' } } : undefined;
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="file-error"]').text()).toBe('ENOENT');
  });
});

describe('images in the content pane', () => {
  /** A binary FileForDisplay carrying the daemon's media verdict. */
  function imageFile(media: FileMedia, extra: Partial<FileForDisplay> = {}): FileForDisplay {
    return { ...TS_FILE, content: '', binary: true, size: 4096, totalLines: 0, media, ...extra };
  }

  function serveFile(body: FileForDisplay): void {
    onRequest = (call) => (call.url.includes('/file') ? { body } : undefined);
  }

  /** Select logo.png, the plain (unchanged) file in the root listing. */
  async function openImage(wrapper: VueWrapper): Promise<void> {
    await wrapper.findAll('.tree-row')[1].trigger('click');
    await flushPromises();
  }

  test('an image verdict renders the viewer with the blob URL for the worktree side', async () => {
    serveFile(imageFile(PNG_MEDIA));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="image-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="image"]').attributes('src')).toBe(
      blobUrl('r1', { path: 'logo.png', side: 'worktree', version: PNG_MEDIA.version })
    );
    // The picture replaces the note, it does not sit beside it.
    expect(wrapper.find('[data-testid="file-binary"]').exists()).toBe(false);
  });

  test('the header reads out format, dimensions and size; no language chip', async () => {
    serveFile(imageFile(PNG_MEDIA));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="file-format"]').text()).toBe('png');
    expect(wrapper.find('[data-testid="file-dimensions"]').text()).toBe('320 × 200');
    expect(wrapper.find('[data-testid="file-frames"]').exists()).toBe(false);
    expect(wrapper.find('.file-size').text()).toBe('4.0 KB');
    expect(wrapper.find('[data-testid="file-header"]').text()).toContain('logo.png');
  });

  test('an animated GIF adds the frame count', async () => {
    serveFile(
      imageFile({
        image: { format: 'gif', mime: 'image/gif', width: 64, height: 64, bytes: 4096, frames: 12 },
        refusal: null,
        version: 'gif-1',
      })
    );
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="file-frames"]').text()).toBe('12 frames');
  });

  // Branch order: the tooLarge flag is the 1 MiB TEXT cap. Below the image
  // branch, every picture over it would read "File too large".
  test('a tooLarge file WITH an image verdict still renders the viewer', async () => {
    serveFile(imageFile(PNG_MEDIA, { binary: false, tooLarge: true, size: 3 * 1024 * 1024 }));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="image-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-too-large"]').exists()).toBe(false);
  });

  // The other half of the same branch order, and the contract the daemon
  // holds up its end of: media present on an oversized file means the bytes
  // really are binary, so the note wins over "too large". A big TEXT file
  // that happens to open with a weak signature (BM, II*\0) carries NO media
  // and lands on "too large" — see readFileForDisplay in core.
  test('a tooLarge file WITH a refusal reads as a binary we cannot preview', async () => {
    serveFile(
      imageFile(
        { image: null, refusal: 'unsupported-format', version: 'webp-1' },
        { binary: false, tooLarge: true, size: 2 * 1024 * 1024 }
      )
    );
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="file-too-large"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-binary"]').text()).toBe(
      'Binary file — 2.0 MB · no preview (format not rendered)'
    );
  });

  test('a refused format keeps the note and names the reason', async () => {
    serveFile(imageFile({ image: null, refusal: 'unsupported-format', version: 'webp-1' }));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="image-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="image-refused"]').text()).toBe(
      '· no preview (format not rendered)'
    );
    expect(wrapper.find('[data-testid="file-binary"]').text()).toBe(
      'Binary file — 4.0 KB · no preview (format not rendered)'
    );
  });

  test('a not-an-image verdict adds nothing to the note', async () => {
    serveFile(imageFile({ image: null, refusal: 'not-an-image', version: 'tar-1' }));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    expect(wrapper.find('[data-testid="file-binary"]').text()).toBe('Binary file — 4.0 KB');
    expect(wrapper.find('[data-testid="image-refused"]').exists()).toBe(false);
  });

  test('a decode failure falls back to the plain note, not to "too large"', async () => {
    serveFile(imageFile(PNG_MEDIA, { binary: false, tooLarge: true, size: 3 * 1024 * 1024 }));
    const { wrapper } = await mountView();
    await openImage(wrapper);

    await wrapper.find('[data-testid="image"]').trigger('error');

    expect(wrapper.find('[data-testid="image-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-too-large"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-binary"]').text()).toBe(
      'Binary file — 3.0 MB · preview failed to decode'
    );
  });

  test('switching from an image to a text file leaves no <img> behind', async () => {
    onRequest = (call) => {
      if (!call.url.includes('/file')) return undefined;
      return params(call).get('path') === 'logo.png'
        ? { body: imageFile(PNG_MEDIA) }
        : { body: TS_FILE };
    };
    const { wrapper } = await mountView();
    await openImage(wrapper);
    expect(wrapper.findAll('img')).toHaveLength(1);

    await wrapper.findAll('.tree-row')[2].trigger('click'); // main.ts
    await flushPromises();

    expect(wrapper.findAll('img')).toHaveLength(0);
    expect(wrapper.find('[data-testid="image-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-format"]').exists()).toBe(false);
  });
});

describe('keyboard navigation', () => {
  test('ArrowDown moves the tab stop down; ArrowUp back; ends clamp', async () => {
    const { wrapper } = await mountView();
    const tabStops = () => wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));
    expect(tabStops()).toEqual(['0', '-1', '-1']);

    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowDown' });
    expect(tabStops()).toEqual(['-1', '0', '-1']);

    await wrapper.findAll('.tree-row')[1].trigger('keydown', { key: 'ArrowUp' });
    expect(tabStops()).toEqual(['0', '-1', '-1']);

    // Clamped at the top.
    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowUp' });
    expect(tabStops()).toEqual(['0', '-1', '-1']);
  });

  test('ArrowRight expands a collapsed dir; ArrowLeft collapses it', async () => {
    const { wrapper } = await mountView();

    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(rowNames(wrapper)).toContain('util.ts');

    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowLeft' });
    expect(rowNames(wrapper)).not.toContain('util.ts');
  });

  test('ArrowLeft on a nested file moves the tab stop to its parent dir', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('click'); // expand src
    await flushPromises();

    await wrapper.findAll('.tree-row')[1].trigger('keydown', { key: 'ArrowLeft' }); // util.ts
    const stops = wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));
    expect(stops[0]).toBe('0'); // src owns the tab stop now
  });

  test('Enter on a file row loads it', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[2].trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(fake.callsTo('/file')).toHaveLength(1);
    expect(wrapper.find('[data-testid="file-content"]').exists()).toBe(true);
  });

  test('Home and End jump the tab stop to the first and last row', async () => {
    const { wrapper } = await mountView();
    const tabStops = () => wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));

    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'End' });
    expect(tabStops()).toEqual(['-1', '-1', '0']);

    await wrapper.findAll('.tree-row')[2].trigger('keydown', { key: 'Home' });
    expect(tabStops()).toEqual(['0', '-1', '-1']);
  });

  test('ArrowRight on an expanded dir with no children does NOT jump to a sibling', async () => {
    onRequest = (call) => {
      if (!call.url.includes('/tree')) return undefined;
      const dir = params(call).get('dir');
      if (dir === '') {
        return {
          body: [
            { name: 'empty', path: 'empty', type: 'dir' },
            { name: 'main.ts', path: 'main.ts', type: 'file' },
          ] satisfies DirEntry[],
        };
      }
      if (dir === 'empty') return { body: [] };
      return undefined;
    };
    const { wrapper } = await mountView();
    const tabStops = () => wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));

    // First Right expands (fetches the empty listing).
    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(wrapper.findAll('.tree-row')[0].attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('.tree-row')).toHaveLength(2); // no children appeared

    // Second Right: per the ARIA tree pattern, stay put — no sibling jump.
    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowRight' });
    expect(tabStops()).toEqual(['0', '-1']);
  });

  test('ArrowRight on an expanded dir WITH children steps into the first child', async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowRight' }); // expand src
    await flushPromises();

    await wrapper.findAll('.tree-row')[0].trigger('keydown', { key: 'ArrowRight' });
    const stops = wrapper.findAll('.tree-row').map((r) => r.attributes('tabindex'));
    expect(stops).toEqual(['-1', '0', '-1', '-1']); // src/util.ts owns the tab stop
  });

  test('focus recovers to the selected row when the focused row vanishes', async () => {
    const { wrapper } = await mountView();

    await wrapper.findAll('.tree-row')[2].trigger('click'); // select main.ts
    await flushPromises();
    // Move focus up to logo.png (a row with no changes).
    await wrapper.findAll('.tree-row')[2].trigger('keydown', { key: 'ArrowUp' });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.findAll('.tree-row')[1].element);

    // Changed-only filter drops logo.png — the focused row vanishes.
    await wrapper.find('[data-testid="toggle-changed"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(rowNames(wrapper)).toEqual(['src', 'main.ts']);
    // Focus moved to the selected row instead of falling to <body>.
    const selected = wrapper.findAll('.tree-row')[1];
    expect(selected.text()).toContain('main.ts');
    expect(document.activeElement).toBe(selected.element);
  });
});

describe('toolbar toggles', () => {
  test('the dotfiles toggle refetches with hidden=true and reads pressed', async () => {
    const { wrapper } = await mountView();
    const toggle = wrapper.find('[data-testid="toggle-hidden"]');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="toggle-hidden"]').attributes('aria-pressed')).toBe('true');
    const last = fake.callsTo('/tree').at(-1)!;
    expect(params(last).get('hidden')).toBe('true');
    expect(params(last).get('ignored')).toBe('false');
  });

  test('the ignored toggle refetches with ignored=true', async () => {
    const { wrapper } = await mountView();
    await wrapper.find('[data-testid="toggle-ignored"]').trigger('click');
    await flushPromises();
    expect(params(fake.callsTo('/tree').at(-1)!).get('ignored')).toBe('true');
  });

  test('the changed toggle filters rows client-side without a fetch', async () => {
    const { wrapper } = await mountView();
    const calls = fake.callsTo('/tree').length;

    await wrapper.find('[data-testid="toggle-changed"]').trigger('click');

    expect(rowNames(wrapper)).toEqual(['src', 'main.ts']); // hasChanges + modified
    expect(fake.callsTo('/tree')).toHaveLength(calls);
    // And a truthful empty-state message when nothing has changes:
    // (covered by the store test; here just flip back)
    await wrapper.find('[data-testid="toggle-changed"]').trigger('click');
    expect(rowNames(wrapper)).toHaveLength(3);
  });
});

describe('portrait layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('lifts the toolbar into the tab-band slot', async () => {
    stubMatchMedia(true);
    addToolbarSlot();
    const { wrapper } = await mountView();
    const slot = document.querySelector('#view-toolbar-slot')!;

    for (const id of ['toggle-hidden', 'toggle-ignored', 'toggle-changed', 'tree-refresh']) {
      expect(slot.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(wrapper.find('.tree-col [data-testid="toggle-hidden"]').exists()).toBe(false);

    // A lifted toggle still drives the store (re-fetches the tree).
    const changed = slot.querySelector<HTMLButtonElement>('[data-testid="toggle-changed"]')!;
    changed.click();
    await wrapper.vm.$nextTick();
    expect(changed.getAttribute('aria-pressed')).toBe('true');
  });

  test('portrait adds a horizontal row resizer that persists explorerTop', async () => {
    stubMatchMedia(true);
    addToolbarSlot();
    const { wrapper } = await mountView();
    expect(wrapper.find('.explorer').classes()).toContain('portrait');
    expect(wrapper.find('.explorer').attributes('style')).toContain('--explorer-top: 34.00%');

    const resizer = wrapper.find('.row-resizer');
    expect(resizer.attributes('aria-orientation')).toBe('horizontal');
    await resizer.trigger('keydown', { key: 'ArrowDown' });
    expect(loadPrefs().explorerTop).toBeCloseTo(0.36);
    expect(wrapper.find('.explorer').attributes('style')).toContain('--explorer-top: 36.00%');
  });

  test('j/k move the tree focus; the content pane is a focusable region', async () => {
    stubMatchMedia(true);
    addToolbarSlot();
    const { wrapper } = await mountView();

    const rows = wrapper.findAll('.tree-row');
    (rows[0].element as HTMLElement).focus();
    await rows[0].trigger('keydown', { key: 'j' });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(rows[1].element);
    await rows[1].trigger('keydown', { key: 'k' });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(rows[0].element);

    const pane = wrapper.find('.content-col');
    expect(pane.attributes('tabindex')).toBe('0');
    expect(pane.attributes('role')).toBe('region');
  });

  test('landscape keeps the toolbar inline and renders NO resizer', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find('.tree-col [data-testid="toggle-hidden"]').exists()).toBe(true);
    expect(wrapper.find('.row-resizer').exists()).toBe(false);
    expect(wrapper.find('.content-col').attributes('tabindex')).toBeUndefined();
  });
});
