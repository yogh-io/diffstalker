/**
 * The author's pull requests, through `gh` (docs/work-page.md §4).
 *
 * Reads, plus one write: `setTopZone` replaces the top zone of one PR's
 * body, and only when the author presses "Update GitHub". The only command
 * run is `gh api graphql` with a fixed query. No value from a request ever
 * becomes an argument: the search strings are fixed, a page cursor comes
 * from GitHub's own answer and is shape-checked, and the one-PR read and
 * the write send their variables as JSON on stdin (`--input -`). Search
 * variables go in with `-f` (raw text), never `-F`, which reads `@file`
 * and types values.
 *
 * Three searches, side by side: the author's open PRs, every closed one
 * (newest update first), and the open PRs the author is asked to review.
 * The closed list has no date window, because it is what tells the page a
 * branch is finished (docs/work-page.md §5.2). Each stops at
 * MAX_PRS_PER_SEARCH.
 *
 * `gh` runs only on a refresh (POST /work/prs/refresh), single-flight. The
 * answer is cached in memory; a failed refresh keeps the last good list.
 * The runner is injected: only index.ts makes the real one, so a daemon
 * made without one (every test) acts as if `gh` were missing.
 */

import { execFile } from 'node:child_process';
import {
  warn as logWarn,
  error as logError,
  debug as logDebug,
} from '@diffstalker/core/utils/logger';
import { normalizeBody, replaceTopZone, topZoneOf } from '@diffstalker/core/view/prBody';
import {
  MAX_PRS_PER_SEARCH,
  PR_EVENTS_MAX,
  type PrChecks,
  type PrEvent,
  type PrEventKind,
  type PrInfo,
  type PrProgress,
  type PrReviewDecision,
  type PrSnapshot,
  type PrSnapshotStatus,
  type PrState,
} from '@diffstalker/core/types/work';
import { systemProbe } from './install.js';

/** One deadline for a whole refresh, every page included. */
export const GH_TIMEOUT_MS = 20_000;

const GH_MAX_BUFFER = 32 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_MESSAGE_LENGTH = 200;

export type GhErrorKind = 'missing' | 'logged-out' | 'failed';

export class GhError extends Error {
  constructor(
    readonly kind: GhErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'GhError';
  }
}

export interface GhRunner {
  /** `gh` is on PATH. A lookup, never a spawn. */
  available(): boolean;
  /** Run `gh <args>`, with `input` on stdin when given; stdout as text. Rejects with GhError. */
  run(args: readonly string[], timeoutMs: number, input?: string): Promise<string>;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, MAX_MESSAGE_LENGTH);
}

/** The real one. Only index.ts calls this. */
export function createGhRunner(): GhRunner {
  return {
    available: () => systemProbe.onPath(['gh']) !== null,
    run: (args, timeoutMs, input) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          'gh',
          [...args],
          {
            timeout: timeoutMs,
            maxBuffer: GH_MAX_BUFFER,
            windowsHide: true,
            encoding: 'utf8',
            env: {
              ...process.env,
              GH_PROMPT_DISABLED: '1',
              GH_NO_UPDATE_NOTIFIER: '1',
              NO_COLOR: '1',
            },
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve(stdout);
            } else if (error.code === 'ENOENT') {
              reject(new GhError('missing', 'gh not found'));
            } else if (error.code === 4) {
              reject(new GhError('logged-out', 'gh is not logged in'));
            } else if (error.killed) {
              reject(new GhError('failed', 'gh timed out'));
            } else {
              reject(new GhError('failed', firstLine(stderr) ?? `gh failed (exit ${error.code})`));
            }
          }
        );
        child.stdin?.end(input ?? '');
      }),
  };
}

const AUTHOR = 'author { __typename login }';

const CLOSED_FIELDS = `number title url state isDraft merged mergedAt closedAt updatedAt
      headRefName headRefOid baseRefName ${AUTHOR}
      headRepositoryOwner { login }
      repository { nameWithOwner }`;

