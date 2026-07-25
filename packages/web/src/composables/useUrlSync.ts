/**
 * useUrlSync: mirror "what is being shown" into the URL query so a view is
 * reproducible and shareable. Three bits ride the query:
 *
 *   ?repo=<worktree-root-path>   the active repo — the path IS the worktree
 *                                root, so it identifies both project AND
 *                                worktree, and re-opening it reproduces the
 *                                exact repo/worktree.
 *   &view=<changes|journal|…>    the active view
 *   &base=<ref>                  the compare base, when one is explicitly
 *                                chosen (Compare view)
 *
 * The URL is READ once at startup (App applies it — it wins over follow /
 * first-repo auto-activation on cold load), then kept in sync with
 * replaceState (no back/forward spam) as the user navigates.
 */

import { computed, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore, VIEWS } from '../stores/ui';
import type { ViewName } from '../prefs';

export interface UrlState {
  repo: string | null;
  view: ViewName | null;
  base: string | null;
}

function isViewName(value: string | null): value is ViewName {
  return value !== null && VIEWS.some((v) => v.name === value);
}

/** Parse the current query into the reproducible bits (unknown view -> null). */
export function parseUrlState(): UrlState {
  if (typeof window === 'undefined') return { repo: null, view: null, base: null };
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  return {
    repo: params.get('repo'),
    view: isViewName(view) ? view : null,
    base: params.get('base'),
  };
}

export function useUrlSync(): { initial: UrlState } {
  const daemon = useDaemonStore();
  const repo = useRepoStore();
  const ui = useUiStore();

  const initial = parseUrlState();

  const activeRepoPath = computed(
    () => daemon.repos.find((r) => r.id === daemon.activeRepoId)?.path ?? null
  );

  function writeUrl(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (activeRepoPath.value) params.set('repo', activeRepoPath.value);
    params.set('view', ui.activeView);
    if (repo.selectedCompareBase) params.set('base', repo.selectedCompareBase);
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(window.history.state, '', url);
  }

  // One write coalesces all three; flush 'post' so it runs after the DOM
  // settles and reads the final values.
  watch([activeRepoPath, () => ui.activeView, () => repo.selectedCompareBase], writeUrl, {
    flush: 'post',
  });

  return { initial };
}
