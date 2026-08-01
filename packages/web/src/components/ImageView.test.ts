/**
 * ImageView (and, through it, ImageFrame): the Explorer's picture viewer.
 *
 * Two things are under test. The first is behaviour: the src is exactly what
 * blobUrl builds, the frame starts in loading, a decode failure emits `fail`
 * and takes the <img> out of the DOM, and the 1:1 toggle flips the stage.
 *
 * The second is the security shape, and it is the reason this file exists at
 * all. Repo bytes may reach the page ONLY as an `<img src>` pointing at a
 * relative same-origin URL. The structural test at the bottom asserts that
 * negatively — no canvas, no object/embed/iframe, no picture/source, no
 * video, and no `blob:` or `data:` anywhere — so a future edit that reaches
 * for URL.createObjectURL or a canvas fails here instead of in review.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { FileMedia } from '@diffstalker/client';
import ImageView from './ImageView.vue';
import { useRepoStore } from '../stores/repo';
import { blobUrl } from '../api/client';

const PNG: FileMedia = {
  image: { format: 'png', mime: 'image/png', width: 320, height: 200, bytes: 4096 },
  refusal: null,
  version: '4096-1712345678000',
};

function mountView(media: FileMedia = PNG, path = 'assets/logo.png') {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  return mount(ImageView, { props: { path, media } });
}

/**
 * happy-dom never decodes anything, so an <img> reports naturalWidth 0
 * forever. Define real intrinsics before firing `load` to model a browser
 * that actually produced pixels; leave them alone to model one that did not.
 */
function setIntrinsic(wrapper: VueWrapper, width: number, height: number): void {
  const img = wrapper.find('[data-testid="image"]').element;
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
}

async function load(wrapper: VueWrapper, width = 320, height = 200): Promise<void> {
  setIntrinsic(wrapper, width, height);
  await wrapper.find('[data-testid="image"]').trigger('load');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('the source', () => {
  test('src is exactly what blobUrl builds, version included', () => {
    const wrapper = mountView();
    expect(wrapper.find('[data-testid="image"]').attributes('src')).toBe(
      blobUrl('r1', { path: 'assets/logo.png', side: 'worktree', version: PNG.version })
    );
  });

  test('the src is relative and same-origin', () => {
    const wrapper = mountView();
    expect(wrapper.find('[data-testid="image"]').attributes('src')).toMatch(/^\/repos\/r1\/blob\?/);
  });

  test('a path with characters that would break a query is encoded', () => {
    const wrapper = mountView(PNG, 'a b/c&d?e.png');
    const src = wrapper.find('[data-testid="image"]').attributes('src')!;
    expect(src).toBe(
      blobUrl('r1', { path: 'a b/c&d?e.png', side: 'worktree', version: PNG.version })
    );
    expect(src).toContain('path=a%20b%2Fc%26d%3Fe.png');
  });

  test('the loading, decoding, referrer and intrinsic-size attributes are set', () => {
    const img = mountView().find('[data-testid="image"]');
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
    expect(img.attributes('referrerpolicy')).toBe('no-referrer');
    expect(img.attributes('draggable')).toBe('false');
    expect(img.attributes('width')).toBe('320');
    expect(img.attributes('height')).toBe('200');
  });

  test('alt is a static constant and never leaks the repo path', () => {
    const wrapper = mountView(PNG, 'secret/dir/logo.png');
    const alt = wrapper.find('[data-testid="image"]').attributes('alt')!;
    expect(alt).toBe('Image preview');
    expect(alt).not.toContain('secret');
    expect(alt).not.toContain('logo.png');
  });
});

describe('the load machine', () => {
  test('starts in loading: the note shows and the image is not ready yet', () => {
    const wrapper = mountView();
    expect(wrapper.find('[data-testid="image-loading"]').text()).toBe('Loading…');
    expect(wrapper.find('[data-testid="image"]').classes()).not.toContain('ready');
    expect(wrapper.find('[data-testid="image-failed"]').exists()).toBe(false);
  });

  test('a real load reveals the image, drops the note and emits nothing', async () => {
    const wrapper = mountView();
    await load(wrapper);

    expect(wrapper.find('[data-testid="image"]').classes()).toContain('ready');
    expect(wrapper.find('[data-testid="image-loading"]').exists()).toBe(false);
    expect(wrapper.emitted('fail')).toBeUndefined();
  });

  test('an error emits fail AND removes the <img> from the DOM', async () => {
    const wrapper = mountView();
    await wrapper.find('[data-testid="image"]').trigger('error');

    expect(wrapper.emitted('fail')).toHaveLength(1);
    // Not merely hidden: a hidden broken image still exposes its alt text.
    expect(wrapper.find('[data-testid="image"]').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="image-failed"]').text()).toBe('Preview failed to decode');
  });

  test('a load that decoded no pixels counts as a failure', async () => {
    const wrapper = mountView();
    // naturalWidth stays 0 — a degenerate decode, not a hostile one. The
    // per-serve re-sniff in the daemon is the security control; this is not.
    await wrapper.find('[data-testid="image"]').trigger('load');

    expect(wrapper.emitted('fail')).toHaveLength(1);
    expect(wrapper.find('img').exists()).toBe(false);
  });

  test('a new version changes the src and resets the frame to loading', async () => {
    const wrapper = mountView();
    await load(wrapper);
    expect(wrapper.find('[data-testid="image"]').classes()).toContain('ready');

    await wrapper.setProps({ media: { ...PNG, version: '4096-1799999999000' } });

    const img = wrapper.find('[data-testid="image"]');
    expect(img.attributes('src')).toContain('v=4096-1799999999000');
    expect(img.classes()).not.toContain('ready');
    expect(wrapper.find('[data-testid="image-loading"]').exists()).toBe(true);
  });

  test('a new version gives a previously failed frame another chance', async () => {
    const wrapper = mountView();
    await wrapper.find('[data-testid="image"]').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);

    await wrapper.setProps({ media: { ...PNG, version: 'later' } });
    expect(wrapper.find('[data-testid="image"]').exists()).toBe(true);
  });
});

