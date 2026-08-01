/**
 * ImageDiffView: the picture card in a Changes section.
 *
 * Three things are under test. The comparison itself (two frames, two
 * distinct blob URLs, the three modes and the range that drives them).
 * The meta bar, which is a correctness feature rather than decoration:
 * both byte sizes and both short oids are on screen in EVERY mode, and
 * matching dimensions with differing bytes says so out loud — otherwise a
 * reviewer can look at two identical-looking pictures and conclude nothing
 * changed when the EXIF (GPS, camera serial, embedded thumbnail) did. And
 * the height invariant: the card is the same height in every state,
 * because DiffStack memoizes exactly one height for this slot.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MediaPair, MediaSide } from '@diffstalker/client';
import ImageDiffView from './ImageDiffView.vue';
import { useUiStore } from '../stores/ui';
import { blobUrl } from '../api/client';

function side(overrides: Partial<MediaSide> = {}): MediaSide {
  return {
    path: 'assets/logo.png',
    side: 'index',
    bytes: 24576,
    oid: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    version: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    image: { format: 'png', mime: 'image/png', width: 512, height: 512, bytes: 24576 },
    refusal: null,
    ...overrides,
  };
}

/** The common case: an image modified in the working tree. */
function modifiedPair(): MediaPair {
  return {
    old: side(),
    new: side({
      side: 'worktree',
      bytes: 31744,
      oid: null,
      version: '31744-1712345678000',
      image: { format: 'png', mime: 'image/png', width: 512, height: 512, bytes: 31744 },
    }),
  };
}

function mountDiff(pair: MediaPair = modifiedPair()): VueWrapper {
  return mount(ImageDiffView, { props: { pair, repoId: 'r1' } });
}

function frames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('img').map((img) => img.attributes('src') ?? '');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('the two sides', () => {
  test('renders one frame per side, each at its own blob URL', () => {
    const wrapper = mountDiff();
    const pair = modifiedPair();

    expect(frames(wrapper)).toEqual([
      blobUrl('r1', { path: 'assets/logo.png', side: 'index', version: pair.old!.version }),
      blobUrl('r1', { path: 'assets/logo.png', side: 'worktree', version: pair.new!.version }),
    ]);
    // Two sides, two different blobs — never the same URL twice.
    expect(new Set(frames(wrapper)).size).toBe(2);
  });

  test('a rename asks each side for the path that side actually has', () => {
    const wrapper = mountDiff({
      old: side({ path: 'assets/old-name.png', side: 'head' }),
      new: side({ path: 'assets/new-name.png', side: 'index' }),
    });
    expect(frames(wrapper)[0]).toContain('path=assets%2Fold-name.png');
    expect(frames(wrapper)[1]).toContain('path=assets%2Fnew-name.png');
  });

  test('the intrinsic sizes come from the daemon verdict, per side', () => {
    const wrapper = mountDiff({
      old: side(),
      new: side({ image: { format: 'png', mime: 'image/png', width: 800, height: 600, bytes: 1 } }),
    });
    const imgs = wrapper.findAll('img');
    expect(imgs[0].attributes('width')).toBe('512');
    expect(imgs[1].attributes('width')).toBe('800');
    expect(imgs[1].attributes('height')).toBe('600');
  });
});

