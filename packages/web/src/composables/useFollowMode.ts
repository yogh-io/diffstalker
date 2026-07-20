/**
 * useFollowMode: the web analog of the CLI's FollowMode policy layer,
 * mounted once at the shell.
 *
 * The daemon owns the truth (it watches the one hook file and
 * broadcasts `follow-change`); the daemon store only RECORDS the latest
 * event. This composable watches it and, when the client-side
 * followEnabled toggle is on:
 *
 * - activates the followed repo (via useRepoOpen's activate, so the
 *   previous repo's ref is released) when it isn't the active one;
 * - when the resolved hook path points INSIDE the repo, switches to
 *   the Explorer view and reveals it in the tree (revealFile expands a
 *   directory target and opens a file target).
 *
 * Events are SERIALIZED through a promise chain (like the daemon's
 * follow controller): one is handled to completion before the next
 * starts, so rapid follow churn cannot interleave repo opens. Only the
 * latest event queued while a handler runs is kept — intermediate ones
 * coalesce away (the newest target wins anyway).
 *
 * With followEnabled off nothing moves — the event is recorded but the
 * user is never hijacked. Flipping the toggle ON acts on the recorded
 * latest event immediately, so "following X" in the header is honest
 * without waiting for the next hook write. The daemon broadcasts
 * repo-opened before follow-change on the same stream, so the followed
 * repo is normally already in daemon.repos; a miss re-pulls the list
 * once.
 */

import { nextTick, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useUiStore } from '../stores/ui';
import { useRepoOpen } from './useRepoOpen';
import type { FollowChangeEvent, RepoSummary } from '@diffstalker/client';

/** Strip trailing slashes ("/repo/" and "/repo" are the same target). */
function normalizePath(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function useFollowMode(): void {
  const daemon = useDaemonStore();
  const explorer = useExplorerStore();
  const ui = useUiStore();
  const { activate } = useRepoOpen();

  async function findRepo(id: string): Promise<RepoSummary | undefined> {
    const known = daemon.repos.find((repo) => repo.id === id);
    if (known) return known;
    // repo-opened precedes follow-change, but a race (or a stream that
    // opened mid-broadcast) can miss it — one refresh closes the gap.
    await daemon.refreshRepos();
    return daemon.repos.find((repo) => repo.id === id);
  }

  async function onFollowChange(event: FollowChangeEvent): Promise<void> {
    const target = await findRepo(event.repoId);
    if (!target) return;

    if (daemon.activeRepoId !== event.repoId) {
      await activate({ id: target.id, path: target.path });
      // Let the explorer store's repo-switch reset flush before revealing.
      await nextTick();
    }

    // The resolved hook path: the worktree root (or anything not under
    // it) only switches the repo; a path strictly under the root is
    // revealed — revealFile expands a directory and opens a file.
    const root = normalizePath(target.path);
    const path = normalizePath(event.path);
    if (path !== root && path.startsWith(root + '/')) {
      ui.setActiveView('explorer');
      await explorer.revealFile(path.slice(root.length + 1));
    }
  }

  // --- Serialization: one event handled at a time, latest-pending wins ---

  let chain: Promise<void> = Promise.resolve();
  let pending: FollowChangeEvent | null = null;

  function enqueue(event: FollowChangeEvent): void {
    const alreadyQueued = pending !== null;
    pending = event; // coalesce: the newest queued event wins
    if (alreadyQueued) return;
    chain = chain.then(async () => {
      const next = pending;
      pending = null;
      // The toggle may have flipped off while this waited in the queue.
      if (next === null || !daemon.followEnabled) return;
      try {
        await onFollowChange(next);
      } catch {
        // Store actions collapse errors into their own state; never
        // let a rejection break the chain for later events.
      }
    });
  }

  watch(
    () => daemon.lastFollowChange,
    (event) => {
      if (event !== null && daemon.followEnabled) enqueue(event);
    }
  );

  // Toggle flipped ON: act on the recorded latest event so the header's
  // "following X" is true immediately, not only on the next hook write.
  watch(
    () => daemon.followEnabled,
    (enabled) => {
      const event = daemon.lastFollowChange;
      if (enabled && event !== null) enqueue(event);
    }
  );
}
