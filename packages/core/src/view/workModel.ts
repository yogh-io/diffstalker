/**
 * Where each piece of work goes on the Work page. The daemon serves facts
 * (repos, PRs, marks); this decides the section, the state and the small
 * facts of every item. Pure and browser-safe. See docs/work-page.md §5.
 */

import { CANDIDATE_RECENT_MS, DONE_WINDOW_MS } from '../types/work.js';
import type {
  DraftFacts,
  PrInfo,
  PrSnapshot,
  WorkActivity,
  WorkAttention,
  WorkBranch,
  WorkClassification,
  WorkItem,
  WorkItemFacts,
  WorkItemState,
  WorkItemTarget,
  WorkLocalTimes,
  WorkMarks,
  WorkRepoFacts,
  WorkSection,
  WorkStack,
  WorkStage,
  WorkWorktree,
} from '../types/work.js';
import { bodyDiffersFromDraft, countPlaceholders } from './prBody.js';

const PR_KEY_PREFIX = 'pr:';

/** The mark key of a local branch. */
export function branchKey(root: string, branch: string): string {
  return `${root}\n${branch}`;
}

/** The mark key of a PR with no local branch. */
export function prKey(pr: PrInfo): string {
  return `${PR_KEY_PREFIX}${pr.repo}#${pr.number}`;
}

/** A branch key split back into its parts; null for any other key. A branch name holds no newline. */
function parseBranchKey(key: string): { root: string; branch: string } | null {
  const cut = key.lastIndexOf('\n');
  if (cut === -1) return null;
  return { root: key.slice(0, cut), branch: key.slice(cut + 1) };
}

/**
 * The PR for this branch of a repo with these identities: the first in
 * snapshot order, so an open one, else the newest by `updatedAt`.
 */
export function findPr(
  prs: readonly PrInfo[],
  identities: readonly string[],
  branch: string
): PrInfo | null {
  return prs.find((pr) => pr.headRefName === branch && identities.includes(pr.repoKey)) ?? null;
}

/** When a merged or closed PR closed, epoch ms; null for an open PR or a date that does not parse. */
function closedAtMs(pr: PrInfo): number | null {
  if (pr.state === 'open') return null;
  const ms = Date.parse(pr.mergedAt ?? pr.closedAt ?? '');
  return Number.isNaN(ms) ? null : ms;
}

/** Open, or closed at most DONE_WINDOW_MS ago: a PR the page shows. */
function prInWindow(pr: PrInfo, now: number): boolean {
  if (pr.state === 'open') return true;
  const closed = closedAtMs(pr);
  return closed !== null && now - closed <= DONE_WINDOW_MS;
}

/** A real GitHub answer with every open PR in it. */
function prListWhole(prs: PrSnapshot): boolean {
  return prs.status === 'ok' && !prs.capped;
}

/** Merged or closed before the Done window. */
function closedBeforeWindow(pr: PrInfo, now: number): boolean {
  const closed = closedAtMs(pr);
  return closed !== null && now - closed > DONE_WINDOW_MS;
}

/** The branch still points at the PR's last commit: no commit since. */
function onPrHead(pr: PrInfo, branch: WorkBranch | null, worktree: WorkWorktree | null): boolean {
  const tip = branch?.tip ?? worktree?.head ?? null;
  return tip === pr.headRefOid;
}

