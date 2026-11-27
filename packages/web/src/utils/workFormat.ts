/**
 * Words and times for the Work page and the draft panel. An item's time
 * reads as how long ago (`3 days 12 hours ago`), with the date and time on
 * hover (docs/work-page.md §2); the gh line keeps a clock time
 * (`checked 14:02`). Fixed English month and day names, so the page reads
 * the same whatever the browser's locale.
 */

import type {
  PrEventKind,
  PrInfo,
  PrProgress,
  PrSnapshotStatus,
  WorkActivity,
  WorkActivityKind,
  WorkItem,
  WorkItemFacts,
  WorkItemNote,
  WorkItemState,
  WorkStage,
} from '@diffstalker/core/types/work';
import type { WorkWindow } from '../prefs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the "last day" filter keeps: activity at most this long ago. */
export const LAST_DAY_MS = DAY_MS;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `14:02`, local time. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `18 Nov`, local date. */
export function formatDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** `14:02` today, `18 Nov 14:02` on another day. */
export function formatStamp(ms: number, now: number): string {
  const a = new Date(ms);
  const b = new Date(now);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  return sameDay ? formatClock(ms) : `${formatDay(ms)} ${formatClock(ms)}`;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const AGO_UNITS: ReadonlyArray<[string, number]> = [
  ['year', 365 * DAY_MS],
  ['month', 30 * DAY_MS],
  ['day', DAY_MS],
  ['hour', HOUR_MS],
  ['minute', MINUTE_MS],
];

/**
 * How long ago, in the two largest units: `3 days 12 hours ago`,
 * `5 hours ago`, `just now` under a minute (or for a time ahead of the
 * clock). A month is 30 days and a year 365.
 */
export function formatAgo(ms: number, now: number): string {
  const span = now - ms;
  for (let i = 0; i < AGO_UNITS.length; i++) {
    const [name, size] = AGO_UNITS[i];
    const count = Math.floor(span / size);
    if (count < 1) continue;
    const parts = [plural(count, name)];
    const next = AGO_UNITS[i + 1];
    if (next !== undefined) {
      const rest = Math.min(
        Math.floor((span - count * size) / next[1]),
        name === 'year' ? 11 : Infinity
      );
      if (rest > 0) parts.push(plural(rest, next[0]));
    }
    return `${parts.join(' ')} ago`;
  }
  return 'just now';
}

/** `Mon 23 Nov 2026, 14:02`, local time: the hover of a how-long-ago. */
export function formatFull(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getDay()]} ${formatDay(ms)} ${date.getFullYear()}, ${formatClock(ms)}`;
}

/** Something happened to the item in the last LAST_DAY_MS. */
export function activeLastDay(item: WorkItem, now: number): boolean {
  return activeWithin(item, now, LAST_DAY_MS);
}

/** Something happened to the item at most `ms` ago. Unknown activity is never within. */
export function activeWithin(item: WorkItem, now: number, ms: number): boolean {
  return item.activity !== null && now - item.activity <= ms;
}

export const STAGE_LABELS: Record<WorkStage, string> = {
  local: 'local only',
  pushed: 'pushed, no PR',
  draft: 'draft PR',
  review: 'in review',
  changes: 'changes requested',
  approved: 'approved',
  merged: 'merged',
  closed: 'closed',
  gone: 'branch gone',
};

/** How many of the five progress steps a stage fills. */
export const STAGE_LEVEL: Record<WorkStage, number> = {
  local: 1,
  pushed: 2,
  draft: 3,
  review: 4,
  changes: 4,
  approved: 5,
  merged: 5,
  closed: 0,
  gone: 0,
};

/** The stages in progress order, for a group's summary. */
export const STAGE_ORDER: readonly WorkStage[] = [
  'local',
  'pushed',
  'draft',
  'review',
  'changes',
  'approved',
  'merged',
  'closed',
  'gone',
];

export const EVENT_LABELS: Record<PrEventKind, string> = {
  approved: 'approved',
  'changes-requested': 'changes requested',
  reviewed: 'reviewed',
  commented: 'commented',
};

export const ACTIVITY_LABELS: Record<WorkActivityKind, string> = {
  ...EVENT_LABELS,
  edited: 'files edited',
  git: 'commit or checkout',
  'head-commit': 'new commit on the PR',
  draft: 'draft edited',
  merged: 'merged',
  closed: 'closed',
};

/** `changes requested · Bert`, or `files edited`. */
export function activityText(activity: WorkActivity): string {
  const what = ACTIVITY_LABELS[activity.kind];
  return activity.author === null ? what : `${what} · ${activity.author}`;
}

/** One line of a fold-out's activity list. */
export interface ItemEvent {
  at: number;
  text: string;
  /** By someone other than the `gh` account. */
  other: boolean;
}

/** The fold-out's activity: PR events, merge or close, and local times; newest first. */
export function itemEvents(item: WorkItem, viewer: string | null): ItemEvent[] {
  const events: ItemEvent[] = [];
  for (const event of item.pr?.progress?.events ?? []) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    events.push({
      at,
      text: `${EVENT_LABELS[event.kind]} · ${event.author}`,
      other: viewer !== null && event.author !== viewer,
    });
  }
  const pr = item.pr;
  const headAt = pr?.state === 'open' ? Date.parse(pr.progress?.headCommittedAt ?? '') : NaN;
  if (!Number.isNaN(headAt)) {
    events.push({ at: headAt, text: ACTIVITY_LABELS['head-commit'], other: false });
  }
  if (pr !== null && pr.state !== 'open') {
    const at = Date.parse(pr.mergedAt ?? pr.closedAt ?? '');
    if (!Number.isNaN(at)) events.push({ at, text: pr.state, other: false });
  }
  const local: Array<[number | null, string]> = [
    [item.times.edited, ACTIVITY_LABELS.edited],
    [item.times.git, ACTIVITY_LABELS.git],
    [item.times.draft, ACTIVITY_LABELS.draft],
  ];
  for (const [at, text] of local) if (at !== null) events.push({ at, text, other: false });
  return events.sort((a, b) => b.at - a.at);
}

/** Review and checks of an open PR. */
function progressDetails(p: PrProgress): Array<[string, string]> {
  const review = [p.decision === null ? 'no decision' : p.decision.replace('-', ' ')];
  if (p.pendingReviewers > 0) review.push(`${p.pendingReviewers} asked`);
  if (p.unresolvedThreads > 0) review.push(plural(p.unresolvedThreads, 'open thread'));
  const out: Array<[string, string]> = [
    ['Review', review.join(', ')],
    ['Checks', p.checks === null ? 'none' : p.checks],
  ];
  if (p.conflicting) out.push(['Merge', 'conflicts with the base branch']);
  return out;
}

/** `3 uncommitted, 2 unpushed, 5 ahead of upstream/main`, or '' when none apply. */
function localDetail(f: WorkItemFacts): string {
  const local: string[] = [];
  if (f.uncommitted > 0) local.push(`${f.uncommitted} uncommitted`);
  if (f.unpushed > 0) local.push(`${f.unpushed} unpushed`);
  if (f.ahead > 0)
    local.push(f.base === null ? `${f.ahead} ahead` : `${f.ahead} ahead of ${f.base}`);
  return local.join(', ');
}

/** The fold-out's facts, label and value, in a fixed order; empty ones left out. */
export function itemDetails(item: WorkItem): Array<[string, string]> {
  const out: Array<[string, string]> = [['Stage', STAGE_LABELS[item.stage]]];
  const base = item.pr?.baseRefName ?? item.facts.base;
  if (base) out.push(['Base', base]);
  if (item.stack) {
    out.push([
      'Stack',
      `layer ${item.stack.position} of ${item.stack.size}, on ${item.stack.root}`,
    ]);
  }
  if (item.pr?.progress) out.push(...progressDetails(item.pr.progress));
  if (item.worktreePath) out.push(['Worktree', item.worktreePath]);
  const local = localDetail(item.facts);
  if (local !== '') out.push(['Local', local]);
  if (item.note) out.push(['Note', NOTE_LABELS[item.note]]);
  if (item.tracked) out.push(['Marks', 'tracked']);
  return out;
}

/** Whose move it is: the author's, someone else's, or nobody's (done). */
export type WorkTurn = 'you' | 'others' | 'none';

/** Where an item stands, in a few words, and whose move it is. */
export interface WorkStatus {
  text: string;
  turn: WorkTurn;
  /** The longer reason, for the hover. */
  why: string;
}

function status(text: string, turn: WorkTurn, why: string): WorkStatus {
  return { text, turn, why };
}

/** The status of the author's own open PR; the first that applies wins. */
function openPrStatus(pr: PrInfo, item: WorkItem, viewer: string | null): WorkStatus {
  const p = pr.progress;
  if (pr.isDraft) return status('draft', 'you', 'A draft on GitHub: not asking for review yet');
  if (p === null) return status('open', 'none', 'GitHub did not say more about this PR');
  if (p.conflicting) return status('conflicts', 'you', 'GitHub says it has merge conflicts');
  if (p.checks === 'failure')
    return status('checks failing', 'you', 'The checks on its head failed');
  if (item.attention.includes('changes-requested')) {
    return status('changes requested', 'you', attentionLines(item)[0] ?? '');
  }
  // A repo that needs no review gives no decision, even after an approval.
  const approvedBy = p.events.find((event) => event.kind === 'approved' && event.author !== viewer);
  if (p.decision === 'approved' || (p.decision === null && approvedBy)) {
    return status('approved', 'you', 'Approved: ready to merge');
  }
  const asked = p.requestedReviewers.join(', ');
  if (p.decision === 'changes-requested') {
    return status('awaiting re-review', 'others', `Asked to review again: ${asked}`);
  }
  if (p.requestedReviewers.length > 0 || p.pendingReviewers > 0) {
    return status('awaiting review', 'others', `Asked to review: ${asked}`);
  }
  const reviewedBy = p.events.find((event) => event.kind === 'reviewed' && event.author !== viewer);
  if (reviewedBy) {
    return status(
      'reviewed, no decision',
      'you',
      `${reviewedBy.author} reviewed with comments only, and nobody is asked to review now`
    );
  }
  return status('needs reviewer', 'you', 'Nobody is asked to review it yet');
}

const LOCAL_STATUS: Partial<Record<WorkItemState, WorkStatus>> = {
  'pushed-no-pr': status('no PR yet', 'you', 'Pushed, and no PR for it yet'),
  'not-pushed': status('not pushed', 'you', 'Commits that are on no remote yet'),
  uncommitted: status('uncommitted', 'you', 'Changes that are not committed'),
  empty: status('nothing yet', 'none', 'A new worktree with nothing in it yet'),
  'branch-gone': status('branch gone', 'none', 'The branch no longer exists'),
};

/**
 * Where an item stands and whose move it is: one short phrase for the
 * Status column (docs/work-page.md §5.4 has the full table).
 */
export function workStatus(item: WorkItem, viewer: string | null): WorkStatus {
  const pr = item.pr;
  if (pr?.reviewRequested) {
    return status('your review', 'you', `${pr.author ?? 'Someone'} asks you to review this`);
  }
  if (pr !== null && pr.state !== 'open') {
    if (item.facts.uncommitted > 0) {
      return status(
        `${pr.state}, leftovers`,
        'you',
        'The PR is done; the worktree still has changes'
      );
    }
    return status(pr.state, 'none', `The PR is ${pr.state}`);
  }
  if (pr !== null) return openPrStatus(pr, item, viewer);
  return LOCAL_STATUS[item.state] ?? status(item.state, 'none', '');
}

/** Why the alert shows, one line per reason. */
export function attentionLines(item: WorkItem): string[] {
  const pr = item.pr;
  const p = pr?.progress ?? null;
  return item.attention.map((reason) => {
    if (reason === 'review-requested') return `${pr?.author ?? 'Someone'} asks you to review this`;
    const waiting = (p?.changesRequestedBy ?? []).filter(
      (reviewer) => !(p?.requestedReviewers ?? []).includes(reviewer)
    );
    return `Changes requested by ${waiting.join(', ')}, not asked to review again yet`;
  });
}

/**
 * What "Copy for a session" puts on the clipboard: facts that find the
 * change again, one per line, for pasting into an agent session.
 */
export function sessionBrief(item: WorkItem): string {
  const lines: string[] = [];
  const pr = item.pr;
  if (pr !== null) {
    lines.push(`Pull request: ${pr.url}`, `Title: ${pr.title}`);
    if (pr.author !== null) {
      lines.push(`Author: ${pr.author}${pr.reviewRequested ? ' (I am asked to review it)' : ''}`);
    }
    const from = pr.headOwner === null ? '' : ` from ${pr.headOwner}`;
    lines.push(
      `Branch: ${pr.headRefName}${from}, into ${pr.baseRefName} of ${pr.repo}`,
      `Head commit: ${pr.headRefOid}`
    );
  } else if (item.branch !== null) {
    const base = item.facts.base === null ? '' : `, ahead of ${item.facts.base}`;
    lines.push(`Branch: ${item.branch}${base}`);
  }
  if (item.repoRoot !== null) lines.push(`Local clone: ${item.repoRoot}`);
  else if (pr !== null)
    lines.push(`Local clone: none; git clone https://github.com/${pr.repo}.git`);
  if (item.worktreePath !== null) lines.push(`Worktree: ${item.worktreePath}`);
  return lines.join('\n');
}

