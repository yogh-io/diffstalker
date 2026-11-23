/**
 * useDraftStore tests: which branch the panel drafts for, the debounced
 * save (one PUT at a time, each on the version the last answer carried),
 * the 409 path, and live updates from `draft-change`. A fake fetch plays
 * the daemon and keeps top.md as one string with a version counter.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useDraftStore } from './draft';
import { DRAFT_SAVE_DELAY_MS } from '../composables/draftSession';
import { useRepoStore } from './repo';
import { useDaemonStore } from './daemon';
import { Deferred, FakeEventSource, makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FakeResponse, FetchCall } from '../testing/fakes';
import type { BranchPr, PrDraft, PutDraftRequest } from '@diffstalker/core/types/work';
import type { CompareStack } from '@diffstalker/core/types/stack';

interface Disk {
  top: string | null;
  suggested: string | null;
  ai: string | null;
  version: number;
}

let fake: FakeFetch;
let disks: Map<string, Disk>;
let local: string[];
/** Hold the next PUT until released. */
let holdPut: Deferred<void> | null;
/** Hold the next PUT's answer until released; it has written by then. */
let holdPutAnswer: Deferred<void> | null;
/** Answer the next PUT with this status and write nothing. */
let putStatus: number | null;
/** Hold the next draft GET until released; `readFirst` reads the disk before the hold. */
let holdGet: { gate: Deferred<void>; readFirst: boolean } | null;

function disk(branch: string): Disk {
  let entry = disks.get(branch);
  if (!entry) {
    entry = { top: null, suggested: null, ai: null, version: 0 };
    disks.set(branch, entry);
  }
  return entry;
}

function versionOf(entry: Disk): string {
  return entry.top === null ? 'absent' : `v${entry.version}`;
}

function asDraft(branch: string): PrDraft {
  const entry = disk(branch);
  return {
    branch,
    top: entry.top,
    suggested: entry.suggested,
    ai: entry.ai,
    adoptedUnedited: false,
    version: versionOf(entry),
  };
}

/** Change top.md the way another tab or an editor would. */
function writeElsewhere(branch: string, top: string): void {
  const entry = disk(branch);
  entry.top = top;
  entry.version += 1;
}

function branchOf(call: FetchCall): string {
  return decodeURIComponent(call.url.split('branch=')[1] ?? '');
}

async function getDraft(call: FetchCall): Promise<FakeResponse> {
  const early = asDraft(branchOf(call));
  if (holdGet) {
    const held = holdGet;
    holdGet = null;
    await held.gate.promise;
    if (!held.readFirst) return { body: asDraft(branchOf(call)) };
  }
  return { body: early };
}

async function putDraft(call: FetchCall): Promise<FakeResponse> {
  if (holdPut) {
    const held = holdPut;
    holdPut = null;
    await held.promise;
  }
  if (putStatus !== null) {
    const status = putStatus;
    putStatus = null;
    return { status, body: { error: 'daemon restarting' } };
  }
  const body = call.body as PutDraftRequest;
  const entry = disk(body.branch);
  if (body.version !== versionOf(entry))
    return { status: 409, body: { error: 'Draft changed elsewhere' } };
  entry.top = body.top.trim() === '' ? null : body.top;
  entry.version += 1;
  const answer = asDraft(body.branch);
  if (holdPutAnswer) {
    const held = holdPutAnswer;
    holdPutAnswer = null;
    await held.promise;
  }
  return { body: answer };
}

async function route(call: FetchCall): Promise<FakeResponse> {
  if (call.url === '/repos/r1/branches') {
    return { body: local.map((name) => ({ name, current: name === 'main' })) };
  }
  if (call.url.startsWith('/repos/r1/draft?')) return getDraft(call);
  if (call.url === '/repos/r1/draft' && call.method === 'PUT') return putDraft(call);
  if (call.url === '/repos' && call.method === 'POST') {
    return { body: { id: 'r2', path: (call.body as { path: string }).path } };
  }
  if (call.url === '/repos/r1' && call.method === 'DELETE') return { body: null };
  if (call.url === '/repos/r1/draft/adopt') {
    const { branch } = call.body as { branch: string };
    const entry = disk(branch);
    entry.top = entry.suggested;
    entry.version += 1;
    return { body: { ...asDraft(branch), adoptedUnedited: true } };
  }
  if (call.url.startsWith('/repos/r1/pr?')) {
    const answer: BranchPr = {
      pr: null,
      status: 'never',
      message: null,
      checkedAt: null,
      viewer: null,
    };
    return { body: answer };
  }
  if (call.url === '/work/prs/refresh') return { body: {} };
  return { status: 404, body: { error: 'no route' } };
}

function puts(): PutDraftRequest[] {
  return fake.calls.filter((c) => c.method === 'PUT').map((c) => c.body as PutDraftRequest);
}

function onBranch(current: string | null): void {
  const repo = useRepoStore();
  repo.shared = {
    ...repo.shared,
    status: {
      files: [],
      branch: { current: current ?? '', ahead: 0, behind: 0 },
      isRepo: true,
    },
    isLoading: false,
  };
}

