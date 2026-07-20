/**
 * FollowMode unit tests against a mocked daemon-scope subscription.
 *
 * FollowMode no longer watches any file — it subscribes to the daemon's
 * follow-change SSE and reacts, gated by a client-side toggle. These tests
 * cover: opening the subscription once, toggle-gating (the disabled case
 * ignores events), the repo switch + file navigate on a follow-change, and
 * dispose closing the stream.
 */

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { DiffstalkerClient } from '@diffstalker/client';
import { FollowMode } from './FollowMode.js';

class FakeDaemonSubscription extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
}

function fakeClient() {
  const subscriptions: FakeDaemonSubscription[] = [];
  const client = {
    subscribeDaemon() {
      const subscription = new FakeDaemonSubscription();
      subscriptions.push(subscription);
      return subscription;
    },
  } as unknown as DiffstalkerClient;
  return { client, subscriptions };
}

const CURRENT_REPO = '/repo/current';

function makeFollow(enabled: boolean, currentRepo: string = CURRENT_REPO) {
  const { client, subscriptions } = fakeClient();
  const repoChanges: string[] = [];
  const fileNavs: string[] = [];
  const follow = new FollowMode(
    client,
    () => currentRepo,
    {
      onRepoChange: (path) => repoChanges.push(path),
      onFileNavigate: (raw) => fileNavs.push(raw),
    },
    enabled
  );
  follow.start();
  return { follow, subscriptions, repoChanges, fileNavs };
}

function emit(subscription: FakeDaemonSubscription, path: string, rawContent: string): void {
  subscription.emit('follow-change', { repoId: 'id', path, rawContent });
}

describe('FollowMode', () => {
  test('opens the daemon-scope subscription once, and start() is idempotent', () => {
    const { follow, subscriptions } = makeFollow(true);
    expect(subscriptions).toHaveLength(1);
    follow.start();
    expect(subscriptions).toHaveLength(1);
  });

  test('ignores follow-change while disabled', () => {
    const { subscriptions, repoChanges, fileNavs } = makeFollow(false);
    emit(subscriptions[0], '/repo/other', '/repo/other/x.ts');
    expect(repoChanges).toEqual([]);
    expect(fileNavs).toEqual([]);
  });

  test('switches repo and navigates on follow-change while enabled', () => {
    const { subscriptions, repoChanges, fileNavs } = makeFollow(true);
    emit(subscriptions[0], '/repo/other', '/repo/other/x.ts');
    expect(repoChanges).toEqual(['/repo/other']);
    expect(fileNavs).toEqual(['/repo/other/x.ts']);
  });

  test('does not switch when the followed path is the current repo, but still navigates', () => {
    const { subscriptions, repoChanges, fileNavs } = makeFollow(true);
    emit(subscriptions[0], CURRENT_REPO, `${CURRENT_REPO}/x.ts`);
    expect(repoChanges).toEqual([]);
    expect(fileNavs).toEqual([`${CURRENT_REPO}/x.ts`]);
  });

  test('toggle() gates reactions; disable() turns it back off', () => {
    const { follow, subscriptions, repoChanges } = makeFollow(false);

    emit(subscriptions[0], '/repo/a', '');
    expect(repoChanges).toEqual([]);

    expect(follow.toggle()).toBe(true);
    expect(follow.isEnabled).toBe(true);
    emit(subscriptions[0], '/repo/b', '');
    expect(repoChanges).toEqual(['/repo/b']);

    follow.disable();
    expect(follow.isEnabled).toBe(false);
    emit(subscriptions[0], '/repo/c', '');
    expect(repoChanges).toEqual(['/repo/b']);
  });

  test('dispose() closes the subscription and stops reacting', () => {
    const { follow, subscriptions, repoChanges } = makeFollow(true);
    follow.dispose();
    expect(subscriptions[0].closed).toBe(true);
    emit(subscriptions[0], '/repo/other', '/repo/other/x.ts');
    expect(repoChanges).toEqual([]);
  });
});
