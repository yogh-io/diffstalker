/**
 * useRepoOpen: the two ways a repo becomes active, shared by the repo
 * switcher, the empty state, and App's warm-daemon auto-activation.
 *
 * repoStore.open() is the SOLE opener (one POST /repos per open; it also
 * releases the previous repo's ref). The daemon store never POSTs — it
 * just tracks the result (trackActive).
 *
 * - openByPath: repo.open(path); on success, track it active and record
 *   the recent. A refused open surfaces via repo.shared.error.
 * - activate: pick an already-open repo from the list. Still routes
 *   through repo.open so the previous repo's ref is released.
 *
 * Both record the path in the recent-repos prefs.
 */

import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import type { RepoRef } from '@diffstalker/client';

export function useRepoOpen() {
  const daemon = useDaemonStore();
  const repo = useRepoStore();
  const ui = useUiStore();

  /** Open a repo by absolute path. False when the daemon refused (the
   * reason lands in repo.shared.error). */
  async function openByPath(path: string): Promise<boolean> {
    const trimmed = path.trim();
    if (!trimmed) return false;
    const ref = await repo.open(trimmed);
    if (!ref) return false;
    daemon.trackActive(ref);
    ui.addRecentRepo(ref.path);
    return true;
  }

  /** Make an already-open repo the active one. */
  async function activate(ref: RepoRef): Promise<void> {
    await repo.open(ref.path);
    daemon.trackActive(ref);
    ui.addRecentRepo(ref.path);
  }

  return { openByPath, activate };
}
