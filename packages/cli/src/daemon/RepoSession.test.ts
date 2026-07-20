/**
 * RepoSession unit tests against a mocked DiffstalkerClient.
 *
 * These carry the behavioral coverage that used to live in-process on the
 * core managers (selection debounce + stale-guard, untracked single-fetch,
 * mutation error surfacing, cascade re-pulls) plus the daemon-specific
 * behavior (envelope application, reconnect re-open, remote synthesis,
 * not-a-repo mode).
 */

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { DiffstalkerClient, WireSharedState, MutationEnvelope } from '@diffstalker/client';
import type { FileEntry } from '@diffstalker/core/git/status';
import { RepoSession, openRepoSession } from './RepoSession.js';

const REPO_ID = 'abc123def456';
const REPO_PATH = '/fake/repo';

function wireState(overrides: Partial<WireSharedState> = {}): WireSharedState {
  return {
    status: {
      isRepo: true,
      branch: { current: 'main', ahead: 0, behind: 0 },
      files: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'modified', staged: false },
        { path: 'new.ts', status: 'untracked', staged: false },
      ],
    },
    hunkCounts: { staged: {}, unstaged: { 'a.ts': 1 } },
    error: null,
    stashList: [],
    operationInProgress: null,
    ...overrides,
  };
}

function envelope(overrides: Partial<MutationEnvelope> = {}): MutationEnvelope {
  return { state: wireState(), ...overrides };
}

class FakeSubscription extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
}

interface FakeClientOptions {
  /** Per-method overrides; anything unset gets a benign default. */
  [method: string]: unknown;
}

/**
 * A recording fake of the client: every call lands in `calls`, and each
 * method can be overridden per-test. subscribeRepo returns a fresh
 * FakeSubscription (the latest one is kept on `subscription`).
 */
function fakeClient(overrides: FakeClientOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const subscriptions: FakeSubscription[] = [];

  const defaults: Record<string, (...args: unknown[]) => unknown> = {
    openRepo: () => Promise.resolve({ id: REPO_ID, path: REPO_PATH }),
    closeRepo: () => Promise.resolve(),
    status: () => Promise.resolve(wireState()),
    diff: (_id, opts) => {
      const o = (opts ?? {}) as { path?: string; staged?: boolean };
      return Promise.resolve({ raw: `${o.path ?? '(all)'}:${o.staged ?? false}`, lines: [] });
    },
    stage: () => Promise.resolve(envelope()),
    unstage: () => Promise.resolve(envelope()),
    stageAll: () => Promise.resolve(envelope()),
    unstageAll: () => Promise.resolve(envelope()),
    discard: () => Promise.resolve(envelope()),
    stageHunk: () => Promise.resolve(envelope()),
    unstageHunk: () => Promise.resolve(envelope()),
    commit: () => Promise.resolve(envelope()),
    history: () => Promise.resolve([]),
    commitDiff: () => Promise.resolve({ raw: '', lines: [] }),
    headMessage: () => Promise.resolve('head message'),
    compare: () => Promise.resolve({ baseBranch: 'main', commits: [], files: [] }),
    baseBranches: () => Promise.resolve(['main']),
    setCompareBase: (_id, branch) => Promise.resolve(branch),
    cherryPick: () => Promise.resolve(envelope({ result: 'Cherry-picked' })),
    revert: () => Promise.resolve(envelope({ result: 'Reverted' })),
    worktrees: () => Promise.resolve([]),
    subscribeRepo: () => {
      const subscription = new FakeSubscription();
      subscriptions.push(subscription);
      return subscription;
    },
  };

  const client = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          const impl = (overrides[prop] as typeof defaults[string]) ?? defaults[prop];
          if (!impl) throw new Error(`fakeClient: unexpected method ${prop}`);
          return impl(...args);
        };
      },
    }
  ) as unknown as DiffstalkerClient;

  return {
    client,
    calls,
    subscriptions,
    callsTo: (method: string) => calls.filter((c) => c.method === method),
  };
}

function makeSession(fake: ReturnType<typeof fakeClient>): RepoSession {
  const session = new RepoSession(
    fake.client,
    { id: REPO_ID, path: REPO_PATH },
    { reconnectDelayMs: 1 }
  );
  session.connect();
  return session;
}

const fileA: FileEntry = { path: 'a.ts', status: 'modified', staged: false };
const fileB: FileEntry = { path: 'b.ts', status: 'modified', staged: false };
const untracked: FileEntry = { path: 'new.ts', status: 'untracked', staged: false };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RepoSession shared state', () => {
  test('applies SSE snapshot: status, revived hunk counts, isLoading off', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);
    expect(session.shared.isLoading).toBe(true);

    const events: number[] = [];
    session.on('state-change', () => events.push(1));
    fake.subscriptions[0].emit('snapshot', wireState());

    expect(session.shared.isLoading).toBe(false);
    expect(session.shared.status?.branch.current).toBe('main');
    expect(session.shared.hunkCounts?.unstaged).toBeInstanceOf(Map);
    expect(session.shared.hunkCounts?.unstaged.get('a.ts')).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    await session.dispose();
  });

  test('refresh pulls /status and applies it', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);
    await session.refresh();
    expect(fake.callsTo('status').length).toBe(1);
    expect(session.shared.status?.isRepo).toBe(true);
    await session.dispose();
  });
});