function parsedTime(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** `upstream/main` -> `main`: the branch a base names, after its first `/`. */
function baseBranchName(base: string): string {
  const slash = base.indexOf('/');
  return slash === -1 ? base : base.slice(slash + 1);
}

/** A worktree on a branch that is not its base's: making it is enough to be work. */
function isFresh(worktree: WorkWorktree): boolean {
  if (worktree.branch === null) return false;
  if (worktree.base === null) return !worktree.isMain;
  return worktree.branch !== baseBranchName(worktree.base);
}

function hasTop(draft: DraftFacts | null): boolean {
  return draft !== null && draft.top !== null && draft.top.trim() !== '';
}

/** The author's zone, an agent's suggestion or the AI zone below the line has text. */
function hasDraft(draft: DraftFacts | null): boolean {
  return hasTop(draft) || draft?.hasSuggested === true || draft?.hasAi === true;
}

/** docs/work-page.md §5.4: how far along, for the colour and the progress icon. */
function stageOf(state: WorkItemState, pr: PrInfo | null): WorkStage {
  if (pr !== null) {
    if (pr.state !== 'open') return pr.state;
    if (pr.isDraft) return 'draft';
    const decision = pr.progress?.decision ?? null;
    if (decision === 'changes-requested') return 'changes';
    if (decision === 'approved') return 'approved';
    return 'review';
  }
  if (state === 'branch-gone') return 'gone';
  if (state === 'pushed-no-pr') return 'pushed';
  return 'local';
}

/**
 * The stack of every open PR that is in one: its base is another open PR's
 * head in the same repo, or its head is another's base. A cycle stops the
 * walk where it closes.
 */
function stacksOf(prs: readonly PrInfo[]): Map<PrInfo, WorkStack> {
  const open = prs.filter((pr) => pr.state === 'open');
  const byHead = new Map<string, PrInfo>();
  for (const pr of open) {
    const key = `${pr.repoKey}\n${pr.headRefName}`;
    if (!byHead.has(key)) byHead.set(key, pr);
  }
  const parentOf = (pr: PrInfo): PrInfo | null =>
    byHead.get(`${pr.repoKey}\n${pr.baseRefName}`) ?? null;

  const walked = new Map<PrInfo, { depth: number; root: PrInfo }>();
  const sizes = new Map<PrInfo, number>();
  for (const pr of open) {
    const seen = new Set<PrInfo>([pr]);
    let root = pr;
    for (
      let parent = parentOf(root);
      parent !== null && !seen.has(parent);
      parent = parentOf(root)
    ) {
      seen.add(parent);
      root = parent;
    }
    walked.set(pr, { depth: seen.size, root });
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }

  const stacks = new Map<PrInfo, WorkStack>();
  for (const [pr, { depth, root }] of walked) {
    const size = sizes.get(root) ?? 1;
    if (size > 1) stacks.set(pr, { position: depth, size, root: root.headRefName });
  }
  return stacks;
}

/**
 * Who waits on the author: a reviewer who asked for changes on the
 * author's open PR and was not asked to review again since, or a review
 * the author is asked for.
 */
function attentionOf(pr: PrInfo | null, viewer: string | null): WorkAttention[] {
  if (pr === null || pr.state !== 'open') return [];
  const out: WorkAttention[] = [];
  const p = pr.progress;
  const mine = viewer !== null && pr.author === viewer;
  if (mine && p !== null && p.decision === 'changes-requested') {
    if (p.changesRequestedBy.some((reviewer) => !p.requestedReviewers.includes(reviewer))) {
      out.push('changes-requested');
    }
  }
  if (pr.reviewRequested) out.push('review-requested');
  return out;
}

/** The newest of the local times, the PR's newest event, and its merge or close. Ties keep the first. */
function activityOf(
  times: WorkLocalTimes,
  pr: PrInfo | null,
  viewer: string | null
): WorkActivity | null {
  const options: WorkActivity[] = [];
  const local = (at: number | null, kind: 'edited' | 'git' | 'draft'): void => {
    if (at !== null) options.push({ at, kind, author: null, other: false });
  };
  local(times.edited, 'edited');
  local(times.git, 'git');
  local(times.draft, 'draft');
  const headAt = pr?.state === 'open' ? parsedTime(pr.progress?.headCommittedAt ?? '') : null;
  if (pr !== null && headAt !== null) {
    options.push({
      at: headAt,
      kind: 'head-commit',
      author: pr.author,
      other: viewer !== null && pr.author !== null && pr.author !== viewer,
    });
  }
  const event = pr?.progress?.events[0];
  const eventAt = event === undefined ? null : parsedTime(event.at);
  if (event !== undefined && eventAt !== null) {
    options.push({
      at: eventAt,
      kind: event.kind,
      author: event.author,
      other: viewer !== null && event.author !== viewer,
    });
  }
  const closedAt = pr === null ? null : closedAtMs(pr);
  if (pr !== null && pr.state !== 'open' && closedAt !== null) {
    options.push({ at: closedAt, kind: pr.state, author: null, other: false });
  }
  let best: WorkActivity | null = null;
  for (const option of options) {
    if (best === null || option.at > best.at) best = option;
  }
  return best;
}

/** Where a branch that is in no worktree opens: the main worktree, else the most recently used one. */
function hostWorktree(repo: WorkRepoFacts): WorkWorktree | null {
  let best: WorkWorktree | null = null;
  for (const worktree of repo.worktrees) {
    if (worktree.isBare) continue;
    if (worktree.isMain) return worktree;
    if (best === null || (worktree.lastActivity ?? -Infinity) > (best.lastActivity ?? -Infinity)) {
      best = worktree;
    }
  }
  return best;
}

/** Everything one item is built from, before it has a section. */
interface Draft {
  key: string;
  kind: WorkItem['kind'];
  repo: WorkRepoFacts;
  worktree: WorkWorktree | null;
  branch: string | null;
  branchFact: WorkBranch | null;
  draft: DraftFacts | null;
  pr: PrInfo | null;
  /** `pr` closed before the window and the worktree still holds uncommitted changes. */
  leftover: boolean;
  gone: boolean;
  tracked: boolean;
}

function factsOf(item: Draft): WorkItemFacts {
  const top = hasTop(item.draft) ? (item.draft?.top ?? '') : null;
  return {
    uncommitted: item.worktree?.uncommitted ?? 0,
    unpushed: item.branchFact?.unpushed ?? 0,
    ahead: item.worktree?.aheadOfBase ?? 0,
    base: item.worktree?.base ?? null,
    draft: top !== null,
    placeholders: top === null ? 0 : countPlaceholders(top),
    adoptedUnedited: top !== null && (item.draft?.adoptedUnedited ?? false),
    bodyDiffers:
      top !== null &&
      item.pr?.state === 'open' &&
      item.pr.body !== null &&
      bodyDiffersFromDraft(item.pr.body, top),
  };
}

/** docs/work-page.md §5.2, first match wins; null: not work at all. */
function sectionOf(item: Draft, facts: WorkItemFacts): WorkSection | null {
  if (item.pr !== null && !item.leftover) return item.pr.state === 'open' ? 'work' : 'done';
  if (hasDraft(item.draft) || item.tracked) return 'work';
  if (item.worktree === null) return null;
  if (facts.uncommitted > 0 || facts.ahead > 0) return 'candidates';
  if (item.kind === 'branch' && (facts.unpushed > 0 || isFresh(item.worktree))) return 'candidates';
  return null;
}

function prState(pr: PrInfo): WorkItemState {
  if (pr.state !== 'open') return pr.state;
  return pr.isDraft ? 'pr-draft' : 'pr-open';
}

/** docs/work-page.md §5.4, first match wins. */
function stateOf(item: Draft, facts: WorkItemFacts): WorkItemState {
  if (item.pr !== null) return prState(item.pr);
  if (item.gone) return 'branch-gone';
  const remoteCopy = item.branchFact?.remoteCopy ?? false;
  if (remoteCopy && facts.unpushed === 0) return 'pushed-no-pr';
  if (facts.unpushed > 0 || (!remoteCopy && (facts.ahead > 0 || item.worktree === null))) {
    return 'not-pushed';
  }
  if (facts.uncommitted > 0) return 'uncommitted';
  return 'empty';
}

function openOf(item: Draft): WorkItemTarget | null {
  if (item.worktree !== null) return { path: item.worktree.path, head: null };
  if (item.gone || item.branch === null) return null;
  const host = hostWorktree(item.repo);
  return host === null ? null : { path: host.path, head: item.branch };
}

/** Dirty or clean, not the count: a worktree that keeps changing would come back after every dismiss. */
function fingerprintOf(item: Draft, facts: WorkItemFacts): string {
  const dirty = facts.uncommitted > 0 ? 1 : 0;
  if (item.kind === 'detached') return `${item.worktree?.head ?? ''}|${dirty}`;
  const tip = item.branchFact?.tip ?? item.worktree?.head ?? '';
  return `${tip}|${dirty}|${item.draft?.mtime ?? 0}`;
}

/** The item, or null when it is not work. */
function finish(item: Draft, context: Context): WorkItem | null {
  const facts = factsOf(item);
  const section = sectionOf(item, facts);
  if (section === null) return null;
  const state = stateOf(item, facts);
  const times: WorkLocalTimes = {
    edited: item.worktree?.changedAt ?? null,
    git: item.worktree?.lastActivity ?? null,
    draft: item.draft?.mtime ?? null,
  };
  const lastActivity = activityOf(times, item.pr, context.viewer);
  return {
    key: item.key,
    kind: item.kind,
    section,
    repoRoot: item.repo.root,
    repoName: item.repo.name,
    worktreePath: item.worktree?.path ?? null,
    branch: item.branch,
    state,
    facts,
    pr: item.pr,
    note: section === 'done' && item.worktree !== null ? 'worktree-on-disk' : null,
    open: openOf(item),
    stage: stageOf(state, item.pr),
    stack: item.pr === null ? null : (context.stacks.get(item.pr) ?? null),
    attention: attentionOf(item.pr, context.viewer),
    lastActivity,
    times,
    activity: lastActivity?.at ?? null,
    fingerprint: fingerprintOf(item, facts),
    tracked: item.tracked,
  };
}

/** What every repo is judged against. */
interface Context {
  /**
   * The author's PRs in the snapshot, in snapshot order. A PR the author is
   * only asked to review never takes a local branch: its head branch name
   * may be anything, and would clash with one of the author's.
   */
  prs: readonly PrInfo[];
  /** The PRs the page shows: open, or closed inside the window. */
  shown: readonly PrInfo[];
  marks: WorkMarks;
  now: number;
  /** The PR list is whole, so a branch may be called finished. */
  canFinish: boolean;
  /** The `gh` account the PRs were read as. */
  viewer: string | null;
  stacks: Map<PrInfo, WorkStack>;
}

/** The branches of a repo that may be an item: checked out, drafted, with a shown PR, or tracked. */
function branchNames(repo: WorkRepoFacts, context: Context): Set<string> {
  const { shown, marks } = context;
  const names = new Set<string>();
  for (const worktree of repo.worktrees) {
    if (!worktree.isBare && worktree.branch !== null) names.add(worktree.branch);
  }
  for (const draft of repo.drafts) names.add(draft.branch);
  for (const branch of repo.branches) {
    if (findPr(shown, repo.identities, branch.name) !== null) names.add(branch.name);
  }
  for (const key of Object.keys(marks.tracked)) {
    const parsed = parseBranchKey(key);
    if (parsed !== null && parsed.root === repo.root) names.add(parsed.branch);
  }
  return names;
}

/** One repo's facts by name, for the branch loop. */
interface RepoLookup {
  repo: WorkRepoFacts;
  worktrees: WorkWorktree[];
  branches: Map<string, WorkBranch>;
  drafts: Map<string, DraftFacts>;
}

/** The item for one local branch, or null when it is not work or is finished. */
function branchItem(lookup: RepoLookup, name: string, context: Context): WorkItem | null {
  const { repo } = lookup;
  const { marks, now } = context;
  const key = branchKey(repo.root, name);
  const worktree = lookup.worktrees.find((candidate) => candidate.branch === name) ?? null;
  const branchFact = lookup.branches.get(name) ?? null;
  // A capped list may just not reach the name, and an unborn branch has no ref yet.
  const gone = branchFact === null && worktree === null && !repo.branchesCapped;
  const pr = findPr(context.prs, repo.identities, name);
  // Closed before the window, and no commit on the branch since.
  const untouched =
    pr !== null && closedBeforeWindow(pr, now) && (gone || onPrHead(pr, branchFact, worktree));
  const clean = worktree === null || worktree.uncommitted === 0;
  if (untouched && clean && context.canFinish) return null;
  const leftover = untouched && (worktree?.uncommitted ?? 0) > 0;
  return finish(
    {
      key,
      kind: 'branch',
      repo,
      worktree,
      branch: name,
      branchFact,
      draft: lookup.drafts.get(name) ?? null,
      // Any other PR closed before the window is left off: the branch has new work.
      pr: pr !== null && (prInWindow(pr, now) || leftover) ? pr : null,
      leftover,
      gone,
      tracked: marks.tracked[key] !== undefined,
    },
    context
  );
}

function repoItems(repo: WorkRepoFacts, context: Context): WorkItem[] {
  const { marks } = context;
  const worktrees = repo.worktrees.filter((worktree) => !worktree.isBare);
  const lookup: RepoLookup = {
    repo,
    worktrees,
    branches: new Map(repo.branches.map((branch) => [branch.name, branch])),
    drafts: new Map(repo.drafts.map((draft) => [draft.branch, draft])),
  };
  const items: WorkItem[] = [];

  for (const name of branchNames(repo, context)) {
    const item = branchItem(lookup, name, context);
    if (item !== null) items.push(item);
  }

  for (const worktree of worktrees) {
    if (worktree.branch !== null) continue;
    const item = finish(
      {
        key: worktree.path,
        kind: 'detached',
        repo,
        worktree,
        branch: null,
        branchFact: null,
        draft: null,
        pr: null,
        leftover: false,
        gone: false,
        tracked: marks.tracked[worktree.path] !== undefined,
      },
      context
    );
    if (item !== null) items.push(item);
  }
  return items;
}

const EMPTY_FACTS: WorkItemFacts = {
  uncommitted: 0,
  unpushed: 0,
  ahead: 0,
  base: null,
  draft: false,
  placeholders: 0,
  adoptedUnedited: false,
  bodyDiffers: false,
};

const NO_TIMES: WorkLocalTimes = { edited: null, git: null, draft: null };

/** A PR that no local branch took: it only links to GitHub. */
function prOnlyItem(pr: PrInfo, repos: readonly WorkRepoFacts[], context: Context): WorkItem {
  const { marks } = context;
  const key = prKey(pr);
  const tracked = marks.tracked[key] !== undefined;
  const state = prState(pr);
  const lastActivity = activityOf(NO_TIMES, pr, context.viewer);
  const clone = repos.find((repo) => repo.identities.includes(pr.repoKey)) ?? null;
  return {
    key,
    kind: 'pr',
    section: pr.state === 'open' ? 'work' : 'done',
    repoRoot: clone?.root ?? null,
    repoName: clone?.name ?? pr.repo,
    worktreePath: null,
    branch: pr.headRefName,
    state,
    facts: { ...EMPTY_FACTS },
    pr,
    note: clone === null ? 'no-local-clone' : 'no-local-branch',
    open: null,
    stage: stageOf(state, pr),
    stack: context.stacks.get(pr) ?? null,
    attention: attentionOf(pr, context.viewer),
    lastActivity,
    times: { ...NO_TIMES },
    activity: lastActivity?.at ?? null,
    fingerprint: pr.updatedAt,
    tracked,
  };
}

function compareKeys(a: WorkItem, b: WorkItem): number {
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Newest activity first, unknown last, then by key so the order is stable. */
function byActivity(a: WorkItem, b: WorkItem): number {
  if (a.activity !== b.activity) {
    if (a.activity === null) return 1;
    if (b.activity === null) return -1;
    return b.activity - a.activity;
  }
  return compareKeys(a, b);
}

/** Active at most CANDIDATE_RECENT_MS ago. Unknown activity is not recent. */
function isRecent(item: WorkItem, now: number): boolean {
  return item.activity !== null && now - item.activity <= CANDIDATE_RECENT_MS;
}

function byCloseDate(a: WorkItem, b: WorkItem): number {
  const closedA = a.pr === null ? null : closedAtMs(a.pr);
  const closedB = b.pr === null ? null : closedAtMs(b.pr);
  if (closedA !== closedB) {
    if (closedA === null) return 1;
    if (closedB === null) return -1;
    return closedB - closedA;
  }
  return compareKeys(a, b);
}

/**
 * Mark keys with nothing behind them. Only a complete scan may say so. A
 * tracked branch of a scanned repo has an item (`branch-gone` at worst)
 * until it is finished; a PR key may lack one only because the list is
 * partial, so it needs a whole list.
 */
function findStaleMarks(marks: WorkMarks, items: readonly WorkItem[], prs: PrSnapshot): string[] {
  const itemKeys = new Set(items.map((item) => item.key));
  const prsWhole = prListWhole(prs);
  const stale = new Set<string>();
  for (const key of [...Object.keys(marks.tracked), ...Object.keys(marks.dismissed)]) {
    if (itemKeys.has(key)) continue;
    if (prsWhole || !key.startsWith(PR_KEY_PREFIX)) stale.add(key);
  }
  return [...stale].sort();
}

/**
 * Sort the scanned repos, the PR snapshot and the marks into the page's
 * sections. A branch whose PR closed before the Done window is finished
 * and gives no item, unless something happened on it since; only a whole
 * PR list may say so. A candidate with no activity in the last
 * CANDIDATE_RECENT_MS goes to `older`. `scanComplete` says every repo and
 * the PR query answered; without it no mark is called stale.
 */
export function classifyWork(
  repos: readonly WorkRepoFacts[],
  prs: PrSnapshot,
  marks: WorkMarks,
  now: number,
  scanComplete: boolean = false
): WorkClassification {
  const seen = new Set<string>();
  const unique = repos.filter((repo) => {
    if (seen.has(repo.root)) return false;
    seen.add(repo.root);
    return true;
  });
  const own = prs.prs.filter((pr) => !pr.reviewRequested);
  const context: Context = {
    prs: own,
    shown: own.filter((pr) => prInWindow(pr, now)),
    marks,
    now,
    canFinish: prListWhole(prs),
    viewer: prs.viewer,
    stacks: stacksOf(prs.prs),
  };

  const items = unique.flatMap((repo) => repoItems(repo, context));
  const taken = new Set(items.map((item) => item.pr).filter((pr) => pr !== null));
  for (const pr of context.shown) {
    if (!taken.has(pr)) items.push(prOnlyItem(pr, unique, context));
  }
  for (const pr of prs.prs) {
    if (pr.reviewRequested && pr.state === 'open') items.push(prOnlyItem(pr, unique, context));
  }

  const result: WorkClassification = {
    work: [],
    candidates: [],
    older: [],
    done: [],
    dismissed: [],
    staleMarks: scanComplete ? findStaleMarks(marks, items, prs) : [],
  };
  for (const item of items) {
    if (marks.dismissed[item.key]?.fingerprint === item.fingerprint) result.dismissed.push(item);
    else if (item.section === 'candidates' && !isRecent(item, now)) result.older.push(item);
    else result[item.section].push(item);
  }
  result.work.sort(byActivity);
  result.candidates.sort(byActivity);
  result.older.sort(byActivity);
  result.dismissed.sort(byActivity);
  result.done.sort(byCloseDate);
  return result;
}
