/**
 * useDaemonStore: daemon-scope Pinia store — the open-repo list, follow
 * state, and connection status, fed by the daemon-scope events on the
 * tab's ONE SSE stream (GET /events: snapshot / repo-opened /
 * repo-closed / follow-change / settings-change / discovery-change).
 *
 * This store OWNS that stream. Browsers allow six HTTP/1.1 connections
 * per host and an EventSource holds one open for good, so every other
 * consumer rides along instead of opening its own: settings/discovery
 * events are handed to the settings store, and the active repo's events
 * arrive on the same stream when it is attached (attachRepo reopens it
 * as GET /events?repo=<id> and routes `repo-snapshot` / `state-change`
 * / `journal-append` / `repo-missing` to the repo store's handlers).
 *
 * One stream per tab is still not enough: six open tabs hold six
 * streams, the pool is full, and every fetch in every tab stalls. So a
 * HIDDEN tab holds no stream at all. When the tab is hidden for longer
 * than HIDDEN_CLOSE_DELAY_MS the stream is closed (the delay keeps a
 * quick flick between tabs from churning streams and the snapshot
 * requests); when the tab is visible again it reopens with the current
 * attachment, and the daemon resends `snapshot` and `repo-snapshot`. A
 * tab that is hidden when the stream is first wanted opens nothing until
 * it is shown. This pause is NOT a connection loss: `connection` keeps
 * its value and no error handler fires. The attached repo is told when
 * the stream is back (onResume) so it can refetch what the pause
 * skipped — the journal is append-only, so it would otherwise have a
 * hole. "Back" means the reopened stream delivered its `repo-snapshot`,
 * not that the EventSource was created: the daemon subscribes the
 * stream before it writes that snapshot, so everything after it arrives
 * live, while a refetch fired at creation races the subscribe and can
 * miss an append that lands in between. The daemon-side repo ref is
 * kept the whole time (see App.vue's pagehide note): only the stream
 * pauses, the watchers keep running.
 *
 * The browser CANNOT spawn a daemon (the page is served by one). On
 * connection loss this store only surfaces `connection: 'disconnected'`
 * and lets the native EventSource retry; when the stream reopens the
 * daemon sends a fresh `snapshot`, which repopulates the repo list and
 * flips the status back to 'connected'. An intentional reopen (attach /
 * detach / resume) is not a loss: the old handle is closed first, and a
 * closed EventSource fires no error.
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
import type { DaemonStreamHandlers, RepoAttachment, RepoStreamHandlers } from '../api/client';
import type { SseHandle } from '../api/transport';
import type {
  FollowChangeEvent,
  FollowState,
  RepoRef,
  RepoSummary,
  VersionState,
} from '@diffstalker/client';
import { errorMessage } from '../api/errors';
import { delay } from '../utils/delay';
import { useSettingsStore } from './settings';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * loadFollow resilience: the daemon always answers GET /follow when up
 * (even --no-follow returns a FOLLOW_DISABLED state), so a transient
 * failure clears on a bounded retry. These bound the retry so a
 * genuinely-dead daemon does not loop forever.
 */
export const FOLLOW_LOAD_ATTEMPTS = 3;
export const FOLLOW_RETRY_DELAY_MS = 300;

/** The follow-change form of a follow target, or null when unset. */
function followTarget(state: FollowState): FollowChangeEvent | null {
  if (state.followedRepoId === null || state.followedPath === null) return null;
  return {
    repoId: state.followedRepoId,
    path: state.followedPath,
    rawContent: state.followedPath,
  };
}

/**
 * How often a connected tab re-asks the daemon for version state. The daemon
 * caches npm's answer for six hours, so anything under that only costs a
 * local request; hourly keeps the indicator honest without being chatty.
 */
export const VERSION_POLL_MS = 60 * 60 * 1000;

/**
 * How long a tab stays hidden before its stream is closed. Long enough
 * that flicking between tabs does not close and reopen the stream (and
 * re-run the snapshot requests) every time; short enough that a row of
 * background tabs frees the connection pool within seconds.
 */
export const HIDDEN_CLOSE_DELAY_MS = 10_000;

/**
 * The handlers a repo attaches with: the stream events, plus what the
 * stream owner tells the repo about the stream itself.
 */