describe('RepoSession selection', () => {
  test('debounce: rapid selectFile calls coalesce to leading + trailing fetch', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);

    session.selectFile(fileA); // leading fetch fires immediately
    session.selectFile(fileB); // replaces the trailing fetch
    session.selectFile(fileA); // still within the window: trailing = A
    await sleep(40);

    const diffPaths = fake.callsTo('diff').map((c) => (c.args[1] as { path?: string }).path);
    // Leading fetch for a.ts (2 sides) + trailing fetch for a.ts (2 sides);
    // b.ts was debounced away entirely.
    expect(diffPaths).not.toContain('b.ts');
    expect(diffPaths.filter((p) => p === 'a.ts').length).toBe(4);
    await session.dispose();
  });

  test('stale-guard: a superseded fetch never lands in state', async () => {
    let releaseA: (() => void) | null = null;
    const fake = fakeClient({
      diff: (_id: string, opts: { path?: string; staged?: boolean }) => {
        const result = { raw: `${opts.path}:${opts.staged}`, lines: [] };
        if (opts.path === 'a.ts') {
          return new Promise((resolve) => {
            releaseA = () => resolve(result);
          });
        }
        return Promise.resolve(result);
      },
    });
    const session = makeSession(fake);

    session.selectFile(fileA); // fetch blocks
    await sleep(30);
    session.selectFile(fileB); // fetch resolves immediately
    await sleep(30);
    expect(session.selection.diff?.raw).toBe('b.ts:false');

    releaseA!(); // stale a.ts result arrives late
    await sleep(5);
    expect(session.selection.diff?.raw).toBe('b.ts:false'); // not clobbered
    await session.dispose();
  });

  test('untracked file: single diff fetch, never staged=true', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);

    session.selectFile(untracked);
    await sleep(30);

    const diffCalls = fake.callsTo('diff');
    expect(diffCalls.length).toBe(1);
    const opts = diffCalls[0].args[1] as { path?: string; staged?: boolean };
    expect(opts.path).toBe('new.ts');
    expect('staged' in opts).toBe(false);
    // Combined pair synthesizes an empty staged side for the flat view.
    expect(session.selection.combined?.staged.raw).toBe('');
    await session.dispose();
  });

  test('status arrival re-anchors the selection and clears a vanished file', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);
    session.selectFile(fileA);
    await sleep(30);

    // a.ts now staged: the selection follows the path to the new entry.
    fake.subscriptions[0].emit(
      'state-change',
      wireState({
        status: {
          isRepo: true,
          branch: { current: 'main', ahead: 0, behind: 0 },
          files: [{ path: 'a.ts', status: 'modified', staged: true }],
        },
      })
    );
    expect(session.selection.file?.staged).toBe(true);

    // a.ts vanishes: the selection clears (the UI reconciler picks a neighbor).
    fake.subscriptions[0].emit(
      'state-change',
      wireState({
        status: { isRepo: true, branch: { current: 'main', ahead: 0, behind: 0 }, files: [] },
      })
    );
    expect(session.selection.file).toBeNull();
    await session.dispose();
  });
});

describe('RepoSession mutations', () => {
  test('success applies the envelope state through the SSE path', async () => {
    const fake = fakeClient({
      stage: () =>
        Promise.resolve(
          envelope({ state: wireState({ hunkCounts: { staged: { 'a.ts': 2 }, unstaged: {} } }) })
        ),
    });
    const session = makeSession(fake);

    await session.stage(fileA);
    expect(fake.callsTo('stage').length).toBe(1);
    expect(session.shared.hunkCounts?.staged.get('a.ts')).toBe(2);
    expect(session.shared.isLoading).toBe(false);
    await session.dispose();
  });

  test('failure lands in shared.error and never throws to the caller', async () => {
    const fake = fakeClient({
      stageHunk: () => Promise.reject(new Error('patch does not apply')),
    });
    const session = makeSession(fake);

    await session.stageHunk('--- fake patch'); // must not reject
    expect(session.shared.error).toContain('Failed to stage hunk');
    expect(session.shared.error).toContain('patch does not apply');
    await session.dispose();
  });

  test('discard is refused for a staged entry (parity with the old manager)', async () => {
    const fake = fakeClient();
    const session = makeSession(fake);
    await session.discard({ path: 'a.ts', status: 'modified', staged: true });
    expect(fake.callsTo('discard').length).toBe(0);
    await session.dispose();
  });
});

