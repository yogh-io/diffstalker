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

import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import type { SseHandle } from '../api/transport';
import type {
  FollowChangeEvent,
  FollowState,
  RepoRef,
  RepoSummary,
  VersionState,
} from '@diffstalker/client';
import { errorMessage } from '../api/errors';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * loadFollow resilience: the daemon always answers GET /follow when up
 * (even --no-follow returns a FOLLOW_DISABLED state), so a transient
 * failure clears on a bounded retry. These bound the retry so a
 * genuinely-dead daemon does not loop forever.
 */
export const FOLLOW_LOAD_ATTEMPTS = 3;
export const FOLLOW_RETRY_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The follow-change form of a follow target, or null when unset. */
function followTarget(state: FollowState): FollowChangeEvent | null {
  if (state.followedRepoId === null || state.followedPath === null) return null;
  return {
    repoId: state.followedRepoId,
    path: state.followedPath,
    rawContent: state.followedPath,
  };
}

function sameTarget(a: FollowChangeEvent, b: FollowChangeEvent | null): boolean {
  return b !== null && a.repoId === b.repoId && a.path === b.path;
}

/**
 * How often a connected tab re-asks the daemon for version state. The daemon
 * caches npm's answer for six hours, so anything under that only costs a
 * local request; hourly keeps the indicator honest without being chatty.
 */
export const VERSION_POLL_MS = 60 * 60 * 1000;