describe('the 1:1 toggle', () => {
  test('flips the stage class and the pressed state', async () => {
    const wrapper = mountView();
    const toggle = wrapper.find('[data-testid="image-fit-toggle"]');

    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="image-frame"]').classes()).toContain('fit');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-testid="image-frame"]').classes()).toContain('actual');
    expect(wrapper.find('[data-testid="image-frame"]').classes()).not.toContain('fit');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="image-frame"]').classes()).toContain('fit');
  });

  test('the preference survives a switch to another image', async () => {
    const wrapper = mountView();
    await wrapper.find('[data-testid="image-fit-toggle"]').trigger('click');

    // No :key on the frame, so image-to-image navigation keeps the choice.
    await wrapper.setProps({ path: 'assets/other.png', media: { ...PNG, version: 'other' } });

    expect(wrapper.find('[data-testid="image-fit-toggle"]').attributes('aria-pressed')).toBe(
      'true'
    );
    expect(wrapper.find('[data-testid="image-frame"]').classes()).toContain('actual');
  });
});

describe('the stage', () => {
  test('is a focusable, labelled group so 1:1 can be panned by keyboard', () => {
    const stage = mountView().find('[data-testid="image-frame"]');
    expect(stage.attributes('tabindex')).toBe('0');
    expect(stage.attributes('role')).toBe('group');
    expect(stage.attributes('aria-label')).toBe('Image preview');
  });
});

describe('the transport shape', () => {
  test('exactly one <img> and nothing else that can decode or navigate', async () => {
    const wrapper = mountView();
    await load(wrapper);

    expect(wrapper.findAll('img')).toHaveLength(1);

    // Every element that could decode media, host a document, or offer a
    // second source. None of these may ever appear in an image surface.
    for (const tag of ['canvas', 'object', 'embed', 'iframe', 'picture', 'source', 'video']) {
      expect(wrapper.findAll(tag)).toHaveLength(0);
    }

    // No "open raw" / "download" affordance: a top-level navigation to repo
    // bytes is the threat this design exists to prevent.
    expect(wrapper.findAll('a')).toHaveLength(0);
  });

  test('no blob: or data: URL anywhere in the rendered tree', async () => {
    const wrapper = mountView();
    await load(wrapper);

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