describe('RepoSession history and compare', () => {
  test('loadHistory populates commits; state-change re-pulls when loaded', async () => {
    const commit = {
      hash: 'abcd1234',
      shortHash: 'abcd123',
      message: 'msg',
      author: 'a',
      date: new Date(),
      refs: '',
    };
    const fake = fakeClient({ history: () => Promise.resolve([commit]) });
    const session = makeSession(fake);

    await session.loadHistory(50);
    expect(session.history.commits.length).toBe(1);
    expect(fake.callsTo('history').length).toBe(1);

    // A state-change re-pulls history (the old cascade, client-side).
    fake.subscriptions[0].emit('state-change', wireState());
    await sleep(10);
    expect(fake.callsTo('history').length).toBe(2);
    await session.dispose();
  });

  test('refreshCompare stores the diff and base branch; errors land in compare.error', async () => {
    const fake = fakeClient({
      compare: () => Promise.resolve({ baseBranch: 'develop', commits: [], files: [] }),
    });
    const session = makeSession(fake);
    await session.refreshCompare(true);
    expect(session.compare.baseBranch).toBe('develop');
    expect(session.compare.compareDiff).not.toBeNull();
    expect((fake.callsTo('compare')[0].args[1] as { uncommitted?: boolean }).uncommitted).toBe(
      true
    );

    const failing = fakeClient({ compare: () => Promise.reject(new Error('no base')) });
    const failingSession = makeSession(failing);
    await failingSession.refreshCompare();
    expect(failingSession.compare.error).toContain('no base');
    await session.dispose();
    await failingSession.dispose();
  });
});

describe('RepoSession remote operations', () => {
  test('cherryPick synthesizes inProgress then lastResult', async () => {
    let release: ((value: MutationEnvelope) => void) | null = null;
    const fake = fakeClient({
      cherryPick: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const session = makeSession(fake);

    const done = session.cherryPick('abcd1234');
    expect(session.remote.inProgress).toBe(true);
    expect(session.remote.operation).toBe('cherryPick');

    release!(envelope({ result: 'Cherry-picked abcd1234' }));
    await done;
    expect(session.remote.inProgress).toBe(false);
    expect(session.remote.lastResult).toBe('Cherry-picked abcd1234');
    await session.dispose();
  });

  test('revert failure sets remote.error; clearRemoteState resets', async () => {
    const fake = fakeClient({ revert: () => Promise.reject(new Error('conflict')) });
    const session = makeSession(fake);

    await session.revertCommit('abcd1234'); // must not reject
    expect(session.remote.error).toBe('conflict');
    session.clearRemoteState();
    expect(session.remote.error).toBeNull();
    await session.dispose();
  });
});

describe('RepoSession reconnect', () => {
  test('connection drop surfaces an error, re-opens the repo, resubscribes, re-pulls history', async () => {
    const commit = {
      hash: 'abcd1234',
      shortHash: 'abcd123',
      message: 'msg',
      author: 'a',
      date: new Date(),
      refs: '',
    };
    const fake = fakeClient({ history: () => Promise.resolve([commit]) });
    const session = makeSession(fake);
    await session.loadHistory();
    const historyCalls = fake.callsTo('history').length;

    fake.subscriptions[0].emit('close');
    expect(session.shared.error).toContain('reconnecting');

    await sleep(20); // reconnectDelayMs is 1 in tests
    expect(fake.callsTo('openRepo').length).toBe(1); // re-POST /repos
    expect(fake.subscriptions.length).toBe(2); // resubscribed
    expect(fake.callsTo('history').length).toBeGreaterThan(historyCalls);
    await session.dispose();
  });
});

describe('openRepoSession and not-a-repo mode', () => {
  test('daemon refusal yields a not-a-repo session with the reason surfaced', async () => {
    const fake = fakeClient({
      openRepo: () => Promise.reject(new Error('Not a git repository: /fake/nope')),
    });
    const session = await openRepoSession(fake.client, '/fake/nope');

    expect(session.isRepo).toBe(false);
    expect(session.repoId).toBeNull();
    expect(session.repoPath).toBe('/fake/nope');
    expect(session.shared.error).toContain('Not a git repository');
    expect(session.shared.isLoading).toBe(false);
    expect(fake.callsTo('subscribeRepo').length).toBe(0);

    // Every operation no-ops without touching the client.
    await session.stage(fileA);
    session.selectFile(fileA);
    await session.loadHistory();
    await session.refreshCompare();
    expect(await session.getHeadCommitMessage()).toBe('');
    expect(await session.listWorktrees()).toEqual([]);
    expect(fake.callsTo('stage').length).toBe(0);
    expect(fake.callsTo('diff').length).toBe(0);
    await session.dispose();
  });

  test('a successful open connects and dispose releases the daemon ref', async () => {
    const fake = fakeClient();
    const session = await openRepoSession(fake.client, REPO_PATH);
    expect(session.repoId).toBe(REPO_ID);
    expect(fake.callsTo('subscribeRepo').length).toBe(1);

    await session.dispose();
    expect(fake.callsTo('closeRepo').length).toBe(1);
    expect(fake.subscriptions[0].closed).toBe(true);
  });
});
