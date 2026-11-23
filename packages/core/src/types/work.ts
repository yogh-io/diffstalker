/**
 * The Work page and PR drafts: the wire contract between the daemon and
 * the web UI. See docs/work-page.md.
 *
 * Types, plus the few plain constants both sides need at runtime. This
 * module imports nothing, so the browser can import its values.
 */

// --- PR drafts ---

/** Where drafts live, under the git common dir: `<common>/diffstalker/pr/<branch>/`. */
export const DRAFT_DIR_SEGMENTS = ['diffstalker', 'pr'] as const;

/** The author's zone. Written by the daemon only. */
export const DRAFT_TOP_FILE = 'top.md';
/** An agent's suggestion for the top zone. Agents only. */
export const DRAFT_SUGGESTED_FILE = 'top.suggested.md';
/** Everything below the `---`. Agents only. */
export const DRAFT_AI_FILE = 'ai.md';
/** sha256 (hex) of the text "start from this" copied. Daemon only. */
export const DRAFT_ADOPTED_FILE = 'adopted';

/** No path component of a branch with a draft may equal one of these. */
export const DRAFT_FILE_NAMES: readonly string[] = [
  DRAFT_TOP_FILE,
  DRAFT_SUGGESTED_FILE,
  DRAFT_AI_FILE,
  DRAFT_ADOPTED_FILE,
];

/** `PrDraft.version` when there is no top.md. */
export const DRAFT_VERSION_ABSENT = 'absent';

/** The largest draft file the daemon reads or writes, in bytes. */
export const MAX_DRAFT_BYTES = 256 * 1024;

/** One branch's draft, as the Compare panel reads and saves it. */
export interface PrDraft {
  branch: string;
  /** null: no top.md. */
  top: string | null;
  suggested: string | null;
  ai: string | null;
  /** top.md is still exactly the text "start from this" copied. */
  adoptedUnedited: boolean;
  /** Opaque; changes whenever top.md changes. */
  version: string;
}

/** Body of `PUT /repos/:id/draft`. An empty `top` deletes top.md. */
export interface PutDraftRequest {
  branch: string;
  top: string;
  /** The `PrDraft.version` this text was based on. */
  version: string;
}

/** Body of `POST /repos/:id/draft/adopt`. */
export interface AdoptDraftRequest {
  branch: string;
  version: string;
}

/**
 * The `draft-change` SSE payload, on the repo stream. With `prefix` false
 * one branch's draft changed. With `prefix` true a directory changed:
 * the draft of `branch` and of every branch below `branch/` may have
 * changed, and an empty `branch` means every draft.
 */
export interface DraftChangeEvent {
  branch: string;
  prefix: boolean;
}

/** One draft found in a repo scan. */
export interface DraftFacts {
  branch: string;
  hasTop: boolean;
  hasSuggested: boolean;
  hasAi: boolean;
  /** top.md text, or null when there is none. */
  top: string | null;
  adoptedUnedited: boolean;
  /** Newest mtime of the draft's files, epoch ms. */
  mtime: number;
}

// --- GitHub ---

export type PrState = 'open' | 'closed' | 'merged';

/** What a person did on a PR. A review with only comments is `reviewed`. */
export type PrEventKind = 'approved' | 'changes-requested' | 'reviewed' | 'commented';

export interface PrEvent {
  kind: PrEventKind;
  /** GitHub login. */
  author: string;
  /** ISO timestamp, as GitHub sends it. */
  at: string;
}

/** At most this many events are kept per PR, newest first. */
export const PR_EVENTS_MAX = 10;

export type PrReviewDecision = 'approved' | 'changes-requested' | 'review-required';

/** The head commit's combined CI state. */
export type PrChecks = 'success' | 'failure' | 'pending';

