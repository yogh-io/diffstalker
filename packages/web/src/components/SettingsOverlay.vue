<script setup lang="ts">
/**
 * SettingsOverlay (`,`): the settings panel.
 *
 * Two kinds of setting share it, and the difference is stated in the UI
 * rather than left to be discovered: **Appearance** is this browser's
 * (localStorage, per-device), **Repositories** is the daemon's (one file
 * on the machine, shared by every client, survives a restart).
 *
 * The watch directories are the substance here. A directory the user
 * keeps projects in is scanned for git repos, which then appear in the
 * repo switcher ready to open — the browser cannot browse a filesystem,
 * so this is what replaces typing an absolute path every time.
 *
 * The panel never invents a root: a path is only listed once the daemon
 * has accepted it, and a refusal (relative, missing, not a directory)
 * shows the daemon's own reason under the field.
 */

import { computed, onMounted, ref } from 'vue';
import { useUiStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useFocusTrap } from '../composables/useFocusTrap';
import DirectoryPicker from './DirectoryPicker.vue';
import { themeOrder, themes, isThemeName } from '../theme/themes';

const ui = useUiStore();
const settings = useSettingsStore();

const dialogEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

const newRoot = ref('');
/** Whether the daemon-side directory browser is open under the field. */
const browsing = ref(false);

/**
 * Re-walk on open: the watchers keep the SET of repos current, but they
 * deliberately do not look inside a repo's .git, so a branch label can be
 * stale after a checkout elsewhere. A scan is filesystem-only.
 */
onMounted(() => {
  // A refusal from a previous visit would otherwise sit under an empty
  // field, complaining about a path nobody is typing any more.
  settings.clearSaveError();
  void settings.rescan();
});

/** Scan result per configured root, in the order they were configured. */
const rows = computed(() =>
  settings.watchRoots.map((path) => {
    const state = settings.roots.find((root) => root.path === path);
    return {
      path,
      repoCount: state?.repos.length ?? 0,
      error: state?.error ?? null,
      capped: state?.capped ?? false,
      /** No scan result yet — the daemon is still walking it. */
      pending: state === undefined,
    };
  })
);

function onThemeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isThemeName(value)) ui.setTheme(value);
}

async function addRoot(): Promise<void> {
  const path = newRoot.value.trim();
  if (!path || settings.saving) return;
  if (await settings.addWatchRoot(path)) newRoot.value = '';
}

/**
 * A folder picked in the browser is added straight away — picking it IS
 * the confirmation, and it came from the daemon's own listing, so there
 * is nothing left to type or correct. Only a refusal (a directory that
 * vanished between the listing and the save) leaves the picker open.
 */
async function pickRoot(path: string): Promise<void> {
  if (await settings.addWatchRoot(path)) {
    browsing.value = false;
    newRoot.value = '';
  }
}

/**
 * Escape backs out of the directory browser first; the panel and the
 * typed path stay. Without this the global key layer takes the whole
 * overlay down in one keystroke. preventDefault is the handshake —
 * useGlobalKeys returns early on an already-handled event.
 *
 * It lives on the dialog, not inside DirectoryPicker: the picker's root
 * is not focusable, and focus usually still sits on the Browse… button,
 * so a handler in there would never see the key.
 */
function onEscape(event: KeyboardEvent): void {
  if (!browsing.value) return;
  event.preventDefault();
  browsing.value = false;
}

function removeRoot(path: string): void {
  void settings.removeWatchRoot(path);
}
</script>

