<script setup lang="ts">
/**
 * App shell: header / activity rail / workspace / status bar on a CSS
 * grid. Owns the daemon connection and the warm-daemon auto-activation:
 *
 * - onMounted: daemonStore.connect() (daemon-scope SSE);
 * - activation flows through useRepoOpen (switcher, open-by-path, and
 *   the auto-activation below) — repoStore.open() is the sole opener;
 * - one-shot auto-activation: when the FIRST daemon repo list arrives
 *   (page load) with open repos and nothing active, activate the
 *   followed repo, else the first open one. Latched after that first
 *   list — a later repo-opened (say, the CLI opening a repo) must never
 *   hijack a user sitting at the empty state;
 * - the global keyboard layer (useGlobalKeys) and follow-mode policy
 *   (useFollowMode) mount here, and the two overlays (fuzzy finder,
 *   hotkeys help) render at the shell level from ui.activeOverlay.
 */

import { computed, onMounted, watch } from 'vue';
import { useDaemonStore } from './stores/daemon';
import { useUiStore } from './stores/ui';
import { useRepoOpen } from './composables/useRepoOpen';
import { useGlobalKeys } from './composables/useGlobalKeys';
import { useFollowMode } from './composables/useFollowMode';
import AppHeader from './components/AppHeader.vue';
import ActivityRail from './components/ActivityRail.vue';
import StatusBar from './components/StatusBar.vue';
import RepoEmptyState from './components/RepoEmptyState.vue';
import FinderOverlay from './components/FinderOverlay.vue';
import HotkeysOverlay from './components/HotkeysOverlay.vue';
import ChangesView from './views/ChangesView.vue';
import HistoryView from './views/HistoryView.vue';
import CompareView from './views/CompareView.vue';
import ExplorerView from './views/ExplorerView.vue';
import type { ViewName } from './prefs';

const daemon = useDaemonStore();
const ui = useUiStore();
const { activate } = useRepoOpen();

// Stamp the theme before first paint (setup runs before mount).
ui.init();

useGlobalKeys();
useFollowMode();

const VIEW_COMPONENTS: Record<ViewName, unknown> = {
  changes: ChangesView,
  history: HistoryView,
  compare: CompareView,
  explorer: ExplorerView,
};

const activeViewComponent = computed(() => VIEW_COMPONENTS[ui.activeView]);

const hasActiveRepo = computed(() => daemon.activeRepoId !== null);

onMounted(() => {
  daemon.connect();
});

// Warm daemon on page load: activate the followed repo, else the first.
// One-shot — the latch disarms on the FIRST repo list, even an empty one,
// so nothing auto-activates later (repo-opened SSE, post-close arrivals).
let autoActivateArmed = true;
watch(
  () => daemon.repos,
  (repos) => {
    if (!autoActivateArmed) return;
    autoActivateArmed = false;
    if (daemon.activeRepoId !== null || repos.length === 0) return;
    const followed = repos.find((r) => r.id === daemon.follow?.followedRepoId);
    void activate(followed ?? repos[0]);
  }
);
</script>

<template>
  <div class="shell">
    <AppHeader />
    <ActivityRail />
    <main class="workspace">
      <RepoEmptyState v-if="!hasActiveRepo" />
      <!-- Keyed on the active repo: a repo switch (switcher or follow
           mode) REMOUNTS the view, discarding component-local state that
           belongs to the old repo — History's loaded-log latch, Compare's
           toggle — so a view never keeps showing the previous repo. -->
      <component :is="activeViewComponent" v-else :key="daemon.activeRepoId ?? ''" />
    </main>
    <StatusBar />

    <FinderOverlay v-if="ui.activeOverlay === 'finder'" />
    <HotkeysOverlay v-else-if="ui.activeOverlay === 'help'" />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: grid;
  grid-template:
    'header header' auto
    'rail main' 1fr
    'status status' auto
    / auto 1fr;
}

.workspace {
  grid-area: main;
  overflow: auto;
  background: var(--bg);
}
</style>
