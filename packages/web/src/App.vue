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
 * - the global keyboard layer (useGlobalKeys), follow-mode policy
 *   (useFollowMode) and auto-mode policy (useAutoMode) mount here, and
 *   the two overlays (fuzzy finder, hotkeys help) render at the shell
 *   level from ui.activeOverlay.
 */

import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useDaemonStore } from './stores/daemon';
import { useRepoStore } from './stores/repo';
import { useUiStore } from './stores/ui';
import { useRepoOpen } from './composables/useRepoOpen';
import { useGlobalKeys } from './composables/useGlobalKeys';
import { useFollowMode } from './composables/useFollowMode';
import { useAutoMode } from './composables/useAutoMode';
import AppHeader from './components/AppHeader.vue';
import ActivityRail from './components/ActivityRail.vue';
import StatusBar from './components/StatusBar.vue';
import RepoEmptyState from './components/RepoEmptyState.vue';
import FinderOverlay from './components/FinderOverlay.vue';
import HotkeysOverlay from './components/HotkeysOverlay.vue';
import ChangesView from './views/ChangesView.vue';
import JournalView from './views/JournalView.vue';
import HistoryView from './views/HistoryView.vue';
import CompareView from './views/CompareView.vue';
import ExplorerView from './views/ExplorerView.vue';
import type { ViewName } from './prefs';

const daemon = useDaemonStore();
const repo = useRepoStore();
const ui = useUiStore();
const { activate } = useRepoOpen();

// Stamp the theme before first paint (setup runs before mount).
ui.init();

useGlobalKeys();
useFollowMode();
useAutoMode();

const VIEW_COMPONENTS: Record<ViewName, unknown> = {
  changes: ChangesView,
  journal: JournalView,
  history: HistoryView,
  compare: CompareView,
  explorer: ExplorerView,
};

const activeViewComponent = computed(() => VIEW_COMPONENTS[ui.activeView]);

const hasActiveRepo = computed(() => daemon.activeRepoId !== null);

onMounted(() => {
  daemon.connect();
});

/**
 * Unload release: without it a reload (F5) / tab close / navigation
 * leaks the daemon-side repo ref — the refcount only ever climbs, the
 * daemon never closes a web-touched repo, and its watchers run forever.
 * pagehide is the reliable end-of-page signal (it fires on reload,
 * close, and navigation in every modern browser; unload does not), and
 * the store's releaseOnUnload sends a keepalive DELETE that outlives
 * the page (the beacon mechanism; navigator.sendBeacon itself is
 * POST-only and the release endpoint is DELETE).
 *
 * Deliberately NOT wired to visibilitychange->hidden: that fires on
 * every tab switch/minimize, not just unload. Releasing there would
 * drop the last web ref while the user works in their editor with the
 * tab hidden — the daemon would dispose the repo's watchers and the
 * journal would miss exactly the edits it exists to record (and the
 * store's SSE recovery loop would re-take the ref ~1s later anyway,
 * making it pure dispose/reopen churn). On real unloads pagehide fires
 * after visibilitychange, so nothing is lost by skipping it. If the
 * page returns from bfcache the SSE stream is dead, so the store's
 * recovery loop re-POSTs /repos and re-acquires the ref on its own.
 */
const releaseOnPageHide = (): void => {
  repo.releaseOnUnload();
};
onMounted(() => {
  window.addEventListener('pagehide', releaseOnPageHide);
});
onUnmounted(() => {
  window.removeEventListener('pagehide', releaseOnPageHide);
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

/* Portrait/vertical monitors: the rail becomes a full-width tab band
   between the header and the workspace. Fires on window SHAPE (see
   useMediaQuery.PORTRAIT_QUERY) — landscape renders the grid above,
   byte for byte. */
@media (orientation: portrait), (max-aspect-ratio: 1/1) {
  .shell {
    grid-template:
      'header' auto
      'railband' auto
      'main' 1fr
      'status' auto
      / 1fr;
  }
}
</style>
