import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useActiveRowScroll } from './useActiveRowScroll';

/**
 * jsdom/happy-dom report zero rects, so the geometry is stubbed: the scroller
 * is a 0..100 window and the row is placed relative to it. What is under test
 * is the decision logic and the suppression ordering, not the browser's layout.
 */
function box(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top } as DOMRect;
}

function setup(rowTop: number, rowBottom: number) {
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => box(0, 100);
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });

  const row = document.createElement('div');
  row.getBoundingClientRect = () => box(rowTop, rowBottom);

  const key = ref(0);
  let handlers!: ReturnType<typeof useActiveRowScroll>;
  const Host = defineComponent({
    setup() {
      handlers = useActiveRowScroll(
        ref(scroller),
        () => key.value,
        () => row
      );
      return () => h('div');
    },
  });
  const wrapper = mount(Host);
  return { scroller, key, wrapper, get handlers() { return handlers; } };
}

describe('useActiveRowScroll', () => {
  it('scrolls up when the row is above the viewport', async () => {
    const t = setup(-30, -10);
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(-30); // inner.top - outer.top
    t.wrapper.unmount();
  });

  it('scrolls down when the row is below the viewport', async () => {
    const t = setup(120, 140);
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(40); // inner.bottom - outer.bottom
    t.wrapper.unmount();
  });

  it('leaves a fully visible row alone', async () => {
    const t = setup(20, 40);
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(0);
    t.wrapper.unmount();
  });

  it('suppresses the scroll while the pointer is in the list', async () => {
    const t = setup(120, 140);
    t.handlers.onPointerEnter();
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(0);
    t.wrapper.unmount();
  });

  it('resumes after the pointer leaves', async () => {
    const t = setup(120, 140);
    t.handlers.onPointerEnter();
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(0);

    t.handlers.onPointerLeave();
    t.key.value++;
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(40);
    t.wrapper.unmount();
  });

  /**
   * The ordering invariant: the suppression is read when the watch callback
   * runs, and a suppressed change schedules NOTHING. So a pointerleave after
   * that point cannot release a deferred scroll — there is none to release,
   * and the row the user declined to jump to stays where it is until the next
   * change.
   *
   * (A leave in the SAME tick as the change is a different case and does
   * scroll: Vue queues the callback, so the leave lands before it runs and the
   * user is no longer pointing at the list by the time the decision is made.
   * That is correct, and the test below pins it so the distinction is not
   * "fixed" by accident.)
   */
  it('schedules nothing while suppressed, so a later leave cannot release it', async () => {
    const t = setup(120, 140);
    t.handlers.onPointerEnter();
    t.key.value++;
    await nextTick(); // the watch callback runs here and returns early
    t.handlers.onPointerLeave();
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(0);
    t.wrapper.unmount();
  });

  it('still scrolls when the pointer leaves in the same tick as the change', async () => {
    const t = setup(120, 140);
    t.handlers.onPointerEnter();
    t.key.value++;
    t.handlers.onPointerLeave(); // before the queued callback runs
    await nextTick();
    await nextTick();
    expect(t.scroller.scrollTop).toBe(40);
    t.wrapper.unmount();
  });

  it('does nothing when the row cannot be resolved', async () => {
    const scroller = document.createElement('div');
    scroller.getBoundingClientRect = () => box(0, 100);
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });
    const key = ref(0);
    const Host = defineComponent({
      setup() {
        useActiveRowScroll(ref(scroller), () => key.value, () => null);
        return () => h('div');
      },
    });
    const w = mount(Host);
    key.value++;
    await nextTick();
    await nextTick();
    expect(scroller.scrollTop).toBe(0);
    w.unmount();
  });
});
