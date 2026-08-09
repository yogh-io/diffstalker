<script setup lang="ts">
/**
 * DirectoryPicker: browse the DAEMON's filesystem to pick a directory.
 *
 * The browsing has to happen server-side. A browser never learns a real
 * path from its own pickers — `<input webkitdirectory>` gives relative
 * names (and would enumerate every file in the tree), and
 * `showDirectoryPicker()` gives a handle with a bare name — so the one
 * thing the daemon needs, an absolute path on its machine, is exactly
 * what the platform will not provide. `GET /browse` lists one level, and
 * this walks it.
 *
 * Directories only, no files: the thing being chosen is a folder. A
 * directory that is itself a repo is marked, because the useful pick is
 * almost always its PARENT — the folder that holds the projects.
 */

import { computed, onMounted, ref } from 'vue';
import { shortenPath } from '@diffstalker/core/view/formatPath';
import { DiffstalkerClient } from '../api/client';
import { errorMessage } from '../api/errors';
import type { DirectoryEntry } from '@diffstalker/client';

const props = defineProps<{
  /** Where to start; falls back to the daemon's home when absent. */
  start?: string | null;
}>();

const emit = defineEmits<{ pick: [path: string]; cancel: [] }>();

const client = new DiffstalkerClient();

const current = ref<string>('');
const parent = ref<string | null>(null);
const entries = ref<DirectoryEntry[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);
/** Request counter: only the newest listing may write. Never rendered. */
let seq = 0;

/**
 * List a directory. A failure (removed, unreadable) keeps the listing
 * that is on screen and says why — walking into a dead directory should
 * not empty the picker and strand you.
 *
 * Every write is behind the sequence guard, the error and the spinner
 * included: on a slow mount, clicking a second folder means you want the
 * second one, so a late answer to the first must not land on top of it —
 * and must not switch the spinner off while the newer request runs.
 */
async function open(path?: string): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  try {
    const listing = await client.browse(path);
    if (mine !== seq) return;
    current.value = listing.path;
    parent.value = listing.parent;
    entries.value = listing.entries;
    error.value = null;
  } catch (err) {
    if (mine !== seq) return;
    error.value = errorMessage(err);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/**
 * The path as the bar shows it: ellipsized in the MIDDLE, not the end —
 * the folder you are standing in is the tail, and it is the one part that
 * must never be the bit that gets cut. (The obvious CSS trick for this,
 * `direction: rtl`, reorders the leading slash to the far end and renders
 * `/home/jorn` as `home/jorn/`.) Full path on hover.
 */
const currentLabel = computed(() => shortenPath(current.value, 52));

onMounted(async () => {
  const start = props.start ?? undefined;
  await open(start);
  // A typo in the field would otherwise open a dead box: no listing to
  // walk, ↑ and "Use this folder" both disabled, Cancel the only way out —
  // exactly what Browse… exists to avoid. Fall back to home, still saying
  // why the requested path did not open.
  if (start !== undefined && !current.value) {
    const why = error.value;
    await open();
    if (why) error.value = why;
  }
});
</script>

<template>
  <div class="picker" data-testid="directory-picker">
    <div class="bar">
      <button
        class="up chrome-chip"
        type="button"
        :disabled="parent === null || loading"
        aria-label="Parent directory"
        title="Parent directory"
        @click="open(parent ?? undefined)"
      >
        ↑
      </button>
      <span class="current mono" :title="current">{{ currentLabel || '…' }}</span>
      <button class="chrome-chip" type="button" @click="emit('cancel')">Cancel</button>
      <button
        class="use chrome-chip"
        type="button"
        :disabled="!current"
        @click="emit('pick', current)"
      >
        Use this folder
      </button>
    </div>

    <p v-if="error" class="picker-error mono">{{ error }}</p>
    <p v-if="loading" class="empty mono">Loading…</p>

    <ul v-if="entries.length" class="entries">
      <li v-for="entry in entries" :key="entry.path">
        <button type="button" class="entry" @click="open(entry.path)">
          <span class="entry-name mono">{{ entry.name }}</span>
          <span v-if="entry.isRepo" class="repo-tag mono">repo</span>
        </button>
      </li>
    </ul>
    <p v-else-if="!loading && !error" class="empty mono">no subdirectories</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.bar button {
  padding: 0.25rem 0.625rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
  white-space: nowrap;
}

.bar button:hover:not(:disabled) {
  color: var(--text);
}

.bar button:disabled {
  opacity: 0.5;
}

.use:hover:not(:disabled) {
  border-color: var(--accent);
}

.current {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 12rem;
  overflow-y: auto;
}

.entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.25rem 0.375rem;
  border-radius: 3px;
  text-align: left;
}

.entry:hover {
  background: var(--surface);
}

.entry-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-base);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-tag {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-dim);
}

.picker-error,
.empty {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.picker-error {
  color: var(--del);
}
</style>
