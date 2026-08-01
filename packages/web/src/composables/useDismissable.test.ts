import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useDismissable } from './useDismissable';

/** The bit of the host we assert on; `expose` does not carry types through. */
interface HostVm {
  open: boolean;
}

/** Mounts the composable on a real element so outside-clicks are measurable. */
function mountHost() {
  const Host = defineComponent({
    setup(_, { expose }) {
      const { open, rootEl } = useDismissable();
      expose({ open });
      return () => h('div', { ref: rootEl }, [h('span', { class: 'inside' }, 'x')]);
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, vm: wrapper.vm as unknown as HostVm };
}

describe('useDismissable', () => {
  it('starts closed', () => {
    const { wrapper: w, vm } = mountHost();
    expect(vm.open).toBe(false);
    w.unmount();
  });

  it('closes on a mousedown outside the root', async () => {
    const { wrapper: w, vm } = mountHost();
    vm.open = true;
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(vm.open).toBe(false);
    w.unmount();
  });

  it('stays open on a mousedown inside the root', () => {
    const { wrapper: w, vm } = mountHost();
    vm.open = true;
    w.element.querySelector('.inside')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(vm.open).toBe(true);
    w.unmount();
  });

  it('closes on Escape', () => {
    const { wrapper: w, vm } = mountHost();
    vm.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(vm.open).toBe(false);
    w.unmount();
  });

  it('ignores keys other than Escape', () => {
    const { wrapper: w, vm } = mountHost();
    vm.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(vm.open).toBe(true);
    w.unmount();
  });

  it('removes both listeners on unmount', () => {
    const { wrapper: w, vm } = mountHost();
    vm.open = true;
    const stale = vm;
    w.unmount();
    // Nothing should still be listening: neither event may flip the old state.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(stale.open).toBe(true);
  });
});
