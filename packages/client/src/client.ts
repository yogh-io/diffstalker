/**
 * DiffstalkerClient: a typed client for every diffstalkerd endpoint.
 *
 * REST methods return the daemon's wire shapes (mutations return the
 * unified {state, result?} envelope); commit dates arrive as ISO strings
 * and are revived to Date so history/compare results match core's
 * CommitInfo/CompareDiff exactly.
 *
 * SSE subscriptions re-emit the daemon's events under the daemon's own
 * event names (`snapshot`/`state-change` per repo; `snapshot`/
 * `repo-opened`/`repo-closed`/`follow-change` daemon-scope), so a consumer
 * can mirror the core manager events one-to-one.
 */

import { EventEmitter } from 'node:events';
import { Transport } from './transport.js';
import type { SseConnection, TransportTarget } from './transport.js';
import type {
  CommitInfo,
  CompareDiff,
  DiffResult,
  DirEntry,
  FileForDisplay,
  FollowChangeEvent,
  FollowState,
  HealthState,
  JournalAppendEvent,
  JournalResponse,
  LocalBranch,
  MutationEnvelope,
  RepoClosedEvent,
  RepoOpenedEvent,
  RepoRef,
  RepoSummary,
  WireCommitInfo,
  WireCompareDiff,
  WireSharedState,
  WorktreeInfo,
} from './wire.js';

/** Revive a wire commit: the ISO date string becomes a Date. */
function reviveCommit(commit: WireCommitInfo): CommitInfo {
  return { ...commit, date: new Date(commit.date) };
}

/** Build a query string, skipping undefined values. */
function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/** Events common to both subscription scopes. */
interface CommonSubscriptionEvents {
  /** The stream ended server-side. Not emitted after close(). */
  close: [];
  /** Connection/protocol failure. Only emitted when a listener exists. */
  error: [Error];
}

/** Per-repo stream (GET /repos/:id/events). */
export type RepoSubscriptionEvents = CommonSubscriptionEvents & {
  snapshot: [WireSharedState];
  'state-change': [WireSharedState];
  'journal-append': [JournalAppendEvent];
};

/** Daemon-scope stream (GET /events). */
export type DaemonSubscriptionEvents = CommonSubscriptionEvents & {
  snapshot: [RepoRef[]];
  'repo-opened': [RepoOpenedEvent];
  'repo-closed': [RepoClosedEvent];
  'follow-change': [FollowChangeEvent];
};

/**
 * An SSE subscription: an EventEmitter re-emitting the daemon's named
 * events with JSON-parsed payloads, plus close() to tear the connection
 * down (after which nothing is emitted and no socket is left behind).
 */
export class SseSubscription<
  Events extends Record<keyof Events, unknown[]>,
