<script setup lang="ts">
/**
 * App shell: header / activity rail / workspace / status bar on a CSS
 * grid. Owns the daemon connection and the warm-daemon auto-activation:
 *
 * - onMounted: daemonStore.connect() (daemon-scope SSE);
 * - activation flows through useRepoOpen (switcher, open-by-path, and
 *   the auto-activation below) — repoStore.open() is the sole opener;
 * - one-shot auto-activation: when the first daemon repo list AND the
 *   follow state have both arrived (page load) with open repos and
 *   nothing active, activate the first open repo — unless follow mode
 *   has a target, which useFollowMode navigates to instead. Latched
 *   after that first decision — a later repo-opened (say, the CLI
 *   opening a repo) must never hijack a user sitting at the empty
 *   state;
 * - the global keyboard layer (useGlobalKeys), follow-mode policy
 *   (useFollowMode) and auto-mode policy (useAutoMode) mount here, and
 *   the two overlays (fuzzy finder, hotkeys help) render at the shell
 *   level from ui.activeOverlay.
 */

import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useDaemonStore } from './stores/daemon';
import { useExplorerStore } from './stores/explorer';
import { useRepoStore } from './stores/repo';
import { useUiStore } from './stores/ui';
import { useRepoOpen } from './composables/useRepoOpen';
import { useGlobalKeys } from './composables/useGlobalKeys';
import { useFollowMode } from './composables/useFollowMode';
import { useAutoMode } from './composables/useAutoMode';
import { useSplitMode } from './composables/useMediaQuery';
import { useUrlSync, type UrlState } from './composables/useUrlSync';
import AppHeader from './components/AppHeader.vue';
import ActivityRail from './components/ActivityRail.vue';
import ViewToolbarStrip from './components/ViewToolbarStrip.vue';
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
const explorer = useExplorerStore();
const repo = useRepoStore();
const ui = useUiStore();

// Publishes data-split on the root element: the ONE definition of the
// stacked/split breakpoint, which every portrait CSS block now reads.
useSplitMode();
const { activate, openByPath } = useRepoOpen();

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

// Warm daemon on page load: fall back to the first open repo — unless a
// follow target exists with the toggle on, where useFollowMode owns the
// navigation (it acts on the lastFollowChange seeded by loadFollow).
// The repo list and the follow state load in parallel, so the decision
// WAITS for daemon.follow: deciding on the bare repo list would race
// loadFollow and activate repos[0] while the real target is in flight.
// One-shot — the latch disarms on the first decided list, even an empty
// one, so nothing auto-activates later (repo-opened SSE, post-close
// arrivals).
//
// Backstop: if /follow never loads (a permanently failing GET while the
// SSE stream stays up — the store retries but can exhaust them), waiting
// on daemon.follow forever would strand the user on the empty state with
// no manual escape. A bounded fallback opens repos[0] once the wait
// exceeds FOLLOW_FALLBACK_MS.
const FOLLOW_FALLBACK_MS = 3000;
let autoActivateArmed = true;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function disarmAutoActivate(): void {
  autoActivateArmed = false;
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function activateFirst(repos: typeof daemon.repos): void {
  if (daemon.activeRepoId !== null || repos.length === 0) return;
  void activate(repos[0]);
}

// URL state: reproduce the shown repo/view/base/file from the path, and keep
// the path in sync as those change (useUrlSync installs the write watcher).
// A repo in the URL WINS over follow / first-repo on cold load — disarm the
// auto-activation so they don't race it. The view is applied in setup (before
// mount) so the first paint is the shared view. The compare base and the
// explorer's file ride the repo once it opens.
//
// Back/forward hands the popped state here: only this level can open a repo
// (useRepoOpen) — useUrlSync owns the URL, never the app state.
const urlSync = useUrlSync({ onPopState: applyUrlState });

async function applyUrlRepo(repoRel: string, base: string | null): Promise<void> {
  await urlSync.whenHomeReady;
  // Home-relative first; fall back to an absolute open for a repo outside
  // home (the URL kept its absolute path there).
  let ok = await openByPath(urlSync.toAbsolute(repoRel));
  if (!ok && !repoRel.startsWith('/')) ok = await openByPath('/' + repoRel);
  if (ok && base !== null) await repo.setSelectedCompareBase(base);
}

/**
 * Show what a URL names: view first (it paints without waiting), then the
 * repo, then the explorer's file. A repo already open is not reopened — the
 * POST would release and re-take the ref and remount the view for nothing.
 * The reveal waits a tick after an open so the explorer store's repo-switch
 * reset has flushed (same ordering useFollowMode needs).
 *
 * An explorer URL with NO file closes the open one. Leaving it would make
 * Back stop at the first file the user opened: the entry says "no file", the
 * app would still show one, and the truthful rewrite would put the file back
 * into that entry — one step short of where Back was going.
 */
async function applyUrlState(state: UrlState): Promise<void> {
  if (state.view) ui.setActiveView(state.view);
  if (state.repoRel === null) return;
  if (urlSync.isActiveRepo(state.repoRel)) {
    if (state.base !== null && state.base !== repo.selectedCompareBase) {
      await repo.setSelectedCompareBase(state.base);
    }
  } else {
    await applyUrlRepo(state.repoRel, state.base);
    await nextTick();
  }
  if (state.view === 'explorer' && state.file === null) explorer.clearSelection();
  else if (state.file !== null && state.file !== explorer.selectedPath) {
    await explorer.revealFile(state.file);
  }
}

if (urlSync.initial.view) ui.setActiveView(urlSync.initial.view);
if (urlSync.initial.repoRel !== null) {
  disarmAutoActivate();
  // The URL repo wins over the initial follow target too (follow resumes on
  // the next live hook change).
  daemon.skipInitialFollow = true;
  void applyUrlState(urlSync.initial);
}

watch(
  [() => daemon.repos, () => daemon.follow],
  ([repos, follow]) => {
    if (!autoActivateArmed) return;
    if (follow === null) {
      // Follow still loading — normally wait, but arm the bounded
      // fallback so a stuck /follow cannot deadlock the empty state.
      if (fallbackTimer === null && repos.length > 0) {
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null;
          if (!autoActivateArmed) return;
          disarmAutoActivate();
          activateFirst(daemon.repos);
        }, FOLLOW_FALLBACK_MS);
      }
      return;
    }
    disarmAutoActivate();
    if (daemon.followEnabled && follow.followedRepoId !== null && follow.followedPath !== null) {
      return; // useFollowMode navigates to the followed repo
    }
    activateFirst(repos);
  }
);

onUnmounted(() => {
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
});
</script>

<template>
  <div class="shell">
    <AppHeader />
    <ActivityRail />
    <ViewToolbarStrip />
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
  /* The main column is minmax(0, 1fr), NOT 1fr: a bare 1fr track floors
     at min-content, so a wide diff/journal line would stretch the whole
     column — and every row that spans it (header, status) with it —
     past the viewport, clipping the header's right-side controls. Flooring
     at 0 keeps the layout at viewport width; wide content scrolls inside
     its own container (.diff-scroll / the workspace) instead. */
  /* The rail is a full-width tab band between the header and the
     workspace at EVERY width — the nav never reflows to a left sidebar,
     so it never steals horizontal room from the diff. */
  grid-template:
    'header' auto
    'railband' auto
    'viewtoolbar' auto
    'main' 1fr
    'status' auto
    / minmax(0, 1fr);
}

.workspace {
  grid-area: main;
  min-width: 0;
  overflow: auto;
  background: var(--bg);
}
</style>