export interface RepoAttachHandlers extends RepoStreamHandlers {
  /**
   * The stream reopened after a hidden-tab pause and its first
   * `repo-snapshot` has just been applied (onSnapshot ran). Events sent
   * during the pause were never received: the daemon resends the
   * snapshots, but an append-only log (the journal) has to be refetched.
   * Called after the snapshot on purpose: from that event on the stream
   * is live, so a refetch started now cannot leave a hole.
   */
  onResume?: () => void;
}

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
  /** The repo whose events ride along on the stream, if any. */
  let attachedRepo: { id: string; handlers: RepoAttachHandlers } | null = null;
  /**
   * The stream is wanted but closed because the tab is hidden. Set when
   * a hidden tab's close delay runs out, or when the stream is asked for
   * while the tab is hidden; cleared by the reopen when the tab is shown
   * again, or by disconnect().
   */
  let pausedHidden = false;
  /**
   * The stream was reopened after the hidden pause and the attached repo
   * has not been told yet: its onResume fires on the first
   * `repo-snapshot` of that stream. Cleared by that snapshot, and by a
   * change of attachment (the new repo was never paused) or disconnect().
   */
  let resumePending = false;
  let hiddenCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let watchingVisibility = false;
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
   * The daemon-scope half of the stream. The snapshot handler runs on
   * EVERY (re)open — a reconnect, but also each attach/detach and each
   * resume from hidden — so what it kicks off must be safe to repeat:
   * refreshRepos replaces the list, loadFollow is single-flight and only
   * re-seeds a target whose repo CHANGED,
   * the settings load replaces daemon-owned values, loadVersion pins
   * servedBy once, and the version poll is idempotent.
   */
  const streamHandlers: DaemonStreamHandlers = {
    onSnapshot: (refs) => {
      connection.value = 'connected';
      error.value = null;
      mergeSnapshot(refs);
      // The snapshot has no branches; the REST list does. Fire-and-forget.
      void refreshRepos();
      void loadFollow();
      // Daemon-owned settings + what they discovered. Pulled here (not
      // when the panel opens) because the repo switcher lists discovered
      // repos too, so they must be there before anyone asks.
      void useSettingsStore().load();
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
    // Settings and discovery live in their own store; this stream is the
    // only place their events arrive, so they are handed over here rather
    // than each store opening a second EventSource.
    onSettingsChange: (settings) => useSettingsStore().applySettings(settings),
    onDiscoveryChange: (state) => useSettingsStore().applyDiscovery(state),
    onError: () => {
      // No respawn from a browser: surface the status, let EventSource
      // retry. The attached repo's handlers get the same signal from the
      // client (their onError), so the repo store enters recovery too.
      connection.value = 'disconnected';
    },
  };

  function tabHidden(): boolean {
    return document.visibilityState === 'hidden';
  }

  /**
   * (Re)open the stream for the current attachment. The old handle is
   * closed FIRST: the transport's closed flag drops its late events, and
   * closing fires no error, so a reopen never reads as a lost connection.
   *
   * A hidden tab opens nothing: the stream is marked paused instead, and
   * the visibility handler opens it — with whatever is attached by then —
   * when the tab is shown. So no stream ever exists in a hidden tab,
   * whichever path asked for it (connect, attach, detach, or the repo
   * store's recovery re-attaching).
   */
  function openStream(): void {
    subscription?.close();
    subscription = null;
    clearHiddenCloseTimer();
    watchVisibility();
    if (tabHidden()) {
      pausedHidden = true;
      return;
    }
    pausedHidden = false;
    subscription = client.subscribeEvents(
      streamHandlers,
      attachedRepo === null ? undefined : withResume(attachedRepo)
    );
  }

  /**
   * The attachment as the client sees it: the repo's own handlers, plus
   * the resume signal hung on the first `repo-snapshot` of a stream that
   * reopened after the hidden pause. The snapshot is applied first, so
   * the repo refetches from a state that is already live.
   */
  function withResume(attached: { id: string; handlers: RepoAttachHandlers }): RepoAttachment {
    const { handlers } = attached;
    return {
      id: attached.id,
      handlers: {
        ...handlers,
        onSnapshot: (state) => {
          handlers.onSnapshot(state);
          if (!resumePending) return;
          resumePending = false;
          handlers.onResume?.();
        },
      },
    };
  }

  function watchVisibility(): void {
    if (watchingVisibility) return;
    watchingVisibility = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function clearHiddenCloseTimer(): void {
    if (hiddenCloseTimer === null) return;
    clearTimeout(hiddenCloseTimer);
    hiddenCloseTimer = null;
  }

  /**
   * Hidden: close the stream once the delay runs out — an intentional
   * close, so `connection` and the error handlers are left alone.
   * Visible: cancel a pending close, or reopen a paused stream. The
   * attached repo is told the pause is over when the reopened stream
   * delivers its first `repo-snapshot` (see withResume), not here: a
   * refetch fired now would race the daemon subscribing the new stream.
   */
  function onVisibilityChange(): void {
    if (tabHidden()) {
      if (hiddenCloseTimer !== null || subscription === null) return;
      hiddenCloseTimer = setTimeout(() => {
        hiddenCloseTimer = null;
        subscription?.close();
        subscription = null;
        pausedHidden = true;
      }, HIDDEN_CLOSE_DELAY_MS);
      return;
    }
    clearHiddenCloseTimer();
    if (!pausedHidden) return;
    resumePending = attachedRepo !== null;
    openStream();
  }

  /**
   * Open the stream. Idempotent; EventSource auto-reconnects, and each
   * (re)connect yields a fresh snapshot. Carries the attached repo, if
   * one was attached before this ran. In a hidden tab this only marks
   * the stream as wanted; it opens when the tab is shown.
   */
  function connect(): void {
    if (subscription || pausedHidden) return;
    openStream();
  }

  /**
   * Ride a repo's events along on the stream: reopens it as
   * GET /events?repo=<id>, replacing any previous attachment. The repo
   * store calls this once per open and once per recovery; events from
   * the previous attachment's stream are dropped with its handle. In a
   * hidden tab the attachment is only recorded — the reopen on show
   * carries it.
   */
  function attachRepo(id: string, handlers: RepoAttachHandlers): void {
    attachedRepo = { id, handlers };
    // A new attachment was never paused: nothing to resume.
    resumePending = false;
    openStream();
  }

  /**
   * Drop the attachment and, when the stream is open, reopen it without
   * a repo — the daemon must not keep a subscriber on a repo whose ref
   * this tab has released. A no-op when nothing is attached.
   */
  function detachRepo(): void {
    if (attachedRepo === null) return;
    attachedRepo = null;
    resumePending = false;
    if (subscription) openStream();
  }

  /** Close the stream (teardown/tests). The attachment is kept for connect(). */
  function disconnect(): void {
    subscription?.close();
    subscription = null;
    pausedHidden = false;
    resumePending = false;
    clearHiddenCloseTimer();
    if (watchingVisibility) {
      watchingVisibility = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
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
   * LATER loads (every stream reopen: a reconnect, an attach/detach, a
   * resume from hidden): the cold-load race is over. A follow-change
   * broadcast into a dead or paused stream is never re-sent on reopen,
   * so if the daemon's target genuinely CHANGED meanwhile the header
   * (follow.value) and navigation (lastFollowChange) would diverge.
   * Re-seed when the loaded target's REPO differs from the one we last
   * knew; an unchanged target leaves any newer live event intact.
   *
   * The repo id is the whole comparison, on purpose. The id is a hash of
   * the worktree root, so a different root means a different id; and the
   * root we hold may be stale — the follow-change handler keeps the
   * previous root when the followed repo is not in the open-repo list
   * yet. Comparing paths too made an ordinary reopen (the user picking
   * another repo) look like a changed target, and follow mode then
   * pulled them straight back to the followed repo.
   */
  function applyFollow(state: FollowState): void {
    const prevRepoId = follow.value?.followedRepoId ?? null;
    follow.value = state;
    const target = followTarget(state);

    if (!followLoadedOnce) {
      followLoadedOnce = true;
      if (lastFollowChange.value === null && target !== null) {
        lastFollowChange.value = target;
      }
      return;
    }

    if (target !== null && target.repoId !== prevRepoId) {
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
    attachRepo,
    detachRepo,
    refreshRepos,
    loadFollow,
    loadVersion,
    trackActive,
    closeRepo,
    toggleFollow,
  };
});