/**
 * Only an open PR's body is compared with a draft, and only an open PR's
 * progress is shown, so only the open search reads them.
 */
const OPEN_FIELDS = `${CLOSED_FIELDS}
      body reviewDecision mergeable
      reviewRequests(first: 20) { totalCount nodes { requestedReviewer {
        __typename ... on User { login } ... on Team { slug } } } }
      latestOpinionatedReviews(first: 20) { nodes { ${AUTHOR} state } }
      reviews(last: 20) { nodes { ${AUTHOR} state submittedAt } }
      comments(last: 20) { nodes { ${AUTHOR} createdAt } }
      reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { ${AUTHOR} createdAt } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

function pageFields(fields: string): string {
  return `pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${fields} } }`;
}

/** One search, for the pages after the first. */
function pageQuery(fields: string): string {
  return `query($q: String!, $after: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) { ${pageFields(fields)} }
}`;
}

/**
 * The first page of a search. The open one also asks who `gh` is logged in
 * as. The two run as separate requests, side by side: in one request they
 * passed GitHub's 10 s limit and came back as a 502.
 */
function firstQuery(fields: string, withViewer: boolean): string {
  return `query($q: String!) {${withViewer ? '\n  viewer { login }' : ''}
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}) { ${pageFields(fields)} }
}`;
}

export const OPEN_FIRST_QUERY = firstQuery(OPEN_FIELDS, true);
export const CLOSED_FIRST_QUERY = firstQuery(CLOSED_FIELDS, false);
export const OPEN_PAGE_QUERY = pageQuery(OPEN_FIELDS);
export const CLOSED_PAGE_QUERY = pageQuery(CLOSED_FIELDS);

/** One PR, fresh, with everything the open search reads plus its node id. */
export const PR_ONE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id ${OPEN_FIELDS} } }
}`;

/** The one write: a PR's whole body. setTopZone builds it from GitHub's own lower zone. */
export const UPDATE_BODY_MUTATION = `mutation($id: ID!, $body: String!) {
  updatePullRequest(input: { pullRequestId: $id, body: $body }) { pullRequest { id ${OPEN_FIELDS} } }
}`;

export const OPEN_SEARCH = 'is:pr author:@me is:open';
/** Open PRs the `gh` account is asked to review: usually someone else's. */
export const REVIEW_SEARCH = 'is:pr is:open review-requested:@me';
export const CLOSED_SEARCH = 'is:pr author:@me is:closed sort:updated-desc';

interface Search {
  text: string;
  firstQuery: string;
  pageQuery: string;
  withBody: boolean;
}

const OPEN: Search = {
  text: OPEN_SEARCH,
  firstQuery: OPEN_FIRST_QUERY,
  pageQuery: OPEN_PAGE_QUERY,
  withBody: true,
};
export const REVIEW_FIRST_QUERY = firstQuery(OPEN_FIELDS, false);
const REVIEW: Search = {
  text: REVIEW_SEARCH,
  firstQuery: REVIEW_FIRST_QUERY,
  pageQuery: OPEN_PAGE_QUERY,
  withBody: true,
};
const CLOSED: Search = {
  text: CLOSED_SEARCH,
  firstQuery: CLOSED_FIRST_QUERY,
  pageQuery: CLOSED_PAGE_QUERY,
  withBody: false,
};

/** A GraphQL cursor as GitHub writes them; never flag-shaped. */
const CURSOR = /^[A-Za-z0-9+/=_:][A-Za-z0-9+/=_:-]{0,199}$/;

function shapeError(what: string): GhError {
  return new GhError('failed', `GitHub answered in an unexpected shape (${what})`);
}

type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shapeError(what);
  return value as Json;
}

function text(rec: Json, key: string): string {
  const value = rec[key];
  if (typeof value !== 'string') throw shapeError(key);
  return value;
}

