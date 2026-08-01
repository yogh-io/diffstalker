/**
 * useUrlSync: mirror "what is being shown" into a CLEAN, path-based URL so
 * a view is reproducible and shareable — no query string, and no
 * /home/<user> prefix.
 *
 *   /<home-relative-repo-path>/<view>
 *   /w/calculator/fix-bbox/compare
 *   /w/calculator/fix-bbox/compare/upstream:main      (overridden base)
 *   /w/diffstalker/explorer/packages:web:src:App.vue  (open file)
 *   /w/diffstalker/history
 *
 * The repo path's slashes are real path segments. Paths are stored RELATIVE
 * to the daemon's $HOME (fetched from GET /health) — a repo outside home
 * keeps its absolute path. The view is the trailing keyword.
 *
 * Two views carry one extra segment after the keyword, and both write their
 * `/` as `:` so the rider stays ONE segment and the view keyword keeps its
 * fixed position (no scanning for it, no guessing where the repo path ends):
 * `compare` carries the base branch (only when explicitly chosen — a git ref
 * can never contain `:`, so that one round-trips exactly), and `explorer`
 * carries the repo-relative file being shown. A file name containing a
 * literal `:` is the one case that does not round-trip; it is legal on Linux
 * but rare, and the cost is a failed reveal (the explorer shows its own
 * error), not a broken app.
 *
 * The daemon already serves index.html for any non-API, non-file path (SPA
 * fallback), so a deep link reloads correctly. App reads `initial` once at
 * startup (it wins over follow / first-repo), then every repo/view/base/file
 * change keeps the path in sync.
 *
 * Browser history: every landing on a new path PUSHES an entry — another
 * repo, view, compare base or explorer file — so Back walks back through
 * what you looked at instead of leaving the app. Note that this counts
 * follow mode's file reveals too: with follow on, tracking an editor writes
 * one entry per file it lands on. Three writes REPLACE:
 *
 *  - the first write of the session (that entry IS the page you arrived on);
 *  - the write that first names a repo — the entry URL becoming complete (a
 *    deep link's repo finishing its open, the warm-daemon auto-activation, a
 *    follow target on cold load), not a navigation away from it;
 *  - anything written while a popped entry is being applied (below).
 *
 * Back/forward: popstate parses the path and hands it to `onPopState` (App
 * owns applying it — only App can open repos). Applying is async and lands
 * in pieces (the view immediately, the repo after a POST), so every write
 * during it replaces: an intermediate state must never push an entry of its
 * own, and the final replace leaves the URL truthful even if the repo could
 * not be reopened.
 */

import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useRepoStore } from '../stores/repo';
import { useUiStore, VIEWS } from '../stores/ui';
import { DiffstalkerClient } from '../api/client';
import type { ViewName } from '../prefs';

const COMPARE: ViewName = 'compare';
const EXPLORER: ViewName = 'explorer';

/** The rider segment's stand-in for `/` (see the header comment). */
const RIDE_SEP = ':';

function encodeRider(value: string): string {
  return value.split('/').join(RIDE_SEP);
}

function decodeRider(value: string): string {
  return value.split(RIDE_SEP).join('/');
}

function isViewName(value: string | undefined): value is ViewName {
  return value !== undefined && VIEWS.some((v) => v.name === value);
}

function stripLeadingSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

export interface UrlState {
  /** Repo path from the URL: home-relative, or absolute for a repo outside
   * home. Null when the URL names no repo. Un-expanded (App resolves it). */
  repoRel: string | null;
  view: ViewName | null;
  base: string | null;
  /** Explorer: the repo-relative file being shown, when one is open. */
  file: string | null;
}

/**
 * Parse the pushState path into {repoRel, view, base, file}. The view is the
 * trailing keyword, or the one before a rider segment. Checking the rider
 * positions FIRST means a rider that happens to equal a view keyword (a
 * branch named `history`, a file named `changes`) is still read as the rider.
 */
export function parseUrlPath(pathname: string): UrlState {
  const segs = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const n = segs.length;
  const repoUpTo = (k: number): string | null => (k > 0 ? segs.slice(0, k).join('/') : null);
  const last = segs[n - 1];
  const secondLast = segs[n - 2];
  const bare = (view: ViewName): UrlState => ({
    repoRel: repoUpTo(n - 1),
    view,
    base: null,
    file: null,
  });

  if (n >= 1 && last === COMPARE) return bare(COMPARE);
  if (n >= 2 && secondLast === COMPARE) {
    return { repoRel: repoUpTo(n - 2), view: COMPARE, base: decodeRider(last), file: null };
  }
  if (n >= 1 && last === EXPLORER) return bare(EXPLORER);
  if (n >= 2 && secondLast === EXPLORER) {
    return { repoRel: repoUpTo(n - 2), view: EXPLORER, base: null, file: decodeRider(last) };
  }
  if (n >= 1 && isViewName(last)) return bare(last);
  return { repoRel: repoUpTo(n), view: null, base: null, file: null };
}

export interface UrlSyncOptions {
  /**
   * Apply a popped history entry (Back/Forward). App owns this: reaching a
   * URL can mean opening a repo, which only App's repo-open flow does.
   */
  onPopState?: (state: UrlState) => Promise<void> | void;
}

/** What the last write recorded — the push/replace decision reads it. */
interface WrittenState {
  path: string;
  view: ViewName;
  repoRel: string | null;
  base: string | null;
  file: string | null;
}