> extends EventEmitter<Events> {
  private connection: SseConnection;
  private closed = false;

  constructor(transport: Transport, path: string) {
    super();
    this.connection = transport.openSse(path, {
      onEvent: (event, data) => this.dispatch(event, data),
      onClose: () => this.forward('close'),
      onError: (err) => this.emitError(err),
    });
  }

  private dispatch(event: string, data: string): void {
    let payload: unknown = null;
    if (data.length > 0) {
      try {
        payload = JSON.parse(data);
      } catch {
        this.emitError(new Error(`Invalid JSON in SSE "${event}" event: ${data.slice(0, 200)}`));
        return;
      }
    }
    this.forward(event, payload);
  }

  /**
   * Re-emit under the daemon's event name. Names arrive as runtime
   * strings, so this goes through the untyped emitter surface; the typed
   * event maps on the exported subscription types cover consumers.
   */
  private forward(event: string, ...args: unknown[]): void {
    (this as unknown as EventEmitter).emit(event, ...args);
  }

  /** Guarded: an unhandled 'error' emit would crash the process. */
  private emitError(err: Error): void {
    if ((this as unknown as EventEmitter).listenerCount('error') > 0) {
      this.forward('error', err);
    }
  }

  /** Close the stream: destroys the socket, emits nothing further. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    this.removeAllListeners();
  }
}

export type RepoSubscription = SseSubscription<RepoSubscriptionEvents>;
export type DaemonSubscription = SseSubscription<DaemonSubscriptionEvents>;

export class DiffstalkerClient {
  private transport: Transport;

  constructor(target: TransportTarget) {
    this.transport = new Transport(target);
  }

  // --- Daemon ---

  health(): Promise<HealthState> {
    return this.transport.request('GET', '/health');
  }

  getFollow(): Promise<FollowState> {
    return this.transport.request('GET', '/follow');
  }

  // --- Repos ---

  openRepo(path: string): Promise<RepoRef> {
    return this.transport.request('POST', '/repos', { path });
  }

  listRepos(): Promise<RepoSummary[]> {
    return this.transport.request('GET', '/repos');
  }

  async closeRepo(id: string): Promise<void> {
    await this.transport.request('DELETE', this.repoPath(id, ''));
  }

  worktrees(id: string): Promise<WorktreeInfo[]> {
    return this.transport.request('GET', this.repoPath(id, '/worktrees'));
  }

  /** Same as worktrees(), but for a raw filesystem path that may not be
   * open on this daemon (e.g. a recently-visited repo). */
  worktreesForPath(path: string): Promise<WorktreeInfo[]> {
    return this.transport.request('GET', '/worktrees' + toQuery({ path }));
  }

  // --- Working tree ---

  status(id: string): Promise<WireSharedState> {
    return this.transport.request('GET', this.repoPath(id, '/status'));
  }

  diff(id: string, opts: { path?: string; staged?: boolean } = {}): Promise<DiffResult> {
    return this.transport.request(
      'GET',
      this.repoPath(id, '/diff') + toQuery({ path: opts.path, staged: opts.staged })
    );
  }

  stage(id: string, path: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/stage', { path });
  }

  unstage(id: string, path: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/unstage', { path });
  }

  stageAll(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/stage-all');
  }

  unstageAll(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/unstage-all');
  }

  discard(id: string, path: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/discard', { path });
  }

  commit(id: string, message: string, opts: { amend?: boolean } = {}): Promise<MutationEnvelope> {
    return this.mutate(id, '/commit', {
      message,
      ...(opts.amend !== undefined ? { amend: opts.amend } : {}),
    });
  }

  stageHunk(id: string, patch: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/stage-hunk', { patch });
  }

  unstageHunk(id: string, patch: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/unstage-hunk', { patch });
  }

  // --- History / compare ---

  async history(id: string, count?: number): Promise<CommitInfo[]> {
    const commits = await this.transport.request<WireCommitInfo[]>(
      'GET',
      this.repoPath(id, '/history') + toQuery({ count })
    );
    return commits.map(reviveCommit);
  }

  commitDiff(id: string, hash: string): Promise<DiffResult> {
    return this.transport.request(
      'GET',
      this.repoPath(id, `/commits/${encodeURIComponent(hash)}/diff`)
    );
  }

  /** HEAD commit message (amend prefill); "" when the repo has no commits. */
  async headMessage(id: string): Promise<string> {
    const { message } = await this.transport.request<{ message: string }>(
      'GET',
      this.repoPath(id, '/head-message')
    );
    return message;
  }

  branches(id: string): Promise<LocalBranch[]> {
    return this.transport.request('GET', this.repoPath(id, '/branches'));
  }

  baseBranches(id: string): Promise<string[]> {
    return this.transport.request('GET', this.repoPath(id, '/base-branches'));
  }

  async getCompareBase(id: string): Promise<string | null> {
    const { base } = await this.transport.request<{ base: string | null }>(
      'GET',
      this.repoPath(id, '/compare/base')
    );
    return base;
  }

  async setCompareBase(id: string, branch: string): Promise<string> {
    const { base } = await this.transport.request<{ base: string }>(
      'PUT',
      this.repoPath(id, '/compare/base'),
      { branch }
    );
    return base;
  }

  async compare(
    id: string,
    opts: { base?: string; uncommitted?: boolean } = {}
  ): Promise<CompareDiff> {
    const diff = await this.transport.request<WireCompareDiff>(
      'GET',
      this.repoPath(id, '/compare') + toQuery({ base: opts.base, uncommitted: opts.uncommitted })
    );
    return { ...diff, commits: diff.commits.map(reviveCommit) };
  }

  // --- Journal ---

  /**
   * The append-only journal: entries with seq > since (all when omitted),
   * plus the store's epoch and the pruning watermark. The payload is
   * JSON-native — the embedded DiffResult crosses the wire as-is, like
   * diff() — so nothing is revived here.
   */
  journal(id: string, since?: number): Promise<JournalResponse> {
    return this.transport.request('GET', this.repoPath(id, '/journal') + toQuery({ since }));
  }

  // --- Explorer ---

  tree(
    id: string,
    opts: { dir?: string; hidden?: boolean; ignored?: boolean } = {}
  ): Promise<DirEntry[]> {
    return this.transport.request(
      'GET',
      this.repoPath(id, '/tree') +
        toQuery({ dir: opts.dir, hidden: opts.hidden, ignored: opts.ignored })
    );
  }

  file(id: string, path: string): Promise<FileForDisplay> {
    return this.transport.request('GET', this.repoPath(id, '/file') + toQuery({ path }));
  }

  files(id: string): Promise<string[]> {
    return this.transport.request('GET', this.repoPath(id, '/files'));
  }

  // --- Remote / branch / undo ---

  push(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/push');
  }

  fetch(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/fetch');
  }

  pull(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/pull');
  }

  stash(id: string, message?: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/stash', message === undefined ? {} : { message });
  }

  stashPop(id: string, index?: number): Promise<MutationEnvelope> {
    return this.mutate(id, '/stash-pop', index === undefined ? {} : { index });
  }

  switchBranch(id: string, name: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/switch-branch', { name });
  }

  createBranch(id: string, name: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/create-branch', { name });
  }

  softReset(id: string, count?: number): Promise<MutationEnvelope> {
    return this.mutate(id, '/soft-reset', count === undefined ? {} : { count });
  }

  cherryPick(id: string, hash: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/cherry-pick', { hash });
  }

  revert(id: string, hash: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/revert', { hash });
  }

  abort(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/abort');
  }

  rebaseContinue(id: string): Promise<MutationEnvelope> {
    return this.mutate(id, '/rebase-continue');
  }

  // --- SSE ---

  /**
   * Subscribe to one repo's shared-state stream: `snapshot` on connect,
   * then `state-change` and `journal-append` — the same names the daemon
   * (and the core managers) use.
   */
  subscribeRepo(id: string): RepoSubscription {
    return new SseSubscription<RepoSubscriptionEvents>(
      this.transport,
      this.repoPath(id, '/events')
    );
  }

  /**
   * Subscribe to the daemon-scope stream: `snapshot` (open repos) on
   * connect, then `repo-opened` / `repo-closed` / `follow-change`.
   */
  subscribeDaemon(): DaemonSubscription {
    return new SseSubscription<DaemonSubscriptionEvents>(this.transport, '/events');
  }

  // --- Internals ---

  private repoPath(id: string, suffix: string): string {
    return `/repos/${encodeURIComponent(id)}${suffix}`;
  }

  private mutate(id: string, suffix: string, body?: unknown): Promise<MutationEnvelope> {
    return this.transport.request('POST', this.repoPath(id, suffix), body);
  }
}
