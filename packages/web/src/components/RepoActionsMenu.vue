<script setup lang="ts">
/**
 * RepoActionsMenu: the header's compact popover for the branch / stash /
 * soft-reset operations (the ops the CLI backend supports but never bound
 * to keys). Same popover mechanics as RepoSwitcher: outside click or Esc
 * closes; not modal, so no focus trap.
 *
 * - Branch: local branches load fresh on every open (repo.listBranches);
 *   the current branch is marked and inert, picking another calls
 *   switchBranch. A name field + create calls createBranch (creates AND
 *   switches — daemon semantics).
 * - Stash: stash with an optional message; the live stash list
 *   (shared.stashList, from the SSE state) with a per-entry pop.
 * - Soft reset: count input (default 1) behind an inline confirm naming
 *   the count — it moves HEAD, so no single-click resets.
 *
 * Every action goes through the store's remote-op machine, so the header
 * status shows progress and the menu's buttons disable while one runs.
 * Triggering an action closes the menu — progress/result/error render in
 * the header's status slot, not in here.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import type { LocalBranch } from '@diffstalker/core/git/status';

const repo = useRepoStore();
const { remote, shared } = storeToRefs(repo);

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLElement | null>(null);

const branches = ref<LocalBranch[]>([]);
const branchesLoading = ref(false);
const branchesError = ref(false);
const newBranchName = ref('');
const stashMessage = ref('');
const resetCount = ref(1);
const confirmingReset = ref(false);

const busy = computed(() => remote.value.inProgress);
const stashList = computed(() => shared.value.stashList);

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  confirmingReset.value = false;
  void loadBranches();
}

/**
 * Close the panel. `refocus` returns focus to the trigger (disclosure
 * convention) — used on Esc and after an action; NOT on an outside
 * click (the user is focusing something else) or a repo switch.
 */
function close(refocus = false): void {
  open.value = false;
  if (refocus) triggerEl.value?.focus();
}

/** listBranches rethrows a DaemonError; keep the list empty + hint. */
async function loadBranches(): Promise<void> {
  branchesLoading.value = true;
  branchesError.value = false;
  try {
    branches.value = await repo.listBranches();
  } catch {
    branches.value = [];
    branchesError.value = true;
  } finally {
    branchesLoading.value = false;
  }
}

// Repo switched (follow mode or the switcher) while the menu is open:
// close it and drop ALL transient state — a stale branch list, a pending
// reset confirm, or typed inputs must never drive an action against the
// newly-active repo.
watch(
  () => [repo.repoId, repo.repoPath],
  () => {
    open.value = false;
    confirmingReset.value = false;
    newBranchName.value = '';
    stashMessage.value = '';
    resetCount.value = 1;
    branches.value = [];
    branchesError.value = false;
  }
);

// The action handlers close the menu FIRST, then run the store op —
// progress/result/error belong to the header status slot, not the menu.
// Store remote ops never reject (failures land in remote.error).

async function pickBranch(branch: LocalBranch): Promise<void> {
  if (branch.current) return;
  close(true);
  await repo.switchBranch(branch.name);
}

async function createBranch(): Promise<void> {
  const name = newBranchName.value.trim();
  if (name === '') return;
  newBranchName.value = '';
  close(true);
  await repo.createBranch(name);
}

async function stash(): Promise<void> {
  const message = stashMessage.value.trim();
  stashMessage.value = '';
  close(true);
  await repo.stash(message === '' ? undefined : message);
}

/** "stash@{N}" — built in script because {{ }} in a template can't nest }}. */
function stashRef(index: number): string {
  return `stash@{${index}}`;
}

async function popStash(index: number): Promise<void> {
  close(true);
  await repo.stashPop(index);
}

async function confirmReset(): Promise<void> {
  confirmingReset.value = false;
  close(true);
  await repo.softReset(resetCount.value);
}

