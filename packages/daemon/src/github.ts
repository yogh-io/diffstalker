/**
 * The author's pull requests, through `gh` (docs/work-page.md §4).
 *
 * Reads, plus one write: `setTopZone` replaces the top zone of one PR's
 * body, and only when the author presses "Update GitHub". The only command
 * run is `gh api graphql --input -`: a fixed query and its variables go in
 * as JSON on stdin, so the argv never changes. No value from a request is
 * ever sent: the search strings are fixed, the date in the closed search is
 * built from the daemon's own clock and shape-checked, and a page cursor,
 * owner or name comes from GitHub's own answer and is shape-checked.
 *
 * A refresh reads, side by side:
 * - The author's open PRs and the open PRs the author is asked to review,
 *   as light lists: what shows a change, plus CI, conflicts, the decision
 *   and the draft flag. A finished check does not move `updatedAt`.
 * - The details (body, reviewers, reviews, comments, threads) only of a PR
 *   that is new or whose `updatedAt` or head commit moved, ten per request.
 *   The rest keep the details read before.
 * - The closed PRs: the newest 300 on the first refresh, then only those
 *   updated since the last good one, less a margin, merged in. The closed
 *   list has no date window: it is what tells the page a branch is finished
 *   (docs/work-page.md §5.2).
 * Each search stops at MAX_PRS_PER_SEARCH.
 *
 * `gh` runs only on a refresh (POST /work/prs/refresh), single-flight. The
 * answer is cached in memory. A failed refresh keeps the last good list and
 * is not retried: a timed-out request costs GitHub points. The runner is
 * injected: only index.ts makes the real one, so a daemon made without one
 * (every test) acts as if `gh` were missing.
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

/** One deadline for a whole refresh, every request included. */
export const GH_TIMEOUT_MS = 20_000;

const GH_MAX_BUFFER = 32 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_MESSAGE_LENGTH = 200;
/** PRs per detail request. */
export const DETAIL_BATCH = 10;
const DETAIL_REQUESTS_AT_ONCE = 3;
/** The closed search looks this far back past the last good refresh: GitHub's index lags. */
export const CLOSED_MARGIN_MS = 10 * 60 * 1000;

/** The whole argv of every `gh` run. */
export const GH_ARGS: readonly string[] = ['api', 'graphql', '--input', '-'];

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

/** An open PR, light: what shows a change, and what changes without moving `updatedAt`. */
const LIVE_FIELDS = `${CLOSED_FIELDS}
      reviewDecision mergeable
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }`;

/** The costly part of an open PR, read only when it changed. */
const DETAIL_FIELDS = `body
      reviewRequests(first: 20) { totalCount nodes { requestedReviewer {
        __typename ... on User { login } ... on Team { slug } } } }
      latestOpinionatedReviews(first: 20) { nodes { ${AUTHOR} state } }
      reviews(last: 20) { nodes { ${AUTHOR} state submittedAt } }
      comments(last: 20) { nodes { ${AUTHOR} createdAt } }
      reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { ${AUTHOR} createdAt } } } }`;

/** A whole PR, with the node id the write needs. */
const PR_FRAGMENT = `fragment Pr on PullRequest { id ${LIVE_FIELDS}
      ${DETAIL_FIELDS} }`;

function searchQuery(fields: string, withViewer: boolean): string {
  return `query($q: String!, $after: String) {${withViewer ? '\n  viewer { login }' : ''}
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${fields} } }
  }
}`;
}

/** The open and the review-request search. Also asks who `gh` is logged in as. */
export const LIVE_QUERY = searchQuery(LIVE_FIELDS, true);
export const CLOSED_QUERY = searchQuery(CLOSED_FIELDS, false);

/** `size` whole PRs by owner, name and number, as p0, p1, …. */
function detailQuery(size: number): string {
  const slots = Array.from({ length: size }, (_, i) => i);
  const params = slots.map((i) => `$owner${i}: String!, $name${i}: String!, $number${i}: Int!`);
  const reads = slots.map(
    (i) =>
      `  p${i}: repository(owner: $owner${i}, name: $name${i}) { pullRequest(number: $number${i}) { ...Pr } }`
  );
  return `query(${params.join(', ')}) {\n${reads.join('\n')}\n}\n${PR_FRAGMENT}`;
}

/** One fixed text per batch size; the first reads one PR. */
export const DETAIL_QUERIES: readonly string[] = Array.from({ length: DETAIL_BATCH }, (_, i) =>
  detailQuery(i + 1)
);

