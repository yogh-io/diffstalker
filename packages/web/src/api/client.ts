/**
 * DiffstalkerClient (browser): a typed client for the diffstalkerd
 * endpoints the web UI uses, mirroring @diffstalker/client's method
 * surface over the browser transport (fetch + EventSource, same-origin
 * relative URLs). The web UI is a near-viewer: besides opening a repo
 * (POST /repos) and releasing it (DELETE /repos/:id), the only git
 * mutations it makes are file-level stage / unstage (POST /stage,
 * /unstage). No commit, discard, hunk-staging, or remote/branch ops —
 * those stay in the terminal UI.
 *
 * Wire types are reused TYPE-ONLY from @diffstalker/client and core DTO
 * types TYPE-ONLY from @diffstalker/core — both erase at build, so no
 * node:http / node:events reaches the browser bundle.
 *
 * Decoding: commit dates arrive as ISO strings and are revived to Date
 * (history, compare commits); hunkCounts arrive as plain {path: number}
 * objects and STAY plain objects (no Map in the browser).
 */

import { request, subscribe } from './transport';
import type { SseHandle } from './transport';
import type {
  FollowChangeEvent,
  FollowState,
  HealthState,
  JournalAppendEvent,
  JournalResponse,
  RepoClosedEvent,
  RepoOpenedEvent,
  RepoRef,
  RepoSummary,
  WireCommitInfo,
  WireCompareDiff,
  WireSharedState,
} from '@diffstalker/client';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareDiff, DiffResult } from '@diffstalker/core/git/diff';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';

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

