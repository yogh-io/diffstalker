import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useDismissable } from './useDismissable';

/** Mounts the composable on a real element so outside-clicks are measurable. */
function mountHost() {
  const Host = defineComponent({
    setup(_, { expose }) {
      const { open, rootEl } = useDismissable();
      expose({ open });
      return () => h('div', { ref: rootEl }, [h('span', { class: 'inside' }, 'x')]);
    },
  });
  return mount(Host, { attachTo: document.body });
}

describe('useDismissable', () => {
  it('starts closed', () => {
    const w = mountHost();
    expect(w.vm.open).toBe(false);
    w.unmount();
  });

  it('closes on a mousedown outside the root', async () => {
    const w = mountHost();
    w.vm.open = true;
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(w.vm.open).toBe(false);
    w.unmount();
  });

  it('stays open on a mousedown inside the root', () => {
    const w = mountHost();
    w.vm.open = true;
    w.element.querySelector('.inside')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(w.vm.open).toBe(true);
    w.unmount();
  });

  it('closes on Escape', () => {
    const w = mountHost();
    w.vm.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.vm.open).toBe(false);
    w.unmount();
  });

  it('ignores keys other than Escape', () => {
    const w = mountHost();
    w.vm.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(w.vm.open).toBe(true);
    w.unmount();
  });

  it('removes both listeners on unmount', () => {
    const w = mountHost();
    w.vm.open = true;
    const stale = w.vm;
    w.unmount();
    // Nothing should still be listening: neither event may flip the old state.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(stale.open).toBe(true);
  });
});
