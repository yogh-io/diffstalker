/**
 * useRepoStore: the per-active-repo Pinia store — the browser port of the
 * CLI's RepoSession (packages/cli/src/daemon/RepoSession.ts). Nearly a
 * viewer: the only git mutations it makes are file-level stage / unstage
 * (stageFile / unstageFile → POST /stage, /unstage); no commit, discard,
 * hunk-staging, or remote/branch ops. Its other non-GET requests are
 * POST /repos (attach) and DELETE /repos/:id (release) — refcounting, not
 * git operations. The release fires on a
 * repo switch, on dispose(), and — via releaseOnUnload(), wired to
 * pagehide in App.vue — when the page unloads: without that unload
 * release a reload/close would leak the ref and the daemon would never
 * close a web-touched repo.
 *
 * - shared state (status, hunk counts, stash list, in-progress op, error)
 *   is fed by the per-repo SSE stream through the single applyWireState
 *   sink;
 * - selection tracks the ACTIVE file only (auto mode's anchor and the
 *   list's re-anchoring). It fetches NOTHING — the stacked Changes
 *   surface reads per-file diffs from workingDiffs; the old per-selection
 *   GET /diff path is gone;
 * - workingDiffs is the per-file working-diff cache behind the stacked
 *   Changes surface (docs/web-diff-stream-architecture.md §2): activated
 *   by refreshAllDiffs (two whole-tree pulls split client-side +
 *   per-file pulls for untracked files) — fired automatically on the
 *   repo's first snapshot, retried on later snapshots until it lands —
 *   then kept warm on state-change by refetching ONLY the changed files
 *   (mtimes/hunkCounts/status diffing, whole-tree fallback past 15
 *   files). Entries preserve object identity when content is unchanged
 *   (raw compared by value) so downstream render memos hit; stale
 *   responses are dropped by per-key sequence tokens;
 * - mediaMeta is the per-file image verdict behind the Changes stack's
 *   picture cards, keyed like workingDiffs. Purely on demand (the view
 *   asks for the binary sections a reader can see, at concurrency 4) and
 *   at most once per key; a state-change drops the gate for every touched
 *   file so the mutable worktree side can never go stale;
 * - history and compare are pulled on demand and re-pulled on state-change
 *   when previously loaded;
 * - the journal (the daemon's append-only per-hunk edit chronology) is
 *   lazy-loaded on the Journal view's first activation and then fed by
 *   'journal-append' SSE batches, deduped by seq and applied only when
 *   the batch's epoch matches the cached one (a mismatch means the
 *   daemon store reset — the batch is buffered, never spliced in, and
 *   the log is refetched from scratch); reconnect refetches
 *   ?since=<journalSyncedTo, the watermark only successful fetches
 *   advance>, and an epoch change or pruned gap replaces the log
 *   wholesale ("journal restarted") instead of leaving a silent hole;
 * - the compare base is per-client too: selectedCompareBase rides along
 *   as GET /compare?base=… — nothing is persisted daemon-side.
 *
 * A refused stage/unstage is the one error that OUTLIVES the next wire
 * state: it is kept beside shared.error and re-shown until the outcome
 * it names is reached, superseded, or retried (see the `refusal` field).
 *
 * Everything a view reads is synchronous reactive state (shallowRefs whose
 * whole value is replaced — shallow so object identity survives, which the
 * stale-guard and selection re-anchoring depend on). Shared-state and diff
 * loading collapse errors into shared.error rather than throwing. The two
 * on-demand reads that mirror RepoSession by rejecting a DaemonError to the
 * caller — loadHistory and selectHistoryCommit — are the exceptions; a view
 * calling those awaits and catches (connection errors still collapse quietly).
 *
 * Reconnect: when the SSE stream drops, ONE calm status line lands in
 * shared.error and a single-flight recovery loop re-POSTs /repos (the
 * path-hashed id is stable across a daemon restart), resubscribes, and
 * pulls a fresh status — which clears the line. The browser cannot spawn
 * a daemon (unlike the CLI's ensureDaemon); it just retries until the
 * daemon is back.
 *
 * Deviations from RepoSession, both singleton-store realities:
 * - a generation counter guards async completions across open() calls
 *   (RepoSession is one instance per repo; this store is reused);
 * - open() is the ONE place a repo ref is taken (POST /repos) and it
 *   releases the previous repo's ref after a successful switch, so the
 *   daemon's refcount stays truthful and daemon-side close stays possible.
 */

import { computed, markRaw, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { DaemonError, errorMessage, isConnectionError } from '../api/errors';
import { splitDiffByFile } from '@diffstalker/core/view/splitDiffByFile';
import { isLargeFileDiff } from '@diffstalker/core/git/diffParse';
import { diffModel } from '../utils/diffRows';
import type { DiffModel } from '../utils/diffRows';
import type { SseHandle } from '../api/transport';
import type {
  JournalAppendEvent,
  JournalResponse,
  MediaPair,
  RepoRef,
  WireHunkCounts,
  WireSharedState,
} from '@diffstalker/client';
import type { FileEntry, CommitInfo } from '@diffstalker/core/git/status';
import type { CompareDiff, CompareFileDiff, DiffResult } from '@diffstalker/core/git/diff';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';
import type { JournalEntry } from '@diffstalker/core/types/journal';
import type {
  WholeFileRequest,
  RepoSharedState,
  RepoSelectionState,
  RepoHistoryState,
  RepoCompareState,
  CompareSelectionState,
} from './types';

/** How long changed-file refetches coalesce into one per-file batch. */
const DIFF_DEBOUNCE_MS = 20;

/** Delay before a reconnect attempt after the SSE stream drops. */
const RECONNECT_DELAY_MS = 1000;

/** Max parallel per-file diff fetches for the working-diff cache. */
const WORKING_DIFF_CONCURRENCY = 6;

/**
 * Max parallel /media metadata fetches. Lower than the diff queue on
 * purpose: each one costs the daemon two blob inspections (both sides),
 * it runs ALONGSIDE the diff queue rather than instead of it, and the
 * requests only exist for sections the reader can actually see.
 */
const MEDIA_CONCURRENCY = 4;

/**
 * When a state-change touches more files than this (branch switch,
 * big stash pop), one whole-tree re-pull beats N per-file fetches.
 */
const WHOLE_TREE_REPULL_THRESHOLD = 15;

/** One cached per-file working diff. The DiffResult is markRaw'd. */
export interface WorkingDiffEntry {
  diff: DiffResult;
  /** When this entry's content was applied (epoch ms). */
  fetchedAt: number;
}

/**
 * Value-equality for two diffs, used to PRESERVE OBJECT IDENTITY: an
 * unchanged file keeps its existing DiffResult, so render memos keyed on
 * identity stay hit. This used to compare the raw diff text, which the
 * wire no longer carries (it was a duplicate of `lines`); walking the
 * lines is the same comparison, allocates nothing, and exits at the first
 * difference.
 *
 * editedAt is deliberately NOT compared — the old raw text carried no
 * hunk stamps either, so a re-stamp must not count as a content change.
 */
function sameDiff(a: DiffResult, b: DiffResult): boolean {
  if (a === b) return true;
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i++) {
    if (a.lines[i].content !== b.lines[i].content) return false;
    if (a.lines[i].type !== b.lines[i].type) return false;
  }
  return true;
}

/** The working-diff cache: entries keyed by file-list row key. */
export interface WorkingDiffsState {
  byKey: Map<string, WorkingDiffEntry>;
  /** Bumped on every commit — the shallowRef's change signal. */
  seq: number;
}

/**
 * Cache key for a file-list row: `s:`/`u:` side prefix + path,
 * mirroring the Changes list exactly (a partially staged file has two
 * rows, two entries).
 */
export function workingDiffKey(file: FileEntry): string {
  return `${file.staged ? 's' : 'u'}:${file.path}`;
}

/**
 * Stack key for a compare row. The path alone is NOT unique: with
 * "include uncommitted" on, a file the branch's commits touch and that
 * also has uncommitted edits is listed twice, once per side. Same
 * `c:`/`u:` shape as workingDiffKey so both views key rows alike.
 */
export function compareFileKey(file: CompareFileDiff): string {
  return `${file.isUncommitted ? 'u' : 'c'}:${file.path}`;
}

/** One queued /media fetch; `settle` releases whoever awaited ensureMedia. */
interface MediaRequest {
  key: string;
  path: string;
  staged: boolean;
  settle: () => void;
}

/**
 * A mutation the daemon refused, kept alive across state-changes.
 * `path` + `staged` record what was ASKED FOR, which is how the store
 * knows when the refusal stopped being true (see isRefusalSettled).
 */
interface Refusal {
  message: string;
  path: string;
  staged: boolean;
}

/** The last snapshot workingDiffs changed-set diffing compares against. */
interface WorkingSnapshot {
  files: Map<string, FileEntry>;
  mtimes: Record<string, number> | null;
  hunkCounts: WireHunkCounts | null;
}

/**
 * The single state a lost daemon connection collapses into. Set once
 * (never spammed) so the header shows one calm line while recovery runs
 * in the background; cleared when a fresh snapshot arrives.
 */
