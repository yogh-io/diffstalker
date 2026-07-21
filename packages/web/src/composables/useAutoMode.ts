/**
 * useAutoMode: the web port of the CLI's auto-mode POLICY (App.ts
 * applyAutoTab + applyAutoScrollToLatestChange), mounted once at the
 * shell. Pure viewing — it only selects files and switches views, no
 * mutations. Two behaviors, driven by every applied shared state:
 *
 * - view switching on file-COUNT transitions: files disappear (>0 -> 0,
 *   on the Changes view) -> switch to History and select the newest
 *   commit; files appear (0 -> >0, on History) -> switch to Changes;
 * - auto-select the newest-CHANGED file: when a file's mtime increased
 *   (or the file is new), select it — the store re-fetches its diff —
 *   and briefly flash its row.
 *
 * Change detection is by the daemon-sent mtimes (shared.mtimes): the
 * browser cannot stat files, and mtimes mean SSE churn without a
 * content change (staging, selection elsewhere) never triggers a jump.
 * Both the mtime map and the previous file count update even while
 * auto mode is OFF, so toggling it on later acts only on changes that
 * land AFTER the toggle — never on a stale "newest". The very first
 * snapshot (per repo) only seeds — attaching to a dirty repo must not
 * jump.
 */

import { watch } from 'vue';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import type { FileEntry } from '@diffstalker/core/git/status';
import type { RepoSharedState } from '../stores/types';

interface NewestChange {
  path: string;
  mtime: number;
}

export function useAutoMode(): void {
  const repo = useRepoStore();
  const ui = useUiStore();

  /** Last seen mtime per path — updated on EVERY state, auto on or off. */
  let lastMtimes = new Map<string, number>();
  /** Previous status file count, for the view-switch transitions. */
  let prevFileCount = 0;
  /** False until the first status of the current repo seeded the maps. */
  let seeded = false;

  // The singleton store is reused across open() calls: a repo switch
  // starts a fresh seeding cycle so the new repo's first snapshot never
  // reads as "everything just changed".
  watch(
    () => repo.repoId,
    () => {
      lastMtimes = new Map();
      prevFileCount = 0;
      seeded = false;
    }
  );

  /**
   * Roll the mtime map forward and return the freshest changed file
   * (mtime increased, or newly seen), null when nothing changed.
   * Runs on every state — auto on or off — so the map never goes stale.
   */
  function findNewestChange(
    files: FileEntry[],
    wireMtimes: Record<string, number>
  ): NewestChange | null {
    const current = new Map<string, number>();
    let newest: NewestChange | null = null;
    for (const file of files) {
      const mtime = wireMtimes[file.path];
      if (mtime === undefined) continue; // deleted/renamed — nothing on disk
      if (current.has(file.path)) continue; // staged/unstaged pair: one entry
      current.set(file.path, mtime);

      const prev = lastMtimes.get(file.path);
      const changed = prev === undefined || mtime > prev;
      if (changed && (!newest || mtime > newest.mtime)) {
        newest = { path: file.path, mtime };
      }
    }
    lastMtimes = current;
    return newest;
  }

  /** Changes dried up on the Changes view: show the newest commit. */
  function switchToHistory(): void {
    const newestCommit = repo.history.commits[0];
    if (newestCommit) {
      repo.selectHistoryCommit(newestCommit).catch(() => {
        // Transient (e.g. rebased away mid-switch): the list view still
        // shows the fresh log.
      });
    }
    ui.setActiveView('history');
  }

  /**
   * View switching on file-count transitions (CLI applyAutoTab). Only
   * hijacks the two views involved. Returns true when the working tree
   * went clean — there is nothing left to auto-select.
   */
  function applyViewSwitch(prevCount: number, count: number): boolean {
    if (prevCount > 0 && count === 0) {
      if (ui.activeView === 'changes') switchToHistory();
      return true;
    }
    if (prevCount === 0 && count > 0 && ui.activeView === 'history') {
      ui.setActiveView('changes');
    }
    return false;
  }

  /** Select + flash the newest-changed file (Changes view only). */
  function selectNewestFile(files: FileEntry[], newest: NewestChange): void {
    if (ui.activeView !== 'changes') return;
    // Hand the store the EXACT entry from the current status (its
    // stale-guard is identity-based). First match wins; the diff view
    // shows the combined pair either way.
    const entry = files.find((f) => f.path === newest.path);
    if (!entry) return;
    repo.selectFile(entry);
    ui.flashFile(newest.path);
  }

  function onSharedState(shared: RepoSharedState): void {
    const status = shared.status;
    if (status === null || !status.isRepo) return;
    const files = status.files;

    // Tracking always runs, even with auto mode off.
    const prevCount = prevFileCount;
    prevFileCount = files.length;
    const newest = findNewestChange(files, shared.mtimes ?? {});

    const firstSnapshot = !seeded;
    seeded = true;
    if (firstSnapshot) return; // seed silently: never jump on attach
    if (!ui.autoModeEnabled) return;

    if (applyViewSwitch(prevCount, files.length)) return;
    if (newest !== null) selectNewestFile(files, newest);
  }

  watch(
    () => repo.shared,
    (shared) => onSharedState(shared)
  );
}
