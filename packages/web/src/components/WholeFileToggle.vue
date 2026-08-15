<script setup lang="ts">
/**
 * WholeFileToggle: "whole file" — draw this one file in full, every line
 * numbered, with the changed lines marked in place, instead of the
 * hunks-plus-three-lines the diff normally shows.
 *
 * Unlike ViewFileButton and CopyPathButton (self-contained, store-reading,
 * path-only), this one takes props and emits. Which fetch to fire is a
 * property of the SURFACE, not of the path: Changes compares index against
 * the working tree, Compare compares a merge-base against HEAD, History a
 * commit against its parent. The owner knows the pair; a path does not.
 *
 * The ref pair is never picked here, or anywhere. It is inherited from the
 * view — see docs/whole-file-mode.md.
 */

defineProps<{
  /** Whole-file mode is on for this file. */
  on: boolean;
  /** The wide-context diff is being fetched. */
  busy?: boolean;
  /** Nothing to widen (binary, image, untracked, withheld large diff). */
  disabled?: boolean;
  /** Why it is disabled, for the title. */
  disabledReason?: string;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    class="whole-file mono"
    data-testid="whole-file"
    :class="{ on }"
    :disabled="disabled || busy"
    :aria-pressed="on"
    :title="
      disabled
        ? (disabledReason ?? 'This file has no wider view')
        : on
          ? 'Back to hunks'
          : 'Show the whole file, with the changes marked'
    "
    @click.stop="$emit('toggle')"
  >
    {{ busy ? 'loading…' : on ? 'hunks' : 'whole file' }}
  </button>
</template>

<style scoped>
/* Same contract as ViewFileButton and CopyPathButton, and it is load
   bearing: zero block padding and a transparent border keep the button
   measuring SHORTER than the header's own line box, so dropping it in
   cannot change the header's height. DiffStack measures one header once
   and applies that number to every section in the stack — a taller header
   anywhere mis-tops everything below it. The label swaps between
   "whole file", "hunks" and "loading…" for the same reason it never
   wraps: all three are one line at the same size. */
.whole-file {
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

.whole-file:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}

/* On: reads as engaged without a second colour in a header that already
   carries a status letter and +/- counts. */
.whole-file.on {
  color: var(--text);
  border-color: var(--border);
}

.whole-file:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