/** An open repo r1 on `main`, the panel shown, and everything loaded. */
async function started(current: string | null = 'main') {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  repo.repoPath = '/w/calc';
  onBranch(current);
  const store = useDraftStore();
  store.start();
  await flushPromises();
  return { store, repo };
}

beforeEach(() => {
  setActivePinia(createPinia());
  disks = new Map();
  local = ['main', 'feature'];
  holdPut = null;
  holdPutAnswer = null;
  putStatus = null;
  holdGet = null;
  fake = makeFakeFetch(route);
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  useDraftStore().stop();
  useDaemonStore().disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('branch', () => {
  test("HEAD's branch, when it is a local branch", async () => {
    const { store } = await started();
    expect(store.branch).toBe('main');
    expect(fake.callsTo('/repos/r1/draft?branch=main')).toHaveLength(1);
  });

  test('a detached HEAD has no branch to draft for', async () => {
    const { store } = await started(null);
    expect(store.branchesKnown).toBe(true);
    expect(store.branch).toBeNull();
    expect(fake.callsTo('/repos/r1/draft')).toHaveLength(0);
  });

  test('a layer with only a remote-tracking name has none either', async () => {
    const { store, repo } = await started();
    const stack: CompareStack = {
      trunk: 'origin/main',
      layers: [
        { name: 'origin/base', refs: ['origin/base'], tip: 't1', commits: 1, isHead: false },
        { name: 'main', refs: ['main', 'origin/main-copy'], tip: 't2', commits: 1, isHead: true },
      ],
      forkedAbove: false,
    };
    repo.compareStack = stack;
    repo.selectedStackHead = 'origin/base';
    await flushPromises();
    expect(store.branch).toBeNull();

    repo.selectedStackHead = 'main';
    await flushPromises();
    expect(store.branch).toBe('main');
  });

  test('a head that is not a layer is the branch itself', async () => {
    const { store, repo } = await started();
    repo.compareStack = { trunk: 'origin/main', layers: [], forkedAbove: false };
    repo.selectedStackHead = 'feature';
    await flushPromises();
    expect(store.branch).toBe('feature');
  });
});

describe('saving', () => {
  test('one PUT, 400 ms after the last keystroke', async () => {
    const { store } = await started();
    store.setText('W');
    vi.advanceTimersByTime(300);
    store.setText('Why');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1);
    expect(puts()).toHaveLength(0);
    expect(store.save).toBe('dirty');

    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(puts()).toEqual([{ branch: 'main', top: 'Why', version: 'absent' }]);
    expect(store.save).toBe('idle');
    expect(store.baseVersion).toBe('v1');
  });

  test('typing during a save sends a second PUT on the version the answer carried', async () => {
    const { store } = await started();
    holdPut = new Deferred<void>();
    const held = holdPut;
    store.setText('one');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.save).toBe('saving');

    store.setText('one two');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(puts()).toHaveLength(1);

    held.resolve();
    await flushPromises();
    expect(puts()).toEqual([
      { branch: 'main', top: 'one', version: 'absent' },
      { branch: 'main', top: 'one two', version: 'v1' },
    ]);
    expect(store.save).toBe('idle');
    expect(disk('main').top).toBe('one two');
  });

  test('a 409 keeps the text and stops saving; reload takes the file', async () => {
    const { store } = await started();
    writeElsewhere('main', 'from the other tab');
    store.setText('mine');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.save).toBe('conflict');
    expect(store.text).toBe('mine');

    store.setText('mine, more');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 3);
    await flushPromises();
    expect(puts()).toHaveLength(1);

    await store.reload();
    expect(store.text).toBe('from the other tab');
    expect(store.save).toBe('idle');
  });

  test('an empty editor saves an empty top (the daemon deletes top.md)', async () => {
    writeElsewhere('main', 'old');
    const { store } = await started();
    store.setText('');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(puts().at(-1)).toEqual({ branch: 'main', top: '', version: 'v1' });
    expect(store.baseVersion).toBe('absent');
  });

  test('a pending save is sent at once on a branch change, to the old branch', async () => {
    const { store, repo } = await started();
    store.setText('for main');
    onBranch('feature');
    await flushPromises();
    expect(store.branch).toBe('feature');
    expect(puts()).toEqual([{ branch: 'main', top: 'for main', version: 'absent' }]);
    expect(store.text).toBe('');
    expect(repo.repoId).toBe('r1');
  });

  test('a save that failed is sent again on a branch change, to the old branch', async () => {
    const { store } = await started();
    putStatus = 503;
    store.setText('not on disk');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.save).toBe('error');

    onBranch('feature');
    await flushPromises();
    expect(puts()).toEqual([
      { branch: 'main', top: 'not on disk', version: 'absent' },
      { branch: 'main', top: 'not on disk', version: 'absent' },
    ]);
    expect(disk('main').top).toBe('not on disk');
  });

  test('a repo switch sends the pending save before the old repo is released', async () => {
    const { store, repo } = await started();
    store.setText('typed just now');
    await repo.open('/w/other');
    await flushPromises();
    expect(repo.repoId).toBe('r2');
    const order = fake.calls
      .filter((c) => c.method === 'PUT' || c.method === 'DELETE')
      .map((c) => `${c.method} ${c.url}`);
    expect(order).toEqual(['PUT /repos/r1/draft', 'DELETE /repos/r1']);
    expect(disk('main').top).toBe('typed just now');
  });

  test('a pending save is sent when the panel closes', async () => {
    const { store } = await started();
    store.setText('closing');
    store.stop();
    await flushPromises();
    expect(puts()).toEqual([{ branch: 'main', top: 'closing', version: 'absent' }]);
  });
});