export interface WorkGroup {
  /** The repo root, or the PR's `owner/name` when there is no clone. */
  key: string;
  name: string;
  items: WorkItem[];
}

/** What a column header sorts by. */
export type WorkSortKey =
  'stage' | 'branch' | 'stack' | 'pr' | 'review' | 'ci' | 'local' | 'draft' | 'status' | 'activity';

export interface WorkSort {
  key: WorkSortKey;
  dir: 'asc' | 'desc';
}

const TURN_RANK = { you: 0, others: 1, none: 2 } as const;

const DECISION_RANK = { 'changes-requested': 0, 'review-required': 1, approved: 2 } as const;
const CHECKS_RANK = { failure: 0, pending: 1, success: 2 } as const;

type SortValue = number | string | null;

/** Changes requested first, then waiting, then approved; more open threads first. */
function reviewRank(p: PrProgress): number {
  const decision = p.decision === null ? 1 : DECISION_RANK[p.decision];
  return decision * 1e4 - p.unresolvedThreads;
}

/** Conflicts first, then failed, running, passed, none. */
function ciRank(p: PrProgress): number {
  const checks = p.checks === null ? 3 : CHECKS_RANK[p.checks];
  return (p.conflicting ? 0 : 10) + checks;
}

/** Placeholders first, then words that differ from GitHub, then the rest. */
function draftRank(f: WorkItemFacts): SortValue {
  if (!f.draft) return null;
  if (f.placeholders > 0) return 0;
  return f.bodyDiffers ? 1 : 2;
}

