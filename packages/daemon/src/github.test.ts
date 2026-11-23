/**
 * The PR service over a fake gh runner. No test here, or anywhere in the
 * daemon suite, runs the real `gh`: the last test checks that only
 * index.ts makes the real runner.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrInfo } from '@diffstalker/core/types/work';
import {
  CLOSED_FIRST_QUERY,
  CLOSED_PAGE_QUERY,
  CLOSED_SEARCH,
  GhError,
  OPEN_FIRST_QUERY,
  OPEN_PAGE_QUERY,
  OPEN_SEARCH,
  REVIEW_FIRST_QUERY,
  REVIEW_SEARCH,
  createPrService,
  type GhRunner,
} from './github.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');

type Side = 'open' | 'closed' | 'review';

/** The first page of every search: each search's first request takes its part. */
interface FirstPages {
  open: string;
  closed: string;
  review: string;
  taken: Set<Side>;
}

function sideOf(args: readonly string[]): Side {
  if (args.includes(`q=${OPEN_SEARCH}`)) return 'open';
  if (args.includes(`q=${REVIEW_SEARCH}`)) return 'review';
  return 'closed';
}

type Answer = string | GhError | (() => Promise<string>) | FirstPages;

interface Fake {
  runner: GhRunner;
  calls: string[][];
  answers: Answer[];
}

/**
 * Answers in queue order. A FirstPages entry answers all three first
 * requests (the searches run side by side) and leaves the queue once each
 * took its part; any other entry answers the next call, whichever it is.
 */
function fakeRunner(answers: Answer[] = []): Fake {
  const calls: string[][] = [];
  const runner: GhRunner = {
    available: () => true,
    run: async (args) => {
      calls.push([...args]);
      const next = answers[0];
      if (next === undefined) throw new Error('the fake gh ran out of answers');
      if (typeof next === 'object' && !(next instanceof GhError)) {
        const side = sideOf(args);
        if (args.some((arg) => arg.startsWith('after='))) {
          throw new Error('a page was asked before every first page was');
        }
        next.taken.add(side);
        if (next.taken.size === 3) answers.shift();
        return next[side];
      }
      answers.shift();
      if (next instanceof GhError) throw next;
      if (typeof next === 'function') return next();
      return next;
    },
  };
  return { runner, calls, answers };
}

function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: 'A change',
    url: 'https://github.com/aerius/calculator/pull/1',
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    body: 'Why.',
    headRefName: 'feature',
    headRefOid: 'a1b2c3',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'JornC' },
    repository: { nameWithOwner: 'aerius/calculator' },
    author: { __typename: 'User', login: 'JornC' },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviewRequests: { totalCount: 0, nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
    ...overrides,
  };
}

/** The fields only the open search reads. */
const OPEN_ONLY = [
  'body',
  'reviewDecision',
  'mergeable',
  'reviewRequests',
  'latestOpinionatedReviews',
  'reviews',
  'comments',
  'reviewThreads',
  'commits',
];

/** A PR as the closed search returns it: no body, no progress. */
function closedNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const node = prNode({ state: 'CLOSED', ...overrides });
  for (const key of OPEN_ONLY) delete node[key];
  return node;
}

function page(nodes: unknown[], next: string | null = null): Record<string, unknown> {
  return { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes };
}

function firstAnswer(opts: {
  open?: unknown[];
  closed?: unknown[];
  review?: unknown[];
  openNext?: string | null;
  closedNext?: string | null;
  viewer?: string;
}): FirstPages {
  return {
    open: JSON.stringify({
      data: {
        viewer: { login: opts.viewer ?? 'JornC' },
        search: page(opts.open ?? [], opts.openNext ?? null),
      },
    }),
    closed: JSON.stringify({
      data: { search: page(opts.closed ?? [], opts.closedNext ?? null) },
    }),
    review: JSON.stringify({ data: { search: page(opts.review ?? []) } }),
    taken: new Set(),
  };
}

function pageAnswer(nodes: unknown[], next: string | null = null): string {
  return JSON.stringify({ data: { search: page(nodes, next) } });
}

let stderr: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

function warnings(): string[] {
  return stderr.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.includes(' warn '));
}