export const CONNECTION_LOST_MESSAGE = 'daemon connection lost — reconnecting…';

/**
 * A thrown value as the string to SHOW a user: connection loss collapses to
 * the one calm reconnect line, everything else reports itself.
 *
 * Lives here rather than in api/errors because it needs CONNECTION_LOST_MESSAGE,
 * and moving that constant down into api/errors would make api/errors depend on
 * a store — a cycle dependency-cruiser fails at severity error.
 */
export function displayError(err: unknown): string {
  return isConnectionError(err) ? CONNECTION_LOST_MESSAGE : errorMessage(err);
}

function initialShared(): RepoSharedState {
  return {
    status: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    mtimes: null,
    error: null,
    isLoading: true,
  };
}

function initialSelection(): RepoSelectionState {
  return { file: null };
}

function initialHistory(): RepoHistoryState {
  return { commits: [], selectedCommit: null, commitDiff: null, isLoading: false };
}

function initialCompare(): RepoCompareState {
  return {
    compareDiff: null,
    baseBranch: null,
    commitCount: null,
    loading: false,
    error: null,
    noBaseBranch: false,
    selection: { type: null, index: 0, diff: null },
  };
}

export const useRepoStore = defineStore('repo', () => {
  const client = new DiffstalkerClient();

  // --- Reactive state (shallowRefs, whole-value replacement) ---

  const repoId = shallowRef<string | null>(null);
  const repoPath = shallowRef<string | null>(null);
  const shared = shallowRef<RepoSharedState>(initialShared());
  /**
   * Per-file working-diff cache (§2 of the diff-stream design). Whole
   * value replaced on every commit; the entries' DiffResults are
   * markRaw'd (deep-proxying thousands of line objects would dominate
   * reactivity cost) and identity-preserved when content is unchanged.
   */
  const workingDiffs = shallowRef<WorkingDiffsState>({ byKey: new Map(), seq: 0 });
  /**
   * Image metadata per changed file (both sides, renames already
   * resolved by the daemon), keyed like workingDiffs so a partially
   * staged file's two sections get their own verdicts. Filled ONLY on
   * demand — the Changes view asks for the binary sections a reader can
   * see — because each entry costs the daemon two blob inspections.
   * markRaw'd: these are inert wire objects, and the pairs are handed
   * straight to an <img src>, so deep reactivity would buy nothing.
   */
  const mediaMeta = shallowRef(new Map<string, MediaPair>());
  const selection = shallowRef<RepoSelectionState>(initialSelection());
  const history = shallowRef<RepoHistoryState>(initialHistory());
  /**
   * The journal slice (stores/types.ts JournalStoreSlice): the daemon's
   * append-only per-hunk edit chronology, entries in seq order deduped
   * by seq — seq is the only ordering axis, ts a display label. Whole
   * array replaced on every change (shallowRef); folding into display
   * rows is a pure projection the view computes (utils/foldEntries).
   */
  const journalEntries = shallowRef<JournalEntry[]>([]);
  /**
   * The daemon journal-store's epoch (an opaque string, compared by
   * equality only), null until the first load. A different epoch on
   * reconnect means a new store (daemon restart / eviction) whose seq
   * space is unrelated: refetch from scratch.
   */
  const journalEpoch = shallowRef<string | null>(null);
  /** Ring-buffer eviction watermark: entries below it are gone. */
  const journalPrunedBefore = shallowRef(0);
  /** True once the lazy first load landed (Journal view activation). */
  const journalLoaded = shallowRef(false);
  /**
   * A journal reset (epoch change or pruned gap on reconnect) replaced
   * the entries wholesale — the view renders a "journal restarted"
   * divider instead of a silent hole.
   */
  const journalRestarted = shallowRef(false);
  const compare = shallowRef<RepoCompareState>(initialCompare());
  /**
   * The base branch the compare view reads against, per-client. Null
   * means "let the daemon detect one". Sent as GET /compare?base=… —
   * never persisted daemon-side (the viewer mutates nothing).
   */
  const selectedCompareBase = shallowRef<string | null>(null);

  /**
   * Whole-file mode: the one file currently drawn in full instead of as
   * hunks, and its wide-context diff. ONE slot, not a variant dimension
   * on workingDiffs — the mode applies to exactly one file at a time (the
   * anchored one), which is what keeps it addressable as a single URL key
   * rather than an expansion set. See docs/whole-file-mode.md.
   *
   * It lives in the store rather than the component because the working
   * tree moves underneath: the U3 entry refreshes on every file-watcher
   * state-change, and a component-held body would keep rendering the text
   * the file used to have — a lying diff in exactly the case the mode is
   * most wanted.
   *
   * Deliberately NOT stamped with hunk edit times (the daemon skips
   * stampDiff for it), so whole-file mode shows no per-hunk age. The U3
   * body stays in workingDiffs, so toggling back restores all of it.
   */
  const wholeFile = shallowRef<{ key: string; path: string; diff: DiffResult } | null>(null);
  /** The request that filled the slot, replayed when the tree moves. */
  let wholeFileRequest: WholeFileRequest | null = null;
  /** Whole-file fetch in flight (the toggle renders busy). */
  const wholeFileLoading = shallowRef(false);
  /**
   * Why the last whole-file request could not be served, keyed by the row
   * that asked. The mode stays OFF and the hunks stay on screen — asking
   * for MORE context must never leave you with less than you had.
   */
  const wholeFileRefusal = shallowRef<{ key: string; reason: string } | null>(null);
  /** Guards against an older whole-file response landing over a newer one. */
  let wholeFileFetchSeq = 0;

  const isRepo = computed(() => repoId.value !== null);

  // --- Non-reactive internals ---

  let generation = 0;
  /**
   * The repo id whose daemon-side ref this store currently holds — the
   * last successful open's ref, not yet released. Tracked separately
   * from repoId because open() nulls repoId up front: during rapid
   * open churn (open A, open B before A resolves) repoId is already
   * null when the second open starts, but the previously held ref
   * still must be released after the next successful open.
   */
  let heldRepoId: string | null = null;
  /**
   * The standing refusal (null when none). Held OUTSIDE shared.error
   * because every wire state overwrites that field: without it, the
   * next state-change — and a competing git process finishing is itself
   * one — erased the reason the user's click failed, a tick after they
   * read it. See errorLineFor for how the two are merged.
   */
  let refusal: Refusal | null = null;
  let subscription: SseHandle | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let recovering = false;
  let historyPullInFlight = false;
  /** Single-flight guard for the lazy loadJournal pull. */
  let journalLoadInFlight = false;
  /** Single-flight guard for the post-reconnect journal resync. */
  let journalPullInFlight = false;
  /**
   * The resync watermark: the highest seq a SUCCESSFUL journal fetch
   * (load, resync, wholesale refetch) proved contiguous. Live SSE
   * appends never advance it — after a disconnect, appends on the new
   * stream push the tail past the still-unfetched gap, and a second
   * disconnect resyncing from that tail would skip the gap forever.
   * The ?since= floor for every resync.
   */
  let journalSyncedTo = 0;
  /**
   * Epoch of the pre-load 'journal-append' accumulation (the batches
   * applied before the first loadJournal). Tracked so accumulation
   * never interleaves entries across a daemon store reset, and so
   * loadJournal can discard an accumulation from a different epoch
   * instead of merging two seq spaces.
   */
  let preloadAppendEpoch: string | null = null;
  /**
   * Batches whose epoch mismatched the cached one, parked while the
   * from-scratch refetch runs; merged afterwards when their epoch
   * matches the refetched store (they raced the reset — dropping them
   * would reopen the very hole the epoch check exists to close).
   */
  let epochResetBuffer: JournalAppendEvent[] = [];
  let lastIncludeUncommitted = false;
  let historyCount = 100;
  /**
   * Monotonic refreshCompare sequence: each request captures the counter
   * and only the latest one may apply its response, so a slow older pull
   * (e.g. uncommitted ON) landing after a fast newer one (uncommitted
   * OFF) cannot overwrite the state the UI's controls reflect.
   */
  let compareRequestSeq = 0;
  /**
   * Same guard for the standalone commit-count pulls, and the handshake
   * between them and a full compare load: whichever bumps this last owns
   * commitCount, so a slow count response cannot land on top of the fresher
   * number a completed compare already wrote.
   */
  let compareCountSeq = 0;
  /**
   * True once refreshAllDiffs has run for this repo: only then do
   * state-changes cascade into per-file cache refetches (mirrors
   * history/compare, which also re-pull only once loaded).
   */
  let workingDiffsActive = false;
  /** Single-flight guard for the snapshot-triggered activation pull. */
  let workingDiffsPullInFlight = false;
  /**
   * Monotonic count of applied wire states. The activation pull
   * captures it before its whole-tree fetch: a state-change applied
   * WHILE the pull was in flight missed the changed-set cascade (the
   * cache was still inactive), so an advanced counter afterwards means
   * that window must be re-diffed.
   */
  let appliedStateCount = 0;
  /**
   * Monotonic token shared by ALL working-diff fetches (whole-tree and
   * per-file), captured at request start. appliedSeqByKey records the
   * token whose response each entry currently holds; a response only
   * applies when no later-started request already landed on that key —
   * a stale response can never overwrite a newer entry.
   */
  let workingDiffFetchSeq = 0;
  const appliedSeqByKey = new Map<string, number>();
  /**
   * Keys whose /media answer is current or on its way — the "once per
   * key" gate. A key is removed when its file leaves the status set,
   * when a state-change touches it (so the mutable worktree side is
   * re-asked), and when its fetch failed (so a later look retries).
   * Separate from mediaMeta because the two answer different questions:
   * "is there anything to draw" vs "must this be fetched again".
   */
  const mediaRequested = new Set<string>();
  /** Media fetches waiting for one of the MEDIA_CONCURRENCY slots. */
  const mediaQueue: MediaRequest[] = [];
  let mediaWorkers = 0;
  /** Changed files coalescing in the 20ms refetch window, by row key. */
  const pendingChangedFiles = new Map<string, FileEntry>();
  let workingDiffsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The previous wire state's slice the changed-set diffing reads. */
  let workingSnapshot: WorkingSnapshot | null = null;

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (workingDiffsDebounceTimer) {
      clearTimeout(workingDiffsDebounceTimer);
      workingDiffsDebounceTimer = null;
    }
  }

  // --- Lifecycle ---

  /** Drop everything that belongs to the repo being left behind. */
  function resetForNewRepo(): void {
    subscription?.close();
    subscription = null;
    clearTimers();
    recovering = false;
    // A refusal belongs to the repo it was refused in.
    refusal = null;
    historyPullInFlight = false;
    journalLoadInFlight = false;
    journalPullInFlight = false;
    journalSyncedTo = 0;
    preloadAppendEpoch = null;
    epochResetBuffer = [];
    lastIncludeUncommitted = false;
    historyCount = 100;

    workingDiffsActive = false;
    workingSnapshot = null;
    appliedSeqByKey.clear();
    pendingChangedFiles.clear();
    // Media is per-repo and keyed by path: a same-path file in the next
    // repo must never inherit the previous repo's verdict. In-flight
    // fetches are already fenced by the generation guard.
    mediaRequested.clear();
    mediaQueue.length = 0;

    shared.value = initialShared();
    workingDiffs.value = { byKey: new Map(), seq: 0 };
    mediaMeta.value = new Map();
    selection.value = initialSelection();
    history.value = initialHistory();
    journalEntries.value = [];
    journalEpoch.value = null;
    journalPrunedBefore.value = 0;
    journalLoaded.value = false;
    journalRestarted.value = false;
    compare.value = initialCompare();
    selectedCompareBase.value = null;
    // Repo B must not inherit repo A's whole-file key: it would name a
    // file that may not exist here, and the first URL write would carry
    // `whole=1` into the new repo's address.
    wholeFile.value = null;
    wholeFileLoading.value = false;
    wholeFileRefusal.value = null;
    wholeFileRequest = null;
    wholeFileFetchSeq++;
  }

  /**
   * Open a repo — the SOLE place a repo ref is taken (POST /repos) — and
   * subscribe to its SSE stream. After a successful open, the previous
   * repo's ref is released: net-zero on a switch (release old, hold new)
   * AND on a re-open of the same repo (the POST bumped it to 2, the
   * release brings it back to 1). A superseded open (a newer open()
   * started while this one's POST was in flight) releases the ref it just
   * acquired instead — no refcount leaks under churn. Returns the opened
   * ref, or null when the open failed or was superseded.
   *
   * NOTHING is torn down until the POST answers. A refusal (the path is
   * gone, or is not a repo) then costs nothing: the repo on screen keeps
   * its id, its path, its state and its live stream, and the reason lands
   * in shared.error. Wiping first — as this did — left repoId null while
   * the rest of the app still named the old repo, so its view rendered
   * over empty stores and every URL/id-derived thing disagreed about
   * which repo was open.
   *
   * A connection error is different in kind: the daemon is unreachable,
   * not the repo bad, so the store commits to the requested path (repoId
   * null, repoPath = path) and the reconnect loop retries THAT — the repo
   * the user asked for, not the one they were leaving.
   */
  async function open(path: string): Promise<RepoRef | null> {
    const gen = ++generation;
    // Adopt a directly-assigned repoId (tests) into the held tracking.
    heldRepoId ??= repoId.value;

    try {
      const ref = await client.openRepo(path);
      if (gen !== generation) {
        // Superseded by a newer open(): release the ref THIS call just
        // acquired — the newer open owns releasing whatever is held.
        client.closeRepo(ref.id).catch(() => {});
        return null;
      }
      if (heldRepoId !== null) {
        // Release the prior ref (fire-and-forget): the switch (or same-repo
        // re-open) must not leak a daemon-side refcount.
        client.closeRepo(heldRepoId).catch(() => {});
      }
      resetForNewRepo();
      heldRepoId = ref.id;
      repoId.value = ref.id;
      repoPath.value = ref.path;
      connect();
      return ref;
    } catch (err) {
      if (gen !== generation) return null;
      if (isConnectionError(err)) {
        // Daemon unreachable mid-open: commit to the requested path so
        // recovery retries it, then one calm line + background retry.
        resetForNewRepo();
        repoId.value = null;
        repoPath.value = path;
        handleConnectionLoss();
        return null;
      }
      // Refused: nothing moved. The previous repo is still open, still
      // streaming, still on screen — only the reason is new.
      shared.value = { ...shared.value, error: errorMessage(err), isLoading: false };
      return null;
    }
  }

  /** Subscribe to the repo's SSE stream. No-op in not-a-repo mode. */
  function connect(): void {
    if (repoId.value === null) return;
    subscription?.close();
    subscription = client.subscribeRepo(repoId.value, {
      onSnapshot: (state) => applyWireState(state),
      onStateChange: (state) => applyWireState(state),
      onJournalAppend: (event: JournalAppendEvent) => applyJournalAppend(event),
      // An EventSource error IS the connection-down signal; recovery is
      // managed here (close + retry loop), not by the browser's auto-retry,
      // because a restarted daemon needs the repo re-POSTed first.
      onError: () => handleConnectionLoss(),
    });
  }

  /**
   * Unsubscribe and release the daemon-side refcount. The store can be
   * reused afterwards via open().
   */
  async function dispose(): Promise<void> {
    const gen = ++generation;
    subscription?.close();
    subscription = null;
    clearTimers();
    recovering = false;
    const id = repoId.value ?? heldRepoId;
    heldRepoId = null;
    if (id !== null) {
      await client.closeRepo(id).catch(() => {});
      if (gen !== generation) return;
      repoId.value = null;
    }
  }

  /**
   * Best-effort ref release for page unload (App.vue's pagehide
   * handler): a keepalive DELETE that outlives the page — a plain
   * closeRepo() would be aborted mid-unload and leak the ref, leaving
   * the daemon's watchers running forever for a tab that no longer
   * exists. Synchronous and fire-and-forget by design. Clears the
   * held-ref tracking so a bfcache resurrection re-acquires cleanly
   * through the recovery loop (the dead SSE stream triggers it, and
   * recover() re-POSTs /repos) instead of double-releasing later.
   */
  function releaseOnUnload(): void {
    // heldRepoId alone: it is the truthful "we hold a daemon ref"
    // tracking, and clearing it makes a repeat pagehide a no-op — a
    // second DELETE would steal another client's ref.
    const id = heldRepoId;
    if (id === null) return;
    heldRepoId = null;
    client.releaseRepoOnUnload(id);
  }

  // --- Reconnect (single-flight, no daemon spawn) ---

  function handleConnectionLoss(): void {
    subscription?.close();
    subscription = null;
    // A dead daemon supersedes any standing refusal: it is the more
    // urgent condition, and nothing can be resolved until it is back.
    refusal = null;
    // Set the message exactly once so the header doesn't flicker on every
    // failed call; recovery clears it when a fresh snapshot lands. Also
    // drop isLoading so a pre-first-snapshot drop doesn't leave a view
    // stuck on a loading state beside the error line.
    if (shared.value.error !== CONNECTION_LOST_MESSAGE) {
      shared.value = { ...shared.value, error: CONNECTION_LOST_MESSAGE, isLoading: false };
    }
    scheduleRecovery();
  }

  function scheduleRecovery(): void {
    if (recovering || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void recover(); // catches internally, never rejects
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Single-flight recovery: re-POST /repos (a restarted daemon has an
   * empty registry; the path-hashed id is stable), resubscribe, and apply
   * a fresh /status snapshot — which clears the connection error. On any
   * failure, keep the error and retry. Never throws.
   *
   * The re-POST deliberately does NOT release anything: against a
   * restarted daemon there is nothing to release, and against a
   * live-daemon blip the extra count is an accepted minor over-count
   * (matching the CLI's RepoSession).
   */
  async function recover(): Promise<void> {
    const path = repoPath.value;
    if (recovering || path === null) return;
    recovering = true;
    const gen = generation;
    try {
      const ref = await client.openRepo(path);
      if (gen !== generation) return;
      // Track the ref when nothing was held (a held id stays: it is a
      // still-unreleased older repo the next successful open releases).
      heldRepoId ??= ref.id;
      repoId.value = ref.id;
      connect();
      const state = await client.status(ref.id);
      if (gen !== generation) return;
      applyWireState(state);
      // The SSE stream was down: refetch the journal tail (or discard
      // a pre-load accumulation) so the append-only log has no hole.
      // The resync floors on journalSyncedTo — the watermark only
      // successful fetches advance — never the live tail: appends on
      // the fresh stream may already sit past a still-unfetched gap,
      // and an INTERRUPTED earlier recovery must not move the floor.
      void resyncJournal(); // catches internally; never rejects
    } catch {
      // Still down (or down again mid-recovery): keep the error, retry.
      recovering = false;
      if (gen === generation) scheduleRecovery();
      return;
    }
    recovering = false;
  }

  // --- Shared state ---

  /**
   * THE single sink: applies a wire state (SSE snapshot/state-change),
   * then cascades — re-anchor the selection, keep the working-diff
   * cache warm (activating it on the first snapshot), re-pull
   * history/compare when already loaded.
   */
  function applyWireState(wire: WireSharedState): void {
    appliedStateCount += 1;
    const prevSnapshot = workingSnapshot;
    workingSnapshot = snapshotWorkingState(wire);
    shared.value = {
      status: wire.status,
      hunkCounts: wire.hunkCounts,
      stashList: wire.stashList,
      operationInProgress: wire.operationInProgress,
      mtimes: wire.mtimes,
      error: errorLineFor(wire),
      isLoading: false,
    };
    refreshSelectionAfterStatus();
    invalidateMediaAfterState(prevSnapshot);
    if (workingDiffsActive) {
      updateWorkingDiffsAfterState(prevSnapshot);
    } else {
      // First snapshot (or an earlier activation failed): pull the whole
      // tree so the stacked Changes surface has diffs from the start.
      void activateWorkingDiffs(); // catches internally; never rejects
    }
    if (history.value.commits.length > 0) {
      void reloadHistory();
    }
    if (compare.value.compareDiff !== null && !compare.value.loading) {
      void refreshCompare(lastIncludeUncommitted);
    } else {
      // Compare is not open: still keep the rail's commit count current,
      // which costs one rev-list rather than a whole CompareDiff. (When it
      // IS open, the refresh above carries the count with it.)
      void refreshCompareCount();
    }
  }

  /** Surface an error in the UI; cleared by the next applied state. */
  function setError(message: string): void {
    shared.value = { ...shared.value, error: message };
  }

  /**
   * The error line a freshly applied wire state gets.
   *
   * The daemon's own error always wins — it is the newest word about the
   * repo, and it retires the refusal with it. Otherwise a refusal that is
   * still true keeps its line, instead of being wiped by a state-change
   * that has nothing to do with it.
   */
  function errorLineFor(wire: WireSharedState): string | null {
    if (wire.error !== null) {
      refusal = null;
      return wire.error;
    }
    if (refusal !== null && isRefusalSettled(refusal, wire)) refusal = null;
    return refusal?.message ?? null;
  }

  /**
   * A refusal is settled once the status shows the outcome that was
   * asked for, however it was reached — staged from the terminal, the
   * file deleted, the conflict resolved. The button acts on ONE side (a
   * stage on the unstaged row, an unstage on the staged one), so the
   * asked-for outcome is that side being gone.
   *
   * Without this the line would outlive its cause and describe a block
   * that no longer exists. A null status proves nothing, so it holds.
   */
  function isRefusalSettled(current: Refusal, wire: WireSharedState): boolean {
    const files = wire.status?.files;
    if (!files) return false;
    return !files.some((f) => f.path === current.path && f.staged !== current.staged);
  }

  /**
   * Record a refused mutation and show it. Names the action and the file
   * so the line reads as a report of one attempt — it may outlive the
   * state-change that follows it, and a bare git message would then read
   * as a claim about the repo as a whole.
   */
  function setRefusal(path: string, staged: boolean, reason: string): void {
    const message = `Could not ${staged ? 'stage' : 'unstage'} ${path}: ${reason}`;
    refusal = { message, path, staged };
    shared.value = { ...shared.value, error: message };
  }

  /**
   * Retire the standing refusal because the user is trying again. The
   * line goes with it only when it is still the one on screen — a newer
   * error must not be wiped.
   */
  function clearRefusal(): void {
    const current = refusal;
    refusal = null;
    if (current !== null && shared.value.error === current.message) {
      shared.value = { ...shared.value, error: null };
    }
  }

  /**
   * Stage or unstage one file by path — the ONLY working-tree mutations
   * the web UI makes. The daemon does the git op and broadcasts the fresh
   * status over the SSE stream (applyWireState's single sink), which is
   * how the view updates — we deliberately do NOT apply the POST's own
   * {state} envelope: a slow response could land AFTER a newer
   * state-change (an interleaved live edit) and regress the view, and
   * applyWireState has no ordering guard. Awaiting the POST only lets a
   * git refusal surface in shared.error; a connection loss enters the
   * reconnect state; a repo switch mid-flight drops the error so it can't
   * touch the new repo.
   *
   * A refusal is STICKY (see the `refusal` field): it survives the
   * state-changes that follow it, so the explanation is still there when
   * the user looks up from the click that failed.
   */
  async function setStaged(path: string, staged: boolean): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    // A fresh attempt supersedes the previous one's reason.
    clearRefusal();
    try {
      if (staged) await client.stage(id, path);
      else await client.unstage(id, path);
    } catch (err) {
      if (gen !== generation) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setRefusal(path, staged, errorMessage(err));
    }
  }

  function stageFile(path: string): Promise<void> {
    return setStaged(path, true);
  }

  function unstageFile(path: string): Promise<void> {
    return setStaged(path, false);
  }

  /**
   * Run a daemon read. On connection loss: enter the reconnect state and
   * resolve to `fallback` — never throw into a view. A DaemonError
   * propagates to the caller's own error handling.
   */
  async function read<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    const gen = generation;
    try {
      return await op();
    } catch (err) {
      // Repo switched (open()) while this read was in flight: drop it silently
      // so a stale failure can't touch the new repo's state.
      if (gen !== generation) return fallback;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return fallback;
      }
      throw err;
    }
  }

  /** Pull fresh shared state from the daemon. */
  async function refresh(): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    shared.value = { ...shared.value, isLoading: true };
    try {
      const state = await client.status(id);
      if (gen !== generation) return;
      applyWireState(state);
    } catch (err) {
      if (gen !== generation) return;
      shared.value = { ...shared.value, isLoading: false };
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setError(`Failed to refresh: ${errorMessage(err)}`);
    }
  }

  // --- File selection (active file only) ---

  /**
   * Record the active file — auto mode's anchor and the list's
   * re-anchoring target. Fetches NOTHING: the stacked Changes surface
   * reads per-file diffs from workingDiffs.
   */
  function selectFile(file: FileEntry | null): void {
    selection.value = { file };
  }

  /**
   * After fresh status arrives, re-anchor the selection to the matching
   * entry in the new file list (preferring the same staged side). A
   * vanished file clears the selection.
   */
  function refreshSelectionAfterStatus(): void {
    const selected = selection.value.file;
    const status = shared.value.status;
    if (!selected || !status) return;

    const match =
      status.files.find((f) => f.path === selected.path && f.staged === selected.staged) ??
      status.files.find((f) => f.path === selected.path);
    selection.value = match ? { file: match } : initialSelection();
  }

  // --- Working-diff cache (per-file, stacked Changes surface) ---

  function snapshotWorkingState(wire: WireSharedState): WorkingSnapshot {
    return {
      files: new Map((wire.status?.files ?? []).map((f) => [workingDiffKey(f), f])),
      mtimes: wire.mtimes,
      hunkCounts: wire.hunkCounts,
    };
  }

  /**
   * Replace the cache map immutably; the shallowRef signals on every
   * commit. mutate returns false to skip the commit entirely (no
   * reactive churn when nothing changed).
   */
  function commitWorkingDiffs(mutate: (byKey: Map<string, WorkingDiffEntry>) => boolean): void {
    const prev = workingDiffs.value;
    const byKey = new Map(prev.byKey);
    if (!mutate(byKey)) return;
    workingDiffs.value = { byKey, seq: prev.seq + 1 };
  }

  /**
   * Land one per-file response. Drops stale responses (a later-started
   * request already applied to this key), drops keys that left the
   * status set while the fetch was in flight, and preserves identity:
   * an unchanged raw keeps the SAME entry — same DiffResult object, no
   * commit, no reactive signal.
   */
  function applyWorkingDiff(key: string, token: number, diff: DiffResult): void {
    if ((appliedSeqByKey.get(key) ?? 0) > token) return;
    if (workingSnapshot !== null && !workingSnapshot.files.has(key)) return;
    appliedSeqByKey.set(key, token);
    const cached = workingDiffs.value.byKey.get(key);
    if (cached && sameDiff(cached.diff, diff)) return;
    commitWorkingDiffs((byKey) => {
      byKey.set(key, { diff: markRaw(diff), fetchedAt: Date.now() });
      return true;
    });
  }

  /**
   * Fetch per-file diffs through a bounded queue (concurrency 6).
   * Untracked files fetch without a staged flag — the daemon 400s
   * staged=true for them. Never rejects; errors collapse like the
   * selection fetch (connection loss -> reconnect, else shared.error).
   */
  async function fetchWorkingDiffsFor(files: FileEntry[]): Promise<void> {
    const id = repoId.value;
    if (id === null || files.length === 0) return;
    const gen = generation;
    const queue = [...files];
    let lost = false;
    // ONE setError per batch (like the whole-tree pull), not one per
    // failed file — N failures would rewrite shared.error N times.
    let firstFailure: string | null = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift();
        if (!file || lost || gen !== generation) return;
        const key = workingDiffKey(file);
        const token = ++workingDiffFetchSeq;
        try {
          const diff =
            file.status === 'untracked'
              ? await client.diff(id, { path: file.path })
              : await client.diff(id, { path: file.path, staged: file.staged });
          if (gen !== generation) return;
          applyWorkingDiff(key, token, diff);
        } catch (err) {
          if (gen !== generation) return;
          if (isConnectionError(err)) {
            lost = true;
            handleConnectionLoss();
            return;
          }
          firstFailure ??= errorMessage(err);
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(WORKING_DIFF_CONCURRENCY, queue.length) },
      () => worker() // catches internally; never rejects
    );
    await Promise.all(workers);
    if (firstFailure !== null && !lost && gen === generation) {
      setError(`Failed to load diffs: ${firstFailure}`);
    }
  }

  /**
   * The snapshot-triggered activation: one refreshAllDiffs at a time.
   * Runs on every applied wire state while the cache is inactive, so a
   * failed activation (daemon hiccup) retries on the next snapshot /
   * state-change instead of silently staying empty. QUIET on daemon
   * errors: this passive warm-up must not overwrite a fresher wire
   * error on every retry — the stack just keeps its placeholders until
   * a pull lands. (Connection errors still enter the reconnect loop.)
   */
  async function activateWorkingDiffs(): Promise<void> {
    if (workingDiffsPullInFlight || repoId.value === null) return;
    workingDiffsPullInFlight = true;
    const gen = generation;
    const snapshotBefore = workingSnapshot;
    const countBefore = appliedStateCount;
    try {
      await refreshAllDiffs({ quiet: true }); // catches internally; never rejects
    } finally {
      workingDiffsPullInFlight = false;
    }
    // A state-change applied while the whole-tree pull was in flight
    // missed the changed-set cascade (the cache was still inactive):
    // re-run it across that window so the fresh edit isn't served from
    // the stale tree. Quiet like the pull; skipped when the activation
    // failed (the next state retries the whole pull anyway).
    if (gen !== generation || !workingDiffsActive) return;
    if (appliedStateCount !== countBefore) {
      updateWorkingDiffsAfterState(snapshotBefore);
    }
  }

  /**
   * Activate (or fully re-pull) the cache: two whole-tree pulls —
   * GET /diff (unstaged) and GET /diff?staged=true — split client-side
   * into per-file entries, then untracked files (absent from git diff)
   * fetched per-file through the bounded queue. Applies in ONE commit;
   * evicts entries whose file left the status set; value-equal raws
   * keep their objects (stale-while-revalidate — nothing ever blanks).
   * `quiet` keeps a daemon error out of shared.error (the activation
   * retry path); explicit calls surface it.
   */
  async function refreshAllDiffs(opts: { quiet?: boolean } = {}): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    const token = ++workingDiffFetchSeq;
    let unstagedTree: DiffResult;
    let stagedTree: DiffResult;
    try {
      [unstagedTree, stagedTree] = await Promise.all([
        client.diff(id, {}),
        client.diff(id, { staged: true }),
      ]);
    } catch (err) {
      // Activation stays off on failure: an active-but-empty cache would
      // only refetch CHANGED files on later state-changes, silently
      // staying partial. Inactive, the next refreshAllDiffs re-pulls all.
      if (gen !== generation) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      if (!opts.quiet) setError(`Failed to load diffs: ${errorMessage(err)}`);
      return;
    }
    if (gen !== generation) return;
    workingDiffsActive = true;

    const files = shared.value.status?.files ?? [];
    const validKeys = new Set(files.map(workingDiffKey));
    commitWorkingDiffs((byKey) => {
      let dirty = applyTreeSide(byKey, 'u', splitDiffByFile(unstagedTree), validKeys, token);
      dirty = applyTreeSide(byKey, 's', splitDiffByFile(stagedTree), validKeys, token) || dirty;
      for (const key of [...byKey.keys()]) {
        if (!validKeys.has(key)) {
          byKey.delete(key);
          appliedSeqByKey.delete(key);
          dirty = true;
        }
      }
      return dirty;
    });

    await fetchWorkingDiffsFor(files.filter((f) => f.status === 'untracked'));
  }

  /**
   * Merge one side of a split whole-tree pull into the map: keys must
   * still be in the status set, later-started per-file pulls win (seq),
   * value-equal raws keep their objects. Returns whether anything moved.
   */
  function applyTreeSide(
    byKey: Map<string, WorkingDiffEntry>,
    side: 's' | 'u',
    byPath: Map<string, DiffResult>,
    validKeys: Set<string>,
    token: number
  ): boolean {
    let dirty = false;
    for (const [path, diff] of byPath) {
      const key = `${side}:${path}`;
      if (!validKeys.has(key)) continue;
      if ((appliedSeqByKey.get(key) ?? 0) > token) continue; // a newer per-file pull landed
      appliedSeqByKey.set(key, token);
      const cached = byKey.get(key);
      if (cached && sameDiff(cached.diff, diff)) continue; // identity preserved
      byKey.set(key, { diff: markRaw(diff), fetchedAt: Date.now() });
      dirty = true;
    }
    return dirty;
  }

  /**
   * The read behind one whole-file request. Compare's rows are pulled per
   * file from the daemon (the stack pulls the range whole and splits it
   * client-side, so there is no per-file request to widen), and its
   * uncommitted rows sit against HEAD rather than against the base.
   */
  function fetchWholeDiff(id: string, request: WholeFileRequest): Promise<DiffResult> {
    if (request.view === 'history') {
      return client.commitDiff(id, request.hash, { path: request.path, whole: true });
    }
    if (request.view === 'compare') {
      return client.compareFileDiff(id, {
        path: request.path,
        base: selectedCompareBase.value ?? undefined,
        uncommitted: request.uncommitted,
        whole: true,
      });
    }
    const entry = workingSnapshot?.files.get(request.key);
    return client.diff(id, {
      path: entry?.path ?? request.path,
      staged: entry?.staged ?? false,
      whole: true,
    });
  }

  /**
   * Turn whole-file mode on for one row, or off with null. Turning it on
   * for another row turns it off for the previous one — one slot.
   *
   * The request names its SURFACE, not just a key: Changes and Compare
   * both use `u:`-prefixed keys, and the two mean different comparisons
   * (index-vs-worktree, and HEAD-vs-worktree inside a branch comparison).
   * A key alone could not pick the right read.
   *
   * Never rejects. A failed fetch leaves the mode OFF rather than on-and-
   * empty: the hunks stay on screen, which is the truthful fallback.
   * An untracked file is refused here rather than fetched — its diff is
   * already the whole file, and the daemon has no wider context to give.
   */
  async function setWholeFile(request: WholeFileRequest | null): Promise<void> {
    const id = repoId.value;
    const token = ++wholeFileFetchSeq;
    wholeFileRequest = request;
    if (request === null || id === null) {
      wholeFile.value = null;
      wholeFileLoading.value = false;
      wholeFileRefusal.value = null;
      return;
    }
    const key = request.key;
    if (request.view === 'changes') {
      const entry = workingSnapshot?.files.get(key);
      if (!entry || entry.status === 'untracked') {
        wholeFile.value = null;
        wholeFileLoading.value = false;
        wholeFileRefusal.value = null;
        return;
      }
    }
    wholeFileRefusal.value = null;
    // Drop the old body immediately: keeping file A's text on screen
    // while file B loads would render one file's diff under another's
    // header.
    wholeFile.value = null;
    wholeFileLoading.value = true;
    const gen = generation;
    try {
      const diff = await fetchWholeDiff(id, request);
      if (gen !== generation || token !== wholeFileFetchSeq) return;
      // The daemon withheld it: at full context this file is over the
      // per-file diff cap. Installing that response would REPLACE a
      // perfectly good hunk view with "Large file — diff not shown" — the
      // reader asked for more of the file and would be left with none of
      // it. Refuse instead, keep the hunks, and say why on the toggle.
      if (isLargeFileDiff(diff)) {
        wholeFileRefusal.value = {
          key,
          reason: 'Too large to show whole — the hunks are all of it that fits',
        };
        return;
      }
      wholeFile.value = { key, path: request.path, diff: markRaw(diff) };
    } catch (err) {
      if (gen !== generation || token !== wholeFileFetchSeq) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setError(`Failed to load whole file: ${errorMessage(err)}`);
    } finally {
      if (gen === generation && token === wholeFileFetchSeq) {
        wholeFileLoading.value = false;
      }
    }
  }

  /**
   * Keep the whole-file body honest across a state-change: drop it when
   * its file leaves the status set, re-pull it when the file moved. The
   * U3 cache does the same for every other row; a whole-file body that
   * skipped this would be the one stale diff on screen.
   */
  function refreshWholeFileAfterState(changed: FileEntry[]): void {
    const request = wholeFileRequest;
    if (request === null || wholeFile.value === null) return;
    // Only Changes' rows live in the working-tree status set; a Compare
    // row's identity is the comparison, which a status change does not
    // invalidate on its own.
    if (request.view !== 'changes') return;
    if (workingSnapshot !== null && !workingSnapshot.files.has(request.key)) {
      void setWholeFile(null);
      return;
    }
    if (changed.some((file) => workingDiffKey(file) === request.key)) void setWholeFile(request);
  }

  /**
   * The state-change cascade: evict entries whose file left the status
   * set, then refetch ONLY the files the new wire state marks as
   * changed (vs the previous snapshot). Past the threshold, one
   * whole-tree re-pull replaces N per-file fetches (branch switch).
   */
  function updateWorkingDiffsAfterState(prev: WorkingSnapshot | null): void {
    const next = workingSnapshot;
    if (next === null) return;

    const leaving = [...workingDiffs.value.byKey.keys()].filter((key) => !next.files.has(key));
    if (leaving.length > 0) {
      commitWorkingDiffs((byKey) => {
        for (const key of leaving) {
          byKey.delete(key);
          appliedSeqByKey.delete(key);
        }
        return true;
      });
    }
    for (const key of [...pendingChangedFiles.keys()]) {
      if (!next.files.has(key)) pendingChangedFiles.delete(key);
    }

    const changed = computeChangedFiles(prev, next);
    // Before the early return: the whole-file body must be dropped when
    // its file leaves the status set even if nothing else changed.
    refreshWholeFileAfterState(changed);
    if (changed.length === 0) return;
    if (changed.length > WHOLE_TREE_REPULL_THRESHOLD) {
      pendingChangedFiles.clear();
      void refreshAllDiffs(); // catches internally; never rejects
      return;
    }
    scheduleWorkingDiffRefetch(changed);
  }

  /**
   * The changed set: files entering the status set, plus files whose
   * mtime, hunk count (their own side), or status letter moved since
   * the previous snapshot.
   */
  function computeChangedFiles(prev: WorkingSnapshot | null, next: WorkingSnapshot): FileEntry[] {
    const changed: FileEntry[] = [];
    for (const [key, file] of next.files) {
      const prevFile = prev?.files.get(key);
      if (!prevFile) {
        changed.push(file); // entering
        continue;
      }
      const mtimeChanged = next.mtimes?.[file.path] !== prev?.mtimes?.[file.path];
      const hunksChanged =
        hunkCountOf(next.hunkCounts, file) !== hunkCountOf(prev?.hunkCounts ?? null, file);
      if (mtimeChanged || hunksChanged || prevFile.status !== file.status) {
        changed.push(file);
      }
    }
    return changed;
  }

  function hunkCountOf(counts: WireHunkCounts | null, file: FileEntry): number {
    if (!counts) return 0;
    const side = file.staged ? counts.staged : counts.unstaged;
    return side[file.path] ?? 0;
  }

  /** Coalesce changed files for 20ms, then refetch them per-file. */
  function scheduleWorkingDiffRefetch(files: FileEntry[]): void {
    for (const file of files) {
      pendingChangedFiles.set(workingDiffKey(file), file);
    }
    if (workingDiffsDebounceTimer) return;
    workingDiffsDebounceTimer = setTimeout(() => {
      workingDiffsDebounceTimer = null;
      const batch = [...pendingChangedFiles.values()];
      pendingChangedFiles.clear();
      void fetchWorkingDiffsFor(batch); // catches internally; never rejects
    }, DIFF_DEBOUNCE_MS);
  }

  // --- Image metadata (per changed binary file, on demand) ---

  /**
   * Ask for one file's image metadata, at most once per key. Resolves
   * once the answer has landed (or immediately when the key is already
   * current), so a caller may await it; it never rejects — failures
   * collapse into shared.error through the same displayError funnel as
   * every other read, and connection loss enters the reconnect loop.
   *
   * `staged` is the SIDE PAIR to describe, not a property of the file:
   * staged=false compares index with the working tree, staged=true
   * compares HEAD with the index. It matches the section's own `s:`/`u:`
   * key, which is why the cache is keyed the same way.
   *
   * Callers are expected to ask only for binary sections the reader can
   * see (see ChangesView): each answer costs the daemon two blob
   * inspections, so a whole-tree sweep would be paid for nothing.
   */
  function ensureMedia(file: FileEntry, staged: boolean): Promise<void> {
    const key = workingDiffKey(file);
    if (repoId.value === null || mediaRequested.has(key)) return Promise.resolve();
    mediaRequested.add(key);
    return new Promise<void>((settle) => {
      mediaQueue.push({ key, path: file.path, staged, settle });
      pumpMediaQueue();
    });
  }

  /** Fill the free slots; each worker drains the queue until it is empty. */
  function pumpMediaQueue(): void {
    while (mediaWorkers < MEDIA_CONCURRENCY && mediaQueue.length > 0) {
      mediaWorkers += 1;
      void runMediaWorker(); // catches internally; never rejects
    }
  }

  async function runMediaWorker(): Promise<void> {
    try {
      for (;;) {
        const request = mediaQueue.shift();
        if (request === undefined) return;
        try {
          await fetchMedia(request); // catches internally; never rejects
        } finally {
          // Always release the awaiter: a caller must never hang on a
          // request that failed inside fetchMedia.
          request.settle();
        }
      }
    } finally {
      mediaWorkers -= 1;
    }
  }

  /**
   * One /media pull. A response is dropped when the repo switched under
   * it (generation) or when the key was invalidated while it was in
   * flight (the gate no longer holds it) — landing it then would pin a
   * verdict for bytes that have already moved on.
   */
  async function fetchMedia(request: MediaRequest): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    try {
      const pair = await client.media(id, request.path, request.staged);
      if (gen !== generation || !mediaRequested.has(request.key)) return;
      const byKey = new Map(mediaMeta.value);
      byKey.set(request.key, markRaw(pair));
      mediaMeta.value = byKey;
    } catch (err) {
      if (gen !== generation) return;
      // Drop the gate so a later look at the same section retries.
      mediaRequested.delete(request.key);
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setError(`Failed to load image metadata: ${displayError(err)}`);
    }
  }

  /**
   * Keep the media cache honest across a state-change. Two different
   * moves:
   *
   * - a file that LEFT the status set loses its entry outright (nothing
   *   renders it any more, and a re-entry must ask again);
   * - a file that CHANGED keeps its entry on screen but loses the gate,
   *   so the next ensureMedia re-asks. The worktree side is mutable
   *   bytes behind a size-mtime cache key: without this, an edited image
   *   would keep rendering the version string it had when the section
   *   first came into view. Stale-while-revalidate rather than eviction
   *   — blanking the card and re-inflating it would move every section
   *   below it twice for one edit.
   */
  function invalidateMediaAfterState(prev: WorkingSnapshot | null): void {
    const next = workingSnapshot;
    if (next === null) return;
    const leaving = [...mediaMeta.value.keys()].filter((key) => !next.files.has(key));
    for (const key of leaving) mediaRequested.delete(key);
    if (leaving.length > 0) {
      const byKey = new Map(mediaMeta.value);
      for (const key of leaving) byKey.delete(key);
      mediaMeta.value = byKey;
    }
    for (const file of computeChangedFiles(prev, next)) {
      mediaRequested.delete(workingDiffKey(file));
    }
  }

  /**
   * buildDiffModel through the WeakMap memo: an identity-preserved
   * DiffResult returns the identical DiffModel — unchanged files
   * re-run nothing and keep their vnodes. `staged` MUST match the
   * entry's side (the cache key's `s:`/`u:` prefix): it feeds the
   * model's section keys, so a wrong flag would collide a partially
   * staged file's two sections.
   */
  /**
   * The view's entry point to the shared memo in utils/diffRows. Kept as a
   * store method because repo.test asserts it returns an identical object
   * across an identity-preserved refetch.
   */
  function diffModelFor(diff: DiffResult, staged: boolean): DiffModel {
    return diffModel(diff, staged);
  }

  // --- History ---

  async function loadHistory(count: number = 100): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    historyCount = count;
    history.value = { ...history.value, isLoading: true };
    try {
      const commits = await client.history(id, count);
      if (gen !== generation) return;
      // Re-anchor the selection by hash instead of dropping it. A reload
      // runs on EVERY state-change (a file save is enough), and a dropped
      // selection is a real loss now that it is addressable: the URL would
      // lose its commit, and a Back to that entry would land on the list.
      // A commit that is gone (rebased away) selects nothing, as before.
      const previous = history.value.selectedCommit;
      const reanchored =
        previous === null ? null : (commits.find((c) => c.hash === previous.hash) ?? null);
      history.value = {
        commits,
        selectedCommit: reanchored,
        // Same commit, same diff — refetching it would blank the pane for
        // a round trip on every save.
        commitDiff: reanchored === null ? null : history.value.commitDiff,
        isLoading: false,
      };
    } catch (err) {
      if (gen !== generation) return;
      history.value = { ...history.value, isLoading: false };
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      throw err;
    }
  }

  /** Cascade re-pull after a state-change; errors stay out of the UI. */
  async function reloadHistory(): Promise<void> {
    if (historyPullInFlight) return;
    historyPullInFlight = true;
    try {
      await loadHistory(historyCount);
    } catch {
      // Transient (e.g. mid-rebase): keep the previous commits visible.
    } finally {
      historyPullInFlight = false;
    }
  }

  /**
   * Resolve ONE commit by hash, for a link that names a commit the loaded
   * log does not contain (older than the page, or on a cold load before
   * anything was pulled). Null when it does not resolve — rebased away, or
   * the daemon is unreachable. Deliberately not "load a bigger page until
   * it appears": loadHistory re-pulls the WHOLE log at the new count and
   * clears the selection each time, so paging to find one commit is
   * quadratic re-pulls.
   */
  async function resolveCommit(hash: string): Promise<CommitInfo | null> {
    const id = repoId.value;
    if (id === null) return null;
    const gen = generation;
    try {
      const commit = await client.getCommit(id, hash);
      return gen === generation ? commit : null;
    } catch (err) {
      if (isConnectionError(err)) handleConnectionLoss();
      return null;
    }
  }

  async function selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    history.value = { ...history.value, selectedCommit: commit, commitDiff: null };
    const id = repoId.value;
    if (!commit || id === null) return;
    const gen = generation;

    const diff = await read<DiffResult | null>(() => client.commitDiff(id, commit.hash), null);
    if (diff === null || gen !== generation) return;
    if (history.value.selectedCommit === commit) {
      history.value = { ...history.value, commitDiff: diff };
    }
  }

  // --- Journal ---

  /**
   * Union two seq-ordered entry lists by seq. Returns the existing
   * array untouched (same identity, no reactive churn) when the
   * incoming batch adds nothing new.
   */
  function mergeJournalEntries(existing: JournalEntry[], incoming: JournalEntry[]): JournalEntry[] {
    const bySeq = new Map<number, JournalEntry>(existing.map((e) => [e.seq, e]));
    let added = false;
    for (const entry of incoming) {
      if (!bySeq.has(entry.seq)) {
        bySeq.set(entry.seq, entry);
        added = true;
      }
    }
    if (!added) return existing;
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * The SSE 'journal-append' sink, epoch-aware: a batch only ever
   * splices into a log from the SAME daemon store. Loaded + matching
   * epoch: append, ignoring seqs at or below the current tail — events
   * racing a refetch dedupe by seq. Loaded + DIFFERENT epoch: the
   * daemon store reset (restart / prune-reset) under a live stream —
   * the batch's seq space is unrelated, so it is parked in
   * epochResetBuffer (never appended) and the log is refetched from
   * scratch; the refetch merges the parked batch back when its epoch
   * matches the new store. Before the first loadJournal, batches
   * accumulate so an append racing the initial GET is never lost (the
   * load merges by seq) — but never across epochs: a batch from a new
   * store replaces the stale accumulation outright.
   */
  function applyJournalAppend(event: JournalAppendEvent): void {
    if (!journalLoaded.value) {
      if (preloadAppendEpoch !== null && preloadAppendEpoch !== event.epoch) {
        // The daemon store reset before the first load: the accumulated
        // batches belong to the old seq space — drop them, keep only
        // the new store's batch. Never interleave entries across epochs.
        journalEntries.value = [];
      }
      preloadAppendEpoch = event.epoch;
      appendJournalTail(event.entries);
      return;
    }
    if (event.epoch !== journalEpoch.value) {
      epochResetBuffer.push(event);
      void restartJournalFromScratch(); // catches internally; never rejects
      return;
    }
    appendJournalTail(event.entries);
  }

  /** Append the batch's genuinely-new tail (seqs above the current one). */
  function appendJournalTail(entries: JournalEntry[]): void {
    const cur = journalEntries.value;
    const last = cur.at(-1)?.seq ?? 0;
    const fresh = entries.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0) return;
    journalEntries.value = [...cur, ...fresh];
  }

  /**
   * Replace the log wholesale from a full GET (epoch change / pruned
   * gap): entries, epoch, watermark, and the "journal restarted"
   * divider flag move together. The watermark lands on the fetched
   * tail — a fully-pruned empty store is synced through prunedBefore.
   */
  function replaceJournalWholesale(full: JournalResponse): void {
    journalEntries.value = full.entries;
    journalEpoch.value = full.epoch;
    journalPrunedBefore.value = full.prunedBefore;
    journalSyncedTo = full.entries.at(-1)?.seq ?? full.prunedBefore;
    journalRestarted.value = true;
  }

  /**
   * Merge parked mismatched-epoch batches after a from-scratch refetch:
   * batches whose epoch matches the refetched store raced the reset
   * (emitted after the response was built) — the by-seq merge dedupes
   * overlap. A batch matching NEITHER epoch (two resets racing) is
   * dropped; the next live append re-detects the mismatch and refetches
   * again.
   */
  function drainEpochResetBuffer(): void {
    const parked = epochResetBuffer;
    epochResetBuffer = [];
    for (const event of parked) {
      if (event.epoch !== journalEpoch.value) continue;
      const merged = mergeJournalEntries(journalEntries.value, event.entries);
      if (merged !== journalEntries.value) journalEntries.value = merged;
    }
  }

  /**
   * The epoch-mismatch refetch: the cached log belongs to a dead store,
   * so ?since can't patch it — pull the full log and replace wholesale,
   * then merge the parked batches. Single-flight via journalPullInFlight
   * (shared with resyncJournal: both replace the same state, and a
   * mismatched batch arriving mid-resync parks in the buffer the
   * refetch drains). Failures keep the current entries visible;
   * connection loss re-enters the reconnect loop. Never rejects.
   */
  async function restartJournalFromScratch(): Promise<void> {
    const id = repoId.value;
    if (id === null || journalPullInFlight) return;
    journalPullInFlight = true;
    const gen = generation;
    try {
      const full = await client.journal(id);
      if (gen !== generation) return;
      replaceJournalWholesale(full);
      drainEpochResetBuffer();
    } catch (err) {
      if (gen === generation && isConnectionError(err)) handleConnectionLoss();
      // Other failures: the next mismatched append (or reconnect
      // resync) retries; the parked batches stay parked.
    } finally {
      journalPullInFlight = false;
    }
  }

  /**
   * The lazy first load (Journal view activation): pull the full log
   * once — later changes arrive as 'journal-append' SSE batches, so
   * state-changes trigger no re-pull. Merges with whatever the stream
   * already appended. Mirrors loadHistory's error stance: connection
   * loss collapses into the reconnect loop, a DaemonError rejects to
   * the visiting view.
   */
  async function loadJournal(): Promise<void> {
    const id = repoId.value;
    if (id === null || journalLoaded.value || journalLoadInFlight) return;
    journalLoadInFlight = true;
    const gen = generation;
    try {
      const snap = await client.journal(id);
      if (gen !== generation) return;
      if (preloadAppendEpoch !== null && preloadAppendEpoch !== snap.epoch) {
        // The pre-load SSE accumulation came from a different store
        // than the one this GET answered from: merging would splice
        // two seq spaces — the snapshot alone is the truth.
        journalEntries.value = snap.entries;
      } else {
        journalEntries.value = mergeJournalEntries(journalEntries.value, snap.entries);
      }
      preloadAppendEpoch = null;
      journalEpoch.value = snap.epoch;
      journalPrunedBefore.value = snap.prunedBefore;
      // The watermark covers what THIS fetch proved contiguous — the
      // snapshot's tail, not the merged tail (merged entries beyond it
      // came from the live stream, which a disconnect may have holed).
      journalSyncedTo = snap.entries.at(-1)?.seq ?? snap.prunedBefore;
      journalLoaded.value = true;
    } catch (err) {
      if (gen !== generation) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      throw err;
    } finally {
      journalLoadInFlight = false;
    }
  }

  /**
   * Post-reconnect resync. Never loaded: drop any pre-load SSE
   * accumulation — it may predate a daemon restart (a different
   * epoch's seq space) and the lazy load refetches everything anyway.
   * Loaded: refetch ?since=<journalSyncedTo> — the watermark only
   * SUCCESSFUL fetches advance, never the live tail: appends on the
   * fresh stream advance the tail past a still-unfetched gap, and an
   * interrupted recovery (double-disconnect: gap 51..59 unfetched
   * while live appends pushed the tail to 62) resyncing from the tail
   * would lose the gap forever; from the watermark, the refetched
   * slice and racing appends dedupe by seq instead of double-applying.
   * A changed epoch OR a pruned gap (server's prunedBefore above the
   * watermark) means the daemon's journal reset — refetch from scratch
   * and flag journalRestarted so the view shows a divider instead of a
   * silent hole. Failures keep the current entries visible (mirroring
   * reloadHistory) AND the watermark unmoved, so the next attempt
   * re-covers the same gap. Never rejects.
   */
  async function resyncJournal(): Promise<void> {
    const id = repoId.value;
    if (id === null || journalPullInFlight) return;
    if (!journalLoaded.value) {
      if (journalEntries.value.length > 0) journalEntries.value = [];
      preloadAppendEpoch = null;
      return;
    }
    journalPullInFlight = true;
    const gen = generation;
    const since = journalSyncedTo;
    try {
      const snap = await client.journal(id, since);
      if (gen !== generation) return;
      if (snap.epoch !== journalEpoch.value || snap.prunedBefore > since) {
        // Journal reset/pruned past our watermark: the since-slice
        // cannot patch the hole — replace the log wholesale, with a
        // divider, and merge any batches parked by the epoch check.
        const full = await client.journal(id);
        if (gen !== generation) return;
        replaceJournalWholesale(full);
        drainEpochResetBuffer();
        return;
      }
      const merged = mergeJournalEntries(journalEntries.value, snap.entries);
      if (merged !== journalEntries.value) journalEntries.value = merged;
      if (snap.prunedBefore !== journalPrunedBefore.value) {
        journalPrunedBefore.value = snap.prunedBefore;
      }
      // Advance the watermark to what this fetch proved contiguous:
      // its own tail (an empty slice proves nothing new — keep it).
      const fetchedTail = snap.entries.at(-1)?.seq;
      if (fetchedTail !== undefined && fetchedTail > journalSyncedTo) {
        journalSyncedTo = fetchedTail;
      }
    } catch (err) {
      if (gen === generation && isConnectionError(err)) handleConnectionLoss();
      // Other failures: keep the current entries visible; the next
      // reconnect re-syncs from the SAME watermark.
    } finally {
      journalPullInFlight = false;
    }
    kickParkedEpochBatches(gen);
  }

  /**
   * After a resync releases the pull flag: a mismatched-epoch batch
   * that arrived while the flag was held parked in epochResetBuffer,
   * and its own restartJournalFromScratch early-returned. The
   * same-epoch resync path never drains the buffer, so kick the
   * from-scratch refetch here — otherwise the parked batch (for the
   * NEW epoch) would be stranded forever.
   */
  function kickParkedEpochBatches(gen: number): void {
    if (gen !== generation || epochResetBuffer.length === 0) return;
    void restartJournalFromScratch(); // catches internally; never rejects
  }

  // --- Compare ---

  /** The include-uncommitted flag of the most recent compare pull — lets
   * the view's toggle survive a tab switch (the ref is component-local). */
  function getLastIncludeUncommitted(): boolean {
    return lastIncludeUncommitted;
  }

  /**
   * Re-anchor a file selection by path after the file set changed: same
   * file → its new index + diff; file gone → selection cleared so the
   * highlight cannot land on a different file.
   */
  function reanchoredCompareSelection(
    prev: RepoCompareState,
    next: CompareDiff
  ): CompareSelectionState {
    const sel = prev.selection;
    if (sel.type !== 'file') return sel;
    const path = prev.compareDiff?.files[sel.index]?.path;
    const index = path === undefined ? -1 : next.files.findIndex((f) => f.path === path);
    if (index === -1) return { type: null, index: 0, diff: null };
    return { type: 'file', index, diff: next.files[index].diff };
  }

  /**
   * Pull just the commit count (GET /compare/count), for the rail's tab
   * badge. Runs on every applied state so the number is right from the
   * first snapshot and stays right as commits land — the full compare is
   * far too expensive to pull for a number, which is the whole reason this
   * endpoint exists.
   *
   * A 422 (no base branch, or no shared history) clears the count rather
   * than showing 0: "nothing to compare against" is not "zero commits".
   * Every other failure leaves the last known count alone — a badge going
   * blank on a transient blip is worse than a slightly stale number.
   */
  async function refreshCompareCount(): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    const seq = ++compareCountSeq;
    try {
      const { commits } = await client.compareCount(id, {
        base: selectedCompareBase.value ?? undefined,
      });
      if (gen !== generation || seq !== compareCountSeq) return;
      compare.value = { ...compare.value, commitCount: commits };
    } catch (err) {
      if (gen !== generation || seq !== compareCountSeq) return;
      if (err instanceof DaemonError && err.status === 422) {
        compare.value = { ...compare.value, commitCount: null };
      }
    }
  }

  async function refreshCompare(includeUncommitted: boolean = false): Promise<void> {
    lastIncludeUncommitted = includeUncommitted;
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    const seq = ++compareRequestSeq;
    compare.value = { ...compare.value, loading: true, error: null, noBaseBranch: false };
    try {
      const diff = await client.compare(id, {
        base: selectedCompareBase.value ?? undefined,
        uncommitted: includeUncommitted,
      });
      if (gen !== generation || seq !== compareRequestSeq) return;
      // The loaded list is the authority on its own length: take the count
      // from it and retire any count request still in flight, so the badge
      // can never contradict the commits the user is looking at.
      compareCountSeq += 1;
      compare.value = {
        ...compare.value,
        compareDiff: diff,
        baseBranch: diff.baseBranch,
        commitCount: diff.commits.length,
        loading: false,
        noBaseBranch: false,
        selection: reanchoredCompareSelection(compare.value, diff),
      };
    } catch (err) {
      if (gen !== generation || seq !== compareRequestSeq) return;
      applyCompareFailure(err);
    }
  }

  function applyCompareFailure(err: unknown): void {
    if (isConnectionError(err)) {
      compare.value = { ...compare.value, loading: false };
      handleConnectionLoss();
      return;
    }
    // A 422 means the daemon found no base branch to compare against
    // (base detection only considers remote refs). That is a normal
    // state, not a failure — flag it so the view shows a truthful
    // message instead of the generic error banner.
    if (err instanceof DaemonError && err.status === 422) {
      compare.value = {
        ...compare.value,
        compareDiff: null,
        baseBranch: null,
        commitCount: null,
        loading: false,
        error: null,
        noBaseBranch: true,
      };
      return;
    }
    compare.value = {
      ...compare.value,
      loading: false,
      error: `Failed to load compare diff: ${errorMessage(err)}`,
    };
  }

  async function getCandidateBaseBranches(): Promise<string[]> {
    const id = repoId.value;
    if (id === null) return [];
    return read<string[]>(() => client.baseBranches(id), []);
  }

  /**
   * Pick the base the compare view reads against (read-only: rides the
   * next GET /compare as ?base=…, never persisted daemon-side) and
   * re-pull with it.
   */
  async function setSelectedCompareBase(
    branch: string,
    includeUncommitted: boolean = false
  ): Promise<void> {
    selectedCompareBase.value = branch;
    await refreshCompare(includeUncommitted);
  }

  async function selectCompareCommit(index: number): Promise<void> {
    const compareDiff = compare.value.compareDiff;
    const id = repoId.value;
    if (!compareDiff || index < 0 || index >= compareDiff.commits.length || id === null) {
      compare.value = { ...compare.value, selection: { type: null, index: 0, diff: null } };
      return;
    }

    const commit = compareDiff.commits[index];
    compare.value = { ...compare.value, selection: { type: 'commit', index, diff: null } };
    const gen = generation;

    const diff = await read<DiffResult | null>(() => client.commitDiff(id, commit.hash), null);
    if (diff === null || gen !== generation) return;
    const current = compare.value.selection;
    if (current.type === 'commit' && current.index === index) {
      compare.value = { ...compare.value, selection: { ...current, diff } };
    }
  }

  function selectCompareFile(index: number): void {
    const compareDiff = compare.value.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.files.length) {
      compare.value = { ...compare.value, selection: { type: null, index: 0, diff: null } };
      return;
    }
    compare.value = {
      ...compare.value,
      selection: { type: 'file', index, diff: compareDiff.files[index].diff },
    };
  }

  // --- Worktrees / explorer sources ---

  async function listWorktrees(): Promise<WorktreeInfo[]> {
    const id = repoId.value;
    if (id === null) return [];
    return read<WorktreeInfo[]>(() => client.worktrees(id), []);
  }

  return {
    // reactive state
    repoId,
    repoPath,
    isRepo,
    shared,
    workingDiffs,
    wholeFile,
    wholeFileLoading,
    wholeFileRefusal,
    mediaMeta,
    selection,
    history,
    journalEntries,
    journalEpoch,
    journalPrunedBefore,
    journalLoaded,
    journalRestarted,
    compare,
    selectedCompareBase,
    // lifecycle
    open,
    dispose,
    releaseOnUnload,
    refresh,
    setError,
    // working-tree mutations (file-level stage/unstage only)
    stageFile,
    unstageFile,
    // selection
    selectFile,
    // working-diff cache
    refreshAllDiffs,
    setWholeFile,
    diffModelFor,
    // image metadata (on demand, per changed binary file)
    ensureMedia,
    // history
    loadHistory,
    resolveCommit,
    selectHistoryCommit,
    // journal
    loadJournal,
    // compare
    refreshCompare,
    refreshCompareCount,
    getLastIncludeUncommitted,
    getCandidateBaseBranches,
    setSelectedCompareBase,
    selectCompareCommit,
    selectCompareFile,
    // worktrees
    listWorktrees,
  };
});