function stackRank(item: WorkItem): SortValue {
  const stack = item.stack;
  return stack === null ? null : `${stack.root}\u0000${String(stack.position).padStart(4, '0')}`;
}

function progressRank(item: WorkItem, rank: (p: PrProgress) => number): SortValue {
  const p = item.pr?.progress ?? null;
  return p === null ? null : rank(p);
}

/** The value each column sorts on; null sorts last either way. */
const SORT_VALUES: Record<WorkSortKey, (item: WorkItem) => SortValue> = {
  stage: (item) => STAGE_ORDER.indexOf(item.stage),
  branch: (item) => item.branch,
  stack: stackRank,
  pr: (item) => item.pr?.number ?? null,
  review: (item) => progressRank(item, reviewRank),
  ci: (item) => progressRank(item, ciRank),
  local: (item) => item.facts.uncommitted + item.facts.unpushed || null,
  draft: (item) => draftRank(item.facts),
  // The turn does not depend on who the viewer is, so none is needed here.
  status: (item) => TURN_RANK[workStatus(item, null).turn],
  activity: (item) => item.activity,
};

/** Sorted by one column; equal values keep their order, and no value goes last. */
export function sortItems(items: readonly WorkItem[], sort: WorkSort): WorkItem[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = SORT_VALUES[sort.key];
  const keyed = items.map((item) => ({ item, value: value(item) }));
  keyed.sort((a, b) => {
    if (a.value === b.value) return 0;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return (a.value < b.value ? -1 : 1) * sign;
  });
  return keyed.map((entry) => entry.item);
}

