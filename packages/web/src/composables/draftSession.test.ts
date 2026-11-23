/**
 * createDraftSession tests: what happens to typed text when the target
 * changes or the session is disposed, and the GitHub side: starting from
 * the PR's top zone, taking GitHub's text, updating GitHub. The debounced
 * save, the 409 path and draft-change are covered through the draft store
 * (stores/draft.test.ts).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { createDraftSession, DRAFT_SAVE_DELAY_MS } from './draftSession';
import type { DraftSession, DraftTarget } from './draftSession';
import { Deferred, makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FakeResponse, FetchCall } from '../testing/fakes';
import type { BranchPr, PrDraft, PrInfo, PutDraftRequest } from '@diffstalker/core/types/work';
import { replaceTopZone, topZoneOf } from '@diffstalker/core/view/prBody';

const LOWER =
  '---\n<details>\n<summary>LLM-generated technical summary</summary>\n\nAI.\n</details>';

let fake: FakeFetch;
/** top.md per branch, with a version counter. */
let disks: Map<string, { top: string | null; version: number }>;
/** Hold the next PUT until released. */
let holdPut: Deferred<void> | null;
let session: DraftSession | null;
/** The open PR's body on the fake GitHub; null: the branch has no PR. */
let githubBody: string | null;
/** Answer the next /pr/top with this status instead of writing. */
let refuseTop: number | null;

function prAnswer(): BranchPr {
  const pr =
    githubBody === null
      ? null
      : ({
          number: 7,
          title: 'A change',
          url: 'https://github.com/aerius/calculator/pull/7',
          state: 'open',
          isDraft: false,
          body: githubBody,
        } as PrInfo);
  return { pr, status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
}

function disk(branch: string): { top: string | null; version: number } {
  let entry = disks.get(branch);
  if (!entry) {
    entry = { top: null, version: 0 };
    disks.set(branch, entry);
  }
  return entry;
}

function asDraft(branch: string): PrDraft {
  const entry = disk(branch);
  return {
    branch,
    top: entry.top,
    suggested: null,
    ai: null,
    adoptedUnedited: false,
    version: entry.top === null ? 'absent' : `v${entry.version}`,
  };
}

async function putDraft(call: FetchCall): Promise<FakeResponse> {
  if (holdPut) {
    const held = holdPut;
    holdPut = null;
    await held.promise;
  }
  const body = call.body as PutDraftRequest;
  if (body.version !== asDraft(body.branch).version)
    return { status: 409, body: { error: 'Draft changed elsewhere' } };
  const entry = disk(body.branch);
  entry.top = body.top;
  entry.version += 1;
  return { body: asDraft(body.branch) };
}

async function route(call: FetchCall): Promise<FakeResponse> {
  if (call.url.startsWith('/repos/r1/draft?')) {
    return { body: asDraft(decodeURIComponent(call.url.split('branch=')[1] ?? '')) };
  }
  if (call.url === '/repos/r1/draft' && call.method === 'PUT') return putDraft(call);
  if (call.url.startsWith('/repos/r1/pr?') || call.url === '/repos/r1/pr/check') {
    return { body: prAnswer() };
  }
  if (call.url === '/repos/r1/pr/top') {
    if (refuseTop !== null) return { status: refuseTop, body: { error: 'refused' } };
    const body = call.body as { branch: string; version: string; expectedTop: string };
    const top = asDraft(body.branch);
    if (body.version !== top.version || topZoneOf(githubBody ?? '') !== body.expectedTop)
      return { status: 409, body: { error: 'changed' } };
    githubBody = replaceTopZone(githubBody ?? '', top.top ?? '');
    return { body: prAnswer() };
  }
  return { status: 404, body: { error: 'no route' } };
}

function puts(): PutDraftRequest[] {
  return fake.calls.filter((c) => c.method === 'PUT').map((c) => c.body as PutDraftRequest);
}

/** A session on r1/main, loaded. */
async function opened() {
  const target = shallowRef<DraftTarget | null>({ id: 'r1', branch: 'main' });
  const made = createDraftSession(() => target.value);
  session = made;
  await flushPromises();
  return { session: made, target };
}

/** Type, then let the debounce send it. */
async function typeAndSave(on: DraftSession, value: string): Promise<void> {
  on.setText(value);
  vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
  await flushPromises();
}

beforeEach(() => {
  disks = new Map();
  holdPut = null;
  session = null;
  githubBody = null;
  refuseTop = null;
  fake = makeFakeFetch(route);
  vi.stubGlobal('fetch', fake.fn);
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await session?.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('target change', () => {
  test('pending text goes to the old target at once, then the new one loads', async () => {
    const { session, target } = await opened();
    session.setText('for main');
    target.value = { id: 'r1', branch: 'feature' };
    await flushPromises();
    expect(puts()).toEqual([{ branch: 'main', top: 'for main', version: 'absent' }]);
    expect(session.branch).toBe('feature');
    expect(session.text).toBe('');
    expect(fake.callsTo('/repos/r1/draft?branch=feature')).toHaveLength(1);

    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 3);
    await flushPromises();
    expect(puts()).toHaveLength(1);
  });

  test('the same target again, as a new object, changes nothing', async () => {
    const { session, target } = await opened();
    session.setText('typing');
    target.value = { id: 'r1', branch: 'main' };
    await flushPromises();
    expect(session.text).toBe('typing');
    expect(session.save).toBe('dirty');
    expect(puts()).toHaveLength(0);
  });
});

describe('dispose', () => {
  test('waits for the save in flight, sends the pending text once, and settles after it', async () => {
    const { session } = await opened();
    holdPut = new Deferred<void>();
    const firstPut = holdPut;
    await typeAndSave(session, 'one');
    expect(session.save).toBe('saving');
    session.setText('one two');

    let settled = false;
    const done = session.dispose().then(() => {
      settled = true;
    });
    await flushPromises();
    expect(puts()).toHaveLength(1);
    expect(settled).toBe(false);

    holdPut = new Deferred<void>();
    const lastPut = holdPut;
    firstPut.resolve();
    await flushPromises();
    expect(puts()).toEqual([
      { branch: 'main', top: 'one', version: 'absent' },
      { branch: 'main', top: 'one two', version: 'v1' },
    ]);
    expect(settled).toBe(false);

    lastPut.resolve();
    await done;
    expect(disk('main').top).toBe('one two');

    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 3);
    await flushPromises();
    expect(puts()).toHaveLength(2);
  });

  test('a failed last write still settles', async () => {
    const { session } = await opened();
    disk('main').top = 'from elsewhere';
    disk('main').version = 5;
    session.setText('mine');
    await session.dispose();
    expect(puts()).toEqual([{ branch: 'main', top: 'mine', version: 'absent' }]);
    expect(disk('main').top).toBe('from elsewhere');
  });

  test('with nothing pending it sends nothing, and nothing typed after it is sent', async () => {
    const { session } = await opened();
    await typeAndSave(session, 'saved');
    expect(puts()).toHaveLength(1);

    await session.dispose();
    expect(puts()).toHaveLength(1);
    expect(session.branch).toBeNull();

    session.setText('too late');
    session.saveNow();
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 3);
    await flushPromises();
    expect(puts()).toHaveLength(1);
  });
});

