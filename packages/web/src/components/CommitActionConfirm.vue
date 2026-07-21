<script setup lang="ts">
/**
 * CommitActionConfirm: the confirm dialog in front of a cherry-pick or
 * revert — the web analog of the CLI's CommitActionConfirm modal. Names
 * the verb and the commit (shortHash + message) so the user confirms the
 * exact thing that is about to happen.
 *
 * Purely presentational: emits confirm/cancel, the caller runs the
 * mutation. y confirms, n/Escape cancels (CLI parity); focus starts on
 * the safe Cancel button and is trapped in the dialog. `fallbackFocus`
 * is where focus lands on close when the opener can't take it back
 * (a confirm disables the trigger before this dialog unmounts).
 */

import { ref } from 'vue';
import type { CommitInfo } from '@diffstalker/core/git/status';
import { useFocusTrap } from '../composables/useFocusTrap';

const props = defineProps<{
  verb: 'cherry-pick' | 'revert';
  commit: CommitInfo;
  fallbackFocus?: HTMLElement | null;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl, { fallback: () => props.fallbackFocus ?? null });

function onKeydown(event: KeyboardEvent): void {
  // A held modifier means a different chord (Ctrl+Y etc.), not the
  // confirm/cancel shortcut — never confirm on those.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
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
      class="overlay-dialog action-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="commit-action-question"
      tabindex="-1"
      data-testid="commit-action-confirm"
      @keydown="onKeydown"
    >
      <p class="eyebrow">{{ verb }} commit</p>
      <p id="commit-action-question" class="question" data-testid="commit-action-question">
        {{ verb === 'cherry-pick' ? 'Cherry-pick this commit?' : 'Revert this commit?' }}
      </p>
      <p class="commit-line mono" data-testid="commit-action-commit">
        <span class="hash">{{ commit.shortHash }}</span> {{ commit.message }}
      </p>
      <p class="note">
        {{
          verb === 'cherry-pick'
            ? 'Applies the commit onto the current branch as a new commit.'
            : 'Creates a new commit undoing its changes.'
        }}
      </p>
      <div class="actions">
        <button
          class="dialog-btn"
          data-autofocus
          data-testid="commit-action-cancel"
          @click="emit('cancel')"
        >
          cancel
        </button>
        <button class="dialog-btn go" data-testid="commit-action-go" @click="emit('confirm')">
          {{ verb }}
        </button>
      </div>
      <p class="keys">y confirms &middot; Esc cancels</p>
    </div>
  </div>
</template>

<style scoped>
.action-dialog {
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
  color: var(--warn);
}

.question {
  margin: 0;
  font-size: var(--fs-content);
  font-weight: 600;
}

.commit-line {
  margin: 0.5rem 0 0;
  font-size: var(--fs-base);
  overflow-wrap: anywhere;
}

.commit-line .hash {
  color: var(--selection);
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

.dialog-btn.go {
  color: var(--warn);
}

.dialog-btn.go:hover {
  border-color: var(--warn);
}

.keys {
  margin: 0.75rem 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--text-dim);
  text-align: right;
}
</style>
