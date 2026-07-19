/**
 * Follow mode, daemon-side: the daemon owns the truth, clients decide
 * policy.
 *
 * One core FilePathWatcher watches ONE hook file (external tools write a
 * repo/file path into it to signal "focus this"). On change the controller
 * opens the repo through the registry — which normalizes any path (a file,
 * a subdirectory, a bare container) to a worktree root exactly like
 * POST /repos does — and broadcasts `follow-change` on the daemon-scope
 * SSE channel. Clients subscribe and choose whether to react; there is no
 * per-client follow state here.
 *
 * The controller holds ONE persistent "follow" reference on the followed
 * repo (a registry refcount), so the followed repo stays open even when no
 * client has it open. When the target switches to a different repo, the
 * previous repo's follow-ref is released — if nothing else holds it, that
 * closes it (and `repo-closed` goes out via the registry callback).
 *
 * A hook-file content change that does not resolve to a git repository
 * broadcasts nothing and leaves the current follow state untouched
 * (documented choice; the alternative was a follow-change with repoId
 * null).
 */

import { FilePathWatcher, WatcherState } from '@diffstalker/core/managers/FilePathWatcher';
import type { RepoRegistry, OpenResult } from './repoRegistry.js';
import type { DaemonEventHub } from './sse.js';

export interface FollowState {
  /** The hook file being watched (null only in the disabled placeholder). */
  targetFile: string | null;
  enabled: boolean;
  /** Repo id of the currently followed repo, null before the first hit. */
  followedRepoId: string | null;
  /** Worktree root of the currently followed repo. */
  followedPath: string | null;
}

/** The GET /follow shape when follow mode is disabled (--no-follow). */
export const FOLLOW_DISABLED: FollowState = {
  targetFile: null,
  enabled: false,
  followedRepoId: null,
  followedPath: null,
};

export class FollowController {
  private watcher: FilePathWatcher;
  private followedRepoId: string | null = null;
  private followedPath: string | null = null;
  private disposed = false;
  /** Serializes path-change handling so switches cannot interleave. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private registry: RepoRegistry,
    private hub: DaemonEventHub,
    private targetFile: string
  ) {
    this.watcher = new FilePathWatcher(targetFile);
  }

  get state(): FollowState {
    return {
      targetFile: this.targetFile,
      enabled: true,
      followedRepoId: this.followedRepoId,
      followedPath: this.followedPath,
    };
  }

  /**
   * Start watching the hook file (FilePathWatcher creates it, and its
   * directory, when missing). The initial content — a daemon restart picks
   * up whatever target was last written — is followed too; the watcher
   * deliberately does not emit for it, so it is processed explicitly.
   */
  start(): void {
    this.watcher.on('path-change', (state) => this.enqueue(state));
    this.watcher.start();
    if (this.watcher.state.path) {
      this.enqueue(this.watcher.state);
    }
  }

  private enqueue(state: WatcherState): void {
    this.queue = this.queue.then(() => this.follow(state)).catch(() => {});
  }

  private async follow(state: WatcherState): Promise<void> {
    if (this.disposed || !state.path) return;

    let opened: OpenResult;
    try {
      opened = await this.registry.openRepo(state.path);
    } catch {
      // Not a git repository: keep the current follow, broadcast nothing.
      return;
    }
    if (this.disposed) {
      // Disposed while opening: undo the ref we just took.
      this.registry.closeRepo(opened.handle.id);
      return;
    }
    if (opened.created) {
      // Warm up status like POST /repos does; errors land in manager state.
      opened.handle.manager.workingTree.refresh().catch(() => {});
    }

    if (opened.handle.id === this.followedRepoId) {
      // Same repo (possibly a different file inside it): the open above
      // took a second follow-ref — give it back.
      this.registry.closeRepo(opened.handle.id);
    } else {
      const previous = this.followedRepoId;
      this.followedRepoId = opened.handle.id;
      this.followedPath = opened.handle.path;
      if (previous) {
        this.registry.closeRepo(previous);
      }
    }

    // `path` is the resolved content of the hook file (it may point at a
    // file inside the repo — clients can use it to select that file); the
    // followed repo's worktree root is available via GET /follow or /repos.
    this.hub.broadcast('follow-change', {
      repoId: opened.handle.id,
      path: state.path,
      rawContent: state.rawContent,
    });
  }

  /** Stop the watcher and release the follow-ref (daemon shutdown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher.stop();
    if (this.followedRepoId) {
      this.registry.closeRepo(this.followedRepoId);
      this.followedRepoId = null;
      this.followedPath = null;
    }
  }
}