/** Handlers for a per-repo stream (GET /repos/:id/events). */
export interface RepoStreamHandlers {
  onSnapshot: (state: WireSharedState) => void;
  onStateChange: (state: WireSharedState) => void;
  /**
   * One observation's appended journal entries, applied atomically.
   * The event carries the emitting store's epoch (an opaque string,
   * compared with equality only) so the store can drop a batch from a
   * reset daemon store instead of splicing two seq spaces together.
   */
  onJournalAppend?: (event: JournalAppendEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/** Handlers for the daemon-scope stream (GET /events). */
export interface DaemonStreamHandlers {
  onSnapshot: (repos: RepoRef[]) => void;
  onRepoOpened: (repo: RepoOpenedEvent) => void;
  onRepoClosed: (event: RepoClosedEvent) => void;
  onFollowChange: (event: FollowChangeEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export class DiffstalkerClient {
  // --- Daemon ---

  health(): Promise<HealthState> {
    return request('GET', '/health');
  }

  getFollow(): Promise<FollowState> {
    return request('GET', '/follow');
  }

  // --- Repos ---

  openRepo(path: string): Promise<RepoRef> {
    return request('POST', '/repos', { path });
  }

  listRepos(): Promise<RepoSummary[]> {
    return request('GET', '/repos');
  }

  async closeRepo(id: string): Promise<void> {
    await request('DELETE', this.repoPath(id, ''));
  }

  /**
   * Best-effort ref release during page unload (pagehide). The release
   * endpoint is DELETE /repos/:id and navigator.sendBeacon can only issue
   * POSTs, so this uses fetch keepalive — the same outlive-the-page
   * mechanism a beacon rides on. Fire-and-forget by design: the page is
   * going away, nobody can act on the response.
   */
  releaseRepoOnUnload(id: string): void {
    fetch(this.repoPath(id, ''), { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  worktrees(id: string): Promise<WorktreeInfo[]> {
    return request('GET', this.repoPath(id, '/worktrees'));
  }

  // --- Working tree ---

  status(id: string): Promise<WireSharedState> {
    return request('GET', this.repoPath(id, '/status'));
  }

  diff(id: string, opts: { path?: string; staged?: boolean } = {}): Promise<DiffResult> {
    return request(
      'GET',
      this.repoPath(id, '/diff') + toQuery({ path: opts.path, staged: opts.staged })
    );
  }

  /**
   * Stage / unstage one file by path — the ONLY working-tree mutations
   * the web UI makes. The daemon resolves the entry (staged side inferred
   * from the endpoint) and returns the fresh shared state, which is also
   * broadcast over SSE. A refused/failed mutation rejects via DaemonError
   * with the daemon's {error} message, like every other call.
   */
  stage(id: string, path: string): Promise<{ state: WireSharedState }> {
    return request('POST', this.repoPath(id, '/stage'), { path });
  }

  unstage(id: string, path: string): Promise<{ state: WireSharedState }> {
    return request('POST', this.repoPath(id, '/unstage'), { path });
  }

  // --- History / compare ---

  async history(id: string, count?: number): Promise<CommitInfo[]> {
    const commits = await request<WireCommitInfo[]>(
      'GET',
      this.repoPath(id, '/history') + toQuery({ count })
    );
    return commits.map(reviveCommit);
  }

  commitDiff(id: string, hash: string): Promise<DiffResult> {
    return request('GET', this.repoPath(id, `/commits/${encodeURIComponent(hash)}/diff`));
  }

  baseBranches(id: string): Promise<string[]> {
    return request('GET', this.repoPath(id, '/base-branches'));
  }

  async getCompareBase(id: string): Promise<string | null> {
    const { base } = await request<{ base: string | null }>(
      'GET',
      this.repoPath(id, '/compare/base')
    );
    return base;
  }

  async compare(
    id: string,
    opts: { base?: string; uncommitted?: boolean } = {}
  ): Promise<CompareDiff> {
    const diff = await request<WireCompareDiff>(
      'GET',
      this.repoPath(id, '/compare') + toQuery({ base: opts.base, uncommitted: opts.uncommitted })
    );
    return { ...diff, commits: diff.commits.map(reviveCommit) };
  }

  // --- Journal ---

  /**
   * The append-only journal: entries with seq > since (all when omitted),
   * plus the store's epoch (an opaque string, compared by equality only)
   * and the pruning watermark. The payload is JSON-native — the embedded
   * DiffResult crosses the wire as-is, like diff() — so nothing is
   * revived here.
   */
  journal(id: string, since?: number): Promise<JournalResponse> {
    return request('GET', this.repoPath(id, '/journal') + toQuery({ since }));
  }

  // --- Explorer ---

  tree(
    id: string,
    opts: { dir?: string; hidden?: boolean; ignored?: boolean } = {}
  ): Promise<DirEntry[]> {
    return request(
      'GET',
      this.repoPath(id, '/tree') +
        toQuery({ dir: opts.dir, hidden: opts.hidden, ignored: opts.ignored })
    );
  }

  file(id: string, path: string): Promise<FileForDisplay> {
    return request('GET', this.repoPath(id, '/file') + toQuery({ path }));
  }

  files(id: string): Promise<string[]> {
    return request('GET', this.repoPath(id, '/files'));
  }

  // --- SSE ---

  /**
   * Subscribe to one repo's shared-state stream: `snapshot` on connect,
   * then `state-change` and `journal-append` — the daemon's own event
   * names.
   */
  subscribeRepo(id: string, handlers: RepoStreamHandlers): SseHandle {
    return subscribe(this.repoPath(id, '/events'), ['snapshot', 'state-change', 'journal-append'], {
      onEvent: (event, payload) => {
        if (event === 'snapshot') handlers.onSnapshot(payload as WireSharedState);
        else if (event === 'journal-append') {
          handlers.onJournalAppend?.(payload as JournalAppendEvent);
        } else handlers.onStateChange(payload as WireSharedState);
      },
      onOpen: handlers.onOpen,
      onError: handlers.onError,
    });
  }

  /**
   * Subscribe to the daemon-scope stream: `snapshot` (open repos) on
   * connect, then `repo-opened` / `repo-closed` / `follow-change`.
   */
  subscribeDaemon(handlers: DaemonStreamHandlers): SseHandle {
    return subscribe('/events', ['snapshot', 'repo-opened', 'repo-closed', 'follow-change'], {
      onEvent: (event, payload) => this.dispatchDaemonEvent(event, payload, handlers),
      onOpen: handlers.onOpen,
      onError: handlers.onError,
    });
  }

  // --- Internals ---

  private dispatchDaemonEvent(
    event: string,
    payload: unknown,
    handlers: DaemonStreamHandlers
  ): void {
    switch (event) {
      case 'snapshot':
        handlers.onSnapshot(payload as RepoRef[]);
        break;
      case 'repo-opened':
        handlers.onRepoOpened(payload as RepoOpenedEvent);
        break;
      case 'repo-closed':
        handlers.onRepoClosed(payload as RepoClosedEvent);
        break;
      case 'follow-change':
        handlers.onFollowChange(payload as FollowChangeEvent);
        break;
    }
  }

  private repoPath(id: string, suffix: string): string {
    return `/repos/${encodeURIComponent(id)}${suffix}`;
  }
}