/** The one write: a PR's whole body. setTopZone builds it from GitHub's own lower zone. */
export const UPDATE_BODY_MUTATION = `mutation($id: ID!, $body: String!) {
  updatePullRequest(input: { pullRequestId: $id, body: $body }) { pullRequest { ...Pr } }
}
${PR_FRAGMENT}`;

export const OPEN_SEARCH = 'is:pr author:@me is:open';
/** Open PRs the `gh` account is asked to review: usually someone else's. */
export const REVIEW_SEARCH = 'is:pr is:open review-requested:@me';
export const CLOSED_SEARCH = 'is:pr author:@me is:closed sort:updated-desc';

const SEARCH_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The closed search for what changed since `since`, less the margin. Built from a number only. */
function closedSinceSearch(since: number): string {
  const at = new Date(since - CLOSED_MARGIN_MS);
  const two = (n: number) => String(n).padStart(2, '0');
  const date =
    `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}` +
    `T${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())}Z`;
  if (!SEARCH_DATE.test(date)) throw new GhError('failed', 'The clock gave no usable date');
  return `is:pr author:@me is:closed updated:>=${date} sort:updated-desc`;
}

/** A GraphQL cursor as GitHub writes them; never flag-shaped. */
const CURSOR = /^[A-Za-z0-9+/=_:][A-Za-z0-9+/=_:-]{0,199}$/;
const OWNER_AND_NAME = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

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

/** The head commit: when it was made, and its combined checks. */
function headOf(rec: Json): { committedAt: string | null; checks: PrChecks | null } {
  const last = nodesOf(rec, 'commits')[0];
  if (last === undefined) return { committedAt: null, checks: null };
  const commit = record(record(last, 'commit node').commit, 'commit');
  const rollup = commit.statusCheckRollup;
  const checks =
    rollup === null ? null : (CHECKS[text(record(rollup, 'statusCheckRollup'), 'state')] ?? null);
  return { committedAt: textOrNull(commit, 'committedDate'), checks };
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

/** The progress a light list carries. */
type LiveProgress = Pick<PrProgress, 'decision' | 'checks' | 'headCommittedAt' | 'conflicting'>;

/** An open PR as a light list has it. */
interface LivePr {
  pr: PrInfo;
  live: LiveProgress;
}

/** A PR read whole. */
type FullPr = PrInfo & { body: string; progress: PrProgress };

function parseLive(rec: Json): LiveProgress {
  const decision = textOrNull(rec, 'reviewDecision');
  const head = headOf(rec);
  return {
    decision: decision === null ? null : (DECISION[decision] ?? null),
    checks: head.checks,
    headCommittedAt: head.committedAt,
    conflicting: text(rec, 'mergeable') === 'CONFLICTING',
  };
}

function parseProgress(rec: Json): PrProgress {
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
    ...parseLive(rec),
    unresolvedThreads: threads.unresolved,
    pendingReviewers: pending,
    requestedReviewers: requested,
    changesRequestedBy: changesRequestedBy(rec),
    events: newestEvents([...reviewEvents(rec), ...comments, ...threads.events]),
  };
}

/** What every search reads; no body, no progress. */
function parseBase(node: unknown): PrInfo {
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
    body: null,
    headRefName: text(rec, 'headRefName'),
    headRefOid: text(rec, 'headRefOid'),
    baseRefName: text(rec, 'baseRefName'),
    progress: null,
    headOwner: owner,
    author: rec.author === null ? null : text(record(rec.author, 'author'), 'login'),
    reviewRequested: false,
    repo,
    repoKey: repo.toLowerCase(),
  };
}

function parseLivePr(node: unknown): LivePr {
  return { pr: parseBase(node), live: parseLive(record(node, 'pull request')) };
}

