import { describe, test, expect } from 'vitest';
import {
  LAST_DAY_MS,
  activeLastDay,
  activityText,
  checkedLine,
  closedLabel,
  formatClock,
  formatDay,
  formatStamp,
  formatAgo,
  formatFull,
  ghNotice,
  groupByRepo,
  itemEvents,
  sortItems,
  attentionLines,
  sessionBrief,
  layoutWork,
  workStatus,
  itemFacts,
} from './workFormat';
import type { PrInfo, PrProgress, WorkItem, WorkStack } from '@diffstalker/core/types/work';
import type { WorkLine } from './workFormat';

/** Local times, so the tests hold in any time zone. */
const AT = new Date(2026, 10, 23, 14, 2).getTime();

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    key: 'k',
    kind: 'branch',
    section: 'work',
    repoRoot: '/w/a',
    repoName: 'a',
    worktreePath: null,
    branch: 'x',
    state: 'empty',
    facts: {
      uncommitted: 0,
      unpushed: 0,
      ahead: 0,
      base: null,
      draft: false,
      placeholders: 0,
      adoptedUnedited: false,
      bodyDiffers: false,
    },
    pr: null,
    note: null,
    open: null,
    stage: 'local',
    stack: null,
    attention: [],
    lastActivity: null,
    times: { edited: null, git: null, draft: null },
    activity: null,
    fingerprint: '',
    tracked: false,
    ...over,
  };
}

describe('times', () => {
  test('a clock time and a day, never a duration', () => {
    expect(formatClock(AT)).toBe('14:02');
    expect(formatClock(new Date(2026, 0, 2, 9, 5).getTime())).toBe('09:05');
    expect(formatDay(new Date(2026, 10, 18, 9, 0).getTime())).toBe('18 Nov');
  });

  test('a stamp from today is the clock; another day adds the date', () => {
    expect(formatStamp(AT, new Date(2026, 10, 23, 23, 59).getTime())).toBe('14:02');
    expect(formatStamp(AT, new Date(2026, 10, 24, 0, 1).getTime())).toBe('23 Nov 14:02');
  });

  test('how long ago, in the two largest units', () => {
    const now = new Date(2026, 10, 23, 18, 0).getTime();
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now + 5 * min, now)).toBe('just now');
    expect(formatAgo(now - min, now)).toBe('1 minute ago');
    expect(formatAgo(now - 59 * min, now)).toBe('59 minutes ago');
    expect(formatAgo(now - (5 * hour + 20 * min + 30_000), now)).toBe('5 hours 20 minutes ago');
    expect(formatAgo(now - 5 * hour, now)).toBe('5 hours ago');
    expect(formatAgo(now - (3 * day + 12 * hour + 59 * min), now)).toBe('3 days 12 hours ago');
    expect(formatAgo(now - (1 * day + 1 * hour), now)).toBe('1 day 1 hour ago');
    expect(formatAgo(now - 40 * day, now)).toBe('1 month 10 days ago');
    expect(formatAgo(now - 364 * day, now)).toBe('12 months 4 days ago');
    expect(formatAgo(now - 730 * day, now)).toBe('2 years ago');
    expect(formatAgo(now - (365 + 364) * day, now)).toBe('1 year 11 months ago');
  });

  test('the full date and time, for the hover', () => {
    expect(formatFull(AT)).toBe('Mon 23 Nov 2026, 14:02');
  });

  test('the last day is 24 hours back from now, inclusive', () => {
    expect(activeLastDay(item({ activity: AT - LAST_DAY_MS }), AT)).toBe(true);
    expect(activeLastDay(item({ activity: AT - LAST_DAY_MS - 1 }), AT)).toBe(false);
    expect(activeLastDay(item({ activity: null }), AT)).toBe(false);
  });

  test('the gh line', () => {
    expect(checkedLine(AT, 'JornC', AT)).toBe('PRs checked 14:02 as JornC');
    expect(checkedLine(AT, null, AT)).toBe('PRs checked 14:02');
  });
});

