/**
 * A counting semaphore with a bounded wait queue. The blob route holds one
 * slot for the whole time it spawns git or holds an fd open.
 *
 * Serving repo bytes is the one endpoint a single page can aim a hundred
 * requests at without trying: every changed image in a diff is an `<img>`,
 * and the browser opens them all at once. Each request either spawns a git
 * process or opens a file descriptor, and buffers up to 8 MiB before it can
 * decide whether it is allowed to answer at all. Unbounded, one viewport
 * becomes gigabytes of resident memory and a process table full of git.
 *
 * Bounding the QUEUE as well as the concurrency is what turns a flood into a
 * refusal rather than a slow death. Past the queue limit `acquire` hands back
 * nothing to await, so the caller answers 503 immediately: a flood costs a
 * status line instead of a held-open request with a live buffer behind it.
 *
 * It lives in its own module so the queueing is unit-testable directly.
 * Racing real HTTP requests to observe a queue is a flaky test that proves
 * less than the arithmetic below.
 */

/** Give the slot back. Idempotent: a second call does nothing. */
export type ReleaseBlobSlot = () => void;

export interface BlobSemaphore {
  /**
   * A promise for a slot, or null when the queue is full. Null is not an
   * error to retry — it is the signal to refuse the request now.
   */
  acquire(): Promise<ReleaseBlobSlot> | null;
  /** Slots in use. For tests and diagnostics; routes must not read it. */
  readonly active: number;
  /** Callers waiting for a slot. */
  readonly queued: number;
}

/** Concurrent blob reads. Four git processes is already generous for one UI. */
export const BLOB_CONCURRENCY = 4;

/** Waiting requests. Roughly one large diff's worth of images. */
export const BLOB_QUEUE_LIMIT = 64;

export function createBlobSemaphore(
  limit: number = BLOB_CONCURRENCY,
  queueLimit: number = BLOB_QUEUE_LIMIT
): BlobSemaphore {
  let active = 0;
  const waiters: Array<(release: ReleaseBlobSlot) => void> = [];

  function makeRelease(): ReleaseBlobSlot {
    let spent = false;
    return () => {
      // A double release would hand out a slot that was never taken, which
      // is how a bounded semaphore quietly becomes an unbounded one.
      if (spent) return;
      spent = true;
      const next = waiters.shift();
      if (next) {
        // The slot moves straight to the next waiter, so `active` is
        // unchanged: it was never free.
        next(makeRelease());
      } else {
        active--;
      }
    };
  }

  return {
    acquire(): Promise<ReleaseBlobSlot> | null {
      if (active < limit) {
        active++;
        return Promise.resolve(makeRelease());
      }
      if (waiters.length >= queueLimit) return null;
      return new Promise<ReleaseBlobSlot>((resolve) => {
        waiters.push(resolve);
      });
    },
    get active(): number {
      return active;
    },
    get queued(): number {
      return waiters.length;
    },
  };
}
