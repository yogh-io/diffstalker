<script setup lang="ts">
/**
 * The hover tooltip for any element with a `data-tip` attribute: shown at
 * once, just above the pointer, and following it. The native `title`
 * waits about a second and sits below the pointer. One element and three
 * document listeners for the whole app, so a page of hundreds of rows adds
 * nothing per row. Touch pointers get none; a click or a scroll hides it
 * until the pointer moves again.
 *
 * `data-tip` is not an accessible name: an icon-only button still needs
 * its own `aria-label`.
 */

import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

/** Space between the pointer and the tip, and between the tip and the window edge, px. */
const GAP = 12;
const EDGE = 8;

const text = shallowRef<string | null>(null);
const left = ref(0);
const top = ref(0);
const tipEl = ref<HTMLElement | null>(null);
let size = { width: 0, height: 0 };
let pointer = { x: 0, y: 0 };

function place(): void {
  const { width, height } = size;
  const maxLeft = window.innerWidth - width - EDGE;
  left.value = Math.max(EDGE, Math.min(pointer.x - width / 2, maxLeft));
  const above = pointer.y - height - GAP;
  top.value = above >= EDGE ? above : pointer.y + GAP * 2;
}

async function show(next: string): Promise<void> {
  if (next !== text.value) {
    text.value = next;
    await nextTick();
    const el = tipEl.value;
    size =
      el === null ? { width: 0, height: 0 } : { width: el.offsetWidth, height: el.offsetHeight };
  }
  place();
}

function hide(): void {
  text.value = null;
}

function onMove(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  pointer = { x: event.clientX, y: event.clientY };
  const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
  const tip = target?.getAttribute('data-tip') ?? '';
  if (tip === '') hide();
  else void show(tip);
}

onMounted(() => {
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerdown', hide, { passive: true });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', hide);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerdown', hide);
  document.removeEventListener('scroll', hide, { capture: true });
  document.documentElement.removeEventListener('pointerleave', hide);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="text !== null"
      ref="tipEl"
      class="hover-tip"
      role="tooltip"
      data-testid="hover-tip"
      :style="{ left: `${left}px`, top: `${top}px` }"
    >
      {{ text }}
    </div>
  </Teleport>
</template>

<style scoped>
.hover-tip {
  position: fixed;
  z-index: 1000;
  max-width: min(32rem, calc(100vw - 16px));
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
  font-size: var(--fs-small);
  line-height: 1.4;
  white-space: pre-line;
  overflow-wrap: anywhere;
  pointer-events: none;
}
</style>