describe('facts', () => {
  test('in a fixed order, zero and false left out', () => {
    const facts = item({
      facts: {
        uncommitted: 3,
        unpushed: 2,
        ahead: 5,
        base: 'upstream/main',
        draft: true,
        placeholders: 1,
        adoptedUnedited: true,
        bodyDiffers: true,
      },
    });
    expect(itemFacts(facts)).toEqual([
      '3 uncommitted',
      '2 unpushed',
      '5 ahead of upstream/main',
      'draft',
      '1 placeholder',
      'agent text, not edited',
      'GitHub body differs from draft',
    ]);
    expect(itemFacts(item())).toEqual([]);
  });

  test('a closed PR reads as its state and day', () => {
    const pr = {
      state: 'merged',
      mergedAt: new Date(2026, 10, 18, 9, 0).toISOString(),
      closedAt: null,
    } as PrInfo;
    expect(closedLabel(item({ pr }))).toBe('merged 18 Nov');
    expect(closedLabel(item())).toBeNull();
  });
});

describe('gh notices', () => {
  test('one per failure; nothing when it worked or was never asked', () => {
    expect(ghNotice('gh-missing', null)).toBe('gh not found — PR state unknown');
    expect(ghNotice('gh-logged-out', null)).toBe('gh not logged in — PR state unknown');
    expect(ghNotice('error', 'timeout')).toBe('could not reach GitHub: timeout');
    expect(ghNotice('ok', null)).toBeNull();
    expect(ghNotice('never', null)).toBeNull();
  });
});

describe('activity text', () => {
  test('what, and who for a GitHub event', () => {
    expect(activityText({ at: 1, kind: 'changes-requested', author: 'Bert', other: true })).toBe(
      'changes requested · Bert'
    );
    expect(activityText({ at: 1, kind: 'edited', author: null, other: false })).toBe(
      'files edited'
    );
  });
});

describe('groupByRepo', () => {
  const stack = (position: number, root = 's1'): WorkStack => ({ position, size: 3, root });

  test('repos in the order they first appear; the order inside stays', () => {
    const items = [
      item({ key: 'a1', repoRoot: '/w/a', repoName: 'a' }),
      item({ key: 'b1', repoRoot: '/w/b', repoName: 'b' }),
      item({ key: 'a2', repoRoot: '/w/a', repoName: 'a' }),
      item({ key: 'gh', repoRoot: null, repoName: 'i3/i3' }),
    ];
    expect(groupByRepo(items).map((g) => [g.name, g.items.map((i) => i.key)])).toEqual([
      ['a', ['a1', 'a2']],
      ['b', ['b1']],
      ['i3/i3', ['gh']],
    ]);
  });

  test("a stack's layers sit together where its first layer appears, bottom first", () => {
    const items = [
      item({ key: 'l2', stack: stack(2) }),
      item({ key: 'x' }),
      item({ key: 'l1', stack: stack(1) }),
      item({ key: 'other', stack: stack(1, 's9') }),
      item({ key: 'l3', stack: stack(3) }),
    ];
    expect(groupByRepo(items)[0].items.map((i) => i.key)).toEqual(['l1', 'l2', 'l3', 'x', 'other']);
  });
});

describe('itemEvents', () => {
  test('PR events, the merge and local times, newest first; other means not the viewer', () => {
    const mergedAt = '2026-11-22T10:00:00Z';
    const events = itemEvents(
      item({
        times: { edited: Date.parse('2026-11-23T08:00:00Z'), git: null, draft: null },
        pr: {
          state: 'merged',
          mergedAt,
          closedAt: mergedAt,
          progress: {
            decision: null,
            unresolvedThreads: 0,
            pendingReviewers: 0,
            requestedReviewers: [],
            changesRequestedBy: [],
            checks: null,
            headCommittedAt: null,
            conflicting: false,
            events: [
              { kind: 'approved', author: 'Bert', at: '2026-11-21T10:00:00Z' },
              { kind: 'commented', author: 'JornC', at: '2026-11-20T10:00:00Z' },
            ],
          },
        } as unknown as PrInfo,
      }),
      'JornC'
    );
    expect(events.map((e) => [e.text, e.other])).toEqual([
      ['files edited', false],
      ['merged', false],
      ['approved · Bert', true],
      ['commented · JornC', false],
    ]);
  });
});