/**
 * Items by repo, in the order the repos first appear, so the list's own
 * order (newest activity first) decides which repo comes first. Inside a
 * repo the order stays, except that a stack's layers are pulled together
 * where its first layer appears, bottom first. With a `sort`, the repos
 * keep that order and the rows inside each are sorted instead.
 */
export function groupByRepo(items: readonly WorkItem[], sort: WorkSort | null = null): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const item of items) {
    const key = item.repoRoot ?? item.repoName;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, name: item.repoName, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.items = sort === null ? withStacksTogether(group.items) : sortItems(group.items, sort);
  }
  return [...groups.values()];
}

/** A stack is named by its repo and its bottom branch: two repos may share a branch name. */
function stackKey(item: WorkItem): string | null {
  return item.stack === null ? null : `${item.repoRoot ?? item.repoName}\n${item.stack.root}`;
}

function withStacksTogether(items: readonly WorkItem[]): WorkItem[] {
  const layers = new Map<string, WorkItem[]>();
  for (const item of items) {
    const key = stackKey(item);
    if (key === null) continue;
    const list = layers.get(key) ?? [];
    list.push(item);
    layers.set(key, list);
  }
  const placed = new Set<string>();
  const out: WorkItem[] = [];
  for (const item of items) {
    const root = stackKey(item);
    if (root === null) {
      out.push(item);
      continue;
    }
    if (placed.has(root)) continue;
    placed.add(root);
    const stack = layers.get(root) ?? [item];
    out.push(...[...stack].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0)));
  }
  return out;
}

