/**
 * The PR service over a fake GitHub behind a fake gh runner. No test here,
 * or anywhere in the daemon suite, runs the real `gh`: the last test checks
 * that only index.ts makes the real runner.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrInfo } from '@diffstalker/core/types/work';
import {
  CLOSED_QUERY,
  CLOSED_SEARCH,
  DETAIL_BATCH,
  DETAIL_QUERIES,
  GH_ARGS,
  GhError,
  LIVE_QUERY,
  OPEN_SEARCH,
  REVIEW_SEARCH,
  UPDATE_BODY_MUTATION,
  createPrService,
  type GhRunner,
} from './github.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');

type Node = Record<string, unknown>;

interface Request {
  query: string;
  variables: Record<string, unknown>;
}

type Override = string | GhError | Promise<string> | undefined;

/** What the fake GitHub holds; a test changes it between refreshes. */
interface GitHub {
  viewer: string;
  open: Node[];
  review: Node[];
  closed: Node[];
}

interface Fake {
  runner: GhRunner;
  github: GitHub;
  argv: string[][];
  requests: Request[];
  /** Answers a request in place of GitHub when it returns something. */
  override: ((request: Request) => Override) | null;
}

const isSearch = (request: Request) => /\bsearch\(/.test(request.query);
const isDetail = (request: Request) => DETAIL_QUERIES.includes(request.query);
const searches = (fake: Fake) => fake.requests.filter(isSearch);
const details = (fake: Fake) => fake.requests.filter(isDetail);
/** The PR numbers one detail request asks for. */
const numbersOf = (request: Request) =>
  Object.keys(request.variables)
    .filter((key) => key.startsWith('number'))
    .map((key) => request.variables[key]);

/** Only the fields the query names, as GitHub answers. */
function asked(node: Node, query: string): Node {
  return Object.fromEntries(
    Object.entries(node).filter(([key]) => new RegExp(`\\b${key}\\b`).test(query))
  );
}

/** The PRs a search finds: the closed one may ask only for what changed since a date. */
function found(github: GitHub, q: string): Node[] {
  if (q === OPEN_SEARCH) return github.open;
  if (q === REVIEW_SEARCH) return github.review;
  if (q === CLOSED_SEARCH) return github.closed;
  const since = /^is:pr author:@me is:closed updated:>=(\S+) sort:updated-desc$/.exec(q);
  if (since === null) throw new Error(`the fake GitHub does not know the search ${q}`);
  return github.closed.filter((n) => Date.parse(String(n.updatedAt)) >= Date.parse(since[1]));
}

/** A page of 100, with a cursor that is the offset of the next one. */
function searchAnswer(github: GitHub, { query, variables }: Request): unknown {
  const list = found(github, String(variables.q));
  const from = variables.after === null ? 0 : Number(String(variables.after).slice(4));
  const more = from + 100 < list.length;
  return {
    data: {
      ...(query.includes('viewer') ? { viewer: { login: github.viewer } } : {}),
      search: {
        pageInfo: { hasNextPage: more, endCursor: more ? `Y3Vy${from + 100}` : null },
        nodes: list.slice(from, from + 100).map((node) => asked(node, query)),
      },
    },
  };
}

/** p0, p1, … by owner, name and number. */
function detailAnswer(github: GitHub, { query, variables }: Request): unknown {
  const everything = [...github.open, ...github.review, ...github.closed];
  const data: Node = {};
  for (let i = 0; `number${i}` in variables; i++) {
    const owner = String(variables[`owner${i}`]);
    const name = String(variables[`name${i}`]);
    const node = everything.find(
      (n) =>
        String((n.repository as Node).nameWithOwner).toLowerCase() ===
          `${owner}/${name}`.toLowerCase() && n.number === variables[`number${i}`]
    );
    data[`p${i}`] = { pullRequest: node === undefined ? null : asked(node, query) };
  }
  return { data };
}

function answer(github: GitHub, request: Request): unknown {
  if (isSearch(request)) return searchAnswer(github, request);
  if (isDetail(request)) return detailAnswer(github, request);
  throw new Error('the fake GitHub does not know this query');
}

function fakeGitHub(github: Partial<GitHub> = {}): Fake {
  const fake: Fake = {
    github: { viewer: 'JornC', open: [], review: [], closed: [], ...github },
    argv: [],
    requests: [],
    override: null,
    runner: {
      available: () => true,
      run: async (args, _timeout, input) => {
        fake.argv.push([...args]);
        const request = JSON.parse(input ?? '') as Request;
        fake.requests.push(request);
        const over = fake.override?.(request);
        if (over instanceof GhError) throw over;
        if (over !== undefined) return over;
        return JSON.stringify(answer(fake.github, request));
      },
    },
  };
  return fake;
}

function prNode(overrides: Node = {}): Node {
  const number = (overrides.number as number | undefined) ?? 1;
  return {
    id: `PR_${number}`,
    number,
    title: 'A change',
    url: `https://github.com/aerius/calculator/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    body: 'Why.',
    headRefName: `branch-${number}`,
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

function closedNode(overrides: Node = {}): Node {
  return prNode({ state: 'CLOSED', closedAt: '2026-11-19T00:00:00Z', ...overrides });
}

const many = (count: number, from = 1, node = prNode) =>
  Array.from({ length: count }, (_, i) => node({ number: from + i }));

/** Change a PR on the fake GitHub, by number. */
function edit(list: Node[], number: number, changes: Node): void {
  const index = list.findIndex((node) => node.number === number);
  list[index] = { ...list[index], ...changes };
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
  test('every call has the same argv; the query and its variables go in on stdin', async () => {
    const fake = fakeGitHub({
      open: many(150),
      review: many(2, 900),
      closed: many(3, 500, closedNode),
    });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    await service.refresh();
    expect(GH_ARGS).toEqual(['api', 'graphql', '--input', '-']);
    expect(fake.argv.length).toBeGreaterThan(8);
    for (const argv of fake.argv) expect(argv).toEqual(['api', 'graphql', '--input', '-']);
    for (const request of fake.requests) {
      expect([LIVE_QUERY, CLOSED_QUERY, ...DETAIL_QUERIES]).toContain(request.query);
    }
  });

  test('the searches are fixed strings', async () => {
    const fake = fakeGitHub();
    await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.requests.map((r) => [r.query, r.variables])).toEqual([
      [LIVE_QUERY, { q: 'is:pr author:@me is:open', after: null }],
      [LIVE_QUERY, { q: 'is:pr is:open review-requested:@me', after: null }],
      [CLOSED_QUERY, { q: 'is:pr author:@me is:closed sort:updated-desc', after: null }],
    ]);
    expect([OPEN_SEARCH, REVIEW_SEARCH, CLOSED_SEARCH]).toEqual([
      'is:pr author:@me is:open',
      'is:pr is:open review-requested:@me',
      'is:pr author:@me is:closed sort:updated-desc',
    ]);
  });

  test('the light lists read no details; the detail read and the write read everything', () => {
    const word = (field: string) => new RegExp(`\\b${field}\\b`);
    const detail = [
      'body',
      'reviewRequests',
      'latestOpinionatedReviews',
      'reviews',
      'comments',
      'reviewThreads',
    ];
    const live = [
      'updatedAt',
      'headRefOid',
      'isDraft',
      'mergeable',
      'reviewDecision',
      'committedDate',
      'statusCheckRollup',
    ];
    for (const field of detail) {
      expect(LIVE_QUERY).not.toMatch(word(field));
      expect(CLOSED_QUERY).not.toMatch(word(field));
    }
    for (const field of live) expect(LIVE_QUERY).toMatch(word(field));
    for (const field of ['mergeable', 'reviewDecision', 'statusCheckRollup']) {
      expect(CLOSED_QUERY).not.toMatch(word(field));
    }
    for (const query of [...DETAIL_QUERIES, UPDATE_BODY_MUTATION]) {
      for (const field of [...detail, ...live, 'id']) expect(query).toMatch(word(field));
    }
    expect(LIVE_QUERY).toMatch(word('viewer'));
    expect(CLOSED_QUERY).not.toMatch(word('viewer'));
  });

  test('a detail query has one fixed text per batch size, with only its own variables', () => {
    expect(DETAIL_QUERIES).toHaveLength(DETAIL_BATCH);
    DETAIL_QUERIES.forEach((query, i) => {
      const size = i + 1;
      expect(query.match(/\bp\d+: repository\(/g)).toHaveLength(size);
      const variables = new Set(query.match(/\$\w+/g));
      const expected = new Set(
        Array.from({ length: size }, (_, k) => [`$owner${k}`, `$name${k}`, `$number${k}`]).flat()
      );
      expect(variables).toEqual(expected);
    });
  });
});

describe('details', () => {
  test('the first refresh reads the light lists, then every open PR whole', async () => {
    const fake = fakeGitHub({
      open: [prNode({ number: 1 }), prNode({ number: 2 })],
      review: [prNode({ number: 3, author: { __typename: 'User', login: 'Bert' } })],
      closed: [closedNode({ number: 4 })],
    });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('ok');
    expect(searches(fake)).toHaveLength(3);
    expect(details(fake).map(numbersOf)).toEqual([[1, 2, 3]]);
    const byNumber = new Map(snapshot.prs.map((pr) => [pr.number, pr]));
    for (const number of [1, 2, 3]) {
      expect(byNumber.get(number)?.body).toBe('Why.');
      expect(byNumber.get(number)?.progress).not.toBeNull();
    }
    expect(byNumber.get(4)).toMatchObject({ state: 'closed', body: null, progress: null });
  });

  test('a second refresh with nothing changed reads no PR whole', async () => {
    const fake = fakeGitHub({
      open: many(3),
      review: many(1, 900),
      closed: many(2, 500, closedNode),
    });
    const service = createPrService(fake.runner, () => NOW);
    const first = await service.refresh();
    fake.requests.length = 0;
    const second = await service.refresh();
    expect(searches(fake)).toHaveLength(3);
    expect(details(fake)).toEqual([]);
    expect(second.prs).toEqual(first.prs);
  });

  test('a moved head commit reads exactly that PR, in one request', async () => {
    const fake = fakeGitHub({ open: many(5) });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    edit(fake.github.open, 3, { headRefOid: 'f00d', body: 'Pushed.' });
    fake.requests.length = 0;
    const snapshot = await service.refresh();
    expect(details(fake).map(numbersOf)).toEqual([[3]]);
    expect(details(fake)[0].variables).toEqual({
      owner0: 'aerius',
      name0: 'calculator',
      number0: 3,
    });
    expect(snapshot.prs.find((pr) => pr.number === 3)).toMatchObject({
      headRefOid: 'f00d',
      body: 'Pushed.',
    });
  });

  test('a moved updatedAt reads exactly that PR, and its new details show', async () => {
    const fake = fakeGitHub({ open: many(5) });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    edit(fake.github.open, 4, {
      updatedAt: '2026-11-23T11:00:00Z',
      body: 'Edited.',
      comments: {
        nodes: [
          { author: { __typename: 'User', login: 'Bert' }, createdAt: '2026-11-23T11:00:00Z' },
        ],
      },
    });
    fake.requests.length = 0;
    const snapshot = await service.refresh();
    expect(details(fake).map(numbersOf)).toEqual([[4]]);
    const pr = snapshot.prs.find((p) => p.number === 4);
    expect(pr?.body).toBe('Edited.');
    expect(pr?.progress?.events).toEqual([
      { kind: 'commented', author: 'Bert', at: '2026-11-23T11:00:00Z' },
    ]);
  });

  test('CI, conflicts, the decision and the draft flag show without a detail read', async () => {
    const fake = fakeGitHub({ open: [prNode({ number: 1, body: 'Kept.' })] });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    edit(fake.github.open, 1, {
      isDraft: true,
      mergeable: 'CONFLICTING',
      reviewDecision: 'APPROVED',
      commits: {
        nodes: [
          {
            commit: {
              committedDate: '2026-11-20T09:00:00Z',
              statusCheckRollup: { state: 'FAILURE' },
            },
          },
        ],
      },
      // GitHub would not show this without a detail read, nor does the cache.
      body: 'Not read.',
    });
    fake.requests.length = 0;
    const snapshot = await service.refresh();
    expect(details(fake)).toEqual([]);
    expect(snapshot.prs[0]).toMatchObject({ isDraft: true, body: 'Kept.' });
    expect(snapshot.prs[0].progress).toMatchObject({
      checks: 'failure',
      conflicting: true,
      decision: 'approved',
      headCommittedAt: '2026-11-20T09:00:00Z',
    });
  });

  test('a new PR is read whole on its own', async () => {
    const fake = fakeGitHub({ open: many(3) });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    fake.github.open.push(prNode({ number: 77 }));
    fake.requests.length = 0;
    await service.refresh();
    expect(details(fake).map(numbersOf)).toEqual([[77]]);
  });

  test('a request holds at most ten PRs, with the query of its size', async () => {
    const fake = fakeGitHub({ open: many(20), review: many(3, 900) });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const sizes = details(fake).map((request) => numbersOf(request).length);
    expect(sizes.sort((a, b) => b - a)).toEqual([10, 10, 3]);
    for (const request of details(fake)) {
      expect(request.query).toBe(DETAIL_QUERIES[numbersOf(request).length - 1]);
    }
    expect(snapshot.prs.filter((pr) => pr.body === 'Why.')).toHaveLength(23);
  });

  test('a PR that left the open list is read again if it comes back', async () => {
    const fake = fakeGitHub({ open: many(2) });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    const second = fake.github.open.pop() as Node;
    await service.refresh();
    fake.github.open.push(second);
    fake.requests.length = 0;
    await service.refresh();
    expect(details(fake).map(numbersOf)).toEqual([[2]]);
  });

  test('a PR GitHub no longer has fails the refresh', async () => {
    const fake = fakeGitHub({ open: many(1) });
    fake.override = (request) =>
      isDetail(request) ? JSON.stringify({ data: { p0: { pullRequest: null } } }) : undefined;
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot).toMatchObject({ status: 'error', message: 'GitHub no longer has this PR' });
  });
});

describe('closed', () => {
  const SINCE =
    /^is:pr author:@me is:closed updated:>=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) sort:updated-desc$/;
  const closedSearches = (fake: Fake) =>
    fake.requests.filter((r) => r.query === CLOSED_QUERY).map((r) => String(r.variables.q));

  test('after the first refresh, asks only for what changed since it, less ten minutes', async () => {
    let clock = NOW;
    const fake = fakeGitHub({ closed: many(3, 500, closedNode) });
    const service = createPrService(fake.runner, () => clock);
    await service.refresh();
    clock = NOW + 5 * 60_000;
    await service.refresh();
    clock = NOW + 60 * 60_000 + 1234;
    await service.refresh();
    const [first, second, third] = closedSearches(fake);
    expect(first).toBe(CLOSED_SEARCH);
    expect(second).toMatch(SINCE);
    expect(second).toBe(
      'is:pr author:@me is:closed updated:>=2026-11-23T11:50:00Z sort:updated-desc'
    );
    expect(third).toBe(
      'is:pr author:@me is:closed updated:>=2026-11-23T11:55:00Z sort:updated-desc'
    );
  });

  test('merges what changed into the cached list', async () => {
    let clock = NOW;
    const fake = fakeGitHub({
      open: [prNode({ number: 1 }), prNode({ number: 2 })],
      closed: [
        closedNode({ number: 10, updatedAt: '2026-11-19T00:00:00Z' }),
        closedNode({ number: 11, updatedAt: '2026-11-18T00:00:00Z' }),
      ],
    });
    const service = createPrService(fake.runner, () => clock);
    await service.refresh();
    // #2 merges, and someone comments on the closed #11.
    const two = fake.github.open.pop() as Node;
    fake.github.closed.unshift({
      ...two,
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-11-23T12:30:00Z',
      updatedAt: '2026-11-23T12:30:00Z',
    });
    edit(fake.github.closed, 11, { title: 'Renamed', updatedAt: '2026-11-23T12:31:00Z' });
    clock = NOW + 60 * 60_000;
    fake.requests.length = 0;
    const snapshot = await service.refresh();
    expect(details(fake)).toEqual([]);
    expect(snapshot.prs.map((pr) => [pr.number, pr.state])).toEqual([
      [1, 'open'],
      [11, 'closed'],
      [2, 'merged'],
      [10, 'closed'],
    ]);
    expect(snapshot.prs.find((pr) => pr.number === 11)?.title).toBe('Renamed');
  });

  test('keeps the newest 300 when the merge passes the cap', async () => {
    let clock = NOW;
    const old = Array.from({ length: 300 }, (_, i) =>
      closedNode({ number: 1000 + i, updatedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString() })
    );
    const fake = fakeGitHub({ closed: old });
    const service = createPrService(fake.runner, () => clock);
    expect((await service.refresh()).prs).toHaveLength(300);
    fake.github.closed.unshift(closedNode({ number: 1, updatedAt: '2026-11-23T12:10:00Z' }));
    clock = NOW + 30 * 60_000;
    const snapshot = await service.refresh();
    expect(snapshot.prs).toHaveLength(300);
    expect(snapshot.prs[0].number).toBe(1);
    expect(snapshot.prs.some((pr) => pr.number === 1299)).toBe(false);
    expect(snapshot.capped).toBe(false);
  });

  test('a failed refresh does not move the mark', async () => {
    let clock = NOW;
    const fake = fakeGitHub();
    const service = createPrService(fake.runner, () => clock);
    await service.refresh();
    clock = NOW + 60 * 60_000;
    fake.override = (request) =>
      request.variables.q === OPEN_SEARCH ? new GhError('failed', 'HTTP 502') : undefined;
    expect((await service.refresh()).status).toBe('error');
    fake.override = null;
    clock = NOW + 2 * 60 * 60_000;
    await service.refresh();
    expect(closedSearches(fake).slice(1)).toEqual([
      'is:pr author:@me is:closed updated:>=2026-11-23T11:50:00Z sort:updated-desc',
      'is:pr author:@me is:closed updated:>=2026-11-23T11:50:00Z sort:updated-desc',
    ]);
  });

  test('a clock that gives no date is an error, and nothing is asked', async () => {
    let clock = NOW;
    const fake = fakeGitHub();
    const service = createPrService(fake.runner, () => clock);
    clock = Number.NaN;
    await service.refresh();
    const asked = fake.requests.length;
    clock = NOW;
    const snapshot = await service.refresh();
    expect(snapshot).toMatchObject({ status: 'error', message: 'The clock gave no usable date' });
    expect(fake.requests).toHaveLength(asked);
  });
});

describe('progress', () => {
  const person = (login: string) => ({ __typename: 'User', login });
  const bot = { __typename: 'Bot', login: 'sonarqubecloud' };

  async function progressOf(overrides: Node) {
    const fake = fakeGitHub({ open: [prNode(overrides)] });
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
      commits: {
        nodes: [
          {
            commit: {
              committedDate: '2026-11-13T20:40:00Z',
              statusCheckRollup: { state: 'ERROR' },
            },
          },
        ],
      },
    });
    expect(progress).toMatchObject({
      decision: 'changes-requested',
      unresolvedThreads: 2,
      pendingReviewers: 2,
      checks: 'failure',
      headCommittedAt: '2026-11-13T20:40:00Z',
      conflicting: true,
    });
  });

  test('no checks and an unknown decision read as null', async () => {
    const progress = await progressOf({
      reviewDecision: 'SOMETHING_NEW',
      commits: { nodes: [{ commit: { committedDate: null, statusCheckRollup: null } }] },
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
    const fake = fakeGitHub({ open: [prNode()], review: [theirs] });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const byNumber = new Map(snapshot.prs.map((pr) => [pr.number, pr]));
    expect(byNumber.get(752)).toMatchObject({ reviewRequested: true, author: 'SerhatG' });
    expect(byNumber.get(1)).toMatchObject({ reviewRequested: false, author: 'JornC' });
  });
});

describe('paging', () => {
  test('follows the cursor GitHub gave', async () => {
    const fake = fakeGitHub({ open: many(150) });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const open = searches(fake).filter((r) => r.variables.q === OPEN_SEARCH);
    expect(open.map((r) => r.variables.after)).toEqual([null, 'Y3Vy100']);
    expect(snapshot.prs).toHaveLength(150);
    expect(snapshot.capped).toBe(false);
  });

  test('refuses a flag-shaped cursor and asks for no next page', async () => {
    const fake = fakeGitHub();
    fake.override = (request) =>
      request.variables.q === OPEN_SEARCH
        ? JSON.stringify({
            data: {
              viewer: { login: 'JornC' },
              search: { pageInfo: { hasNextPage: true, endCursor: '--x' }, nodes: [] },
            },
          })
        : undefined;
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(fake.requests).toHaveLength(3);
    expect(snapshot.status).toBe('error');
  });

  test('stops at 300 open PRs and says so', async () => {
    const fake = fakeGitHub({ open: many(350) });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(searches(fake).filter((r) => r.variables.q === OPEN_SEARCH)).toHaveLength(3);
    expect(snapshot.prs).toHaveLength(300);
    expect(snapshot.capped).toBe(true);
  });

  test('stops at 300 closed PRs without calling the list capped', async () => {
    const fake = fakeGitHub({ closed: many(350, 1, closedNode) });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(searches(fake).filter((r) => r.query === CLOSED_QUERY)).toHaveLength(3);
    expect(snapshot.prs).toHaveLength(300);
    expect(snapshot.capped).toBe(false);
  });
});

describe('refresh', () => {
  test('two at once run gh once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = fakeGitHub({ open: [prNode()] });
    fake.override = (request) => gate.then(() => JSON.stringify(answer(fake.github, request)));
    const service = createPrService(fake.runner, () => NOW);
    const first = service.refresh();
    const second = service.refresh();
    release();
    expect(await first).toBe(await second);
    expect(fake.requests).toHaveLength(4);

    await service.refresh();
    expect(fake.requests).toHaveLength(7);
  });

  test('a good answer sets ok, the viewer and the time', async () => {
    let clock = NOW;
    const fake = fakeGitHub({ open: [prNode({ headRefName: 'feature' })], viewer: 'JornC' });
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
        headCommittedAt: null,
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
      const fake = fakeGitHub({ open: [prNode()] });
      const service = createPrService(fake.runner, () => clock);
      const good = await service.refresh();
      clock = NOW + 60_000;
      fake.override = (request) => (request.variables.q === OPEN_SEARCH ? error : undefined);
      const failed = await service.refresh();
      expect(failed).toMatchObject({ status, message });
      expect(failed.prs).toEqual(good.prs);
      expect(failed.checkedAt).toBe(NOW);
      expect(failed.viewer).toBe('JornC');
      expect(warnings()).toHaveLength(1);
    });
  }

  test('a failed detail read keeps the snapshot, is not retried, and the next refresh reads only what is missing', async () => {
    let clock = NOW;
    const fake = fakeGitHub({ open: many(3) });
    const service = createPrService(fake.runner, () => clock);
    const good = await service.refresh();
    for (let number = 1; number <= 15; number++) {
      if (number <= 3) edit(fake.github.open, number, { updatedAt: '2026-11-23T11:00:00Z' });
      else fake.github.open.push(prNode({ number }));
    }
    fake.override = (request) =>
      isDetail(request) && numbersOf(request).includes(1)
        ? new GhError('failed', 'HTTP 502')
        : undefined;
    fake.requests.length = 0;
    clock = NOW + 60_000;
    const failed = await service.refresh();
    expect(failed).toMatchObject({ status: 'error', message: 'HTTP 502', checkedAt: NOW });
    expect(failed.prs).toEqual(good.prs);
    expect(details(fake).map(numbersOf)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12, 13, 14, 15],
    ]);

    fake.override = null;
    fake.requests.length = 0;
    const next = await service.refresh();
    expect(next.status).toBe('ok');
    expect(details(fake).map(numbersOf)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    expect(next.prs).toHaveLength(15);
  });

  test('no detail request starts after one failed', async () => {
    const fake = fakeGitHub({ open: many(60) });
    fake.override = (request) =>
      isDetail(request) ? new GhError('failed', 'HTTP 502') : undefined;
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    // The three that started side by side, and none after.
    expect(details(fake)).toHaveLength(3);
  });

  test('text that is not JSON is an error', async () => {
    const fake = fakeGitHub();
    fake.override = () => '<html>rate limited</html>';
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    expect(snapshot.message).toContain('not JSON');
  });

  test('an answer of the wrong shape is an error', async () => {
    const fake = fakeGitHub({ open: [prNode({ number: 'one' })] });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    expect(snapshot.prs).toEqual([]);
  });

  test('a PR without its head commit is refused', async () => {
    const fake = fakeGitHub({ open: [prNode({ headRefOid: null })] });
    expect((await createPrService(fake.runner, () => NOW).refresh()).status).toBe('error');
  });

  test('a url that is not https is refused', async () => {
    const fake = fakeGitHub({ open: [prNode({ url: 'javascript:alert(1)' })] });
    expect((await createPrService(fake.runner, () => NOW).refresh()).status).toBe('error');
  });

  test('a repo name that is not owner/name is never sent back', async () => {
    const fake = fakeGitHub({ open: [prNode({ repository: { nameWithOwner: 'a/b/c' } })] });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.status).toBe('error');
    expect(details(fake)).toEqual([]);
  });

  test("GitHub's own error message is kept", async () => {
    const fake = fakeGitHub();
    fake.override = () =>
      JSON.stringify({ data: null, errors: [{ message: 'Something went wrong' }] });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot).toMatchObject({ status: 'error', message: 'Something went wrong' });
  });

  test('maps merged and closed, and keeps a PR in both searches once', async () => {
    const fake = fakeGitHub({
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
    });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    const byNumber = new Map(snapshot.prs.map((pr) => [pr.number, pr]));
    expect(snapshot.prs).toHaveLength(3);
    expect(byNumber.get(5)).toMatchObject({ state: 'closed', body: null });
    expect(byNumber.get(6)).toMatchObject({ state: 'merged', headRefOid: 'f00d' });
    expect(byNumber.get(7)?.headOwner).toBeNull();
  });

  test('sorts open first, then the newest update first', async () => {
    const fake = fakeGitHub({
      open: [
        prNode({ number: 1, updatedAt: '2026-11-01T00:00:00Z' }),
        prNode({ number: 2, updatedAt: '2026-11-10T00:00:00Z' }),
      ],
      closed: [closedNode({ number: 3, updatedAt: '2026-11-22T00:00:00Z' })],
    });
    const snapshot = await createPrService(fake.runner, () => NOW).refresh();
    expect(snapshot.prs.map((pr) => pr.number)).toEqual([2, 1, 3]);
  });
});

describe('checkOne', () => {
  test('reads one PR whole, and the next refresh keeps it without reading it again', async () => {
    const fake = fakeGitHub({ open: many(2) });
    const service = createPrService(fake.runner, () => NOW);
    await service.refresh();
    edit(fake.github.open, 2, { updatedAt: '2026-11-23T11:00:00Z', body: 'Fresh.' });
    fake.requests.length = 0;
    const pr = service.snapshot().prs.find((p) => p.number === 2) as PrInfo;
    expect((await service.checkOne(pr)).body).toBe('Fresh.');
    expect(fake.requests.map((r) => [r.query, r.variables])).toEqual([
      [DETAIL_QUERIES[0], { owner0: 'aerius', name0: 'calculator', number0: 2 }],
    ]);
    fake.requests.length = 0;
    const snapshot = await service.refresh();
    expect(details(fake)).toEqual([]);
    expect(snapshot.prs.find((p) => p.number === 2)?.body).toBe('Fresh.');
  });
});

describe('prFor', () => {
  test('matches the repo case-insensitively and the branch exactly', async () => {
    const fake = fakeGitHub({
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
    });
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
    expect(createPrService(fakeGitHub().runner).ghAvailable()).toBe(true);
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