<template>
  <div class="overlay-scrim" data-testid="settings-overlay" @click.self="ui.closeOverlay()">
    <div
      ref="dialogEl"
      class="overlay-dialog settings"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      @keydown.esc="onEscape"
    >
      <header class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <button
          class="settings-close"
          data-autofocus
          data-testid="settings-close"
          aria-label="Close"
          @click="ui.closeOverlay()"
        >
          ×
        </button>
      </header>

      <div class="settings-body">
        <section class="settings-section">
          <h3 class="section-title eyebrow">Appearance</h3>
          <p class="section-note">Stored in this browser.</p>
          <div class="field-row">
            <label for="settings-theme">Theme</label>
            <select id="settings-theme" :value="ui.theme" @change="onThemeChange">
              <option v-for="name in themeOrder" :key="name" :value="name">
                {{ themes[name].displayName }}
              </option>
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="section-title eyebrow">Repositories</h3>
          <p class="section-note">
            Stored by the daemon, on its machine — every client sees the same list.
            <span v-if="!settings.persisted" class="warn">
              This daemon is not saving settings to disk; they last until it stops.
            </span>
          </p>

          <h4 class="field-title">Watch directories</h4>
          <p class="field-help">
            A folder you keep projects in. Every git repository directly inside it — or one level
            further down — shows up in the repo switcher, ready to open.
          </p>

          <ul v-if="rows.length" class="root-list" data-testid="watch-roots">
            <li v-for="row in rows" :key="row.path" class="root-row">
              <div class="root-main">
                <span class="root-path mono" :title="row.path">{{ row.path }}</span>
                <span v-if="row.error" class="root-status error mono">{{ row.error }}</span>
                <span v-else-if="row.pending" class="root-status mono">scanning…</span>
                <span v-else class="root-status mono">
                  {{ row.repoCount }} {{ row.repoCount === 1 ? 'repo' : 'repos' }}
                  <span v-if="row.capped" class="warn">(list capped)</span>
                </span>
              </div>
              <button
                class="root-remove chrome-chip"
                :disabled="settings.saving"
                :aria-label="`Stop watching ${row.path}`"
                @click="removeRoot(row.path)"
              >
                Remove
              </button>
            </li>
          </ul>
          <p v-else class="field-help empty">No watch directories yet.</p>

          <form class="add-form" @submit.prevent="addRoot">
            <label class="visually-hidden" for="settings-new-root">
              Directory to watch, absolute on the daemon's machine
            </label>
            <input
              id="settings-new-root"
              v-model="newRoot"
              class="mono"
              type="text"
              placeholder="/home/you/projects"
              spellcheck="false"
              autocomplete="off"
            />
            <button
              type="button"
              class="browse-btn chrome-chip"
              data-testid="settings-browse"
              :disabled="settings.saving"
              @click="browsing = !browsing"
            >
              Browse…
            </button>
            <button
              type="submit"
              class="add-btn chrome-chip"
              :disabled="settings.saving || !newRoot.trim()"
            >
              Add
            </button>
          </form>

          <!-- Keyed on `browsing` so re-opening always starts a fresh walk
               from the typed path (or home), never where it was left. -->
          <DirectoryPicker
            v-if="browsing"
            class="picker-slot"
            :start="newRoot.trim() || null"
            @pick="pickRoot"
            @cancel="browsing = false"
          />
          <p v-if="settings.saveError" class="form-error mono" data-testid="settings-error">
            {{ settings.saveError }}
          </p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: min(38rem, calc(100vw - 2rem));
  /* The scrim already pushes the dialog down by clamp(2rem, 12vh, 8rem),
     which a flat `100vh - 4rem` never subtracted — on a short window the
     foot of the panel sat below a scrim that has no overflow, clipped
     with nothing able to scroll to it. */
  max-height: calc(100dvh - clamp(2rem, 12vh, 8rem) - 2rem);
  display: flex;
  flex-direction: column;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.settings-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}

.settings-close {
  padding: 0 0.375rem;
  font-size: var(--fs-title);
  line-height: 1;
  color: var(--text-dim);
  border-radius: 4px;
}

.settings-close:hover {
  color: var(--text);
}

.settings-body {
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.section-title {
  margin: 0 0 0.25rem;
  font-weight: 500;
}

.section-note {
  margin: 0 0 0.75rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.warn {
  color: var(--del);
}

.field-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: var(--fs-base);
}

.field-title {
  margin: 0 0 0.25rem;
  font-size: var(--fs-base);
  font-weight: 600;
}

.field-help {
  margin: 0 0 0.625rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.field-help.empty {
  font-style: italic;
}

.root-list {
  list-style: none;
  margin: 0 0 0.625rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.root-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
}

.root-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.root-path {
  font-size: var(--fs-base);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-status {
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.root-status.error {
  color: var(--del);
}

.root-remove {
  padding: 0.25rem 0.625rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
  white-space: nowrap;
}

.root-remove:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--del);
}

.add-form {
  display: flex;
  gap: 0.5rem;
}

.add-form input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-base);
}

.add-btn,
.browse-btn {
  padding: 0.375rem 0.875rem;
  white-space: nowrap;
}

.browse-btn {
  color: var(--text-dim);
}

.browse-btn:hover:not(:disabled) {
  color: var(--text);
}

.picker-slot {
  margin-top: 0.5rem;
}

.add-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.add-btn:disabled {
  color: var(--text-dim);
}

select {
  font: inherit;
  font-size: var(--fs-small);
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.375rem;
}

.form-error {
  margin: 0.5rem 0 0;
  font-size: var(--fs-small);
  color: var(--del);
}
</style>
