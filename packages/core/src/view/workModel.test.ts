import { describe, expect, test } from 'bun:test';
import { CANDIDATE_RECENT_MS, DONE_WINDOW_MS } from '../types/work.js';
import type {
  DraftFacts,
  PrInfo,
  PrProgress,
  PrSnapshot,
  WorkBranch,
  WorkItem,
  WorkMarks,
  WorkRepoFacts,
  WorkWorktree,
} from '../types/work.js';
import { branchKey, classifyWork, findPr, prKey } from './workModel.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ROOT = '/w/calc';

function wt(path: string, branch: string | null, over: Partial<WorkWorktree> = {}): WorkWorktree {
  return {
    path,
    branch,
    head: `${path}-head`,
    isMain: false,
    isBare: false,
    lastActivity: NOW - DAY,
    changedAt: null,
    aheadOfBase: 0,
    base: 'upstream/main',
    uncommitted: 0,
    ...over,
  };
}

function br(name: string, over: Partial<WorkBranch> = {}): WorkBranch {
  return { name, tip: `${name}-tip`, remoteCopy: false, unpushed: null, ...over };
}

function draft(branch: string, top: string | null, over: Partial<DraftFacts> = {}): DraftFacts {
  return {
    branch,
    hasTop: top !== null,
    hasSuggested: false,
    hasAi: false,
    top,
    adoptedUnedited: false,
    mtime: 1000,
    ...over,
  };
}

function repo(over: Partial<WorkRepoFacts> = {}): WorkRepoFacts {
  return {
    path: ROOT,
    root: ROOT,
    name: 'calc',
    worktrees: [wt(ROOT, 'main', { isMain: true })],
    branches: [br('main', { remoteCopy: true, unpushed: 0 })],
    branchesCapped: false,
    identities: ['aerius/calculator', 'jornc/calculator'],
    drafts: [],
    ...over,
  };
}

