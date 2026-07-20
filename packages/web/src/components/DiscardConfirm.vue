<script setup lang="ts">
/**
 * DiscardConfirm: the confirm dialog in front of a destructive discard —
 * the web analog of the CLI's DiscardConfirm modal. Two shapes, same as
 * the CLI: a tracked file's changes are discarded (checkout), an
 * untracked file is deleted from disk.
 *
 * Purely presentational: emits confirm/cancel, the caller runs the
 * mutation. y confirms, n/Escape cancels (CLI parity); focus starts on
 * the safe Cancel button and is trapped in the dialog.
 */

import { computed, ref } from 'vue';
import type { FileEntry } from '@diffstalker/core/git/status';
import { useFocusTrap } from '../composables/useFocusTrap';

const props = defineProps<{ file: FileEntry }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

const untracked = computed(() => props.file.status === 'untracked');

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'y' || event.key === 'Y') {
    event.preventDefault();
    emit('confirm');
  } else if (event.key === 'Escape' || event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    emit('cancel');
  }
}
</script>

<template>
  <div class="overlay-scrim" @click.self="emit('cancel')">
    <div
      ref="dialogEl"
      class="overlay-dialog discard-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="discard-question"
      tabindex="-1"
      data-testid="discard-confirm"
      @keydown="onKeydown"
    >
      <p class="eyebrow" :class="{ danger: untracked }">
        {{ untracked ? 'Delete file' : 'Discard changes' }}
      </p>
      <p id="discard-question" class="question mono" data-testid="discard-question">
        {{ untracked ? `Delete ${file.path}?` : `Discard changes to ${file.path}?` }}
      </p>
      <p class="note">
        {{
          untracked
            ? 'The file is untracked — this removes it from disk.'
            : 'This cannot be undone.'
        }}
      </p>
      <div class="actions">
        <button
          class="dialog-btn"
          data-autofocus
          data-testid="discard-cancel"
          @click="emit('cancel')"
        >
          cancel
        </button>
        <button
          class="dialog-btn danger"
          data-testid="discard-go"
          @click="emit('confirm')"
        >
          {{ untracked ? 'delete' : 'discard' }}
        </button>
      </div>
      <p class="keys">y confirms &middot; Esc cancels</p>
    </div>
  </div>
</template>

<style scoped>
.discard-dialog {
  width: min(34rem, calc(100vw - 2rem));
  padding: 1rem 1.25rem;
}

.eyebrow {
  margin: 0 0 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.eyebrow.danger {
  color: var(--del);
}

.question {
  margin: 0;
  font-size: var(--fs-content);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.note {
  margin: 0.375rem 0 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}

.dialog-btn {
  padding: 0.3125rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  font-family: var(--font-mono);
  font-size: var(--fs-base);
}

.dialog-btn:hover {
  border-color: var(--text-dim);
}

.dialog-btn.danger {
  color: var(--del);
}

.dialog-btn.danger:hover {
  border-color: var(--del);
}

.keys {
  margin: 0.75rem 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--text-dim);
  text-align: right;
}
</style>