/** Clamp the count field to a positive integer (the daemon 400s HEAD~N past the root). */
function sanitizedCount(): void {
  const n = Math.floor(Number(resetCount.value));
  resetCount.value = Number.isFinite(n) && n >= 1 ? n : 1;
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) {
    close();
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close(true);
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="rootEl" class="actions-menu">
    <button
      ref="triggerEl"
      class="trigger mono"
      data-testid="actions-trigger"
      aria-haspopup="true"
      :aria-expanded="open"
      :disabled="!repo.isRepo"
      title="Branch, stash, and reset operations"
      @click="toggle"
    >
      branch / stash <span class="caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel" data-testid="actions-panel">
      <!-- Branches -->
      <div class="group">
        <p class="group-label">Branches</p>
        <p v-if="branchesLoading && branches.length === 0" class="hint">loading branches…</p>
        <p v-else-if="branchesError" class="hint" data-testid="branches-error">
          couldn't load branches
        </p>
        <div v-else class="branch-list" data-testid="branch-list">
          <button
            v-for="branch in branches"
            :key="branch.name"
            class="row mono"
            :class="{ current: branch.current }"
            :disabled="branch.current || busy"
            :aria-current="branch.current ? 'true' : undefined"
            :title="branch.current ? `On ${branch.name}` : `Switch to ${branch.name}`"
            @click="pickBranch(branch)"
          >
            <span class="marker" aria-hidden="true">{{ branch.current ? '●' : '' }}</span>
            <span class="row-name">{{ branch.name }}</span>
            <span v-if="branch.tracking" class="row-meta">{{ branch.tracking }}</span>
          </button>
        </div>
        <form class="inline-form" data-testid="create-branch-form" @submit.prevent="createBranch">
          <input
            v-model="newBranchName"
            class="mono"
            data-testid="new-branch-name"
            type="text"
            placeholder="new branch name"
            aria-label="New branch name"
            :disabled="busy"
          />
          <button
            type="submit"
            class="do mono"
            data-testid="create-branch"
            :disabled="busy || newBranchName.trim() === ''"
            title="Create the branch and switch to it"
          >
            create
          </button>
        </form>
      </div>

      <!-- Stash -->
      <div class="group">
        <p class="group-label">Stash</p>
        <form class="inline-form" data-testid="stash-form" @submit.prevent="stash">
          <input
            v-model="stashMessage"
            class="mono"
            data-testid="stash-message"
            type="text"
            placeholder="message (optional)"
            aria-label="Stash message"
            :disabled="busy"
          />
          <button
            type="submit"
            class="do mono"
            data-testid="stash-save"
            :disabled="busy"
            title="Stash the working tree changes"
          >
            stash
          </button>
        </form>
        <div v-if="stashList.length" class="stash-list" data-testid="stash-list">
          <div v-for="entry in stashList" :key="entry.index" class="stash-row">
            <span class="stash-ref mono">{{ stashRef(entry.index) }}</span>
            <span class="stash-msg">{{ entry.message }}</span>
            <button
              class="do mono"
              :data-testid="`stash-pop-${entry.index}`"
              :disabled="busy"
              :title="`Pop stash@{${entry.index}} into the working tree`"
              @click="popStash(entry.index)"
            >
              pop
            </button>
          </div>
        </div>
        <p v-else class="hint">no stashes</p>
      </div>

      <!-- Soft reset -->
      <div class="group">
        <p class="group-label">Soft reset</p>
        <div v-if="!confirmingReset" class="inline-form">
          <input
            v-model.number="resetCount"
            class="mono count-input"
            data-testid="reset-count"
            type="number"
            min="1"
            step="1"
            aria-label="Commits to soft-reset"
            :disabled="busy"
            @change="sanitizedCount"
          />
          <button
            class="do mono"
            data-testid="reset-start"
            :disabled="busy"
            title="Soft-reset: moves HEAD back, keeps the changes staged"
            @click="((confirmingReset = true), sanitizedCount())"
          >
            soft reset…
          </button>
        </div>
        <div v-else class="confirm" data-testid="reset-confirm">
          <p class="confirm-text">
            Move HEAD back
            <strong class="mono">{{ resetCount }}</strong>
            commit{{ resetCount === 1 ? '' : 's' }}? The changes stay staged.
          </p>
          <div class="confirm-actions">
            <button class="do mono" data-testid="reset-cancel" @click="confirmingReset = false">
              cancel
            </button>
            <button
              class="do danger mono"
              data-testid="reset-go"
              :disabled="busy"
              @click="confirmReset"
            >
              reset
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.actions-menu {
  position: relative;
}

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  color: var(--text);
  white-space: nowrap;
}

.trigger:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.trigger:disabled {
  color: var(--text-dim);
}

.caret {
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.panel {
  position: absolute;
  top: calc(100% + 0.375rem);
  right: 0;
  z-index: 20;
  width: 20rem;
  max-width: 80vw;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.group-label {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.hint {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.branch-list {
  display: flex;
  flex-direction: column;
  max-height: 12rem;
  overflow-y: auto;
}

.row {
  display: grid;
  grid-template-columns: 0.75rem 1fr auto;
  align-items: baseline;
  gap: 0 0.375rem;
  padding: 0.25rem 0.25rem;
  border-radius: 4px;
  font-size: var(--fs-base);
  text-align: left;
}

.row:hover:not(:disabled) {
  background: var(--surface-raised);
}

.row.current {
  color: var(--accent);
}

.marker {
  font-size: var(--fs-micro);
}

.row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  font-size: var(--fs-micro);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 8rem;
}

.inline-form {
  display: flex;
  gap: 0.375rem;
  align-items: center;
}

.inline-form input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-small);
  padding: 0.25rem 0.375rem;
}

.count-input {
  flex: none;
  width: 3.5rem;
}

.do {
  flex: none;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  font-size: var(--fs-small);
}

.do:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.do:disabled {
  color: var(--text-dim);
}

.do.danger {
  color: var(--del);
}

.do.danger:hover:not(:disabled) {
  border-color: var(--del);
}

.stash-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 9rem;
  overflow-y: auto;
}

.stash-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-small);
}

.stash-ref {
  flex: none;
  color: var(--text-dim);
}

.stash-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.confirm-text {
  margin: 0;
  font-size: var(--fs-small);
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.375rem;
}
</style>