describe('the gh command', () => {
  test('the first two calls are exactly this argv', async () => {
    const fake = fakeRunner([firstAnswer({})]);
    await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls).toEqual([
      ['api', 'graphql', '-f', `query=${OPEN_FIRST_QUERY}`, '-f', 'q=is:pr author:@me is:open'],
      [
        'api',
        'graphql',
        '-f',
        `query=${CLOSED_FIRST_QUERY}`,
        '-f',
        'q=is:pr author:@me is:closed sort:updated-desc',
      ],
      [
        'api',
        'graphql',
        '-f',
        `query=${REVIEW_FIRST_QUERY}`,
        '-f',
        'q=is:pr is:open review-requested:@me',
      ],
    ]);
    expect(OPEN_SEARCH).toBe('is:pr author:@me is:open');
    expect(CLOSED_SEARCH).toBe('is:pr author:@me is:closed sort:updated-desc');
  });

  test('every value after api graphql is one -f key=value pair, and no -F appears', async () => {
    const fake = fakeRunner([firstAnswer({ openNext: 'Y3Vyc29yOjEwMA==' }), pageAnswer([])]);
    await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls).toHaveLength(4);
    for (const call of fake.calls) {
      expect(call.slice(0, 2)).toEqual(['api', 'graphql']);
      const rest = call.slice(2);
      expect(rest.length % 2).toBe(0);
      for (let i = 0; i < rest.length; i += 2) {
        expect(rest[i]).toBe('-f');
        expect(rest[i + 1]).toMatch(/^[a-zA-Z]+=/);
      }
      expect(call).not.toContain('-F');
    }
  });

  test('only the open search reads the body and the progress', () => {
    const open = [OPEN_FIRST_QUERY, OPEN_PAGE_QUERY];
    const closed = [CLOSED_FIRST_QUERY, CLOSED_PAGE_QUERY];
    for (const query of [...open, ...closed]) {
      expect(query).toMatch(/\bheadRefOid\b/);
      expect(query).toMatch(/\bbaseRefName\b/);
    }
    for (const field of ['body', 'reviewDecision', 'reviewThreads', 'statusCheckRollup']) {
      for (const query of open) expect(query).toMatch(new RegExp(`\\b${field}\\b`));
      for (const query of closed) expect(query).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(OPEN_FIRST_QUERY).toMatch(/\bviewer\b/);
    expect(CLOSED_FIRST_QUERY).not.toMatch(/\bviewer\b/);
  });
});