export const STATE_LABELS: Record<WorkItemState, string> = {
  merged: 'merged',
  closed: 'closed',
  'pr-open': 'PR open',
  'pr-draft': 'draft PR',
  'pushed-no-pr': 'pushed, no PR',
  'not-pushed': 'not pushed',
  uncommitted: 'uncommitted',
  empty: 'empty',
  'branch-gone': 'branch gone',
};

/** The same notes, short enough for the Local column. */
export const NOTE_SHORT: Record<WorkItemNote, string> = {
  'no-local-clone': 'no clone',
  'no-local-branch': 'no branch',
  'worktree-on-disk': 'on disk',
};

export const NOTE_LABELS: Record<WorkItemNote, string> = {
  'no-local-clone': 'no local clone',
  'no-local-branch': 'no local branch',
  'worktree-on-disk': 'worktree still on disk',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The small facts of a row, in a fixed order. Zero and false ones are left out. */
export function itemFacts(item: WorkItem): string[] {
  const facts = item.facts;
  const out: string[] = [];
  if (facts.uncommitted > 0) out.push(`${facts.uncommitted} uncommitted`);
  if (facts.unpushed > 0) out.push(`${facts.unpushed} unpushed`);
  if (facts.ahead > 0) {
    out.push(
      facts.base === null ? `${facts.ahead} ahead` : `${facts.ahead} ahead of ${facts.base}`
    );
  }
  if (facts.draft) out.push('draft');
  if (facts.placeholders > 0) out.push(plural(facts.placeholders, 'placeholder'));
  if (facts.adoptedUnedited) out.push('agent text, not edited');
  if (facts.bodyDiffers) out.push('GitHub body differs from draft');
  return out;
}

/** `merged 18 Nov` / `closed 18 Nov`, or null for an item that is not closed. */
export function closedLabel(item: WorkItem): string | null {
  const pr = item.pr;
  if (pr === null || pr.state === 'open') return null;
  const ms = Date.parse(pr.mergedAt ?? pr.closedAt ?? '');
  if (Number.isNaN(ms)) return pr.state;
  return `${pr.state} ${formatDay(ms)}`;
}

/** What the page says about `gh` when it could not ask GitHub (doc §4.2); null when it could. */
export function ghNotice(status: PrSnapshotStatus, message: string | null): string | null {
  switch (status) {
    case 'gh-missing':
      return 'gh not found — PR state unknown';
    case 'gh-logged-out':
      return 'gh not logged in — PR state unknown';
    case 'error':
      return `could not reach GitHub: ${message ?? 'unknown error'}`;
    default:
      return null;
  }
}

/** `PRs checked 6 minutes ago as JornC`: the Work page's line, which keeps counting. */
export function checkedAgoLine(checkedAt: number, viewer: string | null, now: number): string {
  const who = viewer === null ? '' : ` as ${viewer}`;
  return `PRs checked ${formatAgo(checkedAt, now)}${who}`;
}

/** `PRs checked 14:02 as JornC`. */
export function checkedLine(checkedAt: number, viewer: string | null, now: number): string {
  const who = viewer === null ? '' : ` as ${viewer}`;
  return `PRs checked ${formatStamp(checkedAt, now)}${who}`;
}

/** The time headings of "by time", newest first; `older` also takes unknown activity. */
export const TIME_BUCKETS: ReadonlyArray<{
  key: WorkWindow | 'older';
  label: string;
  within: number;
}> = [
  { key: 'day', label: 'Last day', within: DAY_MS },
  { key: 'week', label: 'Last week', within: 7 * DAY_MS },
  { key: 'two-weeks', label: 'Last 2 weeks', within: 14 * DAY_MS },
  { key: 'month', label: 'Last month', within: 30 * DAY_MS },
  { key: 'older', label: 'Older', within: Infinity },
];

/** One line of a section's list: a time heading, a repo heading, or a row. */
export type WorkLine =
  | { kind: 'time'; key: string; label: string; count: number }
  | { kind: 'repo'; key: string; name: string; count: number }
  | { kind: 'item'; key: string; item: WorkItem };

export interface WorkLayout {
  byRepo: boolean;
  byTime: boolean;
  sort: WorkSort | null;
  now: number;
}

/** Items in their order with no repo headings: sorted, or stacks pulled together. */
function flatOrder(items: readonly WorkItem[], sort: WorkSort | null): WorkItem[] {
  return sort === null ? withStacksTogether(items) : sortItems(items, sort);
}

function bucketsOf(
  items: readonly WorkItem[],
  now: number
): Array<{ key: string; label: string; items: WorkItem[] }> {
  const buckets = TIME_BUCKETS.map((bucket) => ({ ...bucket, items: [] as WorkItem[] }));
  for (const item of items) {
    const age = item.activity === null ? Infinity : now - item.activity;
    const bucket = buckets.find((b) => age <= b.within) ?? buckets[buckets.length - 1];
    bucket.items.push(item);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

/**
 * A section's list as lines: under time headings when `byTime`, under
 * repo headings when `byRepo` (inside the time headings when both), else
 * one plain list. The rows in each part follow `sort`, or the default
 * order with a stack's layers together.
 */
export function layoutWork(items: readonly WorkItem[], layout: WorkLayout): WorkLine[] {
  const parts = layout.byTime
    ? bucketsOf(items, layout.now)
    : [{ key: 'all', label: '', items: [...items] }];
  const lines: WorkLine[] = [];
  for (const part of parts) {
    if (layout.byTime) {
      lines.push({
        kind: 'time',
        key: `t:${part.key}`,
        label: part.label,
        count: part.items.length,
      });
    }
    if (!layout.byRepo) {
      for (const item of flatOrder(part.items, layout.sort))
        lines.push({ kind: 'item', key: item.key, item });
      continue;
    }
    for (const group of groupByRepo(part.items, layout.sort)) {
      lines.push({
        kind: 'repo',
        key: `r:${part.key}:${group.key}`,
        name: group.name,
        count: group.items.length,
      });
      for (const item of group.items) lines.push({ kind: 'item', key: item.key, item });
    }
  }
  return lines;
}
