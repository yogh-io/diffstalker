/**
 * GitOperationQueue - Serializes git operations to prevent index.lock conflicts.
 *
 * All git operations must go through this queue to ensure they execute
 * sequentially, preventing concurrent access to the git index.
 */

interface QueuedOperation<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class GitOperationQueue {
  private queue: QueuedOperation<unknown>[] = [];
  private isProcessing = false;
  private scheduledRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRefresh: (() => Promise<void>) | null = null;
  private pendingMutations = 0; // Track pending stage/unstage operations

  /**
   * Enqueue a git operation to be executed sequentially.
   * Returns a promise that resolves when the operation completes.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processNext();
    });
  }

  /**
   * Enqueue a mutation operation (stage/unstage) that should block refreshes.
   * Refreshes are suppressed while any mutations are pending.
   */
  enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingMutations++;
    return this.enqueue(operation).finally(() => {
      this.pendingMutations--;
    });
  }

  /**
   * Check if there are pending mutation operations.
   */
  hasPendingMutations(): boolean {
    return this.pendingMutations > 0;
  }

  /**
   * Schedule a debounced refresh operation.
   * Only one refresh can be pending at a time - new calls replace previous ones.
   * The refresh runs through the queue to ensure it doesn't conflict with other operations.
   * Skips scheduling if there are pending mutations - the last mutation will trigger a refresh.
   */
  scheduleRefresh(callback: () => Promise<void>, delay: number = 150): void {
    // Store the callback for later (even if we don't schedule now)
    this.pendingRefresh = callback;

    // If there are pending mutations, don't schedule yet - the last mutation will trigger refresh
    if (this.pendingMutations > 0) {
      return;
    }

    // Clear any existing scheduled refresh
    if (this.scheduledRefreshTimer) {
      clearTimeout(this.scheduledRefreshTimer);
    }

    // Schedule the refresh
    this.scheduledRefreshTimer = setTimeout(() => {
      // Double-check no mutations started while we were waiting
      if (this.pendingRefresh && this.pendingMutations === 0) {
        const refresh = this.pendingRefresh;
        this.pendingRefresh = null;
        this.scheduledRefreshTimer = null;
        // Enqueue the refresh so it runs in order
        this.enqueue(refresh).catch(() => {
          // Silently ignore refresh errors - they'll be handled by the callback
        });
      }
    }, delay);
  }

  /**
   * Cancel any pending scheduled refresh.
   */
  cancelScheduledRefresh(): void {
    if (this.scheduledRefreshTimer) {
      clearTimeout(this.scheduledRefreshTimer);
      this.scheduledRefreshTimer = null;
    }
    this.pendingRefresh = null;
  }

  /**
   * Check if the queue is currently processing or has pending operations.
   */
  isBusy(): boolean {
    return this.isProcessing || this.queue.length > 0;
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    const operation = this.queue.shift()!;

    try {
      const result = await operation.execute();
      operation.resolve(result);
    } catch (error) {
      operation.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isProcessing = false;
      // Process next operation if any
      this.processNext();
    }
  }
}

// Global registry of queues per repo path to ensure single queue per repo
const queueRegistry = new Map<string, GitOperationQueue>();

/**
 * Get the operation queue for a specific repository.
 * Creates a new queue if one doesn't exist for this path.
 */
export function getQueueForRepo(repoPath: string): GitOperationQueue {
  let queue = queueRegistry.get(repoPath);
  if (!queue) {
    queue = new GitOperationQueue();
    queueRegistry.set(repoPath, queue);
  }
  return queue;
}

/**
 * Remove a queue from the registry (for cleanup).
 */
export function removeQueueForRepo(repoPath: string): void {
  const queue = queueRegistry.get(repoPath);
  if (queue) {
    queue.cancelScheduledRefresh();
    queueRegistry.delete(repoPath);
  }
}
