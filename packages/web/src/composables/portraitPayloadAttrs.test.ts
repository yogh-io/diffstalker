import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { portraitPayloadAttrs } from './usePortraitKeys';

describe('portraitPayloadAttrs', () => {
  it('emits the region attributes only in portrait', () => {
    const isPortrait = ref(false);
    const el = ref<HTMLElement | null>(null);
    const attrs = portraitPayloadAttrs(isPortrait, el, 'File diffs');

    expect(attrs.value.tabindex).toBeUndefined();
    expect(attrs.value.role).toBeUndefined();
    expect(attrs.value['aria-label']).toBeUndefined();

    isPortrait.value = true;
    expect(attrs.value.tabindex).toBe(0);
    expect(attrs.value.role).toBe('region');
    expect(attrs.value['aria-label']).toBe('File diffs');
  });

  /**
   * Vue calls setAttribute(key, value) verbatim, so an `ariaLabel` key would
   * emit `arialabel` and silently drop the accessible name. Assert the exact
   * kebab spelling — this failure is invisible in the rendered UI.
   */
  it('uses the kebab aria-label key, not a camelCase one', () => {
    const isPortrait = ref(true);
    const attrs = portraitPayloadAttrs(isPortrait, ref(null), 'Commit diff');
    expect(Object.keys(attrs.value)).toContain('aria-label');
    expect(Object.keys(attrs.value)).not.toContain('ariaLabel');
  });

  it('always carries a keydown handler, in both layouts', () => {
    const isPortrait = ref(false);
    const attrs = portraitPayloadAttrs(isPortrait, ref(null), 'x');
    expect(typeof attrs.value.onKeydown).toBe('function');
    isPortrait.value = true;
    expect(typeof attrs.value.onKeydown).toBe('function');
  });

  it('keeps one stable handler identity across re-evaluation', () => {
    const isPortrait = ref(false);
    const attrs = portraitPayloadAttrs(isPortrait, ref(null), 'x');
    const first = attrs.value.onKeydown;
    isPortrait.value = true;
    expect(attrs.value.onKeydown).toBe(first);
  });

  it('scrolls the payload on j/k in portrait, and ignores them otherwise', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    const isPortrait = ref(false);
    const attrs = portraitPayloadAttrs(isPortrait, ref(el), 'x', { self: true });

    attrs.value.onKeydown!(new KeyboardEvent('keydown', { key: 'j' }));
    expect(el.scrollTop).toBe(0); // landscape: inert

    isPortrait.value = true;
    attrs.value.onKeydown!(new KeyboardEvent('keydown', { key: 'j' }));
    expect(el.scrollTop).toBeGreaterThan(0);
    const down = el.scrollTop;
    attrs.value.onKeydown!(new KeyboardEvent('keydown', { key: 'k' }));
    expect(el.scrollTop).toBeLessThan(down);
  });
});
