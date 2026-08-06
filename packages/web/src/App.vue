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

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useDaemonStore } from './stores/daemon';
import { useExplorerStore } from './stores/explorer';
import { useRepoStore, workingDiffKey } from './stores/repo';
import { useUiStore } from './stores/ui';
import { useRepoOpen } from './composables/useRepoOpen';
import { useGlobalKeys } from './composables/useGlobalKeys';
import { useFollowMode } from './composables/useFollowMode';
import { useAutoMode } from './composables/useAutoMode';
import { useSplitMode } from './composables/useMediaQuery';
import {
  useUrlSync,
  type RestoreContext,
  type UrlState,
} from './composables/useUrlSync';
import AppHeader from './components/AppHeader.vue';
import ActivityRail from './components/ActivityRail.vue';
import ViewToolbarStrip from './components/ViewToolbarStrip.vue';
import StatusBar from './components/StatusBar.vue';
import RepoEmptyState from './components/RepoEmptyState.vue';
import FinderOverlay from './components/FinderOverlay.vue';
import SearchOverlay from './components/SearchOverlay.vue';
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

/** How long a restored place is protected from an incoming follow event. */
const FOLLOW_GRACE_MS = 1500;
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

// URL state: reproduce the place the path names, and keep the path in sync as
// the app moves (useUrlSync installs the write watcher and owns the URL; this
// level owns the app state, because only this level can open a repo).
// A repo in the URL WINS over follow / first-repo on cold load — disarm the
// auto-activation so they don't race it.
const urlSync = useUrlSync({ onRestore: applyUrlState });

/**
 * An anchor whose data has not landed yet. Restoring must not block on a
 * status snapshot or a compare pull that may never come — it records what
 * it is aiming at and returns; the watchers below apply it when the data
 * arrives, and drop it if the user moves first.
 */
const pendingAnchor = ref<{ view: ViewName; at: string } | null>(null);

/**
 * Show the place a URL names — a deep link on cold load and every Back /
 * Forward run through here, so there is one applier, not two.
 *
 * Order matters: with a repo already open, the URL's repo is opened FIRST
 * and only then the view, or the target view paints against the previous
 * repo's data for a whole round trip. On a cold load it is the other way
 * round — nothing is on screen to lie, and the first paint should be the
 * view the link named. A repo already active is never re-opened: the POST
 * would release and re-take the daemon ref and remount the view for
 * nothing.
 *
 * A URL that names no place at all (`/`, or a stale link from the old
 * grammar) is left alone deliberately. It is indistinguishable from junk,
 * and junk must never tear down a repo; the app resolves normally and the
 * truthful write relabels the entry.
 */
async function applyUrlState(state: UrlState, ctx: RestoreContext): Promise<void> {
  if (state.view === null && state.repo === null) return;
  // Landing somewhere by Back/Forward holds follow mode off briefly: an
  // editor save arriving right after would otherwise yank the user
  // straight back out of the place they just navigated to.
  if (state.repo !== null) daemon.suspendFollowNavigation(FOLLOW_GRACE_MS);
  const coldLoad = daemon.activeRepoId === null;
  if (coldLoad && state.view !== null) ui.setActiveView(state.view);

  if (!(await openUrlRepo(state, ctx))) return;

  if (!coldLoad && state.view !== null) ui.setActiveView(state.view);
  if (state.view === null) return;
  await applyAnchor(state, ctx);
}

/**
 * Open the repo a URL names, if it is not the one already open. False
 * means "stop here": the open was refused (the app stays where it is and
 * the store surfaces the reason) or a newer restore took over.
 */
async function openUrlRepo(state: UrlState, ctx: RestoreContext): Promise<boolean> {
  if (state.repo === null || urlSync.isActiveRepo(state.repo)) return true;
  await urlSync.whenHomeReady;
  if (ctx.isStale()) return false;
  // One branch, no retry: the `~` sentinel already said which kind of path
  // this is.
  const ok = await openByPath(urlSync.toAbsolute(state.repo));
  if (!ok || ctx.isStale()) return false;
  // Let the stores' repo-switch resets flush before anything reads them.
  await nextTick();
  return !ctx.isStale();
}

/**
 * Aim the view at what the URL names. Each view's "nothing named" case
 * CLEARS its selection — without that, Back stops one step short: the
 * entry says "no file", the app still shows one, and the truthful rewrite
 * puts it back into the entry the user was leaving.
 */