describe('sorting', () => {
  const withPr = (key: string, number: number | null) =>
    item({ key, pr: number === null ? null : ({ number } as PrInfo) });

  test('by one column, equal values in their order, no value last either way', () => {
    const items = [withPr('a', 30), withPr('none', null), withPr('b', 10), withPr('c', 30)];
    expect(sortItems(items, { key: 'pr', dir: 'asc' }).map((i) => i.key)).toEqual([
      'b',
      'a',
      'c',
      'none',
    ]);
    expect(sortItems(items, { key: 'pr', dir: 'desc' }).map((i) => i.key)).toEqual([
      'a',
      'c',
      'b',
      'none',
    ]);
  });

  test('groups keep their order; the rows inside are sorted, stacks not pulled together', () => {
    const items = [
      item({ key: 'a1', repoRoot: '/w/a', repoName: 'a', branch: 'zeta' }),
      item({ key: 'b1', repoRoot: '/w/b', repoName: 'b', branch: 'beta' }),
      item({ key: 'a2', repoRoot: '/w/a', repoName: 'a', branch: 'alpha' }),
    ];
    const groups = groupByRepo(items, { key: 'branch', dir: 'asc' });
    expect(groups.map((g) => [g.name, g.items.map((i) => i.key)])).toEqual([
      ['a', ['a2', 'a1']],
      ['b', ['b1']],
    ]);
  });
});

describe('attention and the session brief', () => {
  const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
    number: 752,
    title: 'Proxy fix',
    url: 'https://github.com/aerius/GRIP/pull/752',
    state: 'open',
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-23T10:00:00Z',
    body: '',
    headRefName: 'proxy-fix',
    headRefOid: 'abc123',
    baseRefName: 'main',
    progress: {
      decision: 'changes-requested',
      unresolvedThreads: 0,
      pendingReviewers: 1,
      requestedReviewers: ['Hil'],
      changesRequestedBy: ['Bert', 'Hil'],
      checks: null,
      headCommittedAt: null,
      conflicting: false,
      events: [],
    },
    headOwner: 'SerhatG',
    author: 'SerhatG',
    reviewRequested: true,
    repo: 'aerius/GRIP',
    repoKey: 'aerius/grip',
    ...over,
  });

  test('one line per reason, naming who waits', () => {
    const lines = attentionLines(
      item({ pr: pr(), attention: ['changes-requested', 'review-requested'] })
    );
    expect(lines).toEqual([
      'Changes requested by Bert, not asked to review again yet',
      'SerhatG asks you to review this',
    ]);
  });

  test('a PR with no local clone: the link, branch, head and how to clone', () => {
    expect(sessionBrief(item({ pr: pr(), repoRoot: null, worktreePath: null }))).toBe(
      [
        'Pull request: https://github.com/aerius/GRIP/pull/752',
        'Title: Proxy fix',
        'Author: SerhatG (I am asked to review it)',
        'Branch: proxy-fix from SerhatG, into main of aerius/GRIP',
        'Head commit: abc123',
        'Local clone: none; git clone https://github.com/aerius/GRIP.git',
      ].join('\n')
    );
  });

  test('a local branch with no PR: the branch, clone and worktree', () => {
    const local = item({
      branch: 'feature',
      repoRoot: '/w/calc',
      worktreePath: '/w/calc/worktrees/feature',
      facts: { ...item().facts, base: 'upstream/main' },
    });
    expect(sessionBrief(local)).toBe(
      [
        'Branch: feature, ahead of upstream/main',
        'Local clone: /w/calc',
        'Worktree: /w/calc/worktrees/feature',
      ].join('\n')
    );
  });
});