function textOrNull(rec: Json, key: string): string | null {
  const value = rec[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw shapeError(key);
  return value;
}

function flag(rec: Json, key: string): boolean {
  const value = rec[key];
  if (typeof value !== 'boolean') throw shapeError(key);
  return value;
}

function parseJson(stdout: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GhError('failed', 'gh answered with something that is not JSON');
  }
  return record(value, 'answer');
}

/** The `data` of a GraphQL answer, or GitHub's own error message. */
function dataOf(answer: Json): Json {
  if (answer.data !== null && answer.data !== undefined) return record(answer.data, 'data');
  const errors = answer.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = (errors[0] as { message?: unknown } | null)?.message;
    if (typeof message === 'string')
      throw new GhError('failed', message.slice(0, MAX_MESSAGE_LENGTH));
  }
  throw shapeError('data');
}

function prState(rec: Json): PrState {
  const state = text(rec, 'state');
  if (flag(rec, 'merged') || state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'OPEN') return 'open';
  throw shapeError('state');
}

function nodesOf(rec: Json, key: string): unknown[] {
  const nodes = record(rec[key], key).nodes;
  if (!Array.isArray(nodes)) throw shapeError(`${key}.nodes`);
  return nodes;
}

/** The login of a person; null for a bot or a deleted account. */
function personOf(rec: Json): string | null {
  if (rec.author === null) return null;
  const author = record(rec.author, 'author');
  if (author.__typename === 'Bot') return null;
  return text(author, 'login');
}

const REVIEW_KIND: Record<string, PrEventKind> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'reviewed',
};

function reviewEvents(rec: Json): PrEvent[] {
  const events: PrEvent[] = [];
  for (const node of nodesOf(rec, 'reviews')) {
    const review = record(node, 'review');
    // PENDING is an unsent review; DISMISSED no longer counts.
    const kind = REVIEW_KIND[text(review, 'state')];
    const at = textOrNull(review, 'submittedAt');
    const author = personOf(review);
    if (kind !== undefined && at !== null && author !== null) events.push({ kind, author, at });
  }
  return events;
}

function commentEvent(node: unknown): PrEvent | null {
  const comment = record(node, 'comment');
  const author = personOf(comment);
  return author === null ? null : { kind: 'commented', author, at: text(comment, 'createdAt') };
}

/** The last comment of every thread, plus how many threads are open. */
function threadFacts(rec: Json): { events: PrEvent[]; unresolved: number } {
  const events: PrEvent[] = [];
  let unresolved = 0;
  for (const node of nodesOf(rec, 'reviewThreads')) {
    const thread = record(node, 'review thread');
    if (!flag(thread, 'isResolved')) unresolved += 1;
    for (const comment of nodesOf(thread, 'comments')) {
      const event = commentEvent(comment);
      if (event !== null) events.push(event);
    }
  }
  return { events, unresolved };
}