export function useUrlSync(options: UrlSyncOptions = {}): {
  initial: UrlState;
  whenHomeReady: Promise<void>;
  toAbsolute: (repoRel: string) => string;
  isActiveRepo: (repoRel: string) => boolean;
} {
  const daemon = useDaemonStore();
  const explorer = useExplorerStore();
  const repo = useRepoStore();
  const ui = useUiStore();
  const client = new DiffstalkerClient();

  const home = ref<string | null>(null);
  const whenHomeReady = client
    .health()
    .then((h) => {
      home.value = h.home ?? null;
    })
    .catch(() => {
      // No home from the daemon -> fall back to absolute paths.
    });

  const initial =
    typeof window !== 'undefined'
      ? parseUrlPath(window.location.pathname)
      : { repoRel: null, view: null, base: null, file: null };

  const activeRepoPath = computed(
    () => daemon.repos.find((r) => r.id === daemon.activeRepoId)?.path ?? null
  );

  /** Absolute path for a URL repoRel (home-relative first; App falls back to
   * an absolute open if this misses, covering repos outside home). */
  function toAbsolute(repoRel: string): string {
    return home.value ? `${home.value}/${repoRel}` : `/${repoRel}`;
  }

  /** URL repoRel for an absolute repo path: home-relative when under home. */
  function toRel(abs: string): string {
    if (home.value !== null && (abs === home.value || abs.startsWith(home.value + '/'))) {
      return stripLeadingSlash(abs.slice(home.value.length));
    }
    return stripLeadingSlash(abs);
  }

  /** Is this URL repo the one already open? (Popstate skips reopening it.) */
  function isActiveRepo(repoRel: string): boolean {
    return activeRepoPath.value !== null && toRel(activeRepoPath.value) === repoRel;
  }

  const currentRepoRel = (): string | null =>
    activeRepoPath.value === null ? null : toRel(activeRepoPath.value);

  function buildPath(): string {
    const segs: string[] = [];
    const rel = currentRepoRel();
    if (rel !== null) segs.push(...rel.split('/').filter(Boolean));
    segs.push(ui.activeView);
    if (ui.activeView === COMPARE && repo.selectedCompareBase) {
      segs.push(encodeRider(repo.selectedCompareBase));
    }
    if (ui.activeView === EXPLORER && explorer.selectedPath) {
      segs.push(encodeRider(explorer.selectedPath));
    }
    return '/' + segs.join('/');
  }

  /** The state we last wrote; null until the first write of the session. */
  let written: WrittenState | null = null;
  /** True while a popped entry is being applied — every write replaces. */
  let applyingPop = false;

  /**
   * A different path is a navigation and gets its own entry — repo, view,
   * compare base, explorer file alike. Only the two startup cases and a
   * popped entry being applied replace instead (see the header comment).
   */
  function shouldPush(next: WrittenState): boolean {
    if (written === null || applyingPop) return false;
    return !(written.repoRel === null && next.repoRel !== null);
  }

  /**
   * A repo switch clears the explorer's open file (the store resets on the
   * repo id) one step BEFORE the new repo lands, so for one flush the state
   * reads "same repo, no file". Writing that would strip the file from the
   * entry the user is leaving — and Back would return them to a fileless
   * explorer. Skip it; the next write, with the new repo, is the truthful
   * one. Nothing else clears the file while the repo stays put (the
   * explorer has no close-file action; a popped entry that closes one is
   * excluded here, and needs no write anyway — the URL is already what it
   * says).
   */
  function isRepoSwitchFlicker(next: WrittenState): boolean {
    return (
      written !== null &&
      !applyingPop &&
      next.file === null &&
      written.file !== null &&
      next.repoRel === written.repoRel &&
      next.view === written.view &&
      next.base === written.base
    );
  }

  function writeUrl(): void {
    if (typeof window === 'undefined') return;
    const next: WrittenState = {
      path: buildPath(),
      view: ui.activeView,
      repoRel: currentRepoRel(),
      base: ui.activeView === COMPARE ? repo.selectedCompareBase : null,
      file: ui.activeView === EXPLORER ? explorer.selectedPath : null,
    };
    if (isRepoSwitchFlicker(next)) return;
    // The browser stores the path percent-encoded; buildPath does not
    // encode, so compare in encoded space rather than decoding back.
    if (encodeURI(next.path) !== window.location.pathname) {
      if (shouldPush(next)) window.history.pushState(null, '', next.path);
      else window.history.replaceState(window.history.state, '', next.path);
    }
    // Recorded even when nothing was written (the URL already said this):
    // the NEXT change still has to know what the user is looking at now.
    written = next;
  }

  // First write once $HOME is known, so the path is home-relative from the
  // start (not a transient /home/<user>), then on every state change.
  async function writeAfterHome(): Promise<void> {
    await whenHomeReady;
    writeUrl();
  }
  void writeAfterHome();
  watch(
    [
      activeRepoPath,
      () => ui.activeView,
      () => repo.selectedCompareBase,
      () => explorer.selectedPath,
    ],
    writeUrl,
    { flush: 'post' }
  );

  /**
   * Back/forward. The suppression window covers the whole application,
   * INCLUDING the post-flush watcher writes it triggers (hence the
   * nextTick before the final, truthful write) — every one of them has to
   * replace, or an intermediate state would push an entry the user never
   * navigated to and forward history would be lost.
   */
  async function onPopState(): Promise<void> {
    applyingPop = true;
    try {
      await options.onPopState?.(parseUrlPath(window.location.pathname));
    } finally {
      await nextTick();
      writeUrl();
      applyingPop = false;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', onPopState);
    onScopeDispose(() => window.removeEventListener('popstate', onPopState));
  }

  return { initial, whenHomeReady, toAbsolute, isActiveRepo };
}
