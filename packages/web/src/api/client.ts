/**
 * DiffstalkerClient (browser): a typed client for every diffstalkerd
 * endpoint, mirroring @diffstalker/client's method surface over the
 * browser transport (fetch + EventSource, same-origin relative URLs).
 *
 * Wire types are reused TYPE-ONLY from @diffstalker/client and core DTO
 * types TYPE-ONLY from @diffstalker/core — both erase at build, so no
 * node:http / node:events reaches the browser bundle.
 *
 * Decoding: commit dates arrive as ISO strings and are revived to Date
 * (history, compare commits); hunkCounts arrive as plain {path: number}
 * objects and STAY plain objects (no Map in the browser). Mutations
 * return the unified {state, result?} envelope; success is the HTTP
 * status, never an envelope field.
 */

import { request, subscribe } from './transport';
import type { SseHandle } from './transport';
import type {
  FollowChangeEvent,
  FollowState,
  HealthState,
  MutationEnvelope,
  RepoClosedEvent,
  RepoOpenedEvent,
  RepoRef,
  RepoSummary,
  WireCommitInfo,
  WireCompareDiff,
  WireSharedState,
} from '@diffstalker/client';
import type { CommitInfo, LocalBranch } from '@diffstalker/core/git/status';
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
    const commits = await request<WireCommitInfo[]>(
      'GET',
      this.repoPath(id, '/history') + toQuery({ count })
    );
    return commits.map(reviveCommit);
  }

  commitDiff(id: string, hash: string): Promise<DiffResult> {
    return request('GET', this.repoPath(id, `/commits/${encodeURIComponent(hash)}/diff`));
  }

  /** HEAD commit message (amend prefill); "" when the repo has no commits. */
  async headMessage(id: string): Promise<string> {
    const { message } = await request<{ message: string }>(
      'GET',
      this.repoPath(id, '/head-message')
    );
    return message;
  }

  branches(id: string): Promise<LocalBranch[]> {
    return request('GET', this.repoPath(id, '/branches'));
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

  async setCompareBase(id: string, branch: string): Promise<string> {
    const { base } = await request<{ base: string }>('PUT', this.repoPath(id, '/compare/base'), {
      branch,
    });
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
   * then `state-change` — the daemon's own event names.
   */
  subscribeRepo(id: string, handlers: RepoStreamHandlers): SseHandle {
    return subscribe(this.repoPath(id, '/events'), ['snapshot', 'state-change'], {
      onEvent: (event, payload) => {
        if (event === 'snapshot') handlers.onSnapshot(payload as WireSharedState);
        else handlers.onStateChange(payload as WireSharedState);
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

  private mutate(id: string, suffix: string, body?: unknown): Promise<MutationEnvelope> {
    return request('POST', this.repoPath(id, suffix), body);
  }
}