/** Newest first; one review with inline comments is one event per kind and minute. */
function newestEvents(events: PrEvent[]): PrEvent[] {
  const seen = new Set<string>();
  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((event) => {
      const key = `${event.kind}|${event.author}|${event.at.slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, PR_EVENTS_MAX);
}

const DECISION: Record<string, PrReviewDecision> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

const CHECKS: Record<string, PrChecks> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

function checksOf(rec: Json): PrChecks | null {
  const last = nodesOf(rec, 'commits')[0];
  if (last === undefined) return null;
  const rollup = record(record(last, 'commit node').commit, 'commit').statusCheckRollup;
  if (rollup === null) return null;
  return CHECKS[text(record(rollup, 'statusCheckRollup'), 'state')] ?? null;
}

/** A requested reviewer: a login, `team:<slug>`, or null for a kind GitHub may add. */
function reviewerOf(node: unknown): string | null {
  const reviewer = record(node, 'review request').requestedReviewer;
  if (reviewer === null) return null;
  const rec = record(reviewer, 'requestedReviewer');
  if (typeof rec.login === 'string') return rec.login;
  if (typeof rec.slug === 'string') return `team:${rec.slug}`;
  return null;
}

/** Reviewers whose latest review that approves or not asks for changes. */
function changesRequestedBy(rec: Json): string[] {
  const out: string[] = [];
  for (const node of nodesOf(rec, 'latestOpinionatedReviews')) {
    const review = record(node, 'review');
    const author = personOf(review);
    if (author !== null && text(review, 'state') === 'CHANGES_REQUESTED') out.push(author);
  }
  return out;
}

function parseProgress(rec: Json): PrProgress {
  const decision = textOrNull(rec, 'reviewDecision');
  const threads = threadFacts(rec);
  const requests = record(rec.reviewRequests, 'reviewRequests');
  const pending = requests.totalCount;
  if (typeof pending !== 'number') throw shapeError('reviewRequests.totalCount');
  const requested = nodesOf(rec, 'reviewRequests')
    .map(reviewerOf)
    .filter((reviewer) => reviewer !== null);
  const comments = nodesOf(rec, 'comments')
    .map(commentEvent)
    .filter((event) => event !== null);
  return {
    decision: decision === null ? null : (DECISION[decision] ?? null),
    unresolvedThreads: threads.unresolved,
    pendingReviewers: pending,
    requestedReviewers: requested,
    changesRequestedBy: changesRequestedBy(rec),
    checks: checksOf(rec),
    conflicting: text(rec, 'mergeable') === 'CONFLICTING',
    events: newestEvents([...reviewEvents(rec), ...comments, ...threads.events]),
  };
}

function parsePr(node: unknown, withBody: boolean): PrInfo {
  const rec = record(node, 'pull request');
  const number = rec.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1)
    throw shapeError('number');
  const url = text(rec, 'url');
  // It becomes a link on the page.
  if (!url.startsWith('https://')) throw shapeError('url');
  const owner =
    rec.headRepositoryOwner === null
      ? null
      : text(record(rec.headRepositoryOwner, 'headRepositoryOwner'), 'login');
  const repo = text(record(rec.repository, 'repository'), 'nameWithOwner');
  return {
    number,
    title: text(rec, 'title'),
    url,
    state: prState(rec),
    isDraft: flag(rec, 'isDraft'),
    mergedAt: textOrNull(rec, 'mergedAt'),
    closedAt: textOrNull(rec, 'closedAt'),
    updatedAt: text(rec, 'updatedAt'),
    body: withBody ? text(rec, 'body') : null,
    headRefName: text(rec, 'headRefName'),
    headRefOid: text(rec, 'headRefOid'),
    baseRefName: text(rec, 'baseRefName'),
    progress: withBody ? parseProgress(rec) : null,
    headOwner: owner,
    author: rec.author === null ? null : text(record(rec.author, 'author'), 'login'),
    reviewRequested: false,
    repo,
    repoKey: repo.toLowerCase(),
  };
}

interface Page {
  prs: PrInfo[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parsePage(value: unknown, search: Search): Page {
  const page = record(value, 'search');
  const info = record(page.pageInfo, 'pageInfo');
  if (!Array.isArray(page.nodes)) throw shapeError('nodes');
  return {
    prs: page.nodes.map((node) => parsePr(node, search.withBody)),
    hasNextPage: flag(info, 'hasNextPage'),
    endCursor: textOrNull(info, 'endCursor'),
  };
}

type Remaining = () => number;

/** Run one query of a search; the answer's `data`. */
async function ask(
  runner: GhRunner,
  query: string,
  search: Search,
  remaining: Remaining,
  after?: string
): Promise<Json> {
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${search.text}`];
  if (after !== undefined) args.push('-f', `after=${after}`);
  return dataOf(parseJson(await runner.run(args, remaining())));
}

/** A search's pages, up to MAX_PRS_PER_SEARCH, and the viewer when the first page asked. */
async function collect(
  runner: GhRunner,
  search: Search,
  remaining: Remaining
): Promise<{ prs: PrInfo[]; capped: boolean; data: Json }> {
  const data = await ask(runner, search.firstQuery, search, remaining);
  let page = parsePage(data.search, search);
  const prs = [...page.prs];
  while (page.hasNextPage && prs.length < MAX_PRS_PER_SEARCH) {
    const cursor = page.endCursor;
    if (cursor === null || !CURSOR.test(cursor)) throw shapeError('endCursor');
    const next = await ask(runner, search.pageQuery, search, remaining, cursor);
    page = parsePage(next.search, search);
    prs.push(...page.prs);
  }
  return { prs: prs.slice(0, MAX_PRS_PER_SEARCH), capped: page.hasNextPage, data };
}

/** Open first, then the newest update first. */
function comparePrs(a: PrInfo, b: PrInfo): number {
  const open = Number(b.state === 'open') - Number(a.state === 'open');
  if (open !== 0) return open;
  const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (updated !== 0 && !Number.isNaN(updated)) return updated;
  if (a.repoKey !== b.repoKey) return a.repoKey < b.repoKey ? -1 : 1;
  return a.number - b.number;
}

/** A PR closed mid-run is in both searches: keep the newer answer. */
function dedupe(prs: PrInfo[]): PrInfo[] {
  const byKey = new Map<string, PrInfo>();
  for (const pr of prs) {
    const key = `${pr.repoKey}#${pr.number}`;
    const seen = byKey.get(key);
    if (seen === undefined || Date.parse(pr.updatedAt) > Date.parse(seen.updatedAt))
      byKey.set(key, pr);
  }
  return [...byKey.values()];
}

interface Fetched {
  prs: PrInfo[];
  viewer: string;
  capped: boolean;
}

async function fetchPrs(runner: GhRunner): Promise<Fetched> {
  const deadline = performance.now() + GH_TIMEOUT_MS;
  const remaining = (): number => {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new GhError('failed', 'gh timed out');
    return left;
  };
  const [open, closed, review] = await Promise.all([
    collect(runner, OPEN, remaining),
    collect(runner, CLOSED, remaining),
    collect(runner, REVIEW, remaining),
  ]);
  const viewer = text(record(open.data.viewer, 'viewer'), 'login');
  const asked = review.prs.map((pr) => ({ ...pr, reviewRequested: true }));
  return {
    prs: dedupe([...open.prs, ...closed.prs, ...asked]).sort(comparePrs),
    viewer,
    // Older closed PRs past the cap only matter as a limit (docs/work-page.md §5.2).
    capped: open.capped,
  };
}

const STATUS_OF: Record<GhErrorKind, PrSnapshotStatus> = {
  missing: 'gh-missing',
  'logged-out': 'gh-logged-out',
  failed: 'error',
};

/** GitHub's top zone is not what the author was shown: someone changed it since. */
export class TopZoneChangedError extends Error {
  constructor() {
    super("The PR's top zone changed on GitHub since it was shown. Check again first.");
    this.name = 'TopZoneChangedError';
  }
}

export interface PrService {
  snapshot(): PrSnapshot;
  /** Single-flight; never rejects. */
  refresh(): Promise<PrSnapshot>;
  prFor(identities: readonly string[], branch: string): PrInfo | null;
  ghAvailable(): boolean;
  /** Read one PR fresh and put it in the cached list. Rejects with GhError. */
  checkOne(pr: PrInfo): Promise<PrInfo>;
  /**
   * Replace the top zone of an open PR's body with `top`, keeping the rest
   * as GitHub has it now. `expectedTop` is the top zone the author was
   * shown; when GitHub's differs, nothing is written (TopZoneChangedError).
   * Rejects with GhError when `gh` fails.
   */
  setTopZone(pr: PrInfo, top: string, expectedTop: string): Promise<PrInfo>;
}

/** `owner/name` split; GitHub's own spelling, so it has exactly one slash. */
function ownerAndName(pr: PrInfo): { owner: string; name: string } {
  const [owner, name, ...rest] = pr.repo.split('/');
  if (!owner || !name || rest.length > 0) throw shapeError('nameWithOwner');
  return { owner, name };
}

/** One fixed query with its variables on stdin. */
async function askJson(
  runner: GhRunner,
  query: string,
  variables: Record<string, unknown>
): Promise<Json> {
  const input = JSON.stringify({ query, variables });
  return dataOf(
    parseJson(await runner.run(['api', 'graphql', '--input', '-'], GH_TIMEOUT_MS, input))
  );
}

/** The node id and the PR from a node that carries both. */
function parseWithId(node: unknown): { id: string; pr: PrInfo } {
  const rec = record(node, 'pull request');
  return { id: text(rec, 'id'), pr: parsePr(rec, true) };
}

export function createPrService(runner: GhRunner | null, now: () => number = Date.now): PrService {
  let current: PrSnapshot = {
    status: 'never',
    message: null,
    checkedAt: null,
    viewer: null,
    prs: [],
    capped: false,
  };
  let inflight: Promise<PrSnapshot> | null = null;

  async function run(): Promise<PrSnapshot> {
    if (runner === null) {
      current = { ...current, status: 'gh-missing', message: null };
      return current;
    }
    try {
      const fetched = await fetchPrs(runner);
      current = { status: 'ok', message: null, checkedAt: now(), ...fetched };
    } catch (err) {
      if (err instanceof GhError) {
        logWarn('PR refresh failed', err, { status: STATUS_OF[err.kind] });
        current = {
          ...current,
          status: STATUS_OF[err.kind],
          message: err.kind === 'failed' ? err.message : null,
        };
      } else {
        logError('PR refresh threw', err);
        current = { ...current, status: 'error', message: 'Unexpected failure reading the PRs' };
      }
    }
    return current;
  }

  /** Put a fresh copy of a PR in the cached list, in place of the old one. */
  function store(fresh: PrInfo): PrInfo {
    const same = (pr: PrInfo) => pr.repoKey === fresh.repoKey && pr.number === fresh.number;
    const prs = current.prs.some(same)
      ? current.prs.map((pr) => (same(pr) ? fresh : pr))
      : [fresh, ...current.prs];
    current = { ...current, prs: prs.sort(comparePrs) };
    return fresh;
  }

  async function readOne(pr: PrInfo): Promise<{ id: string; pr: PrInfo }> {
    if (runner === null) throw new GhError('missing', 'gh not found');
    const { owner, name } = ownerAndName(pr);
    const data = await askJson(runner, PR_ONE_QUERY, { owner, name, number: pr.number });
    const node = record(data.repository, 'repository').pullRequest;
    if (node === null) throw new GhError('failed', 'GitHub no longer has this PR');
    return parseWithId(node);
  }

  return {
    snapshot: () => current,
    async checkOne(pr) {
      return store((await readOne(pr)).pr);
    },
    async setTopZone(pr, top, expectedTop) {
      const fresh = await readOne(pr);
      store(fresh.pr);
      if (fresh.pr.state !== 'open') throw new GhError('failed', 'The PR is not open');
      const body = fresh.pr.body ?? '';
      if (topZoneOf(body) !== normalizeBody(expectedTop)) throw new TopZoneChangedError();
      const data = await askJson(runner as GhRunner, UPDATE_BODY_MUTATION, {
        id: fresh.id,
        body: replaceTopZone(body, top),
      });
      const node = record(data.updatePullRequest, 'updatePullRequest').pullRequest;
      logDebug('PR top zone updated', undefined, { pr: `${fresh.pr.repo}#${fresh.pr.number}` });
      return store(parseWithId(node).pr);
    },
    refresh() {
      inflight ??= run().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    prFor(identities, branch) {
      const keys = new Set(identities.map((identity) => identity.toLowerCase()));
      return current.prs.find((pr) => keys.has(pr.repoKey) && pr.headRefName === branch) ?? null;
    },
    ghAvailable: () => runner?.available() ?? false,
  };
}