describe('GitHub', () => {
  test('no top.md and an open PR: the editor starts from its top zone, and nothing is saved', async () => {
    githubBody = `GitHub words.\n\n${LOWER}`;
    const { session } = await opened();
    expect(session.text).toBe('GitHub words.');
    expect(session.prefilled).toBe(true);
    expect(session.githubTop).toBe('GitHub words.');
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS * 3);
    await flushPromises();
    expect(puts()).toEqual([]);
  });

  test('a top.md wins over the PR', async () => {
    githubBody = `GitHub words.\n\n${LOWER}`;
    disk('main').top = 'Mine.';
    disk('main').version = 1;
    const { session } = await opened();
    expect(session.text).toBe('Mine.');
    expect(session.prefilled).toBe(false);
  });

  test('typing saves as usual, and a cleared editor stays clear', async () => {
    githubBody = `GitHub words.\n\n${LOWER}`;
    const { session } = await opened();
    await typeAndSave(session, 'GitHub words. And mine.');
    expect(puts()).toEqual([{ branch: 'main', top: 'GitHub words. And mine.', version: 'absent' }]);
    expect(session.prefilled).toBe(false);
    disk('main').top = null;
    await typeAndSave(session, '');
    expect(session.text).toBe('');
  });

  test("Take GitHub's text reads the PR again and saves its top zone", async () => {
    githubBody = `Old.\n\n${LOWER}`;
    disk('main').top = 'Mine.';
    disk('main').version = 1;
    const { session } = await opened();
    githubBody = `Theirs.\n\n${LOWER}`;
    await session.takeGithub();
    await flushPromises();
    expect(fake.callsTo('/repos/r1/pr/check')).toHaveLength(1);
    expect(puts()).toEqual([{ branch: 'main', top: 'Theirs.', version: 'v1' }]);
    expect(session.text).toBe('Theirs.');
  });

  test('Update GitHub sends the version and the top zone shown; the PR follows', async () => {
    githubBody = `Old.\n\n${LOWER}`;
    disk('main').top = 'Mine.';
    disk('main').version = 1;
    const { session } = await opened();
    await session.pushTop();
    expect(fake.calls.find((c) => c.url === '/repos/r1/pr/top')?.body).toEqual({
      branch: 'main',
      version: 'v1',
      expectedTop: 'Old.',
    });
    expect(githubBody).toBe(`Mine.\n\n${LOWER}`);
    expect(session.githubTop).toBe('Mine.');
    expect(session.error).toBeNull();
  });

  test('Update GitHub refused with 409: the error shows and the PR is read again', async () => {
    githubBody = `Old.\n\n${LOWER}`;
    disk('main').top = 'Mine.';
    disk('main').version = 1;
    const { session } = await opened();
    refuseTop = 409;
    githubBody = `Changed on GitHub.\n\n${LOWER}`;
    await session.pushTop();
    expect(session.error).toContain('Could not update GitHub');
    expect(session.githubTop).toBe('Changed on GitHub.');
    expect(session.pushing).toBe(false);
  });

  test('Update GitHub with unsaved text sends nothing', async () => {
    githubBody = `Old.\n\n${LOWER}`;
    disk('main').top = 'Mine.';
    disk('main').version = 1;
    const { session } = await opened();
    session.setText('Mine, still typing');
    await session.pushTop();
    expect(fake.callsTo('/repos/r1/pr/top')).toHaveLength(0);
  });

  test('check again with a known PR reads that PR alone', async () => {
    githubBody = `Old.\n\n${LOWER}`;
    const { session } = await opened();
    await session.checkPrs();
    expect(fake.callsTo('/repos/r1/pr/check')).toHaveLength(1);
    expect(fake.callsTo('/work/prs/refresh')).toHaveLength(0);
  });
});
