/**
 * SearchModes tests: the strip names all three search gestures with their
 * keys, marks the one you are in, and switches to the others by click —
 * the whole point being that none of it requires knowing a key first.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { nextTick, watch } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SearchModes from './SearchModes.vue';
import { useUiStore } from '../stores/ui';

function mountStrip(current: 'files' | 'contents'): VueWrapper {
  return mount(SearchModes, { props: { current } });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('what the strip says', () => {
  test('every gesture is named with the key that opens it', () => {
    const text = mountStrip('files').text().replace(/\s+/g, ' ');

    expect(text).toContain('Files Ctrl P');
    expect(text).toContain('Contents ⇧ F');
    expect(text).toContain('Outline o');
  });

  test('the mode you are in is the marked one', () => {
    const files = mountStrip('files');
    expect(files.find('[data-testid="mode-files"]').classes()).toContain('current');
    expect(files.find('[data-testid="mode-contents"]').classes()).not.toContain('current');

    const contents = mountStrip('contents');
    expect(contents.find('[data-testid="mode-contents"]').attributes('aria-current')).toBe('true');
    expect(contents.find('[data-testid="mode-files"]').attributes('aria-current')).toBeUndefined();
  });
});

describe('switching by click', () => {
  test('contents opens the search overlay', async () => {
    const ui = useUiStore();
    ui.openOverlay('finder');

    await mountStrip('files').find('[data-testid="mode-contents"]').trigger('click');

    expect(ui.activeOverlay).toBe('search');
  });

  test('files opens the finder overlay', async () => {
    const ui = useUiStore();
    ui.openOverlay('search');

    await mountStrip('contents').find('[data-testid="mode-files"]').trigger('click');

    expect(ui.activeOverlay).toBe('finder');
  });

  test('clicking the mode you are in changes nothing', async () => {
    const ui = useUiStore();
    ui.openOverlay('finder');
    ui.setOverlayQuery('stat');

    await mountStrip('files').find('[data-testid="mode-files"]').trigger('click');

    expect(ui.activeOverlay).toBe('finder');
    expect(ui.overlayQuery).toBe('stat');
  });

  test('outline closes the overlay and asks Explorer for it', async () => {
    const ui = useUiStore();
    ui.openOverlay('finder');
    const before = ui.outlineRequest;

    await mountStrip('files').find('[data-testid="mode-outline"]').trigger('click');
    await nextTick();

    // A popover beside the code, not a mode inside the modal.
    expect(ui.activeOverlay).toBe(null);
    expect(ui.activeView).toBe('explorer');
    expect(ui.outlineRequest).toBe(before + 1);
  });

  test('the view switch lands before the request', async () => {
    // The Explorer is what listens for the request, so it must exist by
    // the time the request fires. App.test.ts proves the popover actually
    // opens from another view; this pins the order the strip sets up.
    const ui = useUiStore();
    ui.setActiveView('changes');
    const order: string[] = [];
    const stopView = watch(
      () => ui.activeView,
      () => order.push('view')
    );
    const stopRequest = watch(
      () => ui.outlineRequest,
      () => order.push('request')
    );

    await mountStrip('files').find('[data-testid="mode-outline"]').trigger('click');
    await nextTick();

    expect(order).toEqual(['view', 'request']);
    stopView();
    stopRequest();
  });
});