describe('progress', () => {
  const person = (login: string) => ({ __typename: 'User', login });
  const bot = { __typename: 'Bot', login: 'sonarqubecloud' };

  async function progressOf(overrides: Record<string, unknown>) {
    const fake = fakeRunner([firstAnswer({ open: [prNode(overrides)] })]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('ok');
    return snapshot.prs[0].progress;
  }

  test('reads the decision, threads, reviewers, checks and conflicts', async () => {
    const progress = await progressOf({
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
      reviewRequests: { totalCount: 2, nodes: [] },
      reviewThreads: {
        nodes: [
          { isResolved: false, comments: { nodes: [] } },
          { isResolved: true, comments: { nodes: [] } },
          { isResolved: false, comments: { nodes: [] } },
        ],
      },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
    });
    expect(progress).toMatchObject({
      decision: 'changes-requested',
      unresolvedThreads: 2,
      pendingReviewers: 2,
      checks: 'failure',
      conflicting: true,
    });
  });

  test('no checks and an unknown decision read as null', async () => {
    const progress = await progressOf({
      reviewDecision: 'SOMETHING_NEW',
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    expect(progress).toMatchObject({ decision: null, checks: null });
  });

  test('events are people only, newest first, sent reviews only', async () => {
    const progress = await progressOf({
      reviews: {
        nodes: [
          {
            author: person('Bert'),
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-11-20T09:00:00Z',
          },
          { author: person('Bert'), state: 'PENDING', submittedAt: null },
          { author: person('Hil'), state: 'DISMISSED', submittedAt: '2026-11-21T09:00:00Z' },
          { author: person('Hil'), state: 'APPROVED', submittedAt: '2026-11-22T09:00:00Z' },
        ],
      },
      comments: {
        nodes: [
          { author: bot, createdAt: '2026-11-23T08:00:00Z' },
          { author: null, createdAt: '2026-11-23T08:30:00Z' },
          { author: person('JornC'), createdAt: '2026-11-21T10:00:00Z' },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: { nodes: [{ author: person('Bert'), createdAt: '2026-11-22T11:00:00Z' }] },
          },
        ],
      },
    });
    expect(progress?.events).toEqual([
      { kind: 'commented', author: 'Bert', at: '2026-11-22T11:00:00Z' },
      { kind: 'approved', author: 'Hil', at: '2026-11-22T09:00:00Z' },
      { kind: 'commented', author: 'JornC', at: '2026-11-21T10:00:00Z' },
      { kind: 'changes-requested', author: 'Bert', at: '2026-11-20T09:00:00Z' },
    ]);
  });

  test('a review and its inline comments in one minute are one event each kind', async () => {
    const at = '2026-11-22T11:00:00Z';
    const progress = await progressOf({
      reviews: { nodes: [{ author: person('Bert'), state: 'COMMENTED', submittedAt: at }] },
      reviewThreads: {
        nodes: [1, 2, 3].map(() => ({
          isResolved: false,
          comments: { nodes: [{ author: person('Bert'), createdAt: '2026-11-22T11:00:30Z' }] },
        })),
      },
    });
    expect(progress?.events.map((event) => event.kind)).toEqual(['commented', 'reviewed']);
  });

  test('keeps at most ten events', async () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      author: person('Bert'),
      createdAt: `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));
    const progress = await progressOf({ comments: { nodes } });
    expect(progress?.events).toHaveLength(10);
    expect(progress?.events[0].at).toBe('2026-11-15T10:00:00Z');
  });

  test('reads who is asked to review and who asked for changes', async () => {
    const progress = await progressOf({
      reviewRequests: {
        totalCount: 3,
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'Bert' } },
          { requestedReviewer: { __typename: 'Team', slug: 'calc' } },
          { requestedReviewer: null },
        ],
      },
      latestOpinionatedReviews: {
        nodes: [
          { author: person('Bert'), state: 'CHANGES_REQUESTED' },
          { author: person('Hil'), state: 'APPROVED' },
          { author: bot, state: 'CHANGES_REQUESTED' },
        ],
      },
    });
    expect(progress).toMatchObject({
      pendingReviewers: 3,
      requestedReviewers: ['Bert', 'team:calc'],
      changesRequestedBy: ['Bert'],
    });
  });

  test('a PR from the review-request search is marked, with its author', async () => {
    const theirs = prNode({
      number: 752,
      headRefName: 'their-branch',
      author: { __typename: 'User', login: 'SerhatG' },
    });
    const fake = fakeRunner([firstAnswer({ open: [prNode()], review: [theirs] })]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const byNumber = new Map(snapshot.prs.map((pr) => [pr.number, pr]));
    expect(byNumber.get(752)).toMatchObject({ reviewRequested: true, author: 'SerhatG' });
    expect(byNumber.get(1)).toMatchObject({ reviewRequested: false, author: 'JornC' });
  });

  test('a closed PR has no progress', async () => {
    const fake = fakeRunner([firstAnswer({ closed: [closedNode({ merged: true })] })]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.prs[0].progress).toBeNull();
  });
});

describe('paging', () => {
  test('follows the cursor GitHub gave', async () => {
    const fake = fakeRunner([
      firstAnswer({ open: [prNode({ number: 1 })], openNext: 'Y3Vyc29yOjEwMA==' }),
      pageAnswer([prNode({ number: 2 })]),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls[3]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${OPEN_PAGE_QUERY}`,
      '-f',
      'q=is:pr author:@me is:open',
      '-f',
      'after=Y3Vyc29yOjEwMA==',
    ]);
    expect(snapshot.prs.map((pr) => pr.number).sort()).toEqual([1, 2]);
    expect(snapshot.capped).toBe(false);
  });

  test('pages the closed search with its own query, and reads no body there', async () => {
    const fake = fakeRunner([
      firstAnswer({ closed: [closedNode({ number: 1 })], closedNext: 'Y3Vyc29yOjEwMA==' }),
      pageAnswer([closedNode({ number: 2 })]),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls[3]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${CLOSED_PAGE_QUERY}`,
      '-f',
      'q=is:pr author:@me is:closed sort:updated-desc',
      '-f',
      'after=Y3Vyc29yOjEwMA==',
    ]);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.prs.map((pr) => [pr.number, pr.body])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  test('refuses a flag-shaped cursor and runs nothing more', async () => {
    const fake = fakeRunner([firstAnswer({ openNext: '--x' })]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls).toHaveLength(3);
    expect(snapshot.status).toBe('error');
  });

  const hundred = (from: number, node: typeof prNode) =>
    Array.from({ length: 100 }, (_, i) => node({ number: from + i, headRefName: `b${from + i}` }));

  test('stops at 300 open PRs and says so', async () => {
    const fake = fakeRunner([
      firstAnswer({ open: hundred(1, prNode), openNext: 'c1' }),
      pageAnswer(hundred(101, prNode), 'c2'),
      pageAnswer(hundred(201, prNode), 'c3'),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls).toHaveLength(5);
    expect(snapshot.prs).toHaveLength(300);
    expect(snapshot.capped).toBe(true);
  });

  test('stops at 300 closed PRs without calling the list capped', async () => {
    const fake = fakeRunner([
      firstAnswer({ closed: hundred(1, closedNode), closedNext: 'c1' }),
      pageAnswer(hundred(101, closedNode), 'c2'),
      pageAnswer(hundred(201, closedNode), 'c3'),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.calls).toHaveLength(5);
    expect(snapshot.prs).toHaveLength(300);
    expect(snapshot.capped).toBe(false);
  });
});

describe('refresh', () => {
  test('two at once run gh once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pages = firstAnswer({ open: [prNode()] });
    const held = (text: string) => async () => {
      await gate;
      return text;
    };
    const fake = fakeRunner([held(pages.open), held(pages.closed), held(pages.review)]);
    const service = createPrService(fake.runner, () => NOW);
    const first = service.refresh();
    const second = service.refresh();
    release();
    expect(await first).toBe(await second);
    expect(fake.calls).toHaveLength(3);

    fake.answers.push(firstAnswer({}));
    await service.refresh();
    expect(fake.calls).toHaveLength(6);
  });

  test('a good answer sets ok, the viewer and the time', async () => {
    let clock = NOW;
    const fake = fakeRunner([firstAnswer({ open: [prNode()], viewer: 'JornC' })]);
    const service = createPrService(fake.runner, () => clock);
    expect(service.snapshot()).toMatchObject({ status: 'never', checkedAt: null, prs: [] });
    clock = NOW + 5;
    const snapshot = await service.refresh();
    expect(snapshot).toMatchObject({
      status: 'ok',
      message: null,
      viewer: 'JornC',
      checkedAt: NOW + 5,
    });
    expect(snapshot.prs[0]).toEqual({
      number: 1,
      title: 'A change',
      url: 'https://github.com/aerius/calculator/pull/1',
      state: 'open',
      isDraft: false,
      mergedAt: null,
      closedAt: null,
      updatedAt: '2026-11-20T10:00:00Z',
      body: 'Why.',
      headRefName: 'feature',
      headRefOid: 'a1b2c3',
      baseRefName: 'main',
      progress: {
        decision: null,
        unresolvedThreads: 0,
        pendingReviewers: 0,
        requestedReviewers: [],
        changesRequestedBy: [],
        checks: null,
        conflicting: false,
        events: [],
      },
      headOwner: 'JornC',
      author: 'JornC',
      reviewRequested: false,
      repo: 'aerius/calculator',
      repoKey: 'aerius/calculator',
    } satisfies PrInfo);
    expect(service.snapshot()).toBe(snapshot);
  });

  const failures: Array<[GhError, string, string | null]> = [
    [new GhError('missing', 'gh not found'), 'gh-missing', null],
    [new GhError('logged-out', 'gh is not logged in'), 'gh-logged-out', null],
    [new GhError('failed', 'HTTP 502'), 'error', 'HTTP 502'],
  ];
  for (const [error, status, message] of failures) {
    test(`${error.kind} is ${status} and keeps the last good list`, async () => {
      let clock = NOW;
      const fake = fakeRunner([firstAnswer({ open: [prNode()] }), error]);
      const service = createPrService(fake.runner, () => clock);
      const good = await service.refresh();
      clock = NOW + 60_000;
      const failed = await service.refresh();
      expect(failed).toMatchObject({ status, message });
      expect(failed.prs).toEqual(good.prs);
      expect(failed.checkedAt).toBe(NOW);
      expect(failed.viewer).toBe('JornC');
      expect(warnings()).toHaveLength(1);
    });
  }

  test('text that is not JSON is an error', async () => {
    const fake = fakeRunner(['<html>rate limited</html>']);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    expect(snapshot.message).toContain('not JSON');
  });

  test('an answer of the wrong shape is an error', async () => {
    const fake = fakeRunner([firstAnswer({ open: [prNode({ number: 'one' })] })]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    expect(snapshot.prs).toEqual([]);
  });

  test('a PR without its head commit is refused', async () => {
    const fake = fakeRunner([firstAnswer({ open: [prNode({ headRefOid: null })] })]);
    expect((await createPrService(fake.runner, () => NOW).refresh()).status).toBe('error');
  });

  test('a url that is not https is refused', async () => {
    const fake = fakeRunner([firstAnswer({ open: [prNode({ url: 'javascript:alert(1)' })] })]);
    expect((await createPrService(fake.runner, () => NOW).refresh()).status).toBe('error');
  });

  test("GitHub's own error message is kept", async () => {
    const fake = fakeRunner([
      JSON.stringify({ data: null, errors: [{ message: 'Something went wrong' }] }),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot).toMatchObject({ status: 'error', message: 'Something went wrong' });
  });

  test('maps merged and closed, and keeps a PR in both searches once', async () => {
    const fake = fakeRunner([
      firstAnswer({
        open: [prNode({ number: 5, updatedAt: '2026-11-21T00:00:00Z' })],
        closed: [
          closedNode({
            number: 5,
            closedAt: '2026-11-22T00:00:00Z',
            updatedAt: '2026-11-22T00:00:00Z',
          }),
          closedNode({
            number: 6,
            state: 'MERGED',
            merged: true,
            mergedAt: '2026-11-19T00:00:00Z',
            closedAt: '2026-11-19T00:00:00Z',
            headRefOid: 'f00d',
          }),
          closedNode({
            number: 7,
            headRepositoryOwner: null,
            closedAt: '2026-11-18T00:00:00Z',
          }),
        ],
      }),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const byNumber = new Map(snapshot.prs.map((pr) => [pr.number, pr]));
    expect(snapshot.prs).toHaveLength(3);
    expect(byNumber.get(5)).toMatchObject({ state: 'closed', body: null });
    expect(byNumber.get(6)).toMatchObject({ state: 'merged', headRefOid: 'f00d' });
    expect(byNumber.get(7)?.headOwner).toBeNull();
  });

  test('sorts open first, then the newest update first', async () => {
    const fake = fakeRunner([
      firstAnswer({
        open: [
          prNode({ number: 1, updatedAt: '2026-11-01T00:00:00Z' }),
          prNode({ number: 2, updatedAt: '2026-11-10T00:00:00Z' }),
        ],
        closed: [closedNode({ number: 3, updatedAt: '2026-11-22T00:00:00Z' })],
      }),
    ]);
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.prs.map((pr) => pr.number)).toEqual([2, 1, 3]);
  });
});

describe('prFor', () => {
  test('matches the repo case-insensitively and the branch exactly', async () => {
    const fake = fakeRunner([
      firstAnswer({
        open: [
          prNode({
            number: 1,
            headRefName: 'Feature',
            repository: { nameWithOwner: 'Aerius/Calculator' },
          }),
          prNode({
            number: 2,
            headRefName: 'feature',
            repository: { nameWithOwner: 'Aerius/Calculator' },
          }),
        ],
      }),
    ]);
    const service = createPrService(fake.runner, () => NOW);
    expect(service.prFor(['aerius/calculator'], 'feature')).toBeNull();
    await service.refresh();
    expect(service.prFor(['AERIUS/calculator'], 'feature')?.number).toBe(2);
    expect(service.prFor(['aerius/calculator'], 'Feature')?.number).toBe(1);
    expect(service.prFor(['jornc/calculator'], 'feature')).toBeNull();
    expect(service.prFor(['aerius/calculator'], 'FEATURE')).toBeNull();
  });
});

describe('without a runner', () => {
  test('acts as if gh were missing, quietly', async () => {
    const service = createPrService(null, () => NOW);
    expect(service.ghAvailable()).toBe(false);
    const snapshot = await service.refresh();
    expect(snapshot).toMatchObject({
      status: 'gh-missing',
      message: null,
      checkedAt: null,
      prs: [],
    });
    expect(warnings()).toEqual([]);
  });

  test('ghAvailable asks the runner', () => {
    expect(createPrService(fakeRunner().runner).ghAvailable()).toBe(true);
  });
});

test('only index.ts makes the real gh runner', () => {
  const srcDir = import.meta.dirname;
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.ts') &&
        entry.name !== 'github.ts' &&
        entry.name !== 'github.test.ts'
      ) {
        if (fs.readFileSync(full, 'utf8').includes('createGhRunner('))
          callers.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);
  expect(callers).toEqual(['index.ts']);
});