function pr(number: number, headRefName: string, over: Partial<PrInfo> = {}): PrInfo {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/aerius/calculator/pull/${number}`,
    state: 'open',
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    body: '',
    headRefName,
    headRefOid: 'pr-head',
    baseRefName: 'main',
    progress: null,
    headOwner: 'JornC',
    author: 'JornC',
    reviewRequested: false,
    repo: 'aerius/calculator',
    repoKey: 'aerius/calculator',
    ...over,
  };
}

function snapshot(prs: PrInfo[] = [], over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    status: 'ok',
    message: null,
    checkedAt: NOW,
    viewer: 'JornC',
    prs,
    capped: false,
    ...over,
  };
}

const NO_MARKS: WorkMarks = { tracked: {}, dismissed: {} };

function marks(over: Partial<WorkMarks> = {}): WorkMarks {
  return { tracked: {}, dismissed: {}, ...over };
}

function keys(items: WorkItem[]): string[] {
  return items.map((item) => item.key);
}

function only(items: WorkItem[]): WorkItem {
  expect(items).toHaveLength(1);
  return items[0];
}

/** One feature worktree beside a clean main worktree. */
function withFeature(feature: Partial<WorkWorktree> = {}, branch: Partial<WorkBranch> = {}) {
  return repo({
    worktrees: [wt(ROOT, 'main', { isMain: true }), wt('/w/calc-x', 'x', feature)],
    branches: [br('main', { remoteCopy: true, unpushed: 0 }), br('x', branch)],
  });
}

describe('keys', () => {
  test('a branch key is root and branch on two lines; a PR key names the repo and number', () => {
    expect(branchKey('/w/a', 'feature/x')).toBe('/w/a\nfeature/x');
    expect(prKey(pr(9087, 'x'))).toBe('pr:aerius/calculator#9087');
  });
});

describe('findPr', () => {
  test('matches the identity and the exact branch, first in snapshot order', () => {
    const open = pr(2, 'x');
    const prs = [pr(1, 'X'), open, pr(3, 'x')];
    expect(findPr(prs, ['aerius/calculator'], 'x')).toBe(open);
    expect(findPr(prs, ['other/repo'], 'x')).toBeNull();
  });
});

describe('sections', () => {
  test('an open PR is work', () => {
    const result = classifyWork([withFeature()], snapshot([pr(9, 'x')]), NO_MARKS, NOW);
    expect(only(result.work).state).toBe('pr-open');
  });

  test("GitHub's draft flag gives pr-draft", () => {
    const result = classifyWork(
      [withFeature()],
      snapshot([pr(9, 'x', { isDraft: true })]),
      NO_MARKS,
      NOW
    );
    expect(only(result.work).state).toBe('pr-draft');
  });

  test('a draft with text is work; a blank one is not', () => {
    const text = repo({ drafts: [draft('main', 'Why: {{fill}}')] });
    expect(keys(classifyWork([text], snapshot(), NO_MARKS, NOW).work)).toEqual([
      branchKey(ROOT, 'main'),
    ]);
    const blank = repo({ drafts: [draft('main', '  \n')] });
    const result = classifyWork([blank], snapshot(), NO_MARKS, NOW);
    expect(result.work).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  test('a tracked item is work', () => {
    const key = branchKey(ROOT, 'main');
    const result = classifyWork(
      [repo()],
      snapshot(),
      marks({ tracked: { [key]: { at: 1 } } }),
      NOW
    );
    const item = only(result.work);
    expect(item.tracked).toBe(true);
    expect(item.key).toBe(key);
  });

  test('uncommitted, ahead, unpushed and fresh worktrees are candidates', () => {
    // On its base branch, so not fresh: only the count makes it a candidate.
    const uncommitted = classifyWork(
      [withFeature({ uncommitted: 2, base: 'upstream/x' })],
      snapshot(),
      NO_MARKS,
      NOW
    );
    expect(only(uncommitted.candidates).facts.uncommitted).toBe(2);
    expect(
      classifyWork([withFeature({ base: 'upstream/x' })], snapshot(), NO_MARKS, NOW).candidates
    ).toEqual([]);

    const ahead = classifyWork([withFeature({ aheadOfBase: 3 })], snapshot(), NO_MARKS, NOW);
    expect(only(ahead.candidates).facts.ahead).toBe(3);

    const unpushed = classifyWork(
      [withFeature({ base: 'upstream/x' }, { remoteCopy: true, unpushed: 2 })],
      snapshot(),
      NO_MARKS,
      NOW
    );
    expect(only(unpushed.candidates).state).toBe('not-pushed');

    const fresh = classifyWork([withFeature()], snapshot(), NO_MARKS, NOW);
    expect(only(fresh.candidates).state).toBe('empty');
  });

  test('a main worktree on its base, clean and not ahead, gives nothing', () => {
    const result = classifyWork([repo()], snapshot(), NO_MARKS, NOW);
    expect(result).toEqual({
      work: [],
      candidates: [],
      older: [],
      done: [],
      dismissed: [],
      staleMarks: [],
    });
  });

  test('with no base, only a worktree that is not the main one is fresh', () => {
    const noBase = repo({
      worktrees: [
        wt(ROOT, 'dev', { isMain: true, base: null }),
        wt('/w/calc-y', 'y', { base: null }),
      ],
      branches: [br('dev'), br('y')],
    });
    expect(keys(classifyWork([noBase], snapshot(), NO_MARKS, NOW).candidates)).toEqual([
      branchKey(ROOT, 'y'),
    ]);
  });

  test('a backup branch with no worktree, PR or draft gives nothing', () => {
    const backup = repo({
      branches: [br('main', { remoteCopy: true, unpushed: 0 }), br('old-try')],
    });
    const result = classifyWork([backup], snapshot(), NO_MARKS, NOW);
    expect(result.work).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  test('a detached worktree is a candidate only when uncommitted or ahead', () => {
    const detached = (over: Partial<WorkWorktree>) =>
      repo({ worktrees: [wt(ROOT, 'main', { isMain: true }), wt('/w/calc-d', null, over)] });
    expect(classifyWork([detached({})], snapshot(), NO_MARKS, NOW).candidates).toEqual([]);
    const dirty = only(
      classifyWork([detached({ uncommitted: 1 })], snapshot(), NO_MARKS, NOW).candidates
    );
    expect(dirty.kind).toBe('detached');
    expect(dirty.key).toBe('/w/calc-d');
    expect(dirty.open).toEqual({ path: '/w/calc-d', head: null });
    const ahead = only(
      classifyWork([detached({ aheadOfBase: 1 })], snapshot(), NO_MARKS, NOW).candidates
    );
    expect(ahead.state).toBe('not-pushed');
  });

  test('a bare entry is never an item', () => {
    const bare = repo({
      root: '/w/calc/.bare',
      worktrees: [wt('/w/calc/.bare', null, { isMain: true, isBare: true, uncommitted: null })],
      branches: [],
    });
    const result = classifyWork([bare], snapshot(), NO_MARKS, NOW);
    expect(result.candidates).toEqual([]);
  });
});

describe('done', () => {
  test('merged in the window is done, with a note when the worktree is still on disk', () => {
    const merged = pr(7, 'x', {
      state: 'merged',
      mergedAt: '2026-11-18T09:00:00Z',
      closedAt: '2026-11-18T09:00:00Z',
    });
    const item = only(classifyWork([withFeature()], snapshot([merged]), NO_MARKS, NOW).done);
    expect(item.state).toBe('merged');
    expect(item.note).toBe('worktree-on-disk');
  });

  test('closed without merging is closed', () => {
    const closed = pr(7, 'x', { state: 'closed', closedAt: '2026-11-22T09:00:00Z' });
    expect(only(classifyWork([withFeature()], snapshot([closed]), NO_MARKS, NOW).done).state).toBe(
      'closed'
    );
  });

  test('the 7-day edge: exactly 7 days is in, a millisecond more is out', () => {
    const at = (ms: number) =>
      pr(7, 'gone-branch', { state: 'merged', mergedAt: new Date(ms).toISOString() });
    const inside = classifyWork([repo()], snapshot([at(NOW - DONE_WINDOW_MS)]), NO_MARKS, NOW);
    expect(inside.done).toHaveLength(1);
    const outside = classifyWork([repo()], snapshot([at(NOW - DONE_WINDOW_MS - 1)]), NO_MARKS, NOW);
    expect(outside.done).toEqual([]);
    expect(outside.work).toEqual([]);
  });

  test('done is ordered by close date, newest first', () => {
    const a = pr(1, 'a', { state: 'merged', mergedAt: '2026-11-18T09:00:00Z' });
    const b = pr(2, 'b', { state: 'closed', closedAt: '2026-11-21T09:00:00Z' });
    const result = classifyWork([repo()], snapshot([a, b]), NO_MARKS, NOW);
    expect(result.done.map((item) => item.pr?.number)).toEqual([2, 1]);
  });
});

describe('finished', () => {
  const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
  /** Branch x's PR, merged `days` ago from the commit x points at. */
  const merged = (days: number, over: Partial<PrInfo> = {}) =>
    pr(7, 'x', {
      state: 'merged',
      mergedAt: daysAgo(days),
      closedAt: daysAgo(days),
      updatedAt: daysAgo(days),
      headRefOid: 'x-tip',
      ...over,
    });
  const nothing = {
    work: [],
    candidates: [],
    older: [],
    done: [],
    dismissed: [],
    staleMarks: [],
  };

  test('merged 6 days ago with the worktree still there is done', () => {
    const item = only(classifyWork([withFeature()], snapshot([merged(6)]), NO_MARKS, NOW).done);
    expect(item.state).toBe('merged');
    expect(item.note).toBe('worktree-on-disk');
  });

  test('merged 8 days ago, worktree on the same tip and clean: no item', () => {
    expect(classifyWork([withFeature()], snapshot([merged(8)]), NO_MARKS, NOW)).toEqual(nothing);
  });

  test('closed without merging finishes the branch too', () => {
    const closed = merged(8, { state: 'closed', mergedAt: null });
    expect(classifyWork([withFeature()], snapshot([closed]), NO_MARKS, NOW)).toEqual(nothing);
  });

  test('a new commit since brings the branch back as a candidate, with no PR', () => {
    const r = withFeature({ aheadOfBase: 2 }, { tip: 'new-tip' });
    const item = only(classifyWork([r], snapshot([merged(8)]), NO_MARKS, NOW).candidates);
    expect(item.pr).toBeNull();
    expect(item.state).toBe('not-pushed');
  });

  test('leftovers on the PR head: a candidate that keeps its PR and says merged', () => {
    const r = withFeature({ uncommitted: 2 });
    const item = only(classifyWork([r], snapshot([merged(30)]), NO_MARKS, NOW).candidates);
    expect(item.pr?.number).toBe(7);
    expect(item.state).toBe('merged');
    expect(item.facts.uncommitted).toBe(2);
    expect(item.note).toBeNull();
    // Without a whole PR list the PR is still the branch's: its head is the tip.
    const partial = classifyWork([r], snapshot([merged(30)], { status: 'error' }), NO_MARKS, NOW);
    expect(only(partial.candidates).state).toBe('merged');
  });

  test('leftovers with an old last edit fold away like any candidate', () => {
    const r = withFeature({ uncommitted: 2, lastActivity: NOW - 40 * DAY });
    const result = classifyWork([r], snapshot([merged(30)]), NO_MARKS, NOW);
    expect(result.candidates).toEqual([]);
    expect(only(result.older).state).toBe('merged');
  });

  test('a new commit and uncommitted changes: a candidate with no PR', () => {
    const r = withFeature({ uncommitted: 2 }, { tip: 'new-tip' });
    const item = only(classifyWork([r], snapshot([merged(30)]), NO_MARKS, NOW).candidates);
    expect(item.pr).toBeNull();
    expect(item.state).toBe('uncommitted');
  });

  test('a worktree whose status failed is not called finished', () => {
    const r = withFeature({ uncommitted: null });
    expect(only(classifyWork([r], snapshot([merged(8)]), NO_MARKS, NOW).candidates).pr).toBeNull();
  });

  test('a draft and no worktree: no item, also when the branch is gone', () => {
    const kept = repo({
      branches: [br('main', { remoteCopy: true, unpushed: 0 }), br('x')],
      drafts: [draft('x', 'text')],
    });
    expect(classifyWork([kept], snapshot([merged(8)]), NO_MARKS, NOW)).toEqual(nothing);
    const gone = repo({ drafts: [draft('x', 'text')] });
    expect(classifyWork([gone], snapshot([merged(8)]), NO_MARKS, NOW)).toEqual(nothing);
  });

  test('tracked and finished: no item, and the mark is stale', () => {
    const key = branchKey(ROOT, 'x');
    const tracked = marks({ tracked: { [key]: { at: 1 } } });
    const result = classifyWork([withFeature()], snapshot([merged(8)]), tracked, NOW, true);
    expect(result.work).toEqual([]);
    expect(result.staleMarks).toEqual([key]);
  });

  test('of several PRs for one branch, an open one wins, else the newest by update', () => {
    const older = merged(40, { number: 1, headRefOid: 'old-tip' });
    const newer = merged(10, { number: 2 });
    // Snapshot order: open first, then the newest update first.
    expect(classifyWork([withFeature()], snapshot([newer, older]), NO_MARKS, NOW)).toEqual(nothing);
    const reopened = pr(3, 'x', { updatedAt: daysAgo(50) });
    const item = only(
      classifyWork([withFeature()], snapshot([reopened, newer, older]), NO_MARKS, NOW).work
    );
    expect(item.pr?.number).toBe(3);
  });

  test('without a whole PR list nothing is finished', () => {
    const partial: Partial<PrSnapshot>[] = [
      { status: 'error' },
      { status: 'never', checkedAt: null },
      { capped: true },
    ];
    for (const over of partial) {
      const result = classifyWork([withFeature()], snapshot([merged(8)], over), NO_MARKS, NOW);
      expect(only(result.candidates).pr).toBeNull();
    }
  });
});

describe('PRs with no local branch', () => {
  test('a repo with the identity but no branch gives no-local-branch; no repo gives no-local-clone', () => {
    const local = pr(1, 'nowhere');
    const foreign = pr(2, 'x', { repo: 'Other/Thing', repoKey: 'other/thing' });
    const result = classifyWork([repo()], snapshot([local, foreign]), NO_MARKS, NOW);
    const byNumber = new Map(result.work.map((item) => [item.pr?.number, item]));
    expect(byNumber.get(1)).toMatchObject({
      kind: 'pr',
      key: 'pr:aerius/calculator#1',
      note: 'no-local-branch',
      repoName: 'calc',
      repoRoot: ROOT,
      open: null,
      fingerprint: local.updatedAt,
    });
    expect(byNumber.get(2)).toMatchObject({
      note: 'no-local-clone',
      repoName: 'Other/Thing',
      repoRoot: null,
      open: null,
    });
  });

  test('a fork PR is matched through the upstream identity', () => {
    const fork = pr(9087, 'x', { headOwner: 'JornC', repo: 'aerius/calculator' });
    const upstreamOnly = withFeature();
    upstreamOnly.identities = ['aerius/calculator'];
    const item = only(classifyWork([upstreamOnly], snapshot([fork]), NO_MARKS, NOW).work);
    expect(item.kind).toBe('branch');
    expect(item.pr).toBe(fork);
  });

  test('a PR whose local branch is in no worktree opens in the main worktree with a head', () => {
    const r = repo({ branches: [br('main', { remoteCopy: true, unpushed: 0 }), br('side')] });
    const item = only(classifyWork([r], snapshot([pr(4, 'side')]), NO_MARKS, NOW).work);
    expect(item.open).toEqual({ path: ROOT, head: 'side' });
    expect(item.worktreePath).toBeNull();
  });
});

describe('one item per branch', () => {
  test('a branch with a worktree, a draft and a PR is one item', () => {
    const r = withFeature({ uncommitted: 3 });
    r.drafts = [draft('x', 'Top text {{why}} and {{how}}', { adoptedUnedited: true })];
    const result = classifyWork(
      [r],
      snapshot([pr(9, 'x', { body: 'Something else' })]),
      NO_MARKS,
      NOW
    );
    const item = only(result.work);
    expect(item.facts).toEqual({
      uncommitted: 3,
      unpushed: 0,
      ahead: 0,
      base: 'upstream/main',
      draft: true,
      placeholders: 2,
      adoptedUnedited: true,
      bodyDiffers: true,
    });
    expect(result.candidates).toEqual([]);
  });

  test('bodyDiffers is false when the PR top zone matches the draft', () => {
    const r = withFeature();
    r.drafts = [draft('x', 'Top text')];
    const body = 'Top text\n\n---\n<details>\nai\n</details>';
    const item = only(classifyWork([r], snapshot([pr(9, 'x', { body })]), NO_MARKS, NOW).work);
    expect(item.facts.bodyDiffers).toBe(false);
  });

  test('two clones of one repo each show their own branch', () => {
    const a = withFeature();
    const b = repo({
      path: '/w/calc2',
      root: '/w/calc2',
      name: 'calc2',
      worktrees: [wt('/w/calc2', 'main', { isMain: true })],
    });
    const result = classifyWork([a, b], snapshot([pr(9, 'x')]), NO_MARKS, NOW);
    expect(keys(result.work)).toEqual([branchKey(ROOT, 'x')]);
  });

  test('repos are deduped by root, the first wins', () => {
    const first = withFeature({ uncommitted: 1 });
    const second = { ...withFeature({ uncommitted: 9 }), path: '/w/calc-x' };
    const item = only(classifyWork([first, second], snapshot(), NO_MARKS, NOW).candidates);
    expect(item.facts.uncommitted).toBe(1);
  });
});

describe('states', () => {
  test('pushed, no PR', () => {
    const item = only(
      classifyWork([withFeature({}, { remoteCopy: true, unpushed: 0 })], snapshot(), NO_MARKS, NOW)
        .candidates
    );
    expect(item.state).toBe('pushed-no-pr');
  });

  test('not pushed: no remote copy and ahead', () => {
    const item = only(
      classifyWork([withFeature({ aheadOfBase: 2 })], snapshot(), NO_MARKS, NOW).candidates
    );
    expect(item.state).toBe('not-pushed');
  });

  test('uncommitted only', () => {
    const item = only(
      classifyWork([withFeature({ uncommitted: 4, base: 'upstream/x' })], snapshot(), NO_MARKS, NOW)
        .candidates
    );
    expect(item.state).toBe('uncommitted');
    expect(item.facts.uncommitted).toBe(4);
  });

  test('a draft whose branch is gone is branch-gone and opens nowhere', () => {
    const r = repo({ drafts: [draft('deleted', 'still here')] });
    const item = only(classifyWork([r], snapshot(), NO_MARKS, NOW).work);
    expect(item.state).toBe('branch-gone');
    expect(item.open).toBeNull();
  });

  test('a capped branch list does not call a missing branch gone', () => {
    const r = repo({ drafts: [draft('far', 'text')], branchesCapped: true });
    const item = only(classifyWork([r], snapshot(), NO_MARKS, NOW).work);
    expect(item.state).not.toBe('branch-gone');
  });

  test('a local branch with no worktree and no remote copy is not pushed', () => {
    const r = repo({
      branches: [br('main', { remoteCopy: true, unpushed: 0 }), br('local')],
      drafts: [draft('local', 'text')],
    });
    expect(only(classifyWork([r], snapshot(), NO_MARKS, NOW).work).state).toBe('not-pushed');
  });
});

describe('opening', () => {
  test('a bare repo opens its newest worktree', () => {
    const r = repo({
      root: '/w/calc/.bare',
      name: 'calc',
      worktrees: [
        wt('/w/calc/.bare', null, { isMain: true, isBare: true, uncommitted: null }),
        wt('/w/calc/a', 'a', { lastActivity: 10 }),
        wt('/w/calc/b', 'b', { lastActivity: 20 }),
      ],
      branches: [br('a'), br('b'), br('side')],
      drafts: [draft('side', 'text')],
    });
    const item = classifyWork([r], snapshot(), NO_MARKS, NOW).work.find((i) => i.branch === 'side');
    expect(item?.open).toEqual({ path: '/w/calc/b', head: 'side' });
  });

  test('a repo with no worktree to open in gives null', () => {
    const r = repo({
      root: '/w/calc/.bare',
      worktrees: [wt('/w/calc/.bare', null, { isMain: true, isBare: true, uncommitted: null })],
      branches: [br('side')],
      drafts: [draft('side', 'text')],
    });
    expect(only(classifyWork([r], snapshot(), NO_MARKS, NOW).work).open).toBeNull();
  });
});

describe('dismiss', () => {
  test('the fingerprint says dirty or clean, not how many', () => {
    const at = (uncommitted: number) =>
      only(classifyWork([withFeature({ uncommitted })], snapshot(), NO_MARKS, NOW).candidates);
    const dirty = at(1);
    expect(dirty.fingerprint).toBe('x-tip|1|0');
    const dismissed = marks({
      dismissed: { [dirty.key]: { fingerprint: dirty.fingerprint, at: 1 } },
    });
    const more = classifyWork([withFeature({ uncommitted: 15274 })], snapshot(), dismissed, NOW);
    expect(keys(more.dismissed)).toEqual([dirty.key]);
    expect(more.candidates).toEqual([]);
    // Clean again is a change: the item comes back.
    expect(at(0).fingerprint).toBe('x-tip|0|0');
    const clean = classifyWork([withFeature()], snapshot(), dismissed, NOW);
    expect(keys(clean.candidates)).toEqual([dirty.key]);
  });

  test('a dismiss with the same fingerprint hides the item; a new tip brings it back', () => {
    const r = withFeature({ uncommitted: 1 });
    const first = only(classifyWork([r], snapshot(), NO_MARKS, NOW).candidates);
    expect(first.fingerprint).toBe('x-tip|1|0');
    const dismissed = marks({
      dismissed: { [first.key]: { fingerprint: first.fingerprint, at: 1 } },
    });

    const hidden = classifyWork([r], snapshot(), dismissed, NOW);
    expect(hidden.candidates).toEqual([]);
    expect(keys(hidden.dismissed)).toEqual([first.key]);

    const moved = withFeature({ uncommitted: 1 }, { tip: 'new-tip' });
    const back = classifyWork([moved], snapshot(), dismissed, NOW);
    expect(keys(back.candidates)).toEqual([first.key]);
    expect(back.dismissed).toEqual([]);
  });

  test('a PR-only item is fingerprinted by updatedAt; a detached one by head and dirty', () => {
    const item = only(classifyWork([repo()], snapshot([pr(1, 'zz')]), NO_MARKS, NOW).work);
    expect(item.fingerprint).toBe('2026-11-20T10:00:00Z');
    const r = repo({
      worktrees: [wt(ROOT, 'main', { isMain: true }), wt('/w/d', null, { uncommitted: 2 })],
    });
    expect(only(classifyWork([r], snapshot(), NO_MARKS, NOW).candidates).fingerprint).toBe(
      '/w/d-head|1'
    );
  });
});

describe('order', () => {
  test('newest activity first, then by key; older ones and unknown last', () => {
    const at = (lastActivity: number | null) => ({ lastActivity, uncommitted: 1 });
    const r = repo({
      worktrees: [
        wt(ROOT, 'main', { isMain: true }),
        wt('/w/a', 'a', at(NOW - 3 * DAY)),
        wt('/w/b', 'b', at(NOW - DAY)),
        wt('/w/c', 'c', at(NOW - DAY)),
        wt('/w/d', 'd', at(NOW - 60 * DAY)),
        wt('/w/e', 'e', at(null)),
        wt('/w/f', 'f', at(NOW - 20 * DAY)),
      ],
      branches: ['main', 'a', 'b', 'c', 'd', 'e', 'f'].map((name) => br(name)),
    });
    const result = classifyWork([r], snapshot(), NO_MARKS, NOW);
    expect(result.candidates.map((i) => i.branch)).toEqual(['b', 'c', 'a']);
    expect(result.older.map((i) => i.branch)).toEqual(['f', 'd', 'e']);
  });

  test('an uncommitted edit counts as activity, so a worktree edited today stays in view', () => {
    const r = withFeature({
      lastActivity: NOW - 90 * DAY,
      changedAt: NOW - 60_000,
      uncommitted: 1,
    });
    const item = only(classifyWork([r], snapshot(), NO_MARKS, NOW).candidates);
    expect(item.activity).toBe(NOW - 60_000);
  });

  test('activity is the newest of edits, git, the draft and PR events; not the PR update', () => {
    const r = withFeature({ lastActivity: 5, changedAt: 6 });
    r.drafts = [draft('x', 'text', { mtime: 7 })];
    const item = only(classifyWork([r], snapshot([pr(9, 'x')]), NO_MARKS, NOW).work);
    expect(item.times).toEqual({ edited: 6, git: 5, draft: 7 });
    expect(item.lastActivity).toEqual({ at: 7, kind: 'draft', author: null, other: false });
    expect(item.activity).toBe(7);
  });
});

function progress(over: Partial<PrProgress> = {}): PrProgress {
  return {
    decision: null,
    unresolvedThreads: 0,
    pendingReviewers: 0,
    requestedReviewers: [],
    changesRequestedBy: [],
    checks: null,
    headCommittedAt: null,
    conflicting: false,
    events: [],
    ...over,
  };
}

describe('activity from GitHub', () => {
  const at = '2026-11-23T09:00:00Z';

  test('a review by someone else is the newest activity, marked other', () => {
    const events = [{ kind: 'changes-requested' as const, author: 'Bert', at }];
    const r = withFeature({ lastActivity: 5 });
    const item = only(
      classifyWork([r], snapshot([pr(9, 'x', { progress: progress({ events }) })]), NO_MARKS, NOW)
        .work
    );
    expect(item.lastActivity).toEqual({
      at: Date.parse(at),
      kind: 'changes-requested',
      author: 'Bert',
      other: true,
    });
  });

  test('your own comment is not other', () => {
    const events = [{ kind: 'commented' as const, author: 'JornC', at }];
    const item = only(
      classifyWork([], snapshot([pr(9, 'x', { progress: progress({ events }) })]), NO_MARKS, NOW)
        .work
    );
    expect(item.lastActivity?.other).toBe(false);
  });

  test('a merge is activity', () => {
    const mergedAt = '2026-11-22T10:00:00Z';
    const merged = pr(9, 'x', { state: 'merged', mergedAt, closedAt: mergedAt });
    const item = only(classifyWork([], snapshot([merged]), NO_MARKS, NOW).done);
    expect(item.lastActivity).toMatchObject({ kind: 'merged', at: Date.parse(mergedAt) });
  });

  test('an open PR whose only comments are from bots: its head commit is the activity', () => {
    const headCommittedAt = '2026-11-13T20:40:00Z';
    const item = only(
      classifyWork(
        [],
        snapshot([pr(9, 'x', { progress: progress({ headCommittedAt }) })]),
        NO_MARKS,
        NOW
      ).work
    );
    expect(item.lastActivity).toEqual({
      at: Date.parse(headCommittedAt),
      kind: 'head-commit',
      author: 'JornC',
      other: false,
    });
  });

  test("a new commit on a PR the author is asked to review is someone else's", () => {
    const headCommittedAt = '2026-11-13T20:40:00Z';
    const theirs = pr(9, 'x', {
      author: 'SerhatG',
      reviewRequested: true,
      progress: progress({ headCommittedAt }),
    });
    const item = only(classifyWork([], snapshot([theirs]), NO_MARKS, NOW).candidates);
    expect(item.lastActivity?.other).toBe(true);
  });

  test('a PR with no events has no activity', () => {
    const item = only(classifyWork([], snapshot([pr(9, 'x')]), NO_MARKS, NOW).work);
    expect(item.lastActivity).toBeNull();
    expect(item.activity).toBeNull();
  });
});

describe('stage', () => {
  const stageOfPr = (over: Partial<PrInfo>) =>
    only(classifyWork([], snapshot([pr(9, 'x', over)]), NO_MARKS, NOW).work).stage;

  test('an open PR by draft flag and review decision', () => {
    expect(stageOfPr({ isDraft: true, progress: progress({ decision: 'approved' }) })).toBe(
      'draft'
    );
    expect(stageOfPr({})).toBe('review');
    expect(stageOfPr({ progress: progress({ decision: 'review-required' }) })).toBe('review');
    expect(stageOfPr({ progress: progress({ decision: 'changes-requested' }) })).toBe('changes');
    expect(stageOfPr({ progress: progress({ decision: 'approved' }) })).toBe('approved');
  });

  test('a branch with no PR: pushed or local', () => {
    const pushed = withFeature({}, { remoteCopy: true, unpushed: 0 });
    expect(only(classifyWork([pushed], snapshot(), NO_MARKS, NOW).candidates).stage).toBe('pushed');
    const local = withFeature({ uncommitted: 2 }, { remoteCopy: false, unpushed: null });
    expect(only(classifyWork([local], snapshot(), NO_MARKS, NOW).candidates).stage).toBe('local');
  });
});

describe('stacks', () => {
  const layer = (number: number, head: string, base: string, over: Partial<PrInfo> = {}) =>
    pr(number, head, { baseRefName: base, ...over });

  test('a chain of PRs is one stack, numbered from the bottom', () => {
    const prs = [layer(3, 's3', 's2'), layer(1, 's1', 'main'), layer(2, 's2', 's1')];
    const work = classifyWork([], snapshot(prs), NO_MARKS, NOW).work;
    const byNumber = new Map(work.map((item) => [item.pr?.number, item.stack]));
    expect(byNumber.get(1)).toEqual({ position: 1, size: 3, root: 's1' });
    expect(byNumber.get(2)).toEqual({ position: 2, size: 3, root: 's1' });
    expect(byNumber.get(3)).toEqual({ position: 3, size: 3, root: 's1' });
  });

  test('a PR on a branch with no PR is no stack', () => {
    const work = classifyWork([], snapshot([layer(1, 'a', '1.5_fixes')]), NO_MARKS, NOW).work;
    expect(only(work).stack).toBeNull();
  });

  test('the same branch names in another repo do not link', () => {
    const other = { repo: 'aerius/register', repoKey: 'aerius/register' };
    const prs = [layer(1, 's1', 'main'), layer(2, 's2', 's1', other)];
    const work = classifyWork([], snapshot(prs), NO_MARKS, NOW).work;
    expect(work.map((item) => item.stack)).toEqual([null, null]);
  });

  test('a closed PR is no layer', () => {
    const closedAt = '2026-11-22T10:00:00Z';
    const prs = [
      layer(1, 's1', 'main', { state: 'merged', mergedAt: closedAt, closedAt }),
      layer(2, 's2', 's1'),
    ];
    const result = classifyWork([], snapshot(prs), NO_MARKS, NOW);
    expect(only(result.work).stack).toBeNull();
  });

  test('a cycle ends the walk', () => {
    const prs = [layer(1, 'a', 'b'), layer(2, 'b', 'a')];
    const work = classifyWork([], snapshot(prs), NO_MARKS, NOW).work;
    expect(work).toHaveLength(2);
  });
});

describe('the recency fold', () => {
  const candidateAt = (lastActivity: number | null) =>
    classifyWork([withFeature({ lastActivity, uncommitted: 1 })], snapshot(), NO_MARKS, NOW);

  test('exactly 14 days is recent; a millisecond more folds away', () => {
    expect(CANDIDATE_RECENT_MS).toBe(14 * DAY);
    expect(candidateAt(NOW - CANDIDATE_RECENT_MS).candidates).toHaveLength(1);
    const folded = candidateAt(NOW - CANDIDATE_RECENT_MS - 1);
    expect(folded.candidates).toEqual([]);
    expect(only(folded.older).section).toBe('candidates');
  });

  test('unknown activity folds away', () => {
    const result = candidateAt(null);
    expect(result.candidates).toEqual([]);
    expect(result.older).toHaveLength(1);
  });

  test('a dismissed old candidate is in dismissed, not older', () => {
    const item = only(candidateAt(NOW - 60 * DAY).older);
    const dismissed = marks({
      dismissed: { [item.key]: { fingerprint: item.fingerprint, at: 1 } },
    });
    const result = classifyWork(
      [withFeature({ lastActivity: NOW - 60 * DAY, uncommitted: 1 })],
      snapshot(),
      dismissed,
      NOW
    );
    expect(result.older).toEqual([]);
    expect(keys(result.dismissed)).toEqual([item.key]);
  });

  test('only candidates fold: old work stays in Work', () => {
    const r = withFeature({ lastActivity: NOW - 60 * DAY });
    r.drafts = [draft('x', 'text', { mtime: NOW - 60 * DAY })];
    const result = classifyWork([r], snapshot(), NO_MARKS, NOW);
    expect(result.work).toHaveLength(1);
    expect(result.older).toEqual([]);
  });
});

describe('staleMarks', () => {
  const gone = branchKey('/w/removed', 'x');
  const trackedHere = branchKey(ROOT, 'vanished');
  const dismissedNoItem = branchKey(ROOT, 'main');
  const all = marks({
    tracked: { [gone]: { at: 1 }, [trackedHere]: { at: 1 }, '/w/old-detached': { at: 1 } },
    dismissed: {
      [dismissedNoItem]: { fingerprint: 'f', at: 1 },
      'pr:aerius/calculator#5': { fingerprint: 'f', at: 1 },
    },
  });

  test('empty unless the scan is complete', () => {
    expect(classifyWork([repo()], snapshot(), all, NOW).staleMarks).toEqual([]);
  });

  test('a repo not scanned, a dismiss with no item, a detached key with no item, a PR key with no item', () => {
    const result = classifyWork([repo()], snapshot(), all, NOW, true);
    expect(result.staleMarks).toEqual(
      [gone, dismissedNoItem, '/w/old-detached', 'pr:aerius/calculator#5'].sort()
    );
    // The tracked branch in a scanned repo is an item, never stale.
    expect(result.work.find((item) => item.key === trackedHere)?.state).toBe('branch-gone');
  });

  test('PR keys stay while the PR list is not known to be whole', () => {
    expect(
      classifyWork([repo()], snapshot([], { capped: true }), all, NOW, true).staleMarks
    ).not.toContain('pr:aerius/calculator#5');
    expect(
      classifyWork([repo()], snapshot([], { status: 'error' }), all, NOW, true).staleMarks
    ).not.toContain('pr:aerius/calculator#5');
  });
});

describe('attention', () => {
  const changes = (over: Partial<PrProgress>) =>
    progress({ decision: 'changes-requested', changesRequestedBy: ['Bert'], ...over });
  const attentionOf = (over: Partial<PrInfo>) =>
    only(classifyWork([], snapshot([pr(9, 'x', over)]), NO_MARKS, NOW).work).attention;

  test('changes requested and that reviewer not asked again: the author is wanted', () => {
    expect(attentionOf({ progress: changes({}) })).toEqual(['changes-requested']);
  });

  test('asked again: nobody waits on the author, though GitHub still says changes requested', () => {
    expect(attentionOf({ progress: changes({ requestedReviewers: ['Bert'] }) })).toEqual([]);
  });

  test('one of two reviewers asked again is not enough', () => {
    const p = changes({ changesRequestedBy: ['Bert', 'Hil'], requestedReviewers: ['Bert'] });
    expect(attentionOf({ progress: p })).toEqual(['changes-requested']);
  });

  test('no decision, or approved: nothing', () => {
    expect(attentionOf({ progress: progress({ changesRequestedBy: ['Bert'] }) })).toEqual([]);
    expect(attentionOf({})).toEqual([]);
  });
});

describe('review requests', () => {
  const theirs = (over: Partial<PrInfo> = {}) =>
    pr(752, 'their-branch', { author: 'SerhatG', reviewRequested: true, ...over });

  test('a candidate without a local branch, that wants the author', () => {
    const result = classifyWork([repo()], snapshot([theirs()]), NO_MARKS, NOW);
    const item = only(result.candidates);
    expect(item).toMatchObject({ kind: 'pr', note: 'no-local-branch', open: null });
    expect(item.attention).toEqual(['review-requested']);
  });

  test('Track moves it to Work', () => {
    const tracked = marks({ tracked: { [prKey(theirs())]: { at: 1 } } });
    const result = classifyWork([repo()], snapshot([theirs()]), tracked, NOW);
    expect(only(result.work).tracked).toBe(true);
  });

  test('an old one does not fold away: someone waits', () => {
    const old = theirs({ updatedAt: '2026-01-01T00:00:00Z' });
    const result = classifyWork([repo()], snapshot([old]), NO_MARKS, NOW);
    expect(result.older).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  test('never takes a local branch of the same name', () => {
    const r = withFeature();
    const named = theirs({ headRefName: 'x' });
    const result = classifyWork([r], snapshot([named]), NO_MARKS, NOW);
    const all = [...result.work, ...result.candidates, ...result.older];
    const local = all.find((item) => item.kind === 'branch' && item.branch === 'x');
    expect(local?.pr ?? null).toBeNull();
    expect(all.some((item) => item.kind === 'pr' && item.pr?.number === 752)).toBe(true);
  });
});