/** Where an open PR stands. Read by the open search only. */
export interface PrProgress {
  /** null: the repo needs no review, or GitHub does not say. */
  decision: PrReviewDecision | null;
  /** Review threads not resolved yet, out of the first 100. */
  unresolvedThreads: number;
  /** Reviewers asked who have not answered yet. */
  pendingReviewers: number;
  /** Their logins, and `team:<slug>` for a team; the first 20. */
  requestedReviewers: string[];
  /** Reviewers whose latest approving-or-not review asks for changes. */
  changesRequestedBy: string[];
  /** null: no checks ran. */
  checks: PrChecks | null;
  /**
   * When the head commit was made, ISO. The newest commit on the PR, so the
   * author's own work on it shows as activity even when only bots comment.
   */
  headCommittedAt: string | null;
  /** GitHub says the PR has merge conflicts. */
  conflicting: boolean;
  /** Reviews and comments by people, newest first, at most PR_EVENTS_MAX. Bots are left out. */
  events: PrEvent[];
}

/** One pull request by the author, as `gh` reported it. */
export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: PrState;
  /** GitHub's draft flag. */
  isDraft: boolean;
  /** ISO timestamps, as GitHub sends them. */
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  /**
   * Read by the open search only, to compare with a draft. null for a PR
   * the closed search found: that search does not fetch it.
   */
  body: string | null;
  /** The head branch name. */
  headRefName: string;
  /** The branch it merges into. */
  baseRefName: string;
  /** Open PRs only; null for a PR the closed search found. */
  progress: PrProgress | null;
  /** The head branch's last commit on GitHub, full hash. */
  headRefOid: string;
  /** Owner of the head repo (the fork); null when it was deleted. */
  headOwner: string | null;
  /** Who opened it; null for a deleted account. */
  author: string | null;
  /**
   * The `gh` account is asked to review it: it came from the
   * `review-requested:@me` search, and is usually someone else's PR.
   */
  reviewRequested: boolean;
  /** The base repo, `owner/name`, as GitHub spells it. */
  repo: string;
  /** `repo` lowercased: what `WorkRepoFacts.identities` is matched against. */
  repoKey: string;
}

/**
 * How the last `gh` run ended.
 * - `never`: not asked yet since the daemon started.
 * - `ok`: the list is what GitHub answered.
 * - `gh-missing`: `gh` is not on PATH.
 * - `gh-logged-out`: `gh` needs a login (exit code 4).
 * - `error`: any other failure, a timeout, bad JSON.
 */
export type PrSnapshotStatus = 'never' | 'ok' | 'gh-missing' | 'gh-logged-out' | 'error';

/** The daemon's cached PR list. `GET /work/prs` and the refresh answer with it. */
export interface PrSnapshot {
  /** How the last run ended. */
  status: PrSnapshotStatus;
  /** The failure text for `error`; null otherwise. */
  message: string | null;
  /** When `prs` was last read from GitHub, epoch ms; null when never. */
  checkedAt: number | null;
  /** The `gh` account `prs` belongs to; null when never read. */
  viewer: string | null;
  /**
   * From the last run that worked, so a failed refresh keeps the older
   * list. Open first, then newest `updatedAt` first: the first PR that
   * matches a branch is the one to show.
   */
  prs: PrInfo[];
  /**
   * The open search hit the page cap: there are more open PRs than listed.
   * The closed search is always cut at the cap, newest update first, and
   * does not set this.
   */
  capped: boolean;
}

/** At most this many PRs are read per search. */
export const MAX_PRS_PER_SEARCH = 300;

/** A closed or merged PR counts as Done for this long. After that its branch is finished. */
export const DONE_WINDOW_DAYS = 7;
export const DONE_WINDOW_MS = DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** `GET /repos/:id/pr?branch=`: the cached PR for one branch. Never runs `gh`. */
export interface BranchPr {
  pr: PrInfo | null;
  status: PrSnapshotStatus;
  message: string | null;
  checkedAt: number | null;
  viewer: string | null;
}

// --- Repo facts ---