async function applyAnchor(state: UrlState, ctx: RestoreContext): Promise<void> {
  pendingAnchor.value = null;
  switch (state.view) {
    case 'explorer':
      if (state.at === null) explorer.clearSelection();
      else if (state.at !== explorer.selectedPath) await explorer.revealFile(state.at);
      return;
    case 'history':
      await applyHistoryAnchor(state.at, ctx);
      return;
    case 'compare':
      await applyCompareAnchor(state, ctx);
      return;
    case 'changes':
      applyChangesAnchor(state.at);
      return;
    default:
      return; // journal: the repo and the view, nothing else
  }
}

/**
 * Changes: `at` is a stack key (`u:`/`s:` + path). An exact match wins; a
 * miss retries the same path on the other side, because a file staged
 * since the link was made moved from one to the other. selectFile needs
 * the EXACT FileEntry from the current status — rows and re-anchoring are
 * identity-based. No status yet means no files to match: park it.
 */
function applyChangesAnchor(at: string | null): void {
  if (at === null) {
    repo.selectFile(null);
    ui.setActiveStackKey(null);
    return;
  }
  const files = repo.shared.status?.files;
  if (!files) {
    pendingAnchor.value = { view: 'changes', at };
    return;
  }
  const path = at.slice(at.indexOf(':') + 1);
  const match =
    files.find((f) => workingDiffKey(f) === at) ?? files.find((f) => f.path === path) ?? null;
  if (!match) return; // committed, discarded, gone: ordinary churn
  repo.selectFile(match);
  ui.setActiveStackKey(workingDiffKey(match));
  ui.requestStackScroll(workingDiffKey(match));
}

/**
 * History: prefix-match the loaded log; a commit older than the loaded
 * page (or on a cold load, before the view has pulled anything) is
 * resolved by hash on its own so a deep link to an old commit works
 * without re-pulling the whole log at a larger count.
 */
async function applyHistoryAnchor(hash: string | null, ctx: RestoreContext): Promise<void> {
  if (hash === null) {
    await repo.selectHistoryCommit(null);
    return;
  }
  if (repo.history.selectedCommit?.hash.startsWith(hash)) return;
  const match = repo.history.commits.find((c) => c.hash.startsWith(hash));
  if (match) {
    await repo.selectHistoryCommit(match);
    return;
  }
  const commit = await repo.resolveCommit(hash);
  if (commit === null || ctx.isStale()) return;
  await repo.selectHistoryCommit(commit);
}

/**
 * Compare: the base is applied BEFORE anything is pulled (it decides what
 * is pulled), and only when it differs — setSelectedCompareBase re-pulls
 * the whole comparison. The file anchor is a PATH, mapped to an index in
 * the resolved file set; with no file set yet, park it.
 */
async function applyCompareAnchor(state: UrlState, ctx: RestoreContext): Promise<void> {
  if (state.base !== null && state.base !== repo.selectedCompareBase) {
    await repo.setSelectedCompareBase(state.base);
    if (ctx.isStale()) return;
  }
  if (state.at === null) return;
  const files = repo.compare.compareDiff?.files;
  if (!files) {
    pendingAnchor.value = { view: 'compare', at: state.at };
    return;
  }
  const index = files.findIndex((f) => f.path === state.at);
  if (index === -1) return;
  repo.selectCompareFile(index);
  ui.requestStackScroll(state.at);
}

// The parked anchor lands when its data does. Both watchers check the view
// is still the one that parked it, so a user who moved on in the meantime
// is never yanked back.
watch(
  () => repo.shared.status,
  () => {
    const parked = pendingAnchor.value;
    if (parked?.view !== 'changes' || ui.activeView !== 'changes') return;
    pendingAnchor.value = null;
    applyChangesAnchor(parked.at);
  }
);

watch(
  () => repo.compare.compareDiff,
  (compareDiff) => {
    const parked = pendingAnchor.value;
    if (parked?.view !== 'compare' || ui.activeView !== 'compare' || !compareDiff) return;
    pendingAnchor.value = null;
    const index = compareDiff.files.findIndex((f) => f.path === parked.at);
    if (index === -1) return;
    repo.selectCompareFile(index);
    ui.requestStackScroll(parked.at);
  }
);

if (urlSync.initial.view !== null || urlSync.initial.repo !== null) {
  if (urlSync.initial.repo !== null) {
    disarmAutoActivate();
    // The URL repo wins over the initial follow target too (follow resumes on
    // the next live hook change).
    daemon.skipInitialFollow = true;
  }
  void urlSync.restore(urlSync.initial);
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
    <SearchOverlay v-else-if="ui.activeOverlay === 'search'" />
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
