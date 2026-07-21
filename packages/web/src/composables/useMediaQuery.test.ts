/**
 * useMediaQuery tests: reactive matchMedia wrapper — initial value,
 * live change events, listener cleanup on unmount, and graceful
 * degradation when matchMedia is missing or listener-less.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useMediaQuery, usePortrait, PORTRAIT_QUERY } from './useMediaQuery';
import type { Ref } from 'vue';

type ChangeListener = (event: { matches: boolean }) => void;

/** A controllable MediaQueryList fake. */
function makeMql(matches: boolean) {
  const listeners: ChangeListener[] = [];
  return {
    matches,
    media: '',
    addEventListener: (_type: string, listener: ChangeListener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: ChangeListener) => {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    dispatch(next: boolean) {
      this.matches = next;
      for (const listener of [...listeners]) listener({ matches: next });
    },
    listenerCount: () => listeners.length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMediaQuery', () => {
  test('reads the initial match and follows change events', () => {
    const mql = makeMql(true);
    vi.stubGlobal('matchMedia', vi.fn(() => mql));

    const matches = useMediaQuery('(orientation: portrait)');
    expect(matches.value).toBe(true);

    mql.dispatch(false);
    expect(matches.value).toBe(false);
    mql.dispatch(true);
    expect(matches.value).toBe(true);
  });

  test('removes its listener when the owning component unmounts', () => {
    const mql = makeMql(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mql));

    const Host = defineComponent({
      setup() {
        useMediaQuery('(orientation: portrait)');
        return () => h('div');
      },
    });
    const wrapper = mount(Host);
    expect(mql.listenerCount()).toBe(1);
    wrapper.unmount();
    expect(mql.listenerCount()).toBe(0);
  });

  test('degrades to false without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(useMediaQuery('(orientation: portrait)').value).toBe(false);
  });

  test('a listener-less matchMedia stub still yields a one-shot value', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, media: '' }))
    );
    expect(useMediaQuery('(orientation: portrait)').value).toBe(true);
  });

  test('usePortrait queries the ONE portrait trigger', () => {
    const spy = vi.fn((query: string) => ({ matches: false, media: query }));
    vi.stubGlobal('matchMedia', spy);
    const portrait: Ref<boolean> = usePortrait();
    expect(portrait.value).toBe(false);
    expect(spy).toHaveBeenCalledWith(PORTRAIT_QUERY);
    expect(PORTRAIT_QUERY).toBe('(orientation: portrait), (max-aspect-ratio: 1/1)');
  });
});