/** One worktree in a repo scan. */
export interface WorkWorktree {
  path: string;
  /** null when detached or bare. */
  branch: string | null;
  /** Checked-out commit; null for a bare entry. */
  head: string | null;
  isMain: boolean;
  isBare: boolean;
  /** Newest index/HEAD mtime, epoch ms; null when unknown. */
  lastActivity: number | null;
  /**
   * Newest mtime of the uncommitted paths (up to 200 are read), epoch ms. A
   * plain edit moves no index or HEAD, so this is what sees one. null when
   * there are none, none could be read, or for a bare entry.
   */
  changedAt: number | null;
  /** Commits on HEAD that are not on its compare base; null when unknown. */
  aheadOfBase: number | null;
  /** The compare base `aheadOfBase` counts against, `upstream/main`; null when none. */
  base: string | null;
  /** Changed plus untracked paths; null for a bare entry or when status failed. */
  uncommitted: number | null;
}

/** One local branch in a repo scan. */
export interface WorkBranch {
  name: string;
  /** Full commit hash. */
  tip: string;
  /** A remote-tracking branch of the same name exists on some remote. */
  remoteCopy: boolean;
  /** Commits on the tip that are on no remote copy; null without a copy. */
  unpushed: number | null;
}

/** `POST /work/repo`: what one repo holds. Facts only, no judgement. */
export interface WorkRepoFacts {
  /** The path that was asked for. */
  path: string;
  /**
   * The repo's main worktree (for a bare repo, the bare git dir). Every
   * worktree of one repo reports the same root, so it names the repo in
   * mark keys and dedupes two scans of one repo.
   */
  root: string;
  /** The label to show. */
  name: string;
  worktrees: WorkWorktree[];
  branches: WorkBranch[];
  /** There are more local branches than listed. */
  branchesCapped: boolean;
  /** `owner/name` of every GitHub remote, lowercased, no repeats. */
  identities: string[];
  drafts: DraftFacts[];
}

/** The page scans at most this many repos at once. */
export const WORK_SCAN_CONCURRENCY = 4;

/** A candidate active this recently stays in view; an older one is folded away. */
export const CANDIDATE_RECENT_DAYS = 14;
export const CANDIDATE_RECENT_MS = CANDIDATE_RECENT_DAYS * 24 * 60 * 60 * 1000;

// --- Marks ---

/** The only state the Work page keeps. Owned by the daemon. */
export interface WorkMarks {
  tracked: Record<string, { at: number }>;
  dismissed: Record<string, { fingerprint: string; at: number }>;
}

export type WorkMarkAction = 'track' | 'dismiss' | 'drop' | 'undismiss';

/** Body of `PUT /work/marks`. The answer is the new `WorkMarks`. */
export interface WorkMarkRequest {
  key: string;
  action: WorkMarkAction;
  /** Required for `dismiss`. */
  fingerprint?: string;
  /** Keys of marks whose item is gone, to drop in the same write. */
  prune?: string[];
}

// --- classifyWork ---

export type WorkSection = 'work' | 'candidates' | 'done';

/** One state per item; the first that applies, in the order of docs/work-page.md §5.4. */
export type WorkItemState =
  | 'merged'
  | 'closed'
  | 'pr-open'
  | 'pr-draft'
  | 'pushed-no-pr'
  | 'not-pushed'
  | 'uncommitted'
  | 'empty'
  | 'branch-gone';

/** `branch`: a local branch. `detached`: a worktree with no branch. `pr`: a PR with no local branch. */
export type WorkItemKind = 'branch' | 'detached' | 'pr';

/** The small facts on a row. A zero or false one is not shown. */
export interface WorkItemFacts {
  uncommitted: number;
  unpushed: number;
  /** Commits ahead of `base`. */
  ahead: number;
  base: string | null;
  /** top.md exists and is not empty. */
  draft: boolean;
  placeholders: number;
  adoptedUnedited: boolean;
  /** The open PR's top zone on GitHub differs from top.md. */
  bodyDiffers: boolean;
}

