<script setup lang="ts">
/**
 * CopyPathButton: "copy path" — puts the repo-relative path of a diff
 * header on the clipboard. Sits next to ViewFileButton and is just as
 * self-contained: a path prop and nothing else.
 *
 * What it copies is exactly what the header shows (repo-relative), so
 * the gesture has no hidden translation step.
 */

import { ref, onBeforeUnmount } from 'vue';

const props = defineProps<{ path: string }>();

/** How long the copied/failed label stands in for "copy path". */
const FEEDBACK_MS = 1500;

const feedback = ref<'copied' | 'failed' | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

function flash(result: 'copied' | 'failed'): void {
  feedback.value = result;
  if (feedbackTimer !== null) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedback.value = null;
    feedbackTimer = null;
  }, FEEDBACK_MS);
}

onBeforeUnmount(() => {
  if (feedbackTimer !== null) clearTimeout(feedbackTimer);
});

/**
 * A rejected write is reported, not swallowed: the clipboard API is
 * missing outside a secure context (a daemon reached over plain http on
 * a LAN address), and a click that silently does nothing reads as a
 * broken UI.
 */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.path);
    flash('copied');
  } catch {
    flash('failed');
  }
}
</script>

<template>
  <button
    class="copy-path mono"
    data-testid="copy-path"
    :title="`Copy ${props.path} to the clipboard`"
    @click.stop="copy()"
  >
    {{ feedback === 'copied' ? 'copied' : feedback === 'failed' ? 'copy failed' : 'copy path' }}
  </button>
</template>

<style scoped>
/* Same shape as .view-file next to it: low-key until hovered, and zero
   block padding with a transparent border so the button measures
   shorter than the header's line box — dropping it into a header cannot
   change that header's height, which DiffStack's exact-height model
   measures once and assumes constant. */
.copy-path {
  flex: none;
  padding: 0 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  cursor: pointer;
  white-space: nowrap;
}

.copy-path:hover {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}
</style>
