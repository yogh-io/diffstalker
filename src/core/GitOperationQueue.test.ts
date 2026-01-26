/**
 * Unit tests for GitOperationQueue
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { GitOperationQueue, getQueueForRepo, removeQueueForRepo } from './GitOperationQueue.js';

describe('GitOperationQueue', () => {
  let queue: GitOperationQueue;

  beforeEach(() => {
    queue = new GitOperationQueue();
  });

  describe('enqueue', () => {
    test('executes a single operation and returns result', async () => {
      const result = await queue.enqueue(async () => 'hello');
      expect(result).toBe('hello');
    });

    test('executes operations sequentially', async () => {
      const order: number[] = [];

      const op1 = queue.enqueue(async () => {
        await delay(50);
        order.push(1);
        return 1;
      });

      const op2 = queue.enqueue(async () => {
        order.push(2);
        return 2;
      });

      const op3 = queue.enqueue(async () => {
        order.push(3);
        return 3;
      });

      await Promise.all([op1, op2, op3]);

      // Operations should complete in order despite op1 being slower
      expect(order).toEqual([1, 2, 3]);
    });

    test('propagates errors', async () => {
      const error = new Error('test error');

      await expect(
        queue.enqueue(async () => {
          throw error;
        })
      ).rejects.toThrow('test error');
    });

    test('continues processing after error', async () => {
      const results: (string | Error)[] = [];

      const op1 = queue
        .enqueue(async () => {
          throw new Error('error');
        })
        .catch((e) => e);

      const op2 = queue.enqueue(async () => 'success');

      const [r1, r2] = await Promise.all([op1, op2]);
      expect(r1).toBeInstanceOf(Error);
      expect(r2).toBe('success');
    });
  });

  describe('enqueueMutation', () => {
    test('tracks pending mutations', async () => {
      expect(queue.hasPendingMutations()).toBe(false);

      let resolve1: () => void;
      const op1 = queue.enqueueMutation(() => new Promise<void>((r) => (resolve1 = r)));

      // Mutation is now pending
      expect(queue.hasPendingMutations()).toBe(true);

      resolve1!();
      await op1;

      // Mutation completed
      expect(queue.hasPendingMutations()).toBe(false);
    });

    test('tracks multiple pending mutations', async () => {
      let resolve1: () => void;
      let resolve2: () => void;

      const op1 = queue.enqueueMutation(() => new Promise<void>((r) => (resolve1 = r)));
      const op2 = queue.enqueueMutation(() => new Promise<void>((r) => (resolve2 = r)));

      expect(queue.hasPendingMutations()).toBe(true);

      resolve1!();
      await op1;

      // Still has pending mutations (op2)
      expect(queue.hasPendingMutations()).toBe(true);

      resolve2!();
      await op2;

      expect(queue.hasPendingMutations()).toBe(false);
    });

    test('decrements pending count even on error', async () => {
      const op = queue
        .enqueueMutation(async () => {
          throw new Error('error');
        })
        .catch(() => {});

      await op;

      expect(queue.hasPendingMutations()).toBe(false);
    });
  });

  describe('scheduleRefresh', () => {
    test('schedules a refresh callback', async () => {
      let called = false;

      queue.scheduleRefresh(async () => {
        called = true;
      });

      // Wait for queue to process
      await delay(10);
      expect(called).toBe(true);
    });

    test('skips refresh if mutations are pending', async () => {
      let refreshCalled = false;

      let resolveMutation: () => void;
      const mutation = queue.enqueueMutation(() => new Promise<void>((r) => (resolveMutation = r)));

      // Try to schedule refresh while mutation is pending
      queue.scheduleRefresh(async () => {
        refreshCalled = true;
      });

      // Complete the mutation
      resolveMutation!();
      await mutation;

      // Give time for refresh to run if it was scheduled
      await delay(10);

      // Refresh should NOT have been called because mutation was pending
      expect(refreshCalled).toBe(false);
    });

    test('skips duplicate refresh scheduling while refresh is queued', async () => {
      let callCount = 0;

      // Block the queue with a slow operation so refresh stays queued
      let resolveBlocker: () => void;
      queue.enqueue(() => new Promise<void>((r) => (resolveBlocker = r)));

      // Now schedule multiple refreshes - they should coalesce into one
      queue.scheduleRefresh(async () => {
        callCount++;
      });

      queue.scheduleRefresh(async () => {
        callCount++;
      });

      queue.scheduleRefresh(async () => {
        callCount++;
      });

      // Release the blocker
      resolveBlocker!();

      // Wait for processing
      await delay(50);

      // Only one refresh should have run
      expect(callCount).toBe(1);
    });

    test('allows new refresh after previous completes', async () => {
      let callCount = 0;

      queue.scheduleRefresh(async () => {
        callCount++;
      });

      // Wait for first refresh to complete
      await delay(20);

      queue.scheduleRefresh(async () => {
        callCount++;
      });

      await delay(20);

      expect(callCount).toBe(2);
    });
  });

  describe('isBusy', () => {
    test('returns false when idle', () => {
      expect(queue.isBusy()).toBe(false);
    });

    test('returns true when processing', async () => {
      let resolveFn: () => void;
      const op = queue.enqueue(() => new Promise<void>((r) => (resolveFn = r)));

      expect(queue.isBusy()).toBe(true);

      resolveFn!();
      await op;

      expect(queue.isBusy()).toBe(false);
    });

    test('returns true when queue has pending operations', async () => {
      let resolveFn: () => void;
      queue.enqueue(() => new Promise<void>((r) => (resolveFn = r)));
      queue.enqueue(async () => {});

      expect(queue.isBusy()).toBe(true);

      resolveFn!();

      // Wait for both to complete
      await delay(20);
      expect(queue.isBusy()).toBe(false);
    });
  });
});

describe('Queue registry', () => {
  beforeEach(() => {
    // Clean up registry between tests
    removeQueueForRepo('/test/repo1');
    removeQueueForRepo('/test/repo2');
  });

  test('getQueueForRepo returns same queue for same path', () => {
    const q1 = getQueueForRepo('/test/repo1');
    const q2 = getQueueForRepo('/test/repo1');

    expect(q1).toBe(q2);
  });

  test('getQueueForRepo returns different queues for different paths', () => {
    const q1 = getQueueForRepo('/test/repo1');
    const q2 = getQueueForRepo('/test/repo2');

    expect(q1).not.toBe(q2);
  });

  test('removeQueueForRepo removes queue from registry', () => {
    const q1 = getQueueForRepo('/test/repo1');
    removeQueueForRepo('/test/repo1');
    const q2 = getQueueForRepo('/test/repo1');

    expect(q1).not.toBe(q2);
  });
});

// Helper function
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