describe('the meta bar', () => {
  test('always names both byte sizes and both short oids', () => {
    const text = mountDiff().find('[data-testid="image-meta"]').text();

    expect(text).toContain('24.0 KB');
    expect(text).toContain('31.0 KB');
    expect(text).toContain('a1b2c3d');
    // The working tree is not a git object, so it says so instead of an oid.
    expect(text).toContain('working tree');
    expect(text).toContain('512 × 512');
  });

  test('says "metadata only" when the dimensions match but the bytes do not', () => {
    const hint = mountDiff().find('[data-testid="image-metadata-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('metadata');
    expect(mountDiff().find('[data-testid="image-byte-delta"]').text()).toBe('(+7.0 KB)');
  });

  test('no hint when the dimensions differ — the picture already shows it', () => {
    const wrapper = mountDiff({
      old: side(),
      new: side({
        bytes: 31744,
        image: { format: 'png', mime: 'image/png', width: 256, height: 256, bytes: 31744 },
      }),
    });
    expect(wrapper.find('[data-testid="image-metadata-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="image-byte-delta"]').exists()).toBe(true);
  });

  test('no byte delta when the sizes are identical', () => {
    const wrapper = mountDiff({ old: side(), new: side({ side: 'worktree', oid: null }) });
    expect(wrapper.find('[data-testid="image-byte-delta"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="image-metadata-hint"]').exists()).toBe(false);
  });

  test('the sizes and oids survive every mode', async () => {
    const wrapper = mountDiff();
    const ui = useUiStore();

    for (const mode of ['swipe', 'onion', 'side-by-side'] as const) {
      ui.setImageDiffMode(mode);
      await wrapper.vm.$nextTick();
      const text = wrapper.find('[data-testid="image-meta"]').text();
      expect(text).toContain('24.0 KB');
      expect(text).toContain('31.0 KB');
      expect(text).toContain('a1b2c3d');
    }
  });
});

describe('the modes', () => {
  test('the picker is a radiogroup, side by side checked by default', () => {
    const wrapper = mountDiff();
    const picker = wrapper.find('[data-testid="image-diff-mode"]');
    expect(picker.attributes('role')).toBe('radiogroup');

    const buttons = picker.findAll('[role="radio"]');
    expect(buttons.map((b) => b.attributes('data-mode'))).toEqual([
      'side-by-side',
      'swipe',
      'onion',
    ]);
    expect(buttons.map((b) => b.attributes('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(wrapper.find('[data-testid="image-diff"]').classes()).toContain('side-by-side');
  });

  test('picking a mode switches the stage and persists the choice', async () => {
    const wrapper = mountDiff();
    await wrapper.find('[data-mode="swipe"]').trigger('click');

    expect(wrapper.find('[data-testid="image-diff"]').classes()).toContain('swipe');
    expect(wrapper.find('.image-stage').classes()).toContain('swipe');
    expect(useUiStore().imageDiffMode).toBe('swipe');
    // Same treatment as diffMode: an app-wide, remembered preference.
    expect(JSON.parse(localStorage.getItem('diffstalker:prefs')!).imageDiffMode).toBe('swipe');
  });

  test('the range drives --swipe and --onion on the stage', async () => {
    const wrapper = mountDiff();
    await wrapper.find('[data-mode="swipe"]').trigger('click');

    const range = wrapper.find('[data-testid="image-diff-swipe"]');
    expect(range.attributes('type')).toBe('range');
    expect(range.attributes('aria-label')).toBe('Swipe between old and new');

    await range.setValue('30');
    const style = wrapper.find('.image-stage').attributes('style')!;
    expect(style).toContain('--swipe: 30');
    expect(style).toContain('--onion: 0.3');
  });

  test('an overlay mode degrades to side by side when the sides differ in size', async () => {
    const wrapper = mountDiff({
      old: side(),
      new: side({
        side: 'worktree',
        oid: null,
        image: { format: 'png', mime: 'image/png', width: 256, height: 256, bytes: 1 },
      }),
    });
    await wrapper.find('[data-mode="onion"]').trigger('click');

    // The choice is remembered, but a wipe between two different shapes
    // compares nothing — this card stays side by side.
    expect(useUiStore().imageDiffMode).toBe('onion');
    expect(wrapper.find('[data-testid="image-diff"]').classes()).toContain('side-by-side');
    expect(wrapper.find('[data-testid="image-diff-swipe"]').attributes('disabled')).toBeDefined();
  });
});

describe('one-sided changes', () => {
  test('an added file renders one frame, a plate, and keeps the range hidden', () => {
    const wrapper = mountDiff({ old: null, new: side({ side: 'worktree', oid: null }) });

    expect(wrapper.findAll('img')).toHaveLength(1);
    expect(wrapper.find('[data-testid="image-old"]').text()).toBe('No version on this side');
    expect(wrapper.find('[data-testid="image-new"] img').exists()).toBe(true);

    // In the DOM, only invisible: removing it would change the card's
    // height, and that height is a constant the stack's offsets rely on.
    const range = wrapper.find('[data-testid="image-diff-swipe"]');
    expect(range.exists()).toBe(true);
    expect(range.classes()).toContain('inert');
    expect(wrapper.find('[data-testid="image-meta"]').text()).toContain('old —');
  });

  test('a deleted file renders the old side only', () => {
    const wrapper = mountDiff({ old: side({ side: 'head' }), new: null });
    expect(wrapper.findAll('img')).toHaveLength(1);
    expect(wrapper.find('[data-testid="image-new"]').text()).toBe('No version on this side');
  });
});

describe('refusals and decode failures', () => {
  test('a refused side gets its own plate; the other still renders', () => {
    const wrapper = mountDiff({
      old: side({ image: null, refusal: 'too-large', version: '' }),
      new: side({ side: 'worktree', oid: null }),
    });

    expect(wrapper.find('[data-testid="image-old"] [data-testid="image-refused"]').text()).toBe(
      'No preview (over the preview size cap: 8 MB, or 2 MB for GIF)'
    );
    expect(wrapper.find('[data-testid="image-new"] img').exists()).toBe(true);
    // The refused side is still described: its byte size is the change.
    expect(wrapper.find('[data-testid="image-meta"]').text()).toContain('24.0 KB');
  });

  test('one side failing to decode swaps only that half', async () => {
    const wrapper = mountDiff();
    await wrapper.find('[data-testid="image-old"] img').trigger('error');

    expect(wrapper.find('[data-testid="image-old"] img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="image-old"]').text()).toBe('Preview failed to decode');
    expect(wrapper.find('[data-testid="image-new"] img').exists()).toBe(true);
    expect(wrapper.emitted('fail')).toBeUndefined();
  });

  test('both sides failing emits fail so the parent can fall back to the note', async () => {
    const wrapper = mountDiff();
    await wrapper.find('[data-testid="image-old"] img').trigger('error');
    await wrapper.find('[data-testid="image-new"] img').trigger('error');

    expect(wrapper.emitted('fail')).toHaveLength(1);
    expect(wrapper.findAll('img')).toHaveLength(0);
  });

  test('a fresh pair gives a failed side another chance', async () => {
    const wrapper = mountDiff();
    await wrapper.find('[data-testid="image-old"] img').trigger('error');
    expect(wrapper.findAll('img')).toHaveLength(1);

    await wrapper.setProps({ pair: modifiedPair() });
    expect(wrapper.findAll('img')).toHaveLength(2);
  });
});

describe('the transport shape', () => {
  test('nothing here can decode media or navigate except the two <img>', () => {
    const wrapper = mountDiff();

    expect(wrapper.findAll('img')).toHaveLength(2);
    for (const tag of ['canvas', 'object', 'embed', 'iframe', 'picture', 'source', 'video']) {
      expect(wrapper.findAll(tag)).toHaveLength(0);
    }
    // No "open raw" / "download" affordance anywhere.
    expect(wrapper.findAll('a')).toHaveLength(0);
  });

  test('no blob: or data: URL anywhere in the rendered tree', () => {
    const wrapper = mountDiff();
    for (const el of wrapper.element.querySelectorAll('*')) {
      for (const attr of ['src', 'href', 'style']) {
        const value = el.getAttribute(attr);
        if (value === null) continue;
        expect(value.startsWith('blob:')).toBe(false);
        expect(value.startsWith('data:')).toBe(false);
      }
    }
    expect(wrapper.html()).not.toContain('blob:');
    expect(wrapper.html()).not.toContain('data:');
  });
});
