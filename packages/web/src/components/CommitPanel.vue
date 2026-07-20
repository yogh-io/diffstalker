<script setup lang="ts">
/**
 * CommitPanel: the compose area of the Changes view — message textarea,
 * amend checkbox, staged summary, commit button. Full parity with the
 * CLI's Commit tab (CommitPanel + CommitFlowState), web-native shape.
 *
 * - Ctrl/Cmd+Enter commits; plain Enter inserts a newline (a real
 *   textarea — no invisible-newline trap).
 * - Enablement mirrors core's validateCommit: an OPEN repo, a
 *   non-empty message AND (staged files OR amend). Without a repo
 *   (open in flight, open failed) commit is disabled — repo.commit
 *   would no-op and clearing the draft would be silent draft loss.
 * - Toggling amend with an empty message prefills from the daemon's
 *   head-message (subject only — fine). The prefill is tracked: while
 *   the user hasn't edited it, toggling amend OFF clears it again —
 *   an accidental toggle must not leave HEAD's message behind as an
 *   apparent draft for a NEW commit. Any user input makes the message
 *   a real draft (no longer cleared). A failed head-message fetch
 *   degrades to no prefill (CLI parity) — never an unhandled
 *   rejection.
 * - repo.commit never throws; a failure lands in shared.error. Success
 *   is therefore "no error after the envelope applied" — only then is
 *   the message cleared, so a failed commit keeps the draft. The
 *   textarea is disabled while committing so an in-flight edit cannot
 *   be silently wiped by that clear.
 */

import { computed, ref } from 'vue';
import { useRepoStore } from '../stores/repo';

const repo = useRepoStore();

const message = ref('');
const amend = ref(false);
const committing = ref(false);

/**
 * True while the message is an UNEDITED amend prefill (HEAD's message
 * we inserted, untouched). Cleared by any user input on the textarea;
 * programmatic writes (the prefill itself, clear-on-success) fire no
 * input event and leave it alone.
 */
const prefillActive = ref(false);

const stagedCount = computed(
  () => repo.shared.status?.files.filter((file) => file.staged).length ?? 0
);

const summary = computed(() => {
  const n = stagedCount.value;
  if (n === 0) return 'nothing staged';
  return n === 1 ? '1 file staged' : `${n} files staged`;
});

const canCommit = computed(
  () =>
    !committing.value &&
    repo.isRepo &&
    message.value.trim() !== '' &&
    (stagedCount.value > 0 || amend.value)
);

/** Button title AND the screen-reader hint: why it is disabled, or what pressing it does. */
const buttonTitle = computed(() => {
  if (committing.value) return 'Committing…';
  if (!repo.isRepo) return 'No repository open';
  if (message.value.trim() === '') return 'Write a commit message first';
  if (stagedCount.value === 0 && !amend.value) return 'Nothing staged to commit';
  return amend.value ? 'Amend the last commit' : 'Commit the staged changes';
});

const buttonLabel = computed(() => {
  if (committing.value) return 'committing…';
  return amend.value ? 'amend commit' : 'commit';
});

async function doCommit(): Promise<void> {
  if (!canCommit.value) return;
  committing.value = true;
  try {
    await repo.commit(message.value.trim(), amend.value);
    // The store collapses failures into shared.error instead of
    // throwing; a clean error line after the envelope applied means the
    // commit landed — clear the draft. On failure the draft stays.
    if (repo.shared.error === null) {
      message.value = '';
      amend.value = false;
      prefillActive.value = false;
    }
  } finally {
    committing.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void doCommit();
  }
}

/** Any user input: the message is now a real draft, not the prefill. */
function onMessageInput(): void {
  prefillActive.value = false;
}

/**
 * Amend toggled ON with an empty draft: prefill the HEAD message to
 * edit. Toggled OFF with the prefill still unedited: clear it — it
 * must not survive as an apparent draft for a NEW commit. A real
 * user-typed message is never clobbered in either direction.
 */
async function onAmendToggle(): Promise<void> {
  if (!amend.value) {
    if (prefillActive.value) {
      message.value = '';
      prefillActive.value = false;
    }
    return;
  }
  if (message.value.trim() !== '') return;
  let head: string;
  try {
    head = await repo.getHeadCommitMessage();
  } catch {
    // A DaemonError (e.g. a 404 on a stale id) degrades to no prefill,
    // matching the CLI — never an unhandled rejection from @change.
    return;
  }
  // Still relevant? (The user may have typed or untoggled meanwhile.)
  if (amend.value && message.value.trim() === '' && head !== '') {
    message.value = head;
    prefillActive.value = true;
  }
}
</script>

<template>
  <section class="commit-panel" aria-label="Commit">
    <h3 class="panel-header">Commit</h3>

    <textarea
      v-model="message"
      class="message mono"
      data-testid="commit-message"
      placeholder="Commit message"
      aria-label="Commit message"
      rows="6"
      :disabled="committing"
      @keydown="onKeydown"
      @input="onMessageInput"
    ></textarea>

    <label class="amend">
      <input
        v-model="amend"
        type="checkbox"
        data-testid="commit-amend"
        :disabled="committing"
        @change="onAmendToggle"
      />
      amend last commit
    </label>

    <p
      class="summary mono"
      :class="{ none: stagedCount === 0 }"
      data-testid="staged-summary"
    >
      {{ summary }}
    </p>

    <button
      class="commit-btn"
      data-testid="commit-button"
      :disabled="!canCommit"
      :title="buttonTitle"
      aria-describedby="commit-button-state"
      @click="doCommit"
    >
      {{ buttonLabel }}
    </button>
    <!-- The disabled reason for assistive tech; title alone is not surfaced. -->
    <span id="commit-button-state" class="sr-only" data-testid="commit-button-state">{{
      buttonTitle
    }}</span>

    <p class="hint">Ctrl+Enter or Cmd+Enter commits &middot; Enter adds a line</p>
  </section>
</template>

<style scoped>
.commit-panel {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  height: 100%;
  padding: 0.75rem;
  overflow-y: auto;
}

.panel-header {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.message {
  flex: none;
  width: 100%;
  min-height: 7.5rem;
  padding: 0.5rem;
  resize: vertical;
  font-size: var(--fs-base);
  line-height: 1.5;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.message::placeholder {
  color: var(--text-dim);
}

.message:focus-visible {
  outline: 2px solid var(--selection);
  outline-offset: 1px;
}

.amend {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--fs-base);
  cursor: pointer;
  user-select: none;
}

.amend input {
  margin: 0;
  accent-color: var(--selection);
}

.summary {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--add);
}

.summary.none {
  color: var(--text-dim);
}

.commit-btn {
  padding: 0.4375rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  font-weight: 600;
}

.commit-btn:hover:not(:disabled) {
  border-color: var(--add);
  color: var(--add);
}

.commit-btn:disabled {
  opacity: 0.55;
}

.hint {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--text-dim);
}

/* Visually hidden, still read by assistive tech. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
