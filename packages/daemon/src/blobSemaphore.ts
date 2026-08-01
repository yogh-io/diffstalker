/**
 * A counting semaphore with a bounded wait queue. Both byte routes hold one
 * slot from before the first git spawn or fs open until their response is
 * finished on the socket.
 *
 * Serving repo bytes is the one endpoint a single page can aim a hundred
 * requests at without trying: every changed image in a diff is an `<img>`,
 * and the browser opens them all at once. Each request either spawns a git
 * process or opens a file descriptor, and buffers up to 8 MiB before it can
 * decide whether it is allowed to answer at all. Unbounded, one viewport
 * becomes gigabytes of resident memory and a process table full of git.
 *
 * A slot is what bounds RESIDENT BYTES, not just reads, and that is why the
 * routes keep it until the response is written rather than until the read is
 * done. The buffer stays alive while the client drains it, so an earlier
 * release would leave the concurrency limit measuring nothing: a slow reader
 * could push request after request through the gate and hold a live buffer
 * behind each one.
 *
 * Bounding the QUEUE as well as the concurrency is what turns a flood into a
 * refusal rather than a slow death. Past the queue limit `acquire` hands back
 * nothing to await, so the caller answers 503 immediately instead of parking
 * one more request in memory.
 *
 * It lives in its own module so the queueing arithmetic is unit-testable
 * directly — racing real HTTP requests to observe a full queue proves less and
 * flakes more. Giving a slot BACK is the opposite case: it hangs off response
 * and request events, which no unit test of this file can see, so the routes
 * test that half against a real server with a real client that walks away.
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

/** Blob requests in flight. Four git processes is already generous for one UI. */
export const BLOB_CONCURRENCY = 4;

/**
 * Waiting requests. One changed binary file costs up to three of them — a
 * `/media` for the verdict plus a `/blob` for each side — so this is roughly
 * twenty changed images queued behind the four in flight.
 */
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