export const useDaemonStore = defineStore('daemon', () => {
  const client = new DiffstalkerClient();

  const connection = shallowRef<ConnectionStatus>('connecting');
  const repos = shallowRef<RepoSummary[]>([]);
  const follow = shallowRef<FollowState | null>(null);
  const followEnabled = shallowRef(true);
  const lastFollowChange = shallowRef<FollowChangeEvent | null>(null);
  /** One-shot: when a URL pins a repo on cold load, useFollowMode consumes
   * the initial (page-load) follow target without navigating, so the URL is
   * reproducible. Cleared after that one seeded change; live follow resumes. */
  const skipInitialFollow = shallowRef(false);
  const activeRepoId = shallowRef<string | null>(null);
  /** Running daemon version vs the latest on npm (GET /version), for the
   * status bar. Null until the first load; stays null when the daemon
   * cannot answer (the indicator then hides). */
  const version = shallowRef<VersionState | null>(null);
  const error = shallowRef<string | null>(null);
  /**
   * The daemon version this page was served by, remembered from the first
   * answer we ever got. The web UI ships INSIDE the daemon tarball, so the
   * daemon's own version is this bundle's identity — no build stamp needed.
   * When a later poll reports a different one, the daemon was restarted on a
   * new version and the code running in this tab no longer matches the API
   * underneath it.
   */
  const servedBy = shallowRef<string | null>(null);

  let subscription: SseHandle | null = null;
  let versionTimer: ReturnType<typeof setInterval> | null = null;
  // loadFollow guards: `loadingFollow` keeps repeated snapshots from
  // stacking overlapping retry loops; `followLoadedOnce` marks the
  // cold-load done so later loads (reconnects) may re-seed a changed
  // target instead of the strict null-only cold-load behaviour.
  let loadingFollow = false;
  let followLoadedOnce = false;

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
        // Re-pulled on every (re)connect: a reconnect can mean the daemon
        // was restarted on a different version. The daemon caches the npm
        // lookup, so this costs one local request.
        void loadVersion();
        startVersionPolling();
      },
      onRepoOpened: (repo) => upsertRepo(repo),
      onRepoClosed: ({ id }) => {
        repos.value = repos.value.filter((repo) => repo.id !== id);
      },
      onFollowChange: (event) => {
        lastFollowChange.value = event;
        if (follow.value) {
          // followedPath mirrors GET /follow: the followed repo's WORKTREE
          // ROOT. event.path is the hook file CONTENT (often a file inside
          // the repo), so it must NOT be written here — that gave the header
          // a filename (or an empty basename) instead of the repo name, and
          // diverged from the repo the diffs actually switched to. Resolve
          // the root from the open-repo list by id; keep the prior root
          // until repo-opened for this id lands (the header re-derives the
          // name reactively from the id, so it self-heals either way).
          const root =
            repos.value.find((repo) => repo.id === event.repoId)?.path ??
            follow.value.followedPath;
          follow.value = {
            ...follow.value,
            followedRepoId: event.repoId,
            followedPath: root,
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
    stopVersionPolling();
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

  /**
   * Pull the version state (GET /version). Best-effort and silent: this
   * only feeds a status-bar hint, so a failure leaves the last known
   * state (or null) and never touches the connection status — the SSE
   * stream owns that.
   */
  async function loadVersion(): Promise<void> {
    try {
      const state = await client.version();
      version.value = state;
      // First answer of this page load defines what served us. Only ever
      // set once — reassigning on every poll is what would make the
      // upgrade check silently never fire.
      if (servedBy.value === null && state.current !== null) {
        servedBy.value = state.current;
      }
    } catch {
      // Nothing to say: the indicator keeps showing what it had.
    }
  }

  /**
   * Re-ask periodically, because otherwise nobody ever does.
   *
   * loadVersion used to run only on (re)connect. That is exactly wrong for
   * the way this thing is meant to be used: a tab left open on a second
   * monitor holds one SSE connection for days and never asks again, so the
   * "up to date" indicator freezes at whatever was true when the tab opened
   * and fails in the reassuring direction. The daemon's own npm lookup is
   * cached for six hours, so this poll costs one local request per hour and
   * reaches the network at most every sixth.
   *
   * The same poll answers the second question: whether the daemon under
   * this tab has been restarted on a newer version than the one that served
   * the bundle.
   */
  function startVersionPolling(): void {
    if (versionTimer !== null) return;
    versionTimer = setInterval(() => void loadVersion(), VERSION_POLL_MS);
  }

  function stopVersionPolling(): void {
    if (versionTimer === null) return;
    clearInterval(versionTimer);
    versionTimer = null;
  }

  /**
   * Apply a freshly-pulled follow state and seed lastFollowChange.
   *
   * A target the daemon acquired BEFORE this page loaded never arrives
   * as a follow-change event — only here. useFollowMode acts on
   * lastFollowChange, so it must be seeded for cold-load navigation and
   * the toggle-flipped-ON path.
   *
   * FIRST load (cold-load race): seed only when lastFollowChange is
   * null. A live follow-change event may legitimately have set a NEWER
   * target while this GET was in flight; the null-only guard must never
   * overwrite it.
   *
   * LATER loads (SSE reconnect): the cold-load race is over. A
   * follow-change broadcast into the dead stream is never re-sent on
   * reconnect, so if the daemon's target genuinely CHANGED while we were
   * disconnected the header (follow.value) and navigation
   * (lastFollowChange) would diverge. Re-seed when the loaded target
   * differs from the one we last knew; an unchanged target leaves any
   * newer live event intact.
   */
  function applyFollow(state: FollowState): void {
    const prevTarget = follow.value ? followTarget(follow.value) : null;
    follow.value = state;
    const target = followTarget(state);

    if (!followLoadedOnce) {
      followLoadedOnce = true;
      if (lastFollowChange.value === null && target !== null) {
        lastFollowChange.value = target;
      }
      return;
    }

    if (target !== null && !sameTarget(target, prevTarget)) {
      lastFollowChange.value = target;
    }
  }

  /**
   * Pull the follow state (GET /follow), resiliently. The daemon always
   * answers /follow when up, so a transient failure while the SSE stream
   * stays alive is retried a bounded number of times — otherwise a
   * single failed GET would leave follow.value null forever (the SSE
   * snapshot that drives loadFollow only re-fires on a stream reconnect,
   * which is fine here), stranding the UI on the empty state. Overlapping
   * calls (repeated snapshots) do NOT stack: an in-flight load owns the
   * retry window and later calls return early.
   */
  async function loadFollow(): Promise<void> {
    if (loadingFollow) return;
    loadingFollow = true;
    try {
      for (let attempt = 1; attempt <= FOLLOW_LOAD_ATTEMPTS; attempt++) {
        try {
          applyFollow(await client.getFollow());
          return;
        } catch {
          if (attempt < FOLLOW_LOAD_ATTEMPTS) {
            await delay(FOLLOW_RETRY_DELAY_MS);
            continue;
          }
          // Bounded retries exhausted: surface the status, leave follow
          // as-is (the App-level fallback escapes the empty state).
          connection.value = 'disconnected';
        }
      }
    } finally {
      loadingFollow = false;
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
    if (activeRepoId.value === id) {
      activeRepoId.value = null;
    }
  }

  /**
   * Follow navigation is suspended until this timestamp (epoch ms). Back
   * arms it: without a grace period, pressing Back and then saving in the
   * editor half a second later silently undoes the Back — the single most
   * common way this workflow loses a navigation. A time window beats
   * "swallow one event", which would eat a genuine live move minutes later.
   */
  let followSuspendedUntil = 0;

  function suspendFollowNavigation(ms: number): void {
    followSuspendedUntil = Date.now() + ms;
  }

  /** Follow events are still RECORDED while suspended — only acted on later. */
  function followNavigationSuspended(): boolean {
    return Date.now() < followSuspendedUntil;
  }

  function toggleFollow(): boolean {
    followEnabled.value = !followEnabled.value;
    return followEnabled.value;
  }

  /**
   * The active repo, and its path — the join between `repos` and
   * `activeRepoId`, which was re-derived at four call sites. It belongs to the
   * store that owns both halves; this store already carries a comment about a
   * bug where a followed-repo path and the active-repo path drifted apart.
   *
   * NOT for resolving an arbitrary repoId (see the follow handler below, whose
   * event.repoId is precisely the one that is NOT active yet), and not for
   * membership tests scoped to one project's repo list.
   */
  const activeRepo = computed(
    () => repos.value.find((repo) => repo.id === activeRepoId.value) ?? null
  );
  const activeRepoPath = computed(() => activeRepo.value?.path ?? null);

  /**
   * The daemon has been restarted on a different version than the one that
   * served this page, so the bundle in this tab is stale. Passive on
   * purpose: an auto-reload would throw away whatever the user was reading,
   * and this is a tool people leave open precisely to keep looking at it.
   */
  const daemonUpgraded = computed(
    () =>
      servedBy.value !== null &&
      version.value?.current != null &&
      version.value.current !== servedBy.value
  );

  return {
    // reactive state
    connection,
    repos,
    follow,
    followEnabled,
    lastFollowChange,
    skipInitialFollow,
    suspendFollowNavigation,
    followNavigationSuspended,
    activeRepoId,
    activeRepo,
    activeRepoPath,
    version,
    servedBy,
    daemonUpgraded,
    error,
    // actions
    connect,
    disconnect,
    refreshRepos,
    loadFollow,
    loadVersion,
    trackActive,
    closeRepo,
    toggleFollow,
  };
});