/** Why an item has less than a full row. */
export type WorkItemNote = 'no-local-clone' | 'no-local-branch' | 'worktree-on-disk';

/** Where a click on a row goes: Compare in `path`, with `?head=` when set. */
export interface WorkItemTarget {
  path: string;
  head: string | null;
}

/**
 * How far along an item is, for its colour and progress icon. In order:
 * local, pushed, draft PR, in review; then changes requested or approved;
 * then merged or closed. `gone`: the branch was deleted.
 */
export type WorkStage =
  'local' | 'pushed' | 'draft' | 'review' | 'changes' | 'approved' | 'merged' | 'closed' | 'gone';

/** An open PR whose base is another open PR's head, or that is such a base. */
export interface WorkStack {
  /** 1 is the bottom: the PR that merges into the trunk. */
  position: number;
  /** Open PRs in the stack. */
  size: number;
  /** The bottom PR's head branch; the same for every member, so it groups them. */
  root: string;
}

/** What `WorkActivity` describes. */
export type WorkActivityKind =
  'edited' | 'git' | 'draft' | 'head-commit' | PrEventKind | 'merged' | 'closed';

/**
 * Why an item wants the author now. `changes-requested`: a reviewer asked
 * for changes and was not asked to review again since. `review-requested`:
 * the author is asked to review it.
 */
export type WorkAttention = 'changes-requested' | 'review-requested';

/** The newest thing that happened to an item. */
export interface WorkActivity {
  /** Epoch ms. */
  at: number;
  /**
   * `edited`: a file in the worktree changed. `git`: the index or HEAD
   * moved (a commit, a stage, a checkout). `draft`: a draft file changed.
   * `head-commit`: the open PR's newest commit was made. The rest come
   * from GitHub's reviews, comments, merge or close.
   */
  kind: WorkActivityKind;
  /** The GitHub login for a PR event; null for local work. */
  author: string | null;
  /** By someone other than the `gh` account the PRs are read as. */
  other: boolean;
}

/** The local times an item's activity is picked from, epoch ms. */
export interface WorkLocalTimes {
  edited: number | null;
  git: number | null;
  draft: number | null;
}

export interface WorkItem {
  /** The mark key: `<root>\n<branch>`, `<worktree path>`, or `pr:<owner>/<name>#<number>`. */
  key: string;
  kind: WorkItemKind;
  section: WorkSection;
  /** null for a PR with no local clone. */
  repoRoot: string | null;
  /** The repo's name, or the PR's `owner/name` when there is no clone. */
  repoName: string;
  worktreePath: string | null;
  branch: string | null;
  state: WorkItemState;
  facts: WorkItemFacts;
  pr: PrInfo | null;
  note: WorkItemNote | null;
  /** null: the row only links to GitHub, or has nowhere to go. */
  open: WorkItemTarget | null;
  stage: WorkStage;
  stack: WorkStack | null;
  /** Empty when nobody waits on the author. */
  attention: WorkAttention[];
  /** The newest of the local times, the PR's events, and its merge or close. */
  lastActivity: WorkActivity | null;
  times: WorkLocalTimes;
  /** Sort key: `lastActivity.at`, or null. */
  activity: number | null;
  /** What a dismiss mark is compared against. */
  fingerprint: string;
  tracked: boolean;
}

/** What `classifyWork` returns. Each list is in display order. */
export interface WorkClassification {
  work: WorkItem[];
  /** Candidates active in the last CANDIDATE_RECENT_DAYS. */
  candidates: WorkItem[];
  /** The other candidates: older or unknown activity. Shown folded. */
  older: WorkItem[];
  done: WorkItem[];
  /** Hidden by a dismiss mark whose fingerprint still matches. */
  dismissed: WorkItem[];
  /** Mark keys with no item behind them. Empty unless the scan was complete. */
  staleMarks: string[];
}
