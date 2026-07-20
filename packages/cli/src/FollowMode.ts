/**
 * Follow mode, client-side policy.
 *
 * The daemon owns the truth: it runs the one hook-file watcher and
 * broadcasts its changes as `follow-change` on the daemon-scope /events
 * stream (see packages/daemon/src/follow.ts). The CLI no longer watches
 * any file itself — it subscribes to that stream and reacts, gated by a
 * client-side `enabled` toggle.
 *
 * The subscription is opened ONCE (App calls start() regardless of the
 * toggle); the toggle only gates whether follow-change events act, so
 * flipping follow on/off never churns the connection.
 */

import type { DiffstalkerClient, DaemonSubscription, FollowChangeEvent } from '@diffstalker/client';

/**
 * Callbacks invoked by FollowMode when the daemon reports a follow change.
 */
export interface FollowModeCallbacks {
  /**
   * Called when the followed path names a repo different from the current
   * session. The callback should switch to it (the daemon already opened
   * and normalized it; POST /repos just refcounts in).
   */
  onRepoChange(newPath: string): void;

  /**
   * Called with the literal hook-file content, so the callback can select
   * that file within the (now current) repo.
   */
  onFileNavigate(rawContent: string): void;
}

/**
 * Reacts to the daemon's `follow-change` events, gated by a client-side
 * toggle. Holds no watcher — all file watching lives on the daemon.
 */
export class FollowMode {
  private subscription: DaemonSubscription | null = null;
  private _enabled: boolean;

  constructor(
    private client: DiffstalkerClient,
    private getCurrentRepoPath: () => string,
    private callbacks: FollowModeCallbacks,
    enabled: boolean
  ) {
    this._enabled = enabled;
  }

  get isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Open the daemon-scope subscription. Idempotent; the toggle — not this —
   * decides whether follow-change events are acted on, so the connection
   * stays up across toggles.
   */
  start(): void {
    if (this.subscription) return;
    const subscription = this.client.subscribeDaemon();
    this.subscription = subscription;
    subscription.on('follow-change', (event) => this.onFollowChange(event));
  }

  private onFollowChange(event: FollowChangeEvent): void {
    if (!this._enabled) return;
    // `path` is the resolved hook-file content (worktree root or a file
    // inside it). A repo different from the current session's switches;
    // applyRepoSwitch de-dupes when the daemon normalizes it back to the
    // current repo, so following a file within the active repo stays put.
    if (event.path && event.path !== this.getCurrentRepoPath()) {
      this.callbacks.onRepoChange(event.path);
    }
    if (event.rawContent) {
      this.callbacks.onFileNavigate(event.rawContent);
    }
  }

  /** Flip the follow toggle; returns the new state. */
  toggle(): boolean {
    this._enabled = !this._enabled;
    return this._enabled;
  }

  /** Turn follow off (e.g. after a manual repo switch); keeps the stream. */
  disable(): void {
    this._enabled = false;
  }

  /** Close the daemon-scope subscription (app exit). */
  dispose(): void {
    this.subscription?.close();
    this.subscription = null;
  }
}
