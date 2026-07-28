/**
 * useUrlSync: mirror "what is being shown" into a CLEAN, path-based URL so
 * a view is reproducible and shareable — no query string, and no
 * /home/<user> prefix.
 *
 *   /<home-relative-repo-path>/<view>
 *   /w/calculator/fix-bbox/compare
 *   /w/calculator/fix-bbox/compare/upstream:main   (overridden base)
 *   /w/diffstalker/history
 *
 * The repo path's slashes are real path segments. Paths are stored RELATIVE
 * to the daemon's $HOME (fetched from GET /health) — a repo outside home
 * keeps its absolute path. The view is the trailing keyword. A compare base
 * (only when explicitly chosen) rides after `compare` with its `/` written
 * as `:` — git refs can't contain `:`, so it round-trips unambiguously and
 * never collides with a repo segment or a view keyword.
 *
 * The daemon already serves index.html for any non-API, non-file path (SPA
 * fallback), so a deep link reloads correctly. App reads `initial` once at
 * startup (it wins over follow / first-repo), then replaceState keeps the
 * path in sync (no back/forward spam) as repo/view/base change.
 */

import { computed, ref, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore, VIEWS } from '../stores/ui';
import { DiffstalkerClient } from '../api/client';
import type { ViewName } from '../prefs';

const COMPARE: ViewName = 'compare';

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
}

/**
 * Parse the pushState path into {repoRel, view, base}. The view is the
 * trailing keyword; for `compare` a base may follow (its `/` written as
 * `:`). Checking `compare`'s position FIRST means a base that happens to
 * equal a view keyword (a branch named `history`) is still read as the base.
 */
export function parseUrlPath(pathname: string): UrlState {
  const segs = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const n = segs.length;
  const repoUpTo = (k: number): string | null => (k > 0 ? segs.slice(0, k).join('/') : null);
  const last = segs[n - 1];
  const secondLast = segs[n - 2];

  if (n >= 1 && last === COMPARE) {
    return { repoRel: repoUpTo(n - 1), view: COMPARE, base: null };
  }
  if (n >= 2 && secondLast === COMPARE) {
    return { repoRel: repoUpTo(n - 2), view: COMPARE, base: last.split(':').join('/') };
  }
  if (n >= 1 && isViewName(last)) {
    return { repoRel: repoUpTo(n - 1), view: last, base: null };
  }
  return { repoRel: repoUpTo(n), view: null, base: null };
}

export function useUrlSync(): {
  initial: UrlState;
  whenHomeReady: Promise<void>;
  toAbsolute: (repoRel: string) => string;
} {
  const daemon = useDaemonStore();
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
      : { repoRel: null, view: null, base: null };

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

  function writeUrl(): void {
    if (typeof window === 'undefined') return;
    const segs: string[] = [];
    if (activeRepoPath.value) {
      segs.push(...toRel(activeRepoPath.value).split('/').filter(Boolean));
    }
    segs.push(ui.activeView);
    if (ui.activeView === COMPARE && repo.selectedCompareBase) {
      segs.push(repo.selectedCompareBase.split('/').join(':'));
    }
    window.history.replaceState(window.history.state, '', '/' + segs.join('/'));
  }

  // First write once $HOME is known, so the path is home-relative from the
  // start (not a transient /home/<user>), then on every state change.
  async function writeAfterHome(): Promise<void> {
    await whenHomeReady;
    writeUrl();
  }
  void writeAfterHome();
  watch([activeRepoPath, () => ui.activeView, () => repo.selectedCompareBase], writeUrl, {
    flush: 'post',
  });

  return { initial, whenHomeReady, toAbsolute };
}
