/**
 * useDaemonStore: daemon-scope Pinia store — the open-repo list, follow
 * state, and connection status, fed by the daemon-scope SSE stream
 * (GET /events: snapshot / repo-opened / repo-closed / follow-change).
 *
 * The browser CANNOT spawn a daemon (the page is served by one). On
 * connection loss this store only surfaces `connection: 'disconnected'`
 * and lets the native EventSource retry; when the stream reopens the
 * daemon sends a fresh `snapshot`, which repopulates the repo list and
 * flips the status back to 'connected'.
 *
 * Follow: this store only RECORDS follow state and the latest
 * follow-change event (plus the client-side followEnabled policy
 * toggle, flipped by the header indicator). The ACTING lives in
 * composables/useFollowMode, which watches `lastFollowChange` and
 * switches the active repo / reveals the followed file while
 * `followEnabled` is on.
 */

import { shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import type { SseHandle } from '../api/transport';
import type { FollowChangeEvent, FollowState, RepoRef, RepoSummary } from '@diffstalker/client';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useDaemonStore = defineStore('daemon', () => {
  const client = new DiffstalkerClient();

  const connection = shallowRef<ConnectionStatus>('connecting');
  const repos = shallowRef<RepoSummary[]>([]);
  const follow = shallowRef<FollowState | null>(null);
  const followEnabled = shallowRef(true);
  const lastFollowChange = shallowRef<FollowChangeEvent | null>(null);
  const activeRepoId = shallowRef<string | null>(null);
  const error = shallowRef<string | null>(null);

  let subscription: SseHandle | null = null;

  /** Keep known branches when the snapshot only carries {id, path}. */
  function mergeSnapshot(refs: RepoRef[]): void {
    const known = new Map(repos.value.map((repo) => [repo.id, repo.branch]));
    repos.value = refs.map((ref) => ({ ...ref, branch: known.get(ref.id) ?? null }));
  }

  function upsertRepo(ref: RepoRef, branch: string | null = null): void {
    const existing = repos.value.find((repo) => repo.id === ref.id);
    if (existing) return;
    repos.value = [...repos.value, { ...ref, branch }];
  }

  /**
   * Open the daemon-scope subscription. Idempotent; EventSource
   * auto-reconnects, and each (re)connect yields a fresh snapshot.
   */
  function connect(): void {
    if (subscription) return;
    subscription = client.subscribeDaemon({
      onSnapshot: (refs) => {
        connection.value = 'connected';
        error.value = null;
        mergeSnapshot(refs);
        // The snapshot has no branches; the REST list does. Fire-and-forget.
        void refreshRepos();
        void loadFollow();
      },
      onRepoOpened: (repo) => upsertRepo(repo),
      onRepoClosed: ({ id }) => {
        repos.value = repos.value.filter((repo) => repo.id !== id);
      },
      onFollowChange: (event) => {
        lastFollowChange.value = event;
        if (follow.value) {
          follow.value = {
            ...follow.value,
            followedRepoId: event.repoId,
            followedPath: event.path,
          };
        }
      },
      onError: () => {
        // No respawn from a browser: surface the status, let EventSource retry.
        connection.value = 'disconnected';
      },
    });
  }

  /** Close the daemon-scope subscription (teardown/tests). */
  function disconnect(): void {
    subscription?.close();
    subscription = null;
  }

  /** Re-pull the open-repo list (GET /repos carries branches). */
  async function refreshRepos(): Promise<void> {
    try {
      repos.value = await client.listRepos();
    } catch {
      // Unreachable daemon: the SSE error handler owns the status line.
      connection.value = 'disconnected';
    }
  }

  /** Pull the follow state (GET /follow). */
  async function loadFollow(): Promise<void> {
    try {
      follow.value = await client.getFollow();
    } catch {
      connection.value = 'disconnected';
    }
  }

  /**
   * Record a successfully-opened repo and make it active. Does NOT POST:
   * repoStore.open() is the sole opener (one POST /repos per open); this
   * just tracks the result daemon-side state-wise and clears a stale
   * daemon error.
   */
  function trackActive(ref: RepoRef): void {
    upsertRepo(ref);
    activeRepoId.value = ref.id;
    error.value = null;
  }

  /** Release a repo (refcounted daemon-side) and drop it locally. */
  async function closeRepo(id: string): Promise<void> {
    try {
      await client.closeRepo(id);
    } catch (err) {
      error.value = errorMessage(err);
      return;
    }
    repos.value = repos.value.filter((repo) => repo.id !== id);
    if (activeRepoId.value === id) activeRepoId.value = null;
  }

  function toggleFollow(): boolean {
    followEnabled.value = !followEnabled.value;
    return followEnabled.value;
  }

  return {
    // reactive state
    connection,
    repos,
    follow,
    followEnabled,
    lastFollowChange,
    activeRepoId,
    error,
    // actions
    connect,
    disconnect,
    refreshRepos,
    loadFollow,
    trackActive,
    closeRepo,
    toggleFollow,
  };
});