describe('draft-change', () => {
  function emitChange(repo: ReturnType<typeof useRepoStore>, branch: string, prefix = false): void {
    const seq = (repo.lastDraftChange?.seq ?? 0) + 1;
    repo.lastDraftChange = { event: { branch, prefix }, seq };
  }

  test('the echo of our own write changes nothing', async () => {
    const { store, repo } = await started();
    store.setText('mine');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    store.setText('mine, still typing');
    emitChange(repo, 'main');
    await flushPromises();
    expect(store.text).toBe('mine, still typing');
    expect(store.save).toBe('dirty');
  });

  test('an echo that lands while our PUT is in flight is not a conflict', async () => {
    const { store, repo } = await started();
    holdPut = new Deferred<void>();
    const held = holdPut;
    store.setText('mine');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.save).toBe('saving');

    // The watcher speaks before the PUT answers: the re-read waits for it.
    emitChange(repo, 'main');
    await flushPromises();
    expect(fake.callsTo('/repos/r1/draft?branch=main')).toHaveLength(1);

    held.resolve();
    await flushPromises();
    expect(fake.callsTo('/repos/r1/draft?branch=main')).toHaveLength(2);
    expect(store.save).toBe('idle');
    expect(store.text).toBe('mine');
  });

  test('a save that starts while the re-read is out waits for it; nothing typed is lost', async () => {
    const { store, repo } = await started();
    store.setText('one');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.baseVersion).toBe('v1');

    // The echo of save 1: its GET is held and reads the disk late.
    const get = new Deferred<void>();
    holdGet = { gate: get, readFirst: false };
    emitChange(repo, 'main');
    await flushPromises();

    // Save 2 starts while the GET is out; it writes, its answer is held.
    const putAnswer = new Deferred<void>();
    holdPutAnswer = putAnswer;
    store.setText('one two');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    store.setText('one two three');

    get.resolve();
    await flushPromises();
    expect(store.save).not.toBe('conflict');

    putAnswer.resolve();
    await flushPromises();
    expect(store.save).toBe('dirty');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.save).toBe('idle');
    expect(store.text).toBe('one two three');
    expect(disk('main').top).toBe('one two three');
  });

  test('a re-read that answers after a newer save does not take the older text', async () => {
    const { store, repo } = await started();
    store.setText('one');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();

    // The GET reads v1, then its answer is held past save 2.
    const get = new Deferred<void>();
    holdGet = { gate: get, readFirst: true };
    emitChange(repo, 'main');
    await flushPromises();
    store.setText('one two');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
    expect(store.baseVersion).toBe('v2');

    get.resolve();
    await flushPromises();
    expect(store.text).toBe('one two');
    expect(store.baseVersion).toBe('v2');
    expect(store.save).toBe('idle');
  });

  test("an agent's ai.md updates the AI zone and keeps the text", async () => {
    const { store, repo } = await started();
    store.setText('typing');
    disk('main').ai = '<details>notes</details>';
    emitChange(repo, '', true);
    await flushPromises();
    expect(store.draft?.ai).toBe('<details>notes</details>');
    expect(store.text).toBe('typing');
  });

  test('a foreign top change while dirty is a conflict; while clean it is taken', async () => {
    const { store, repo } = await started();
    writeElsewhere('main', 'theirs');
    emitChange(repo, 'main');
    await flushPromises();
    expect(store.text).toBe('theirs');
    expect(store.save).toBe('idle');

    store.setText('mine');
    writeElsewhere('main', 'theirs again');
    emitChange(repo, 'main');
    await flushPromises();
    expect(store.save).toBe('conflict');
    expect(store.text).toBe('mine');
  });

  test('a change to another branch is ignored', async () => {
    const { repo } = await started();
    const before = fake.callsTo('/repos/r1/draft?').length;
    emitChange(repo, 'feature');
    await flushPromises();
    expect(fake.callsTo('/repos/r1/draft?')).toHaveLength(before);
  });
});

describe('start from this', () => {
  test('adopt copies the suggestion into the editor', async () => {
    disk('main').suggested = 'Agent text';
    const { store } = await started();
    await store.adopt();
    expect(store.text).toBe('Agent text');
    expect(store.draft?.adoptedUnedited).toBe(true);
    expect(fake.calls.find((c) => c.url === '/repos/r1/draft/adopt')?.body).toEqual({
      branch: 'main',
      version: 'absent',
    });
  });
});