describe('layoutWork', () => {
  const NOW = new Date(2026, 10, 23, 18, 0).getTime();
  const HOUR = 60 * 60 * 1000;
  const at = (key: string, repo: string, hoursAgo: number | null) =>
    item({
      key,
      repoRoot: `/w/${repo}`,
      repoName: repo,
      activity: hoursAgo === null ? null : NOW - hoursAgo * HOUR,
    });
  const items = [at('a1', 'a', 1), at('b1', 'b', 30), at('a2', 'a', 24 * 10), at('c1', 'c', null)];
  const label = (line: WorkLine): string => {
    if (line.kind === 'item') return line.item.key;
    return line.kind === 'time' ? `[${line.label}]` : `<${line.name}>`;
  };
  const shape = (byRepo: boolean, byTime: boolean) =>
    layoutWork(items, { byRepo, byTime, sort: null, now: NOW }).map(label);

  test('neither: one plain list', () => {
    expect(shape(false, false)).toEqual(['a1', 'b1', 'a2', 'c1']);
  });

  test('by repository', () => {
    expect(shape(true, false)).toEqual(['<a>', 'a1', 'a2', '<b>', 'b1', '<c>', 'c1']);
  });

  test('by time: unknown activity is older; empty buckets have no heading', () => {
    expect(shape(false, true)).toEqual([
      '[Last day]',
      'a1',
      '[Last week]',
      'b1',
      '[Last month]',
      'a2',
      '[Older]',
      'c1',
    ]);
  });

  test('both: repos inside each time bucket', () => {
    expect(shape(true, true)).toEqual([
      '[Last day]',
      '<a>',
      'a1',
      '[Last week]',
      '<b>',
      'b1',
      '[Last month]',
      '<a>',
      'a2',
      '[Older]',
      '<c>',
      'c1',
    ]);
  });
});

describe('workStatus', () => {
  const progress = (over: Partial<PrProgress> = {}): PrProgress => ({
    decision: 'review-required',
    unresolvedThreads: 0,
    pendingReviewers: 0,
    requestedReviewers: [],
    changesRequestedBy: [],
    checks: 'success',
    headCommittedAt: null,
    conflicting: false,
    events: [],
    ...over,
  });
  const open = (p: PrProgress | null, over: Partial<PrInfo> = {}) =>
    ({
      state: 'open',
      isDraft: false,
      progress: p,
      author: 'JornC',
      reviewRequested: false,
      ...over,
    }) as PrInfo;
  const statusOf = (pr: PrInfo, over: Partial<WorkItem> = {}) => {
    const s = workStatus(item({ pr, ...over }), 'JornC');
    return `${s.text} (${s.turn})`;
  };

  test("the author's open PR, first that applies", () => {
    expect(statusOf(open(progress(), { isDraft: true }))).toBe('draft (you)');
    expect(statusOf(open(progress({ conflicting: true })))).toBe('conflicts (you)');
    expect(statusOf(open(progress({ checks: 'failure' })))).toBe('checks failing (you)');
    expect(
      statusOf(open(progress({ decision: 'changes-requested', changesRequestedBy: ['Bert'] })), {
        attention: ['changes-requested'],
      })
    ).toBe('changes requested (you)');
    expect(statusOf(open(progress({ decision: 'approved' })))).toBe('approved (you)');
    expect(
      statusOf(
        open(
          progress({
            decision: 'changes-requested',
            changesRequestedBy: ['Bert'],
            requestedReviewers: ['Bert'],
          })
        )
      )
    ).toBe('awaiting re-review (others)');
    expect(statusOf(open(progress({ requestedReviewers: ['Bert'], pendingReviewers: 1 })))).toBe(
      'awaiting review (others)'
    );
    const reviewed = { kind: 'reviewed' as const, author: 'Bert', at: '2026-11-20T10:00:00Z' };
    expect(statusOf(open(progress({ events: [reviewed] })))).toBe('reviewed, no decision (you)');
    expect(statusOf(open(progress()))).toBe('needs reviewer (you)');
  });

  test('no decision but approved by someone else: approved', () => {
    const approved = { kind: 'approved' as const, author: 'Bert', at: '2026-11-20T10:00:00Z' };
    expect(statusOf(open(progress({ decision: null, events: [approved] })))).toBe('approved (you)');
  });

  test('a review request, a closed PR, and local work', () => {
    expect(statusOf(open(progress(), { reviewRequested: true, author: 'SerhatG' }))).toBe(
      'your review (you)'
    );
    expect(statusOf({ state: 'merged' } as PrInfo)).toBe('merged (none)');
    expect(
      statusOf({ state: 'merged' } as PrInfo, {
        facts: { ...item().facts, uncommitted: 2 },
      })
    ).toBe('merged, leftovers (you)');
    expect(workStatus(item({ state: 'pushed-no-pr' }), null).text).toBe('no PR yet');
    expect(workStatus(item({ state: 'not-pushed' }), null).text).toBe('not pushed');
  });
});