/** The node id and the whole PR. */
function parseFull(node: unknown): { id: string; pr: FullPr } {
  const rec = record(node, 'pull request');
  return {
    id: text(rec, 'id'),
    pr: { ...parseBase(rec), body: text(rec, 'body'), progress: parseProgress(rec) },
  };
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parsePage<T>(value: unknown, parse: (node: unknown) => T): Page<T> {
  const page = record(value, 'search');
  const info = record(page.pageInfo, 'pageInfo');
  if (!Array.isArray(page.nodes)) throw shapeError('nodes');
  return {
    items: page.nodes.map(parse),
    hasNextPage: flag(info, 'hasNextPage'),
    endCursor: textOrNull(info, 'endCursor'),
  };
}

/** One fixed query with its variables on stdin; the answer's `data`. */
async function ask(
  runner: GhRunner,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number
): Promise<Json> {
  const input = JSON.stringify({ query, variables });
  return dataOf(parseJson(await runner.run(GH_ARGS, timeoutMs, input)));
}

type Remaining = () => number;

/** A search's pages, up to MAX_PRS_PER_SEARCH, and its first answer. */
async function collect<T>(
  runner: GhRunner,
  query: string,
  search: string,
  parse: (node: unknown) => T,
  remaining: Remaining
): Promise<{ items: T[]; capped: boolean; first: Json }> {
  const items: T[] = [];
  let first: Json | undefined;
  let after: string | null = null;
  for (;;) {
    const data = await ask(runner, query, { q: search, after }, remaining());
    first ??= data;
    const page = parsePage(data.search, parse);
    items.push(...page.items);
    if (!page.hasNextPage || items.length >= MAX_PRS_PER_SEARCH) {
      return { items: items.slice(0, MAX_PRS_PER_SEARCH), capped: page.hasNextPage, first };
    }
    if (page.endCursor === null || !CURSOR.test(page.endCursor)) throw shapeError('endCursor');
    after = page.endCursor;
  }
}

/** `owner/name`, GitHub's own spelling, checked before it goes back. */
function ownerAndName(pr: PrInfo): { owner: string; name: string } {
  const match = OWNER_AND_NAME.exec(pr.repo);
  if (match === null) throw shapeError('nameWithOwner');
  return { owner: match[1], name: match[2] };
}

/** Whole PRs, one to DETAIL_BATCH, in the order asked. */
async function readFull(
  runner: GhRunner,
  prs: readonly PrInfo[],
  timeoutMs: number
): Promise<Array<{ id: string; pr: FullPr }>> {
  const variables: Record<string, string | number> = {};
  prs.forEach((pr, i) => {
    const { owner, name } = ownerAndName(pr);
    variables[`owner${i}`] = owner;
    variables[`name${i}`] = name;
    variables[`number${i}`] = pr.number;
  });
  const data = await ask(runner, DETAIL_QUERIES[prs.length - 1], variables, timeoutMs);
  return prs.map((_, i) => {
    const node = record(data[`p${i}`], 'repository').pullRequest;
    if (node === null) throw new GhError('failed', 'GitHub no longer has this PR');
    return parseFull(node);
  });
}

function keyOf(pr: PrInfo): string {
  return `${pr.repoKey}#${pr.number}`;
}

/** The details read before still fit: the PR did not move since. */
function isCurrent(full: FullPr | undefined, pr: PrInfo): full is FullPr {
  return full !== undefined && full.updatedAt === pr.updatedAt && full.headRefOid === pr.headRefOid;
}

/**
 * Read these PRs whole into `details`, DETAIL_BATCH per request. A batch
 * that arrived stays even when another fails; no batch starts after one failed.
 */
async function readDetails(
  runner: GhRunner,
  prs: readonly PrInfo[],
  details: Map<string, FullPr>,
  remaining: Remaining
): Promise<void> {
  const batches: PrInfo[][] = [];
  for (let i = 0; i < prs.length; i += DETAIL_BATCH) batches.push(prs.slice(i, i + DETAIL_BATCH));
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < batches.length) {
      const batch = batches[next++];
      try {
        const read = await readFull(runner, batch, remaining());
        read.forEach((full, i) => details.set(keyOf(batch[i]), full.pr));
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(DETAIL_REQUESTS_AT_ONCE, batches.length) }, worker);
  const failure = (await Promise.allSettled(workers)).find((r) => r.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
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

/** One copy per PR: the newer answer, or the first on a tie. */
function dedupe(prs: PrInfo[]): PrInfo[] {
  const byKey = new Map<string, PrInfo>();
  for (const pr of prs) {
    const key = keyOf(pr);
    const seen = byKey.get(key);
    if (seen === undefined || Date.parse(pr.updatedAt) > Date.parse(seen.updatedAt))
      byKey.set(key, pr);
  }
  return [...byKey.values()];
}

interface Live {
  prs: PrInfo[];
  viewer: string;
  capped: boolean;
  /** How many PRs were read whole. */
  read: number;
}

/** The two light lists, each PR with its details: kept when it did not move, else read. */
async function fetchLive(
  runner: GhRunner,
  details: Map<string, FullPr>,
  remaining: Remaining
): Promise<Live> {
  const [open, review] = await Promise.all([
    collect(runner, LIVE_QUERY, OPEN_SEARCH, parseLivePr, remaining),
    collect(runner, LIVE_QUERY, REVIEW_SEARCH, parseLivePr, remaining),
  ]);
  const asked = review.items.map(({ pr, live }) => ({
    pr: { ...pr, reviewRequested: true },
    live,
  }));
  const all = [...open.items, ...asked];
  const moved = new Map<string, PrInfo>();
  for (const { pr } of all) {
    if (!isCurrent(details.get(keyOf(pr)), pr)) moved.set(keyOf(pr), pr);
  }
  await readDetails(runner, [...moved.values()], details, remaining);
  const prs = all.map(({ pr, live }): PrInfo => {
    const full = details.get(keyOf(pr));
    if (full === undefined) throw shapeError('details');
    return { ...pr, body: full.body, progress: { ...full.progress, ...live } };
  });
  return {
    prs,
    viewer: text(record(open.first.viewer, 'viewer'), 'login'),
    capped: open.capped,
    read: moved.size,
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

/** The closed list of the last good refresh, and when that refresh started. */
interface ClosedCache {
  prs: PrInfo[];
  since: number;
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
  /** The last whole read of each open PR. */
  const details = new Map<string, FullPr>();
  let closed: ClosedCache | null = null;

  async function fetchAll(gh: GhRunner): Promise<PrSnapshot> {
    const started = now();
    const closedSearch = closed === null ? CLOSED_SEARCH : closedSinceSearch(closed.since);
    const deadline = performance.now() + GH_TIMEOUT_MS;
    const remaining = (): number => {
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) throw new GhError('failed', 'gh timed out');
      return left;
    };
    const [live, answer] = await Promise.all([
      fetchLive(gh, details, remaining),
      collect(gh, CLOSED_QUERY, closedSearch, parseBase, remaining),
    ]);
    const closedPrs = dedupe([...answer.items, ...(closed?.prs ?? [])])
      .sort(comparePrs)
      .slice(0, MAX_PRS_PER_SEARCH);
    closed = { prs: closedPrs, since: started };
    const keep = new Set(live.prs.map(keyOf));
    for (const key of details.keys()) if (!keep.has(key)) details.delete(key);
    logDebug('PR refresh', undefined, { readWhole: live.read, closedFound: answer.items.length });
    return {
      status: 'ok',
      message: null,
      checkedAt: now(),
      viewer: live.viewer,
      // A PR closed mid-run is in both lists: the newer answer wins.
      prs: dedupe([...live.prs, ...closedPrs]).sort(comparePrs),
      capped: live.capped,
    };
  }

  async function run(): Promise<PrSnapshot> {
    if (runner === null) {
      current = { ...current, status: 'gh-missing', message: null };
      return current;
    }
    try {
      current = await fetchAll(runner);
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

  /** Put a fresh whole PR in the cached list, in place of the old one. */
  function store(fresh: FullPr): PrInfo {
    details.set(keyOf(fresh), fresh);
    const same = (pr: PrInfo) => keyOf(pr) === keyOf(fresh);
    const prs = current.prs.some(same)
      ? current.prs.map((pr) => (same(pr) ? fresh : pr))
      : [fresh, ...current.prs];
    current = { ...current, prs: prs.sort(comparePrs) };
    return fresh;
  }

  async function readOne(pr: PrInfo): Promise<{ id: string; pr: FullPr }> {
    if (runner === null) throw new GhError('missing', 'gh not found');
    const [fresh] = await readFull(runner, [pr], GH_TIMEOUT_MS);
    return fresh;
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
      if (topZoneOf(fresh.pr.body) !== normalizeBody(expectedTop)) throw new TopZoneChangedError();
      const data = await ask(
        runner as GhRunner,
        UPDATE_BODY_MUTATION,
        { id: fresh.id, body: replaceTopZone(fresh.pr.body, top) },
        GH_TIMEOUT_MS
      );
      const node = record(data.updatePullRequest, 'updatePullRequest').pullRequest;
      logDebug('PR top zone updated', undefined, { pr: `${fresh.pr.repo}#${fresh.pr.number}` });
      return store(parseFull(node).pr);
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
